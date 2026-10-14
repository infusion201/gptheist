"""Read-only frozen local evidence audit. Does not open the account writer or invent quotes."""
import json,collections,datetime,sys
from pathlib import Path
root=Path(sys.argv[1] if len(sys.argv)>1 else '/tmp/gptheist-entry-evidence')
state=json.loads((root/'state.json').read_text()); parse=lambda s:datetime.datetime.fromisoformat(s.replace('Z','+00:00'))
end=parse(state['lastSnapshotAt']);start=end-datetime.timedelta(hours=39)
reasons=collections.Counter();traction=collections.Counter();coins=set();decisions=0

def record(d):
 global decisions
 if not start<=parse(d['timestamp'])<=end:return
 decisions+=1;reasons[d['reason']]+=1;coins.add(d['candidate']['launchId'])
 diag=d['candidate'].get('tractionDiagnostics')
 if diag:traction['passed' if diag['tractionPass'] else diag.get('exactFailureReason') or 'unknown']+=1

for d in state['decisions']:record(d)
files=0
for path in Path('runs/paper').glob('audit-archive-*.json'):
 stamp=int(path.name.split('-')[2]);t=datetime.datetime.fromtimestamp(stamp/1000,datetime.timezone.utc)
 if start<=t<=end:
  data=json.loads(path.read_text());files+=1
  for d in data.get('decisions',[]):record(d)
frames=buys=available=mismatch=0;fees=collections.Counter();gases=[];friction=[];first_frame=last_frame=None
for line in (root/'market.jsonl').open():
 f=json.loads(line);frames+=1
 if first_frame is None:first_frame=f['completedAt']
 last_frame=f['completedAt']
 for b in f['buys']:
  buys+=1
  if b['result']['status']!='AVAILABLE':continue
  available+=1;q=b['result']['quote'];s=q.get('roundTrip',{}).get('sell')
  if s and q['blockNumber']!=s['blockNumber']:mismatch+=1
  e=q.get('evidence',{});fees[f"{e.get('feeBps')}/{e.get('creatorTaxBps')}"]+=1
  gas=q['costs']['gasUsd']
  if gas is not None:gases.append(gas)
  if s and gas is not None and s['costs']['gasUsd'] is not None:friction.append((1-(s['notionalUsd']-s['costs']['gasUsd'])/(q['notionalUsd']+gas))*100)
report=dict(provenance='Frozen local files; not a verified Railway production export. The owner-reported old daily trade rate is not validated by this tape.',snapshotAt=state['lastSnapshotAt'],windowStart=start.isoformat(),archivesRead=files,decisionOccurrences=decisions,distinctLaunches=len(coins),reasons=dict(reasons),traction=dict(traction),frames=frames,firstFrameAt=first_frame,lastFrameAt=last_frame,buyQuoteRequests=buys,available=available,buySellBlockMismatches=mismatch,protocolCreatorFeesBps=dict(fees),entryGasRangeUsd=[min(gases),max(gases)] if gases else None,recordedFrictionRangePercent=[min(friction),max(friction)] if friction else None,
 currentAccount=dict(cash=state['cash'],positions=len(state['positions']),residentTrades=len(state['trades']),minimumNotional=state['config']['MIN_POSITION_USD'],equityExposureCap=state['cash']*2/100),
 interpretation='Quote friction from mismatched blocks is descriptive only, not verified same-block cost or replay profit. Duplicate decision occurrences from repeated scans are not unique candidates. No alternate-sized or pinned historical sell quote was invented.')
Path('reports/v5-entry-evidence.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
