import { getPaperStrategy } from "./paper-strategy.js";
import { quoteProblem, type ClosedTrade, type PaperState } from "./paper.js";
/** Descriptive statistics only. Unknown excursion history is never synthesized. */
export function researchMetrics(state: PaperState, now = Date.now()) {
  const strategy = getPaperStrategy(state.config);
  const trades = state.trades;
  const fills = [...state.positions.map(p => p.entry), ...trades.flatMap(t => [t.entry, t.exit])];
  const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const returns = trades.map(t => t.returnPercent).sort((a, b) => a - b);
  const group = (key: (t: ClosedTrade) => string) => {
    const buckets: Record<string, { trades: number; realizedPnlUsd: number; wins: number }> = {};
    for (const t of trades) {
      const b = buckets[key(t)] ??= { trades: 0, realizedPnlUsd: 0, wins: 0 };
      b.trades++; b.realizedPnlUsd += t.pnlUsd; if (t.pnlUsd > 0) b.wins++;
    }
    return buckets;
  };
  const cohort = trades.filter(t => t.plan.strategyVersion === strategy.version);
  const open = state.positions.filter(p=>p.plan.strategyVersion===strategy.version);
  const unavailableOpen = open.filter(p=>p.markStatus!=="FRESH" || p.current.side!=="SELL" ||
    quoteProblem(p.current,now,state.config.QUOTE_MAX_AGE_MS,state.config.ETH_USD_MAX_AGE_MS));
  const openUnrealizedPnlUsd = unavailableOpen.length ? null : open.reduce((sum,p)=>sum+p.current.notionalUsd-(p.current.costs.gasUsd??0)-p.costBasisUsd,0);
  const archived=state.archivedStrategyStats?.[String(strategy.version)];
  const cohortCount=cohort.length+(archived?.trades??0);
  const wins = cohort.filter(t => t.pnlUsd > 0).length+(archived?.wins??0);
  const netPnlUsd = cohort.reduce((sum,t)=>sum+t.pnlUsd,0)+(archived?.grossProfit??0)-(archived?.grossLoss??0);
  const grossLoss = -cohort.filter(t=>t.pnlUsd<0).reduce((sum,t)=>sum+t.pnlUsd,0)+(archived?.grossLoss??0);
  const grossProfit = cohort.filter(t=>t.pnlUsd>0).reduce((sum,t)=>sum+t.pnlUsd,0)+(archived?.grossProfit??0);
  const winRatePercent = cohortCount ? wins/cohortCount*100 : null;
  return {
    strategyValidation: { version: strategy.version, targetWinRatePercent: strategy.targetWinRatePercent,
      minimumTrades: strategy.minimumValidationTrades, closedTrades: cohortCount, wins, winRatePercent, netPnlUsd,
      profitFactor: grossLoss > 0 ? grossProfit/grossLoss : null,
      openPositions: open.length, unavailableOpenPositions: unavailableOpen.length, openUnrealizedPnlUsd,
      netLiquidationPnlUsd: openUnrealizedPnlUsd === null ? null : netPnlUsd+openUnrealizedPnlUsd,
      status: cohortCount < strategy.minimumValidationTrades ? "COLLECTING_EVIDENCE" :
        unavailableOpen.length ? "UNVERIFIED_OPEN_EXPOSURE" :
        winRatePercent! >= strategy.targetWinRatePercent && netPnlUsd > 0 && netPnlUsd+openUnrealizedPnlUsd! > 0 &&
          (strategy.version !== 5 || (grossLoss > 0 && grossProfit/grossLoss >= 2)) ? "TARGET_MET" : "BELOW_TARGET" },
    knownTaxesUsd: fills.reduce((sum, q) => sum + (q.evidence ? (Number(q.evidence.creatorTaxWei) + Number(q.evidence.snipeTaxWei)) / 1e18 * q.evidence.ethUsd : 0), 0),
    unknownTaxFills: fills.filter(q => !q.evidence).length,
    totalOpportunities: state.researchLedger ? Object.keys(state.researchLedger).length : null,
    rejectedOpportunities: state.researchLedger ? Object.values(state.researchLedger).filter(o => !o.traded && o.lastResult !== null && o.lastOutcome !== "OBSERVING").length : null,
    opportunityCoverage: "Since research ledger activation; older archived decisions require offline reconstruction",
    // Active-window counts explicitly labeled; the archive retains lifetime opportunities.
    retainedOpportunities: new Set(state.decisions.map(d => d.candidate.launchId)).size,
    retainedRejectedOpportunities: new Set(state.decisions.filter(d => d.outcome !== "PAPER_ELIGIBLE").map(d => d.candidate.launchId)).size,
    distributionCoverage: "Recent resident closed trades; full evidence available in persisted history",
    medianReturnPercent: returns.length ? (returns[Math.floor((returns.length - 1) / 2)]! + returns[Math.floor(returns.length / 2)]!) / 2 : null,
    bestTradePercent: returns.at(-1) ?? null, worstTradePercent: returns[0] ?? null,
    meanMfePercent: mean(trades.flatMap(t => t.management.mfePercent === undefined ? [] : [t.management.mfePercent])),
    meanMaePercent: mean(trades.flatMap(t => t.management.maePercent === undefined ? [] : [t.management.maePercent])),
    meanMfeCaptureRatio: mean(trades.flatMap(t => (t.management.mfePercent ?? 0) > 0 ? [t.returnPercent / t.management.mfePercent!] : [])),
    groups: {
      palermo: group(t => t.plan.inputs.palermoScore === null ? "UNKNOWN" : `${Math.floor(t.plan.inputs.palermoScore / 10) * 10}-${Math.floor(t.plan.inputs.palermoScore / 10) * 10 + 9}`),
      risk: group(t => t.plan.riskClass),
      curveProgress: group(t => t.entry.evidence ? `${Math.floor(t.entry.evidence.progressBps / 2500) * 25}-${Math.floor(t.entry.evidence.progressBps / 2500) * 25 + 25}%` : "UNKNOWN"),
      launchAge: group(t => t.candidate.tokenAgeSeconds === null ? "UNKNOWN" : t.candidate.tokenAgeSeconds < 60 ? "<60s" : t.candidate.tokenAgeSeconds < 180 ? "60-179s" : "180s+"),
      traction: group(t => t.candidate.recentTraction?.status ?? "UNKNOWN"), exitReason: group(t => t.exitReason)
    }
  };
}
