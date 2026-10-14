import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './paper-fixtures.js';
import { initialPaperState, PAPER_CONFIG, liveCandidate, enterPaper, type PaperConfig } from '../src/paper.js';
import { readPaperQuote } from '../src/paper-quotes.js';
import { proposeTradePlan } from '../src/paper-policy.js';
import { entryFunnel } from '../src/paper-entry-diagnostics.js';
import { PaperStore } from '../src/paper-store.js';
import { seedEntryQuality, seedLiquidityHistory } from './liquidity-history-fixture.js';
import type { RpcCaller } from '../src/live.js';
import { entryQuality, getPaperStrategy } from '../src/paper-strategy.js';
import type { CandidateDecision } from '../src/paper.js';

import { v5EntryScenario } from './v5-entry-flow-fixture.js';

test('healthy V5 candidates clear every production gate with real modeled fees and gas',async()=>{
 for(const [equity,gas] of [[250,.010651],[200,.01],[1000,.01],[100,.004]] as const){
  const {state,now}=await v5EntryScenario('HEALTHY',equity,gas);
  assert.equal(state.positions.length,1,JSON.stringify(state.decisions.at(-1)));
  const p=state.positions[0]!;assert.equal(p.mode,'PAPER');assert.equal(p.execution,'SIMULATED');
  assert.ok(p.costBasisUsd<=equity*2/100+1e-8);assert.ok(p.sizeUsd>=1);
  assert.equal(p.entry.blockNumber,p.entry.roundTrip!.sell.blockNumber);
  assert.ok(state.liquidityHistory![p.launchId]!.length>=3);
  const counts=entryFunnel(state,now);for(const name of ['discovered','traction','momentum','liquidity','sizing','eligible'] as const)assert.equal(counts[name],1,name);
  assert.equal(counts.timeSinceLastEligibleMs,0);
 }
});

test('plateaus are observed without authorizing a single spike or an unsafe trade',async()=>{
 const {state}=await v5EntryScenario('SINGLE_SPIKE');
 assert.equal(state.positions.length,0);const id=state.decisions.at(-1)!.candidate.launchId;
 assert.equal(state.liquidityHistory![id]!.length,4);
 assert.equal(state.decisions.at(-1)!.reason,'ENTRY_MOMENTUM_WEAK');assert.equal(state.cash,200);
});

test('withdrawals, missing quotes, thin exits and excessive friction remain blocked',async()=>{
 for(const mode of ['FALLING','MISSING','THIN','GAS']){
  const {state,now}=await v5EntryScenario(mode,200,mode==='GAS'?.2:.01);
  assert.equal(state.positions.length,0,mode);assert.equal(state.cash,200,mode);assert.equal(entryFunnel(state,now).eligible,0,mode);
  if(mode==='GAS')assert.equal(state.decisions.at(-1)!.reason,'ENTRY_FRICTION_TOO_HIGH');
 }
});

test('a $50 account with positive gas is explicitly blocked instead of exceeding its exposure cap',async()=>{
 const {state}=await v5EntryScenario('HEALTHY',50,.01);
 assert.equal(state.positions.length,0);assert.equal(state.cash,50);assert.equal(state.decisions.at(-1)!.reason,'SIZE_NOT_EXECUTABLE');
 assert.ok(state.decisions.at(-1)!.details.some(d=>d.includes('all_in_token_cap_usd=1')));
});

test('V5 sizing uses its actual saved 5% stop; other policy versions retain their stop math',async()=>{
 const f=fixture();f.state.fee=0n;if(f.launch.market.status==='VERIFIED')f.launch.market.creatorTaxBps=0;
 const result=await f.buy(10);if(result.status!=='AVAILABLE')throw Error('fixture');result.quote.costs.gasUsd=.01;result.quote.roundTrip!.sell.costs.gasUsd=.01;
 const state=initialPaperState(f.time,{...PAPER_CONFIG,PAPER_STRATEGY_VERSION:5,MAX_RISK_EQUITY_PERCENT:.01});
 const c=liveCandidate(f.launch);seedEntryQuality(state,c,result.quote);seedLiquidityHistory(state,c,result.quote);
 const plan=proposeTradePlan(state,c,result.quote,f.time);
 const expected=Math.floor((plan.riskBudgetUsd/(plan.exitPolicy.downsidePercent/100)-.01)*100)/100;
 assert.equal(plan.exitPolicy.downsidePercent,5);assert.equal(plan.proposedSizeUsd,expected);
 assert.ok((plan.proposedSizeUsd+.01)*.05<=plan.riskBudgetUsd+1e-8);
});

test('V5 BUY and full SELL use one pinned chain head; V4 still requests separate latest heads',async()=>{
 for(const version of [4,5]){
  const f=fixture();let heads=0;
  const rpc:RpcCaller=async(method,params)=>{if(method==='eth_blockNumber'){f.state.headBlock=2+heads++;}return f.rpc(method,params);};
  const config={...PAPER_CONFIG,PAPER_STRATEGY_VERSION:version} as PaperConfig;
  const result=await readPaperQuote(rpc,async()=>f.state.usd,f.launch,{side:'BUY',sizeUsd:1},()=>f.time,config);
  assert.equal(result.status,'AVAILABLE');if(result.status!=='AVAILABLE')throw Error('Quote not available');
  assert.equal(heads,version===5?1:2);assert.equal(result.quote.blockNumber===result.quote.roundTrip!.sell.blockNumber,version===5);
 }
});

test('stage traces and last eligibility survive restart without resetting the account',async()=>{
 const {state,now}=await v5EntryScenario(),directory=await mkdtemp(join(tmpdir(),'v5-entry-restart-'));
 let store=await PaperStore.open(directory,()=>now);
 try{await store.update(s=>{Object.assign(s,state);});const before=entryFunnel(store.read(),now);await store.close();store=await PaperStore.open(directory,()=>now);
  assert.deepEqual(entryFunnel(store.read(),now),before);assert.equal(store.read().cash,state.cash);assert.equal(store.read().positions.length,1);
 }finally{await store.close();await rm(directory,{recursive:true,force:true});}
});
test('actual saved reserve-reversal observations remain rejected without inventing a price quote',async()=>{
 const {decision}=JSON.parse(await readFile('fixtures/v5-recorded-entry-rejection.json','utf8')) as {decision:CandidateDecision};
 const result=entryQuality(decision.candidate,undefined,Date.parse(decision.timestamp),getPaperStrategy({PAPER_STRATEGY_VERSION:5}));
 assert.equal(result.passed,false);assert.equal(result.reason,'ENTRY_MOMENTUM_WEAK');
});
test('direct V5 entry also enforces its complete stop-risk budget',async()=>{
 const f=fixture();f.state.fee=0n;f.state.creatorTax=0n;const state=initialPaperState(f.time,{...PAPER_CONFIG,PAPER_STRATEGY_VERSION:5,MAX_RISK_EQUITY_PERCENT:.001});
 const result=await f.buy(1);if(result.status!=='AVAILABLE')throw Error('fixture');result.quote.costs.gasUsd=0;result.quote.roundTrip!.sell.costs.gasUsd=0;
 const c=liveCandidate(f.launch);c.quote=result;seedEntryQuality(state,c,result.quote);seedLiquidityHistory(state,c,result.quote);
 assert.equal(enterPaper(state,c,1,f.time).reason,'PLAN_RISK_BUDGET');assert.equal(state.positions.length,0);
});
