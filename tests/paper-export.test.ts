import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromBuffer } from 'yauzl';
import { PaperExport, type ExportJob } from '../src/paper-export.js';
import { PaperStore } from '../src/paper-store.js';
import { ForwardRecorder } from '../src/paper-forward.js';
import { PaperService } from '../src/paper-service.js';
import { initialPaperState, PAPER_CONFIG, liveCandidate, enterPaper, type ClosedTrade } from '../src/paper.js';
import { fixture } from './paper-fixtures.js';
import { seedEntryQuality, seedLiquidityHistory } from './liquidity-history-fixture.js';
import { startDeskServer, stopDeskServer } from '../src/server.js';
import { exportAuthenticated, exportSessionCookie } from '../src/paper-export-auth.js';
import type { IncomingMessage } from 'node:http';

async function unzip(buffer:Buffer):Promise<Record<string,string>> {
  return new Promise((resolve,reject)=>fromBuffer(buffer,{lazyEntries:true},(error,zip)=>{
    if(error||!zip){reject(error);return;}const files:Record<string,string>={};
    zip.on('error',reject);zip.on('end',()=>resolve(files));
    zip.on('entry',entry=>{zip.openReadStream(entry,(error,stream)=>{
      if(error||!stream){reject(error);return;}const chunks:Buffer[]=[];stream.on('data',chunk=>chunks.push(chunk));stream.on('error',reject);
      stream.on('end',()=>{files[entry.fileName]=Buffer.concat(chunks).toString('utf8');zip.readEntry();});
    });});zip.readEntry();
  }));
}
async function ready(service:PaperExport,job:ExportJob){
  for(let i=0;i<500;i++){const status=service.status(job.id)!;if(status.status==='FAILED')throw Error(status.error);if(status.status==='READY')return status;await new Promise(r=>setTimeout(r,10));}
  throw Error('Export timed out');
}
async function seeded(){
  const f=fixture();f.state.fee=0n;if(f.launch.market.status==='VERIFIED')f.launch.market.creatorTaxBps=0;
  const q=await f.buy(1);assert.equal(q.status,'AVAILABLE');if(q.status!=='AVAILABLE')throw Error('fixture');
  q.quote.costs.gasUsd=0;q.quote.roundTrip!.sell.costs.gasUsd=0;
  const state=initialPaperState(f.time,{...PAPER_CONFIG,PAPER_STRATEGY_VERSION:5}),c=liveCandidate(f.launch);c.quote=q;
  seedLiquidityHistory(state,c,q.quote);seedEntryQuality(state,c,q.quote);assert.equal(enterPaper(state,c,1,f.time).outcome,'PAPER_BUY');
  return {f,state};
}

