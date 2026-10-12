"""Read-only audit of retained trades; never opens the paper account writer."""
import argparse
import collections
import json
from datetime import datetime
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--input', default='runs/paper')
parser.add_argument('--output', default='reports/v5-loss-audit.json')
parser.add_argument('--archive-cache', help='Optional read-only trade list from an already completed archive scan')
args = parser.parse_args()
root, output = Path(args.input).resolve(), Path(args.output).resolve()
if output == root or root in output.parents:
    raise SystemExit('Report must be outside account storage')
state = json.loads((root / 'state.json').read_text())
trades = {t['id']: t for t in state['trades']}
archives = len(list(root.glob('audit-archive*.json')))
paths = [] if args.archive_cache else sorted(root.glob('audit-archive*.json'))
for path in paths:
    record = json.loads(path.read_text())
    for trade in record.get('trades', []):
        if trade['id'] in trades and trades[trade['id']] != trade:
            raise SystemExit('Conflicting saved trade ID: ' + trade['id'])
        trades[trade['id']] = trade
if args.archive_cache:
    for trade in json.loads(Path(args.archive_cache).read_text()):
        trades[trade['id']] = trade
supplemental=[]
for path in sorted(root.parent.rglob('*.json')):
    if root in path.parents:
        continue
    record=json.loads(path.read_text())
    if not isinstance(record,dict):
        continue
    full=[t for t in record.get('trades',[]) if isinstance(t,dict) and
          all(k in t for k in ['id','entry','exit','pnlUsd','plan','candidate','enteredAt','returnPercent','symbol','exitReason'])]
    if full:
        supplemental.append(str(path))
    for trade in full:
        if trade['id'] in trades:
            old=trades[trade['id']]
            if any(old.get(k)!=trade.get(k) for k in ['pnlUsd','returnPercent','enteredAt']):
                raise SystemExit('Conflicting saved financial result: '+trade['id'])
        else:
            trades[trade['id']]=trade

def metrics(rows):
    wins = [t['pnlUsd'] for t in rows if t['pnlUsd'] > 0]
    losses = [-t['pnlUsd'] for t in rows if t['pnlUsd'] < 0]
    return dict(trades=len(rows), wins=len(wins), losses=len(losses),
        winRatePercent=100*len(wins)/len(rows) if rows else None,
        profitFactor=sum(wins)/sum(losses) if losses else None,
        averageWinUsd=sum(wins)/len(wins) if wins else None,
        averageLossUsd=sum(losses)/len(losses) if losses else None,
        worstLossUsd=-max(losses) if losses else None,
        worstReturnPercent=min((t['returnPercent'] for t in rows), default=None),
        netPnlUsd=sum(t['pnlUsd'] for t in rows), maxAccountDrawdown=None)

losses = []
def sell_evidence(q, units):
    if not q:
        return None
    e=q.get('evidence')
    return dict(source=q.get('source'), side=q.get('side'),
        fullPosition=q.get('tokenUnits') == units if units else None,
        gasKnown=q.get('costs',{}).get('gasUsd') is not None,
        grossFitsRealReserve=(int(e['amountOut'])+int(e['feeWei'])+int(e['creatorTaxWei']) <= int(e['realQuoteReserve'])) if e else None,
        realReserveSharePercent=int(e['realQuoteReserve'])/int(e['quoteReserve'])*100 if e and int(e['quoteReserve']) else None,
        postMigration=q.get('v4') is not None)
for t in sorted(trades.values(), key=lambda t: t['enteredAt']):
    if t['pnlUsd'] >= 0:
        continue
    c, entry, exit = t['candidate'], t['entry'], t['exit']
    traction = (c.get('tractionDiagnostics') or {}).get('observations', [])
    entered=datetime.fromisoformat(t['enteredAt'].replace('Z','+00:00'))
    reserves = [int(r['reserve']) for r in traction if r.get('verificationStatus') == 'VERIFIED' and r.get('reserve') and
                datetime.fromisoformat(r['timestamp'].replace('Z','+00:00')) <= entered]
    e, x = entry.get('evidence'), exit.get('evidence')
    roundtrip = (entry.get('roundTrip') or {}).get('sell')
    losses.append(dict(id=t['id'], symbol=t['symbol'], strategyVersion=t['plan'].get('strategyVersion'),
        enteredAt=t['enteredAt'], returnPercent=t['returnPercent'], pnlUsd=t['pnlUsd'],
        overTenPercent=t['returnPercent'] < -10, entryReason=t['plan'].get('reasoning'),
        entryInputs=t['plan'].get('inputs'), verifiedPreEntryObservations=len(reserves),
        preEntryReserveFalling=(reserves[-1] < reserves[-2]) if len(reserves) >= 2 else None,
        pressureWeakening=None, priceSpikeBeforeEntry=None,
        preEntryFullSellRecorded=roundtrip is not None,
        preEntrySellEvidence=sell_evidence(roundtrip,entry.get('tokenUnits')),
        exitSellEvidence=sell_evidence(exit,entry.get('tokenUnits')),
        preEntrySellAgeMs=(entered-datetime.fromisoformat(roundtrip['timestamp'].replace('Z','+00:00'))).total_seconds()*1000 if roundtrip else None,
        entryRealReserve=e.get('realQuoteReserve') if e else None,
        exitRealReserve=x.get('realQuoteReserve') if x else None,
        entryToExitReserveChangePercent=(int(x['realQuoteReserve'])/int(e['realQuoteReserve'])-1)*100 if e and x and int(e['realQuoteReserve']) else None,
        exitReason=t['exitReason'], exitReasoning=t.get('exitReasoning'),
        quoteFailures=t.get('management', {}).get('quoteFailureCount'),
        missingEvidence='Price path, buy/sell flow and reaction delay cannot be inferred from entry/exit endpoints. Reserve decline over the hold does not establish its cause.'))
report = dict(source=str(root), accountCreatedAt=state['createdAt'], snapshotAt=state.get('lastSnapshotAt'),
    archivesScanned=archives, provenance='Local retained files; not a verified Railway production export. Orphan archives included and IDs deduplicated; no account history rewritten.',
    supplementalSources=supplemental,
    cohorts={str(v): metrics([t for t in trades.values() if t['plan'].get('strategyVersion',0) == v])
             for v in sorted({t['plan'].get('strategyVersion', 0) for t in trades.values()})},
    v5=metrics([t for t in trades.values() if t['plan'].get('strategyVersion') == 5]),
    openPositions=len(state['positions']), losingTrades=losses,
    exitReasons=dict(collections.Counter(t['exitReason'] for t in trades.values() if t['pnlUsd'] < 0)),
    causalityWarning='Saved observations describe outcomes, not proof of causation. Unknown data stays null. Historical cohort metrics describe saved accounting, not newly verified executable fills; legacy fills can fail present liquidity checks.')
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k != 'losingTrades'}, indent=2))
