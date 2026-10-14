// Explicit synthetic safety scenarios; not production profit or a fabricated market replay.
import {writeFile} from 'node:fs/promises';
import {v5EntryScenario} from '../dist/tests/v5-entry-flow-fixture.js';
import {entryFunnel} from '../dist/src/paper-entry-diagnostics.js';
const cases=[['HEALTHY',250,.010651],['HEALTHY',200,.01],['HEALTHY',1000,.01],['HEALTHY',100,.004],['SINGLE_SPIKE',200,.01],['FALLING',200,.01],['MISSING',200,.01],['THIN',200,.01],['GAS',200,.2],['HEALTHY',50,.01]],results=[];
for(const [mode,equity,gas] of cases){const {state,now,quoteCalls}=await v5EntryScenario(mode,equity,gas);const f=entryFunnel(state,now);
 results.push({mode,equity,gas,quoteCalls,stages:{discovered:f.discovered,traction:f.traction,momentum:f.momentum,liquidity:f.liquidity,sizing:f.sizing,eligible:f.eligible},positions:state.positions.length,reason:state.decisions.at(-1)?.reason,size:state.positions[0]?.sizeUsd??null,allInCost:state.positions[0]?.costBasisUsd??null,confirmationSpanMs:state.positions[0]?.plan.entryQuality?.confirmationSpanMs??null});
}
const totals=Object.fromEntries(['discovered','traction','momentum','liquidity','sizing','eligible'].map(stage=>[stage,results.reduce((n,r)=>n+r.stages[stage],0)]));
const report={syntheticSafetyValidation:true,futureObservationsUsed:false,conditions:'Chronological verified mock contract reads, production integer quotes and complete entry pipeline; 1% protocol fee and known positive gas. No seeded confirmation history. These are test fixtures, not real filled trades.',totals,results};
await writeFile(process.argv[2]??'reports/v5-entry-validation.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