test('ZIP includes exact current and archived trades, open positions, missing quotes, tapes and safe legacy sources',async()=>{
  const {f,state}=await seeded(),directory=await mkdtemp(join(tmpdir(),'v5-zip-data-'));
  const store=await PaperStore.open(directory,()=>f.time),recorder=new ForwardRecorder(join(directory,'research'));
  const password='test-export-password-very-secret',old=process.env.PAPER_EXPORT_TOKEN;process.env.PAPER_EXPORT_TOKEN=password;
  const service=new PaperExport(store,()=>recorder.exportFiles());
  try {
    const p=state.positions[0]!;
    state.trades=Array.from({length:105},(_,i)=>{
      const trade=structuredClone(p) as ClosedTrade;trade.id=`closed-${i}`;trade.launchId=`old-${i}`;
      trade.exit=structuredClone(p.current);trade.exit.notionalUsd=p.costBasisUsd*(i%2?1.1:.8);trade.exit.fillPriceUsd=trade.exit.notionalUsd/trade.exit.quantity;
      trade.exitedAt=new Date(f.time).toISOString();trade.pnlUsd=trade.exit.notionalUsd-trade.costBasisUsd;trade.returnPercent=trade.pnlUsd/trade.costBasisUsd*100;
      trade.exitReason='DYNAMIC_RISK_EXIT';trade.exitReasoning=['Saved downside trigger'];return trade;
    });
    state.cash+=state.trades.reduce((sum,t)=>sum+t.pnlUsd,0);
    state.events.push({timestamp:new Date(f.time).toISOString(),category:'SYSTEM',stage:'PAPER',tokenAddress:null,tokenSymbol:null,eventType:'QUOTE_UNAVAILABLE',message:`RPC failure Bearer ${password}`,metadata:{password:'another-secret',nested:{privateKey:'do-not-export',apiKey:'api-secret-value'},result:{status:'NOT_PAPER_TRADABLE',reason:'INSUFFICIENT_EXIT_LIQUIDITY',details:[]},source:'https://example.test/rpc?api_key=url-secret-value'}});
    await store.update(s=>{Object.assign(s,state);});
    const snapshot=store.read(),before=await readFile(join(directory,'state.json'),'utf8');
    const legacy=`reset-backup-${f.time-1}.json`;
    await writeFile(join(directory,legacy),JSON.stringify({...snapshot,trades:[state.trades[0]],password:'backup-secret',environment:{PRIVATE_KEY:'hidden-secret'}}));
    await writeFile(join(directory,'.env'),'PRIVATE_KEY=not-exported');await writeFile(join(directory,'state-123.tmp'),'not-exported');
    await recorder.record({sequence:1,completedAt:new Date(f.time).toISOString(),snapshot:f.snapshot,buys:[],sells:[{token:p.tokenAddress,tokenUnits:p.entry.tokenUnits!,result:{status:'NOT_PAPER_TRADABLE',reason:'RPC_TIMEOUT',details:[]}}]});
    const job=await service.start();await assert.rejects(service.start(),/already/);
    // A later account update must not leak into the frozen export.
    await store.update(s=>{s.events.push({timestamp:new Date().toISOString(),category:'SYSTEM',stage:'PAPER',tokenAddress:null,tokenSymbol:null,eventType:'TEST_AFTER_SNAPSHOT',message:'after-snapshot-only',metadata:{}});});
    await ready(service,job);const download=service.download(job.id)!;
    const files=await unzip(await readFile(download.path));for(const [name,text] of Object.entries(files))if(name.endsWith('.json'))assert.doesNotThrow(()=>JSON.parse(text),name);
    const manifest=JSON.parse(files['export_manifest.json']!),trades=JSON.parse(files['trades.json']!),positions=JSON.parse(files['open_positions.json']!),sources=JSON.parse(files['sources.json']!);
    assert.equal(manifest.counts.currentAccountClosedTradeRecords,105);assert.equal(manifest.counts.currentOpenPositions,1);
    assert.equal(trades.length,106);assert.equal(positions[0].id,p.id);assert.equal(positions[0].management.pendingExit,p.management.pendingExit);
    assert.equal(JSON.parse(files['snapshot/state.json']!).cash,snapshot.cash);
    assert.ok(sources.find((s:{name:string;currentAccount:boolean})=>s.name===legacy && !s.currentAccount));
    const all=Object.values(files).join('\n');for(const secret of [password,'another-secret','do-not-export','api-secret-value','url-secret-value','backup-secret','hidden-secret','not-exported'])assert.ok(!all.includes(secret),secret);
    assert.ok(all.includes('INSUFFICIENT_EXIT_LIQUIDITY'));assert.ok(all.includes('RPC_TIMEOUT'));assert.ok(!all.includes('after-snapshot-only'));
    assert.equal(manifest.counts.marketFrames,1);assert.ok(manifest.redactions>0);
    for(const [name,info] of Object.entries(manifest.files) as [string,{bytes:number;sha256:string}][]){assert.equal(Buffer.byteLength(files[name]!),info.bytes);assert.equal(createHash('sha256').update(files[name]!).digest('hex'),info.sha256);}
    assert.equal(JSON.parse(before).cash,store.read().cash);assert.equal(store.read().positions.length,1);assert.equal(store.read().config.PAPER_STRATEGY_VERSION,5);
  } finally {await service.close();await recorder.close();await store.close();if(old===undefined)delete process.env.PAPER_EXPORT_TOKEN;else process.env.PAPER_EXPORT_TOKEN=old;await rm(directory,{recursive:true,force:true});}
});

test('research byte boundaries survive appends and pruning; partial tail is reported',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'v5-zip-tape-')),store=await PaperStore.open(directory),recorder=new ForwardRecorder(join(directory,'research'));
  await store.update(s=>{s.config.PAPER_STRATEGY_VERSION=5;});const f=fixture();
  await recorder.record({sequence:1,completedAt:new Date(f.time).toISOString(),snapshot:f.snapshot,buys:[],sells:[]});
  const initialFiles=await recorder.exportFiles();await Promise.all(initialFiles.map(f=>f.handle.close()));
  await writeFile(join(directory,'research',initialFiles[0]!.name),JSON.stringify({sequence:2,completedAt:new Date(f.time+60_000).toISOString(),snapshot:f.snapshot,buys:[],sells:[]})+'\n',{flag:'a'});
  await writeFile(join(directory,'research',initialFiles[0]!.name),'{"partially_written":',{flag:'a'});
  const captured=await recorder.exportFiles(),tape=captured[0]!;
  await writeFile(join(directory,'research',tape.name),'future appended bytes',{flag:'a'});
  await rm(join(directory,'research',tape.name));
  const service=new PaperExport(store,async()=>captured);
  try {const job=await service.start();await ready(service,job);const files=await unzip(await readFile(service.download(job.id)!.path));assert.equal(JSON.parse(files[`market_observations/${tape.name}`]!.trim()).sequence,1);const boundary=JSON.parse(files['export_manifest.json']!).tapeBoundaries[0];assert.ok(boundary.partialTailBytes>0);assert.equal(boundary.afterSnapshotFrames,1);}
  finally{await service.close();await recorder.close();await store.close();await rm(directory,{recursive:true,force:true});}
});

