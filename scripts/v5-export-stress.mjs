// Synthetic export load only. Uses a temporary account, never the running bot's storage.
import {mkdtemp,open,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {PaperStore} from '../dist/src/paper-store.js';
import {PaperExport} from '../dist/src/paper-export.js';
import {PaperService} from '../dist/src/paper-service.js';
import {initialPaperState,PAPER_CONFIG,liveCandidate,enterPaper} from '../dist/src/paper.js';
import {fixture} from '../dist/tests/paper-fixtures.js';
import {seedEntryQuality,seedLiquidityHistory} from '../dist/tests/liquidity-history-fixture.js';
const output=process.argv[2]??'reports/v5-export-memory.json';
const directory=await mkdtemp(join(tmpdir(),'v5-export-stress-')),f=fixture();
f.state.fee=0n;if(f.launch.market.status==='VERIFIED')f.launch.market.creatorTaxBps=0;
const result=await f.buy(1);if(result.status!=='AVAILABLE')throw Error('fixture');result.quote.costs.gasUsd=0;result.quote.roundTrip.sell.costs.gasUsd=0;
const state=initialPaperState(f.time,{...PAPER_CONFIG,PAPER_STRATEGY_VERSION:5}),candidate=liveCandidate(f.launch);candidate.quote=result;
seedLiquidityHistory(state,candidate,result.quote);seedEntryQuality(state,candidate,result.quote);
if(enterPaper(state,candidate,1,f.time).outcome!=='PAPER_BUY')throw Error('fixture admission');
const store=await PaperStore.open(directory,()=>f.time);await store.update(s=>{Object.assign(s,state);});
let sourceBytes=0,sourceRecords=0;
const event=JSON.stringify({timestamp:new Date(f.time).toISOString(),category:'SYSTEM',stage:'PAPER',tokenAddress:null,tokenSymbol:null,eventType:'SYNTHETIC_EXPORT',message:'synthetic saved observation',metadata:{padding:'x'.repeat(4096)}});
for(let i=0;i<8;i++){
 const handle=await open(join(directory,`audit-archive-${f.time-1}-${(i+10).toString(16)}.json`),'wx',0o600);
 try{await handle.write('{"events":[');for(let n=0;n<8192;n++){const row=(n?',':'')+event;await handle.write(row);sourceBytes+=Buffer.byteLength(row);sourceRecords++;}await handle.write(']}');sourceBytes+=13;}
 finally{await handle.close();}
}
let marks=0;
const service=new PaperService(store,async()=>({...f.snapshot,launches:[]}),async p=>{
 marks++;const quote=structuredClone(p.current),stamp=new Date().toISOString();quote.timestamp=stamp;quote.blockTimestamp=stamp;quote.blockNumber+=marks;quote.evidence.usdTimestamp=stamp;
 return {status:'AVAILABLE',quote};
});
const exporter=new PaperExport(store,()=>service.exportResearchFiles()),samples=[];let inFlight=false,monitorError=false;
const before=store.read(),start=Date.now();
const timer=setInterval(()=>{samples.push({...process.memoryUsage(),elapsedMs:Date.now()-start});if(!inFlight){inFlight=true;void service.monitor().catch(()=>{monitorError=true;}).finally(()=>{inFlight=false;});}},50);
try{
 const job=await exporter.start();let status;
 for(;;){status=exporter.status(job.id);if(status.status!=='BUILDING')break;await new Promise(r=>setTimeout(r,50));}
 if(status.status!=='READY')throw Error(status.error);
 const after=store.read(),peakRss=Math.max(...samples.map(s=>s.rss),status.memory.rss),last=samples.slice(-Math.max(1,Math.ceil(samples.length/3)));
 const report={syntheticInfrastructureOnly:true,sourceBytes,sourceRecords,sourceFiles:8,durationMs:Date.now()-start,zipBytes:status.bytes,
  peakRssMiB:peakRss/1048576,sustainedRssMiB:last.reduce((sum,s)=>sum+s.rss,0)/last.length/1048576,workerHeapLimitMiB:128,parentHeapLimitMiB:384,
  monitorQuotesWhileExporting:marks,cgroupMemoryMax:(await readFile('/sys/fs/cgroup/memory.max','utf8').catch(()=> 'unavailable')).trim(),containerLimitEnforced:false,
  acceptance:{rssBelow500MiB:peakRss<500*1048576,rssBelow650MiB:peakRss<650*1048576,cashPreserved:before.cash===after.cash,
    positionsPreserved:before.positions.length===after.positions.length && after.positions[0].id===before.positions[0].id,
    noExitCreated:after.positions[0].management.pendingExit===null,monitorContinued:marks>0&&!monitorError,zipReady:status.status==='READY'},
  samples:samples.filter((_,i)=>i%10===0)};
 await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,samples:undefined},null,2));
 if(Object.values(report.acceptance).some(v=>!v))process.exitCode=1;
}finally{clearInterval(timer);while(inFlight)await new Promise(r=>setTimeout(r,10));await exporter.close();await service.close();await rm(directory,{recursive:true,force:true});}
