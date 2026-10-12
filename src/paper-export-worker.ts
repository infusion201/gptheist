import { parentPort, workerData } from 'node:worker_threads';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { JSONParser, TokenType } from '@streamparser/json';
import { ZipFile } from 'yazl';
import type { PaperState } from './paper.js';
import type { ExportWorkerInput } from './paper-export.js';

const input=workerData as ExportWorkerInput;
const state=input.state as PaperState, cutoff=Date.parse(input.snapshotAt);
const sensitive=/password|secret|private.?key|api.?key|authorization|cookie|credentials|mnemonic|seed.?phrase|railway|access.?token|refresh.?token|export.?token|^env(?:ironment)?$/i;
let redactions=0;
function textSafe(text:string):string {
  let result=text;
  for(const secret of input.secrets)if(result.includes(secret)){result=result.split(secret).join('[REDACTED]');redactions++;}
  result=result.replace(/\bBearer\s+[^\s"',;]+/gi,'Bearer [REDACTED]')
    .replace(/((?:password|api[_-]?key|private[_-]?key|secret|access[_-]?token)\s*[:=]\s*)[^\s"',;&]+/gi,'$1[REDACTED]');
  result=result.replace(/https?:\/\/[^\s"<>]+/g,value=>{
    try{const url=new URL(value);if(url.username||url.password){url.username='';url.password='';redactions++;}
      for(const key of [...url.searchParams.keys()])if(sensitive.test(key)||/^token$|^key$|^auth$/i.test(key)){url.searchParams.set(key,'[REDACTED]');redactions++;}
      return url.toString();
    }catch{return value;}
  });
  return result;
}
function clean(value:unknown):unknown {
  if(typeof value==='string')return textSafe(value);
  if(Array.isArray(value))return value.map(clean);
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>{
    if(sensitive.test(key)){redactions++;return [textSafe(key),'[REDACTED]'];}return [textSafe(key),clean(v)];
  }));
  return value;
}
const encoded=(value:unknown)=>JSON.stringify(clean(value));
const fileStats:Record<string,{bytes:number;sha256:string}>={};
const totals:Record<string,number>={trades:0,positions:0,events:0,decisions:0,history:0,marketFrames:0,quotes:0,missingQuoteResults:0,reserveObservations:0,momentumObservations:0,unknownGasQuotes:0};
for(const key of ['positions','events','decisions','history'] as const)totals[key]=state[key].length;
const sources:{name:string;zipPath:string;bytes:number;sha256?:string;previous?:string|null;previousTrades?:string|null;records:Record<string,number>;currentAccount:boolean}[]=[];
const tapeIssues:{source:string;partialTailBytes:number;afterSnapshotFrames:number}[]=[];
let processed=0;
function progress(){parentPort?.postMessage({type:'progress',processedFiles:++processed});}
function evidenceCounts(value:unknown) {
  if(!value || typeof value!=='object')return;
  const row=value as Record<string,unknown>;
  if(typeof row.recordingSkippedFrames==='number')totals.recordingSkippedFrames=Math.max(totals.recordingSkippedFrames??0,row.recordingSkippedFrames);
  if((row.side==='BUY'||row.side==='SELL') && typeof row.notionalUsd==='number' && row.costs){
    totals.quotes!++;if((row.costs as Record<string,unknown>).gasUsd==null)totals.unknownGasQuotes!++;
  }
  if(row.status==='NOT_PAPER_TRADABLE')totals.missingQuoteResults!++;
  if(row.realQuoteReserveWei && row.timestamp)totals.reserveObservations!++;
  if(row.reserve && row.verificationStatus)totals.momentumObservations!++;
  for(const [key,child] of Object.entries(row))if(!sensitive.test(key) && child && typeof child==='object')evidenceCounts(child);
}
async function* arrayJson(rows:Iterable<unknown>){yield '[';let first=true;for(const row of rows){yield (first?'':',')+encoded(row);first=false;}yield ']\n';}
async function* oneJson(value:unknown){yield encoded(value)+'\n';}
async function* hashed(name:string,iter:AsyncIterable<string|Buffer>){const hash=createHash('sha256');let bytes=0;for await(const chunk of iter){const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);hash.update(buffer);bytes+=buffer.length;yield buffer;}fileStats[name]={bytes,sha256:hash.digest('hex')};}
const zip=new ZipFile();
function add(name:string,produce:()=>AsyncIterable<string|Buffer>){zip.addReadStreamLazy(name,{compressionLevel:1},cb=>cb(null,Readable.from(hashed(name,produce()))));}

async function run(){
  const spoolPath=join(input.workDirectory,'trades-spool.json'),spool=await open(spoolPath,'wx',0o600);
  let firstTrade=true;
  const tradeWrite=async(rows:unknown[])=>{for(const row of rows){await spool.write((firstTrade?'':',')+encoded(row));firstTrade=false;totals.trades!++;}};
  await spool.write('[');
  await tradeWrite(state.trades.map(record=>({sourceFile:'state.json',record})));
  evidenceCounts(state);
  const names=(await readdir(input.directory)).filter(name=>
    /^(?:audit-archive-\d+-[a-f0-9-]+|(?:reset|schema-v\d+|monitor-fix)-backup-\d+)\.json$/.test(name) &&
    Number(name.match(/-(\d+)(?:-[a-f0-9-]+)?\.json$/)?.[1])<=cutoff).sort();
  parentPort?.postMessage({type:'progress',processedFiles:0,totalFiles:names.length+input.research.length});
  // Preserve the bounded exact account snapshot as well as easy-to-read current files.
  add('snapshot/state.json',()=>oneJson(state));
  const {positions:_p,trades:_t,events:_e,decisions:_d,history:_h,tractionHistory:_th,liquidityHistory:_lh,tractionWatchlist:_tw,researchLedger:_rl,...account}=state;
  add('account.json',()=>oneJson({...account,snapshotAt:input.snapshotAt}));
  add('open_positions.json',()=>arrayJson(state.positions));
  add('strategy_config.json',()=>oneJson(state.config));
  add('account_balance_history.json',()=>arrayJson(state.history));
  add('reserve_history.json',()=>oneJson({liquidityHistory:state.liquidityHistory??{},tractionHistory:state.tractionHistory??{}}));
  add('candidates.json',()=>oneJson({decisions:state.decisions,researchLedger:state.researchLedger??{},watchlist:state.tractionWatchlist??{}}));
  add('events.json',()=>arrayJson(state.events));
  function* quotes(value:unknown,path='snapshot/state.json'):Generator<unknown>{
    if(!value || typeof value!=='object')return;
    const row=value as Record<string,unknown>;
    if(((row.side==='BUY'||row.side==='SELL') && row.costs) || row.status==='NOT_PAPER_TRADABLE')yield {path,record:value};
    for(const [key,child] of Object.entries(row))if(child && typeof child==='object')yield* quotes(child,`${path}.${key}`);
  }
  add('quotes.json',()=>arrayJson(quotes(state)));
  const primitiveKeys=['previous','previousTrades','cash','createdAt','schemaVersion','archiveHead','archiveTradeHead','archivedRealizedPnl','lastSnapshotAt','lastObservedHeadBlock','mode'];
  const collections=['trades','positions','events','decisions','history','ledger','watchlist','tractionHistory','liquidityHistory','tractionWatchlist','researchLedger'];
  for(const name of names){
    const source={name,zipPath:`history/${name}`,bytes:0,records:{} as Record<string,number>,currentAccount:false} as typeof sources[number];sources.push(source);
    add(source.zipPath,async function*(){
      const handle=await open(join(input.directory,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        const info=await handle.stat();if(!info.isFile())throw Error('Invalid export source');source.bytes=info.size;
        const rawHash=createHash('sha256');let output:string[]=[],tradeRows:unknown[]=[];
        const parser=new JSONParser({paths:[...collections.map(key=>`$.${key}.*`),...primitiveKeys.map(key=>`$.${key}`)],keepStack:false});
        const contexts:{object:boolean;key:boolean;hide:boolean}[]=[];let skipped=0;
        // Token-level redaction preserves the complete original JSON without retaining its arrays.
        parser.onToken=({token,value})=>{
          const ctx=contexts.at(-1),isKey=token===TokenType.STRING && ctx?.object && ctx.key;
          const start=token===TokenType.LEFT_BRACE||token===TokenType.LEFT_BRACKET;
          const end=token===TokenType.RIGHT_BRACE||token===TokenType.RIGHT_BRACKET;
          if(skipped){if(start)skipped++;if(end)skipped--;if(!skipped && ctx)ctx.hide=false;return;}
          if(ctx?.hide && token!==TokenType.COLON){output.push('"[REDACTED]"');redactions++;if(start){skipped=1;return;}ctx.hide=false;return;}
          if(token===TokenType.STRING){output.push(JSON.stringify(textSafe(String(value))));if(isKey){ctx!.key=false;ctx!.hide=sensitive.test(String(value));}}
          else if(token===TokenType.NUMBER){if(!Number.isFinite(value))throw Error('Nonfinite JSON source');output.push(String(value));}
          else if(token===TokenType.TRUE)output.push('true');else if(token===TokenType.FALSE)output.push('false');else if(token===TokenType.NULL)output.push('null');
          else output.push(({[TokenType.LEFT_BRACE]:'{',[TokenType.RIGHT_BRACE]:'}',[TokenType.LEFT_BRACKET]:'[',[TokenType.RIGHT_BRACKET]:']',[TokenType.COLON]:':',[TokenType.COMMA]:','} as Record<number,string>)[token]??'');
          if(start)contexts.push({object:token===TokenType.LEFT_BRACE,key:token===TokenType.LEFT_BRACE,hide:false});
          if(end)contexts.pop();if(token===TokenType.COMMA && contexts.at(-1)?.object)contexts.at(-1)!.key=true;
        };
        parser.onValue=({value,key,stack})=>{
          if(stack.length===1){if(key==='previous')source.previous=typeof value==='string'?value:null;if(key==='previousTrades')source.previousTrades=typeof value==='string'?value:null;return;}
          const type=String(stack[1]?.key);source.records[type]=(source.records[type]??0)+1;
          if(type in totals)totals[type]=(totals[type]??0)+1;
          evidenceCounts(value);
          if(type==='trades'){tradeRows.push({sourceFile:name,record:value});totals.trades!--;}
        };
        const stream=handle.createReadStream({autoClose:false,highWaterMark:16*1024});
        for await(const chunk of stream){rawHash.update(chunk);if(parser.isEnded){if(chunk.toString('utf8').trim())throw Error('Trailing source content');}else parser.write(chunk);if(tradeRows.length){await tradeWrite(tradeRows);tradeRows=[];}if(output.length){yield output.join('');output=[];}}
        if(!parser.isEnded)parser.end();if(output.length)yield output.join('');source.sha256=rawHash.digest('hex');progress();
      } finally {await handle.close();}
    });
  }
  for(const tape of input.research){
    const path=`market_observations/${tape.name}`;
    add(path,async function*(){
      const issues={source:tape.name,partialTailBytes:0,afterSnapshotFrames:0};let pending=Buffer.alloc(0);
      if(tape.size)for await(const chunk of createReadStream('',{fd:tape.fd,autoClose:false,start:0,end:tape.size-1,highWaterMark:16*1024})){
        pending=Buffer.concat([pending,chunk]);let next;
        while((next=pending.indexOf(10))>=0){const line=pending.subarray(0,next).toString('utf8');pending=pending.subarray(next+1);if(!line.trim())continue;
          const frame=JSON.parse(line);if(!Number.isFinite(Date.parse(frame.completedAt)))throw Error('Invalid research timestamp');
          if(Date.parse(frame.completedAt)>cutoff){issues.afterSnapshotFrames++;continue;}
          evidenceCounts(frame);totals.marketFrames!++;yield encoded(frame)+'\n';
        }
        if(pending.length>4*1048576)throw Error('Oversized research record');
      }
      issues.partialTailBytes=pending.length;tapeIssues.push(issues);progress();
    });
  }
  add('trades.json',async function*(){await spool.write(']\n');await spool.close();for await(const chunk of createReadStream(spoolPath))yield chunk;});
  const linked=new Set<string>();
  function validateChain(){const byName=new Map(sources.map(s=>[s.name,s]));let cursor=state.archiveHead;
    while(cursor){if(linked.has(cursor))throw Error('Cyclic account archive');const source=byName.get(cursor);if(!source)throw Error('Missing account archive');linked.add(cursor);source.currentAccount=true;cursor=source.previous??undefined;}
    const tradeChain=new Set<string>();cursor=state.archiveTradeHead;
    while(cursor){if(tradeChain.has(cursor)||!linked.has(cursor))throw Error('Invalid trade archive chain');tradeChain.add(cursor);cursor=byName.get(cursor)!.previousTrades??undefined;}
  }
  add('sources.json',async function*(){validateChain();yield* arrayJson(sources);});
  add('export_manifest.json',async function*(){
    const currentTrades=state.trades.length+sources.filter(s=>s.currentAccount).reduce((n,s)=>n+(s.records.trades??0),0);
    const accountingTrades=state.archivedStrategyStats?state.trades.length+Object.values(state.archivedStrategyStats).reduce((n,s)=>n+s.trades,0):null;
    yield* oneJson({exportSchemaVersion:1,paperStateSchemaVersion:state.schemaVersion,strategyVersion:state.config.PAPER_STRATEGY_VERSION,
      snapshotAt:input.snapshotAt,completedAt:new Date().toISOString(),readOnly:true,files:fileStats,
      counts:{...totals,currentAccountClosedTradeRecords:currentTrades,accountingClosedTradeCount:accountingTrades,currentOpenPositions:state.positions.length,currentBalanceSamples:state.history.length,
        historyFiles:sources.length,linkedAccountHistoryFiles:linked.size,legacyOrRecoveryFiles:sources.length-linked.size,marketObservationFiles:input.research.length},
      sourceIndex:'sources.json',redactions,
      missingData:[...(input.research.length?[]:['No retained forward market tape exists.']),
        ...(accountingTrades!==null && accountingTrades!==currentTrades?[`Accounting reports ${accountingTrades} closed trades, but ${currentTrades} current-account trade records are reachable. Full fill history is incomplete.`]:[]),
        ...(totals.recordingSkippedFrames?['The retained research tape reports skipped market frames; replay coverage is incomplete.']:[]),
        ...(totals.unknownGasQuotes?['Some saved gas estimates are unknown; nulls were preserved.']:[]),
        ...(totals.missingQuoteResults?['Unavailable quote results remain unavailable; no fill was inferred.']:[]),
        'Previously unsaved or pruned observations cannot be recovered by export.','Other Railway services and files outside this paper data directory are not accessed.'],
      tapeBoundaries:tapeIssues,
      coverage:{currentFiles:'Current account at snapshotAt. Current quote occurrences are in quotes.json; historical quotes, reserves, momentum and rejected candidates remain inside the complete history JSON files.',
        trades:'trades.json contains saved trade occurrences wrapped as {sourceFile,record}, including older recovery snapshots. Use sources.json currentAccount plus state.json records to select the current account. Deduplicate trade IDs within the intended account; never add overlapping backups together.',
        history:'All allowlisted immutable audit archives and saved recovery JSON snapshots existing before snapshotAt are included. Unlinked older files are labelled separately; they are not assumed to be V5.',
        research:'Research descriptors and byte boundaries are frozen; later frames and a partially written last line are excluded and reported.',
        replay:'Full historical replay is not guaranteed. It requires exact-sized entry and full-position sell quotes recorded at each decision, including after original exits. Missing observations cannot be invented.'},
      excluded:['Environment variables, credentials, lock files, temporary state files and unrelated filesystem files'],
      hashMeaning:'files hashes cover redacted uncompressed ZIP entry bytes. sources hashes identify original source bytes; original credentials are never included.'});
  });
  zip.end();
  const output=createWriteStream(input.zipPath,{flags:'wx',mode:0o600});
  zip.on('error',error=>output.destroy(error));
  try {await pipeline(zip.outputStream,output);parentPort?.postMessage({type:'ready',memory:process.memoryUsage(),counts:totals});}
  finally {await spool.close().catch(()=>undefined);}
}
run().catch(()=>{(zip.outputStream as Readable).destroy();parentPort?.postMessage({type:'failed',error:'Export could not be completed. Check saved files and available temporary disk space.'});process.exitCode=1;});