test('V5 account and ZIP endpoints require authentication, sessions survive restart, V4 stays public',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'v5-zip-http-')),store=await PaperStore.open(directory);await store.update(s=>{s.config.PAPER_STRATEGY_VERSION=5;});await store.close();
  const f=fixture(),old=process.env.PAPER_EXPORT_TOKEN;process.env.PAPER_EXPORT_TOKEN='persistent-test-export-password';
  let server=await startDeskServer({host:'127.0.0.1',port:0,paperDirectory:directory,rpc:f.rpc,paperDiscoveryIntervalMs:1000,paperUsdFetch:(async()=>new Response(JSON.stringify({bid:'2000',ask:'2000',time:new Date().toISOString()}))) as typeof fetch});
  const base=()=>{const a=server.address();if(!a||typeof a==='string')throw Error('address');return `http://127.0.0.1:${a.port}`;};
  try {
    for(const path of ['/api/paper','/api/paper/trades','/api/paper/export.zip?id=bogus','/api/paper/export/status?id=bogus'])assert.equal((await fetch(base()+path)).status,401);
    assert.equal((await fetch(base()+'/api/paper/export/session',{method:'POST',headers:{origin:'https://evil.test','content-type':'application/json'},body:JSON.stringify({password:process.env.PAPER_EXPORT_TOKEN})})).status,403);
    assert.equal((await fetch(base()+'/api/paper/export/session',{method:'POST',headers:{origin:base(),'content-type':'application/json'},body:JSON.stringify({password:'incorrect'})})).status,403);
    const login=await fetch(base()+'/api/paper/export/session',{method:'POST',headers:{origin:base(),'content-type':'application/json'},body:JSON.stringify({password:process.env.PAPER_EXPORT_TOKEN})});assert.equal(login.status,200);
    const setCookie=login.headers.get('set-cookie')!;assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Strict/);const cookie=setCookie.split(';')[0]!;
    assert.equal((await fetch(base()+'/api/paper',{headers:{cookie}})).status,200);
    assert.equal((await fetch(base()+'/api/paper/export/jobs',{method:'POST',headers:{cookie,origin:'https://evil.test'}})).status,403);
    const create=await fetch(base()+'/api/paper/export/jobs',{method:'POST',headers:{cookie,origin:base()}});assert.equal(create.status,202);const initial=await create.json() as ExportJob;
    let job=initial;for(let i=0;i<200&&job.status==='BUILDING';i++){await new Promise(r=>setTimeout(r,10));job=await (await fetch(base()+'/api/paper/export/status?id='+initial.id,{headers:{cookie}})).json() as ExportJob;}
    assert.equal(job.status,'READY');const response=await fetch(base()+'/api/paper/export.zip?id='+initial.id,{headers:{cookie}});
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/zip');assert.match(response.headers.get('content-disposition')!,/attachment; filename="gptheist-v5-export-\d{4}-\d{2}-\d{2}\.zip"/);
    const files=await unzip(Buffer.from(await response.arrayBuffer()));assert.equal(JSON.parse(files['export_manifest.json']!).counts.currentOpenPositions,0);
    assert.equal((await fetch(base()+'/api/paper',{headers:{cookie:cookie+'tampered'}})).status,401);
    assert.equal((await fetch(base()+'/api/paper/export.zip?id='+initial.id,{headers:{cookie,'sec-fetch-site':'cross-site'}})).status,401);
    await stopDeskServer(server);server=await startDeskServer({host:'127.0.0.1',port:0,paperDirectory:directory,rpc:f.rpc});
    assert.equal((await fetch(base()+'/api/paper',{headers:{cookie}})).status,200);
    assert.equal((await fetch(base()+'/api/paper/export/status?id='+initial.id,{headers:{cookie}})).status,404);
  }finally{await stopDeskServer(server);if(old===undefined)delete process.env.PAPER_EXPORT_TOKEN;else process.env.PAPER_EXPORT_TOKEN=old;await rm(directory,{recursive:true,force:true});}
});

