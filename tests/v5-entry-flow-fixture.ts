import { fixture } from './paper-fixtures.js';
import { initialPaperState, PAPER_CONFIG, observeSnapshot, type QuoteResult } from '../src/paper.js';
import { readPaperQuote } from '../src/paper-quotes.js';

// Production entry pipeline and integer quotes. No seeded confirmation histories.
export async function v5EntryScenario(mode='HEALTHY',equity=200,gas=.01){
 const f=fixture(),state=initialPaperState(f.time,{...PAPER_CONFIG,PAPER_STRATEGY_VERSION:5,STARTING_BALANCE_USD:equity});
 if(f.launch.market.status==='VERIFIED')f.launch.market.creatorTaxBps=0;
 f.state.fee=100n;f.state.creatorTax=0n;let quoteCalls=0;
 for(let i=0;i<4;i++){
  const now=f.time+i*10_000,block=20+i;
  const reserve=mode==='SINGLE_SPIKE'?(i===3?1.45:1):mode==='FALLING'?1.45-i*.15:mode==='THIN'?.0001:1+i*.15;
  f.state.real=BigInt(Math.round(reserve*1e6))*10n**12n;f.state.reserve=10n**18n+f.state.real;f.state.headBlock=block;f.state.blockTime=Math.floor(now/1000);f.state.usd.timestamp=new Date(now).toISOString();
  const launch=structuredClone(f.launch);
  if(launch.market.status==='VERIFIED'){launch.market.realQuoteReserve=String(f.state.real);launch.market.quoteReserve=String(f.state.reserve);launch.market.progressBps=Math.floor(reserve/2*10000);}
  launch.chronology={...launch.chronology!,eventMode:'LIVE',currentBlock:block,currentTimestamp:Math.floor(now/1000),tokenAgeSeconds:i*10,currentBlockHash:`0x${'b'.repeat(64)}`};
  await observeSnapshot(state,{...f.snapshot,headBlock:block,fetchedAt:new Date(now).toISOString(),launches:[launch]},now,async(_launch,size):Promise<QuoteResult>=>{
   quoteCalls++;if(mode==='MISSING')return {status:'NOT_PAPER_TRADABLE',reason:'RPC_TIMEOUT',details:['No saved executable quote']};
   const result=await readPaperQuote(f.rpc,async()=>f.state.usd,launch,{side:'BUY',sizeUsd:size},()=>now,state.config);
   if(result.status==='AVAILABLE'){result.quote.costs.gasUsd=gas;result.quote.roundTrip!.sell.costs.gasUsd=gas;}
   return result;
  },()=>now);
 }
 return {state,now:f.time+30_000,quoteCalls};
}

