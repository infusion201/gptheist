import type { Candidate, PaperState } from './paper.js';
export const ENTRY_STAGES=['traction','momentum','liquidity','sizing','eligible'] as const;
export type EntryStage=typeof ENTRY_STAGES[number];
export type EntryTrace=Partial<Record<EntryStage,{status:'PASS'|'FAIL';reason:string;at:string}>>;
export function entryStage(state:PaperState,candidate:Candidate,stage:EntryStage,passed:boolean,reason:string,now:number){
  if(state.config.PAPER_STRATEGY_VERSION!==5)return;
  (candidate.entryTrace??={})[stage]={status:passed?'PASS':'FAIL',reason,at:new Date(now).toISOString()};
}
export function rejectedEntryStage(state:PaperState,candidate:Candidate,reason:string,now:number){
  if(/TRACTION/.test(reason))entryStage(state,candidate,'traction',false,reason,now);
  if(/MOMENTUM|RESERVE_REVERSAL|RESERVE_WITHDRAWAL|PRICE_REVERSAL|SINGLE_SPIKE|PERSISTENCE|CONFIRMATION/.test(reason))entryStage(state,candidate,'momentum',false,reason,now);
  if(/LIQUIDITY|COVERAGE|PARTICIPATION|REAL_LIQUIDITY|PRICE_IMPACT/.test(reason))entryStage(state,candidate,'liquidity',false,reason,now);
  if(/SIZE|CAPACITY|EXPOSURE|CASH|RISK_BUDGET|GAP_RISK|ACCOUNT_TOO_SMALL/.test(reason))entryStage(state,candidate,'sizing',false,reason,now);
  entryStage(state,candidate,'eligible',false,reason,now);
}
/** Latest retained assessments, not lifetime counts or invented past gate results. */
export function entryFunnel(state:PaperState,now=Date.now()){
  const latest=new Map<string,PaperState['decisions'][number]>();
  for(const d of state.decisions)latest.set(d.candidate.launchId,d);
  const rows=[...latest.values()].filter(d=>d.candidate.eventMode==='LIVE' && d.candidate.launchTimestamp!==null &&
    now/1000-d.candidate.launchTimestamp>=0 && now/1000-d.candidate.launchTimestamp<=state.config.PAPER_MAX_LAUNCH_AGE_SECONDS);
  const traced=rows.filter(d=>d.candidate.entryTrace);
  const counts=Object.fromEntries(ENTRY_STAGES.map(stage=>[stage,traced.filter(d=>d.candidate.entryTrace?.[stage]?.status==='PASS').length])) as Record<EntryStage,number>;
  const blockers=rows.filter(d=>d.outcome!=='PAPER_ELIGIBLE').map(d=>({launchId:d.candidate.launchId,symbol:d.candidate.symbol,
    reason:d.reason,details:d.details,stages:d.candidate.entryTrace??null}));
  return {scope:'Latest retained LIVE launch assessments within the entry age window; stages not reached are untested, not passed.',
    discovered:rows.length,traced:traced.length,...counts,lastEligibleAt:state.lastEligiblePaperAt??null,
    timeSinceLastEligibleMs:state.lastEligiblePaperAt?Math.max(0,now-Date.parse(state.lastEligiblePaperAt)):null,blockers};
}
