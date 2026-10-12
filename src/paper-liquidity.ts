import { parseUnits } from "viem";
import type { PaperConfig, PaperQuote, QuoteResult } from "./paper.js";

export interface LiquidityObservation {
  token: string; curve: string; block: number; blockHash: string; timestamp: string;
  observedAt: string; tokenUnits: string; sizeUsd?: number;
  realQuoteReserveWei: string; quoteReserveWei: string; tokenReserveRaw: string;
  curveProgressBps: number; creatorTaxBps: number; snipeTaxBps: number;
  positionExitWei: string; netSellWei: string; executableUsd: number | null;
  /** Net of known gas; absent on old saved observations, never inferred. */
  netExecutableUsd?: number | null;
  exitCoverageRatio: number; positionParticipation: number | null;
  sellResult: string;
}
export interface LiquiditySafety {
  reason: string | null; details: string[]; current: LiquidityObservation;
  behavior: "GROWING" | "STABLE" | "DECLINING" | "COLLAPSING" | "UNKNOWN";
  previousReserveWei: string | null; reserveChangePercent: number | null;
  observations: LiquidityObservation[];
  limits: { minRealReserveWei: string; minCoverageRatio: number; maxParticipationBps: number; count: number; minSpanMs: number; windowMs: number; maxDropPercent: number };
}
export function sellObservation(q: PaperQuote, sizeUsd?: number): LiquidityObservation | null {
  const e = q.evidence;
  if (!e || q.side !== "SELL" || q.tokenUnits !== e.amountIn) return null;
  try {
    const net = BigInt(e.amountOut), gross = net + BigInt(e.feeWei) + BigInt(e.creatorTaxWei), real = BigInt(e.realQuoteReserve);
    if (net <= 0n || gross <= 0n || real < 0n) return null;
    return { token: q.tokenAddress, curve: e.curve, block: q.blockNumber, blockHash: e.blockHash, timestamp: q.blockTimestamp,
      observedAt: q.timestamp, tokenUnits: q.tokenUnits!, ...(sizeUsd === undefined ? {} : { sizeUsd }),
      realQuoteReserveWei: real.toString(), quoteReserveWei: e.quoteReserve, tokenReserveRaw: e.tokenReserve,
      curveProgressBps: e.progressBps, creatorTaxBps: e.creatorTaxBps, snipeTaxBps: e.currentSnipeTaxBps ?? e.snipeTaxBps,
      positionExitWei: gross.toString(), netSellWei: net.toString(), executableUsd: gross <= real ? q.notionalUsd : null,
      netExecutableUsd: gross <= real && q.costs.gasUsd !== null ? q.notionalUsd-q.costs.gasUsd : null,
      exitCoverageRatio: Number(real) / Number(gross), positionParticipation: real === 0n ? null : Number(gross) / Number(real),
      sellResult: gross <= real ? "AVAILABLE" : "INSUFFICIENT_EXIT_LIQUIDITY" };
  } catch { return null; }
}
/** Only a calculator-validated, pinned liquidity rejection supplies failure reserve evidence. */
export function failedSellObservation(result: QuoteResult, token: string, curve: string, now: number, config: PaperConfig): LiquidityObservation | null {
  if (result.status !== "NOT_PAPER_TRADABLE" || result.reason !== "INSUFFICIENT_EXIT_LIQUIDITY") return null;
  const d = result.diagnostics, c = d?.calculation;
  const m = d?.market as { status?: string; quoteReserve?: string; tokenReserve?: string; progressBps?: number; creatorTaxBps?: number; currentSnipeTaxBps?: number } | undefined;
  if (!c || m?.status !== "VERIFIED" || d?.currentBlock === undefined || !d.blockTimestamp ||
      now - Date.parse(d.blockTimestamp) < 0 || now - Date.parse(d.blockTimestamp) > config.QUOTE_MAX_AGE_MS) return null;
  try {
    const gross = BigInt(c.grossWei!), real = BigInt(c.realQuoteReserveWei!);
    if (gross <= real || real < 0n) return null;
    return { token, curve, block: d.currentBlock, blockHash: "", timestamp: d.blockTimestamp,
      observedAt: d.completedAt ?? d.attemptedAt, tokenUnits: c.tokenUnits!, realQuoteReserveWei: real.toString(),
      quoteReserveWei: m.quoteReserve!, tokenReserveRaw: m.tokenReserve!, curveProgressBps: m.progressBps!,
      creatorTaxBps: m.creatorTaxBps!, snipeTaxBps: m.currentSnipeTaxBps!, positionExitWei: gross.toString(),
      netSellWei: c.ethOutWei!, executableUsd: null, exitCoverageRatio: Number(real) / Number(gross),
      positionParticipation: real === 0n ? null : Number(gross) / Number(real), sellResult: result.reason };
  } catch { return null; }
}
export function appendLiquidityObservation(history: LiquidityObservation[], current: LiquidityObservation, config: PaperConfig): LiquidityObservation[] {
  const cutoff = Date.parse(current.timestamp) - config.LIQUIDITY_OBSERVATION_WINDOW_MS;
  const rows = history.filter(o => o.token === current.token && o.curve === current.curve && Date.parse(o.timestamp) >= cutoff);
  const last = rows.at(-1);
  // Same block is never a new observation; conflicting hashes invalidate that observation window.
  if (last && current.block === last.block && current.blockHash !== last.blockHash) return [current];
  if (last && (current.block <= last.block || Date.parse(current.timestamp) <= Date.parse(last.timestamp))) return rows;
  return [...rows, current].slice(-100);
}
/** Exit requirement is GROSS: payout plus separately accrued fees consumes real free reserve. */
export function ExitLiquiditySafetyGate(current: LiquidityObservation, history: LiquidityObservation[], config: PaperConfig): LiquiditySafety {
  const real = BigInt(current.realQuoteReserveWei), gross = BigInt(current.positionExitWei);
  const limits = { minRealReserveWei: parseUnits(config.MIN_REAL_EXIT_RESERVE_ETH.toFixed(18), 18).toString(),
    minCoverageRatio: config.MIN_EXIT_COVERAGE_RATIO, maxParticipationBps: config.MAX_EXIT_PARTICIPATION_BPS,
    count: config.LIQUIDITY_OBSERVATION_COUNT, minSpanMs: config.LIQUIDITY_OBSERVATION_MIN_MS,
    windowMs: config.LIQUIDITY_OBSERVATION_WINDOW_MS, maxDropPercent: config.MAX_LIQUIDITY_DROP_PERCENT };
  const rows = history.filter(o => o.token === current.token && o.curve === current.curve && o.block <= current.block &&
    Date.parse(o.timestamp) <= Date.parse(current.timestamp) && Date.parse(current.timestamp) - Date.parse(o.timestamp) <= limits.windowMs);
  const previous = rows.filter(o => o.block < current.block).at(-1);
  const change = previous && BigInt(previous.realQuoteReserveWei) > 0n ? Number(real - BigInt(previous.realQuoteReserveWei)) / Number(previous.realQuoteReserveWei) * 100 : null;
  const first = rows[0], peak = rows.reduce((a, o) => BigInt(o.realQuoteReserveWei) > a ? BigInt(o.realQuoteReserveWei) : a, real);
  const drop = peak > 0n ? Number(peak - real) / Number(peak) * 100 : 0;
  const behavior: LiquiditySafety["behavior"] = !previous ? "UNKNOWN" : drop >= limits.maxDropPercent ? "COLLAPSING" :
    first && real > BigInt(first.realQuoteReserveWei) ? "GROWING" : first && real < BigInt(first.realQuoteReserveWei) ? "DECLINING" : "STABLE";
  const details = [`positionExitWei=${gross}; realQuoteReserveWei=${real}; coverageRatio=${current.exitCoverageRatio}; configuredMinimum=${limits.minCoverageRatio}; participation=${current.positionParticipation}; maxParticipationBps=${limits.maxParticipationBps}`,
    `previousReserveWei=${previous?.realQuoteReserveWei ?? "UNKNOWN"}; currentReserveWei=${real}; changePercent=${change ?? "UNKNOWN"}; peakReserveWei=${peak}; peakDropPercent=${drop}; maxDropPercent=${limits.maxDropPercent}`,
    `observations=${rows.length}; required=${limits.count}; spanMs=${first ? Date.parse(current.timestamp) - Date.parse(first.timestamp) : 0}; requiredSpanMs=${limits.minSpanMs}; minimumRealReserveWei=${limits.minRealReserveWei}`];
  let reason: string | null = null;
  if (current.sellResult !== "AVAILABLE" || gross > real) reason = "INSUFFICIENT_EXIT_LIQUIDITY";
  else if (real < BigInt(limits.minRealReserveWei)) reason = "REAL_LIQUIDITY_TOO_LOW";
  else if (real * 10000n < gross * BigInt(Math.round(limits.minCoverageRatio * 10000)) || gross * 10000n > real * BigInt(limits.maxParticipationBps)) reason = "EXIT_COVERAGE_TOO_LOW";
  else if (drop >= limits.maxDropPercent) reason = "LIQUIDITY_DERIORATING";
  else if (rows.length < limits.count || !first || Date.parse(current.timestamp) - Date.parse(first.timestamp) < limits.minSpanMs ||
      rows.at(-1)?.block !== current.block || rows.at(-1)?.blockHash !== current.blockHash || rows.some((o, i) => o.sellResult !== "AVAILABLE" || (i > 0 && (o.block <= rows[i-1]!.block || Date.parse(o.timestamp) <= Date.parse(rows[i-1]!.timestamp))))) reason = "LIQUIDITY_HISTORY_INSUFFICIENT";
  return { reason, details, current, behavior, previousReserveWei: previous?.realQuoteReserveWei ?? null, reserveChangePercent: change, observations: rows, limits };
}