test('corrupt/missing linked archives and symlinks fail export without rewriting the account',async()=>{
  for(const mode of ['missing','corrupt','symlink']){
    const directory=await mkdtemp(join(tmpdir(),'v5-zip-invalid-')),store=await PaperStore.open(directory),name=`audit-archive-${Date.now()}-abc.json`;
    await store.update(s=>{s.config.PAPER_STRATEGY_VERSION=5;s.archiveHead=name;});
    if(mode==='corrupt')await writeFile(join(directory,name),'{bad');
    if(mode==='symlink')await symlink('/etc/passwd',join(directory,name));
    const before=await readFile(join(directory,'state.json'),'utf8'),service=new PaperExport(store,async()=>[]);
    try{const job=await service.start();await assert.rejects(ready(service,job),/could not/);assert.equal(service.download(job.id),null);assert.equal(await readFile(join(directory,'state.json'),'utf8'),before);}
    finally{await service.close();await store.close();await rm(directory,{recursive:true,force:true});}
  }
});
test('session cookies are secure on Railway, expire and reject changed passwords',()=>{
  const old=process.env.PAPER_EXPORT_TOKEN;process.env.PAPER_EXPORT_TOKEN='unicode-access-password-👑';
  const now=Date.now(),request={headers:{host:'gptheist-v5.up.railway.app'}} as IncomingMessage;
  try{const cookie=exportSessionCookie(request,now);assert.match(cookie,/; Secure/);
    const loggedIn={headers:{cookie:cookie.split(';')[0]}} as IncomingMessage;
    assert.equal(exportAuthenticated(loggedIn,now),true);assert.equal(exportAuthenticated(loggedIn,now+8*3600_000),false);
    process.env.PAPER_EXPORT_TOKEN='rotated-access-password';assert.equal(exportAuthenticated(loggedIn,now),false);
  }finally{if(old===undefined)delete process.env.PAPER_EXPORT_TOKEN;else process.env.PAPER_EXPORT_TOKEN=old;}
});
test('V4 account routes stay unchanged and V5 fails closed when no password is configured',async()=>{
  const old=process.env.PAPER_EXPORT_TOKEN;delete process.env.PAPER_EXPORT_TOKEN;
  try{for(const version of [4,5]){
    const directory=await mkdtemp(join(tmpdir(),'v5-zip-access-')),store=await PaperStore.open(directory);await store.update(s=>{s.config.PAPER_STRATEGY_VERSION=version;});await store.close();
    const f=fixture(),server=await startDeskServer({host:'127.0.0.1',port:0,paperDirectory:directory,rpc:f.rpc});
    try{const address=server.address();if(!address||typeof address==='string')throw Error('address');const base=`http://127.0.0.1:${address.port}`;
      assert.equal((await fetch(base+'/api/paper')).status,version===5?401:200);
      assert.equal((await fetch(base+'/api/paper/trades')).status,version===5?401:200);
      if(version===5){const response=await fetch(base+'/api/paper/export/session',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:'{"password":"anything"}'});assert.equal(response.status,503);}
    }finally{await stopDeskServer(server);await rm(directory,{recursive:true,force:true});}
  }}finally{if(old===undefined)delete process.env.PAPER_EXPORT_TOKEN;else process.env.PAPER_EXPORT_TOKEN=old;}
});

test('position monitoring and durable updates continue while a large archive is exported',async()=>{
  const {f,state}=await seeded(),directory=await mkdtemp(join(tmpdir(),'v5-zip-monitor-')),store=await PaperStore.open(directory,()=>f.time);
  await store.update(s=>{Object.assign(s,state);});
  const name=`audit-archive-${f.time-1}-def.json`;
  // A large JSON array is streamed, not loaded into one object in the worker.
  const rows=Array.from({length:5000},(_,i)=>({timestamp:new Date(f.time).toISOString(),category:'SYSTEM',stage:'PAPER',tokenAddress:null,tokenSymbol:null,eventType:'TEST',message:`saved-${i}`,metadata:{notes:'x'.repeat(2048)}}));
  await writeFile(join(directory,name),JSON.stringify({events:rows}));
  let marks=0;const service=new PaperService(store,async()=>({...f.snapshot,launches:[]}),async p=>{marks++;const q=structuredClone(p.current),stamp=new Date().toISOString();q.timestamp=stamp;q.blockTimestamp=stamp;q.blockNumber+=marks;if(q.evidence)q.evidence.usdTimestamp=stamp;return {status:'AVAILABLE',quote:q};});
  const exporter=new PaperExport(store,()=>service.exportResearchFiles());
  try{const before=store.read(),job=await exporter.start();let buildingMarks=0;
    for(let i=0;i<100&&exporter.status(job.id)?.status==='BUILDING';i++){await service.monitor();buildingMarks++;await new Promise(r=>setTimeout(r,10));}
    await ready(exporter,job);assert.ok(buildingMarks>0);assert.ok(marks>0);assert.equal(store.read().cash,before.cash);assert.equal(store.read().positions.length,1);assert.equal(store.read().positions[0]!.management.pendingExit,null);
    assert.ok(exporter.status(job.id)!.memory!.rss<650*1048576);
  }finally{await exporter.close();await service.close();await rm(directory,{recursive:true,force:true});}
});
