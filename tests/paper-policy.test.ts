import { enterPaper, preparePaperTrade } from "./liquidity-history-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {  PAPER_CONFIG, accountSummary, initialPaperState, isPaperTradeEligible, liveCandidate, markPaperPosition,
  monitorPaper, type PaperQuote, type PaperState, type QuoteResult  } from "../src/paper.js";
import { accountCapacity, evaluateExit, proposeTradePlan } from "../src/paper-policy.js";
import { PaperQuoteService, createEthUsdProvider, readPaperQuote } from "../src/paper-quotes.js";
import { PaperStore } from "../src/paper-store.js";
import { fixture } from "./paper-fixtures.js";

const available = (quote: PaperQuote): QuoteResult => ({ status: "AVAILABLE", quote });
const missing: QuoteResult = { status: "NOT_PAPER_TRADABLE", reason: "QUOTE_UNAVAILABLE", details: [] };
async function open(f = fixture(), s = initialPaperState(f.time)) {
  await preparePaperTrade(s, liveCandidate(f.launch), (_l, size) => f.buy(size), () => f.time);
  assert.equal(s.positions.length, 1);
  return { f, s, p: s.positions[0]! };
}
function sell(p: PaperState["positions"][number], multiplier: number, time = Date.parse(p.enteredAt)): PaperQuote {
  const q = structuredClone(p.entry);
  q.side = "SELL"; q.timestamp = new Date(time).toISOString(); q.blockTimestamp = q.timestamp;
  q.notionalUsd = p.costBasisUsd * multiplier; q.fillPriceUsd = q.notionalUsd / q.quantity;
  q.costs.gasUsd = null;
  if (q.evidence) { q.evidence.usdTimestamp = q.timestamp; q.evidence.snipeTaxBps = 0; q.evidence.amountIn = q.tokenUnits!; q.evidence.amountOut = String(BigInt(Math.round(q.notionalUsd / q.evidence.ethUsd * 1e18))); }
  return q;
}

test("different verified score/progress/taxes yield different sizes, risk budgets and exit policies", async () => {
  const good = fixture(), weaker = fixture();
  weaker.launch.assessment.score = 70; weaker.state.usd.bid = 200; weaker.state.usd.ask = 200; weaker.state.snipe = 50n;
  const a = await open(good), b = await open(weaker);
  assert.notEqual(a.p.sizeUsd, b.p.sizeUsd);
  assert.notEqual(a.p.plan.riskBudgetUsd, b.p.plan.riskBudgetUsd);
  assert.notEqual(a.p.plan.exitPolicy.downsidePercent, b.p.plan.exitPolicy.downsidePercent);
  assert.notEqual(a.p.plan.exitPolicy.profitArmPercent, b.p.plan.exitPolicy.profitArmPercent);
  assert.notEqual(a.p.plan.exitPolicy.trailingDrawdownPercent, b.p.plan.exitPolicy.trailingDrawdownPercent);
  assert.notEqual(a.p.plan.exitPolicy.maxHoldMs, b.p.plan.exitPolicy.maxHoldMs);
  assert.ok(b.p.sizeUsd < a.p.sizeUsd);
  assert.equal(a.p.plan.gptheistVerdict, "WATCH"); assert.equal(a.p.candidate.launch!.verdict, "WATCH");
  assert.equal(a.p.plan.paperVerdict, "PAPER_ELIGIBLE");
});

test("sizing scales with account equity instead of a fixed dollar trade", async () => {
  const f = fixture(); f.state.fee = 0n;
  const a = await open(f, initialPaperState(f.time, { ...PAPER_CONFIG, STARTING_BALANCE_USD: 1000 }));
  const b = await open(f, initialPaperState(f.time, { ...PAPER_CONFIG, STARTING_BALANCE_USD: 2000 }));
  assert.ok(b.p.sizeUsd > a.p.sizeUsd);
  assert.ok(a.p.sizeUsd <= 20); assert.ok(b.p.sizeUsd <= 40);
  assert.equal(a.s.cash, 1000 - a.p.plan.approvedSizeUsd);
  assert.equal(b.s.cash, 2000 - b.p.plan.approvedSizeUsd);
});

test("sizer reduces and requotes excessive measured impact; minimum size can reject", async () => {
  const f = fixture(), s = initialPaperState(f.time), requested: number[] = [];
  await preparePaperTrade(s, liveCandidate(f.launch), async (_l, size) => {
    requested.push(size);
    const result = await f.buy(size);
    if (result.status === "AVAILABLE") result.quote.costs.priceImpactPercent = size / 2;
    return result;
  }, () => f.time);
  assert.equal(s.positions.length, 1); assert.ok(s.positions[0]!.sizeUsd <= 6);
  assert.ok(requested.some((n, i) => i > 0 && n < requested[i - 1]!));
  assert.ok(s.positions[0]!.plan.sizingAttempts.some(a => a.outcome === "PRICE_IMPACT_LIMIT"));
  const blocked = initialPaperState(f.time);
  await preparePaperTrade(blocked, liveCandidate(f.launch), async (_l, size) => {
    const q = await f.buy(size); if (q.status === "AVAILABLE") q.quote.costs.priceImpactPercent = 50; return q;
  }, () => f.time);
  assert.equal(blocked.positions.length, 0); assert.equal(blocked.decisions.at(-1)!.reason, "SIZE_NOT_EXECUTABLE");
});

test("portfolio exposure, cash reserve, per-position caps and known gas constrain entry", async () => {
  const f = fixture(), s = initialPaperState(f.time);
  s.config.MAX_PORTFOLIO_EXPOSURE_PERCENT = .5;
  const a = await open(f, s); assert.ok(a.p.sizeUsd <= 10);
  assert.ok(accountCapacity(s).availableCapacityUsd < s.config.MIN_POSITION_USD);
  const c = liveCandidate(f.launch); c.tokenAddress = `0x${"4".repeat(40)}`; c.launchId = "another";
  c.quote = await f.buy(10);
  if (c.quote.status === "AVAILABLE") c.quote.quote.tokenAddress = c.tokenAddress;
  assert.equal(isPaperTradeEligible(c, s, 10, f.time).reason, "MAX_PORTFOLIO_EXPOSURE");
  const cashState = initialPaperState(f.time); cashState.config.MIN_CASH_RESERVE_PERCENT = 99.5;
  const cash = await open(f, cashState); assert.ok(cash.p.sizeUsd <= 5);
  const q = await f.buy(21); const over = liveCandidate(f.launch); over.quote = q;
  assert.equal(isPaperTradeEligible(over, initialPaperState(f.time), 21, f.time).reason, "MAX_POSITION_EXPOSURE");
  const gas = liveCandidate(f.launch); gas.quote = await f.buy(10);
  if (gas.quote.status === "AVAILABLE") gas.quote.quote.costs.gasUsd = 1001;
  // Gas now counts toward cost-basis exposure, which is checked before cash.
  assert.equal(isPaperTradeEligible(gas, initialPaperState(f.time), 10, f.time).reason, "MAX_POSITION_EXPOSURE");
});

test("new entries are denied for VETO, unsupported pairs, duplicates, max positions and daily loss", async () => {
  const { f, s, p } = await open();
  const c = liveCandidate(f.launch); c.quote = await f.buy(p.sizeUsd);
  assert.equal(isPaperTradeEligible(c, s, p.sizeUsd, f.time).reason, "DUPLICATE_POSITION");
  const empty = initialPaperState(f.time);
  c.decision = "VETO"; assert.equal(isPaperTradeEligible(c, empty, p.sizeUsd, f.time).outcome, "VETO");
  c.decision = "WATCH"; c.launch!.pairToken = f.launch.token;
  assert.equal(isPaperTradeEligible(c, empty, p.sizeUsd, f.time).reason, "UNSUPPORTED_PAIR");
  c.launch!.pairToken = `0x${"0".repeat(40)}`;
  const other = structuredClone(c); other.tokenAddress = `0x${"5".repeat(40)}`; other.launchId = "other";
  if (other.quote.status === "AVAILABLE") other.quote.quote.tokenAddress = other.tokenAddress;
  s.config.MAX_OPEN_POSITIONS = 1;
  assert.equal(isPaperTradeEligible(other, s, p.sizeUsd, f.time).reason, "MAX_OPEN_POSITIONS");
  s.config.MAX_DAILY_LOSS_USD = .01;
  await monitorPaper(s, async () => available(sell(p, .5)), () => f.time);
  assert.equal(isPaperTradeEligible(other, s, p.sizeUsd, f.time).reason, "DAILY_LOSS_LIMIT");
});

test("planning and final entry each request a fresh quote; final failure or price change never fills", async () => {
  for (const finalFailure of [true, false]) {
    const f = fixture(), s = initialPaperState(f.time); let calls = 0;
    await preparePaperTrade(s, liveCandidate(f.launch), async (_l, size) => {
      calls++;
      if (calls >= 3 && finalFailure) return missing;
      const q = await f.buy(size);
      if (calls >= 3 && q.status === "AVAILABLE") q.quote.costs.priceImpactPercent = 20;
      return q;
    }, () => f.time);
    assert.ok(calls >= 3); assert.equal(s.positions.length, 0); assert.equal(s.cash, 1000);
  }
});

test("peak and trailing protection use sell liquidation values and a separate final quote", async () => {
  const { f, s, p } = await open();
  let calls = 0;
  await monitorPaper(s, async () => { calls++; return available(sell(p, 1.5)); }, () => f.time);
  assert.equal(calls, 1); assert.equal(s.positions.length, 1);
  assert.equal(p.management.peakLiquidationValueUsd, p.costBasisUsd * 1.5);
  assert.equal(p.management.peakReturnPercent, 50);
  assert.equal(p.management.peakTimestamp, p.entry.timestamp);
  await monitorPaper(s, async () => { calls++; return available(sell(p, calls === 2 ? 1.3 : 1.25)); }, () => f.time);
  assert.equal(calls, 3); assert.equal(s.positions.length, 0);
  assert.equal(s.trades[0]!.exitReason, "TRAILING_EXIT");
  assert.equal(s.trades[0]!.exit.notionalUsd, p.costBasisUsd * 1.25);
  assert.ok(Math.abs(s.trades[0]!.pnlUsd - p.costBasisUsd * .25) < 1e-8);
  assert.ok(Math.abs(accountSummary(s).equity - (1000 + p.costBasisUsd * .25)) < 1e-8);
});

test("failed final sell quote leaves a pending exit and last successful valuation; retry closes with fresh value", async () => {
  const { f, s, p } = await open(); let count = 0;
  await monitorPaper(s, async () => ++count === 1 ? available(sell(p, .7)) : missing, () => f.time);
  assert.equal(count, 2); assert.equal(s.positions.length, 1); assert.equal(s.trades.length, 0);
  assert.equal(p.current.notionalUsd, p.costBasisUsd * .7);
  assert.equal(p.management.pendingExit?.reason, "DYNAMIC_RISK_EXIT");
  assert.equal(p.management.quoteFailureCount, 1);
  assert.equal(p.management.lastSuccessfulQuote!.notionalUsd, p.costBasisUsd * .7);
  await monitorPaper(s, async () => missing, () => f.time);
  assert.equal(p.management.quoteFailureCount, 2); assert.equal(s.positions.length, 1);
  await monitorPaper(s, async () => available(sell(p, .8)), () => f.time);
  assert.equal(s.positions.length, 0); assert.equal(s.trades[0]!.exit.notionalUsd, p.costBasisUsd * .8);
});

for (const reason of ["MAX_HOLD_EXIT", "PROFIT_PROTECTION", "SIGNAL_DETERIORATION", "TAX_CHANGE", "LIQUIDITY_OR_QUOTE_DETERIORATION", "GRADUATION_TRANSITION"] as const) {
  test(`dynamic ${reason} only uses its persisted policy and actual quote inputs`, async () => {
    const { f, s, p } = await open(); const q = sell(p, 1.1);
    if (reason === "PROFIT_PROTECTION") { markPaperPosition(s, p.id, available(sell(p, 1.5)), f.time); q.notionalUsd = p.costBasisUsd * 1.05; q.fillPriceUsd = q.notionalUsd / p.quantity; }
    if (reason === "SIGNAL_DETERIORATION") q.evidence!.realQuoteReserve = (BigInt(p.entry.evidence!.realQuoteReserve) / 2n).toString();
    if (reason === "TAX_CHANGE") q.evidence!.creatorTaxBps += p.plan.exitPolicy.taxIncreaseBps;
    if (reason === "LIQUIDITY_OR_QUOTE_DETERIORATION") q.costs.priceImpactPercent = p.plan.exitPolicy.maxExitImpactPercent + 1;
    if (reason === "GRADUATION_TRANSITION") q.evidence!.progressBps = 9999;
    markPaperPosition(s, p.id, available(q), f.time);
    assert.equal(evaluateExit(p, reason === "MAX_HOLD_EXIT" ? f.time + p.plan.exitPolicy.maxHoldMs : f.time)?.reason, reason);
  });
}

test("graduation and missing sell liquidity retain position without a fictional sale", async () => {
  const { f, s, p } = await open();
  f.state.phase = 2;
  await monitorPaper(s, position => readPaperQuote(f.rpc, async () => f.state.usd, f.launch,
    { side: "SELL", tokenUnits: position.entry.tokenUnits!, quantity: position.quantity }, () => f.time), () => f.time);
  assert.equal(s.positions.length, 1); assert.equal(s.trades.length, 0);
  assert.equal(p.markReason, "TOKEN_GRADUATED"); assert.ok(p.current.notionalUsd > 0);
});

test("ETH/USD unavailable, stale, and malformed are precise failures; age is configurable", async () => {
  const f = fixture();
  const missingUsd = createEthUsdProvider((async () => { throw new Error("offline"); }) as typeof fetch);
  const fail = await readPaperQuote(f.rpc, missingUsd, f.launch, { side: "BUY", sizeUsd: 10 }, () => f.time);
  assert.equal(fail.status === "NOT_PAPER_TRADABLE" && fail.reason, "ETH_USD_UNAVAILABLE");
  const stale = createEthUsdProvider((async () => new Response(JSON.stringify({ bid: "2000", ask: "2001", time: new Date(f.time - 5000).toISOString() }))) as typeof fetch, () => f.time, 1000);
  await assert.rejects(stale(), /ETH_USD_STALE/);
  const longer = createEthUsdProvider((async () => new Response(JSON.stringify({ bid: "2000", ask: "2001", time: new Date(f.time - 5000).toISOString() }))) as typeof fetch, () => f.time, 10000);
  assert.equal((await longer()).ask, 2001);
  const invalid = createEthUsdProvider((async () => new Response(JSON.stringify({ bid: true, ask: true, time: f.state.usd.timestamp }))) as typeof fetch);
  await assert.rejects(invalid(), /ETH_USD_UNAVAILABLE/);
});

test("source health is independent of research; LIVE expires and failures degrade it", async () => {
  const f = fixture(); let now = f.time, fail = false;
  const service = new PaperQuoteService(f.rpc, PAPER_CONFIG, (async () => {
    if (fail) throw new Error("offline");
    return new Response(JSON.stringify({ bid: "2000", ask: "2000", time: f.state.usd.timestamp }));
  }) as typeof fetch, () => now);
  assert.equal(service.status().status, "DEGRADED");
  assert.ok(service.status().degradationReasons.includes('NO_VERIFIED_QUOTE'));
  await service.refreshUsd(); assert.equal(service.status().ethUsd.status, "LIVE"); assert.equal(service.status().status, "DEGRADED");
  await service.buy(f.launch, 10); assert.equal(service.status().status, "LIVE");
  now += 31_000; assert.equal(service.status().status, "DEGRADED"); assert.equal(service.status().ethUsd.status, "ETH_USD_STALE");
  assert.equal(service.status().quoteAgeMs,31000);assert.ok(service.status().degradationReasons.includes('ETH_USD_STALE'));
  fail = true; await service.refreshUsd(); assert.equal(service.status().ethUsd.status, "ETH_USD_UNAVAILABLE");
});

test("persistence preserves plans, reasoning, peaks and pending exits; old accounts migrate without reset", async () => {
  const { f, s, p } = await open();
  markPaperPosition(s, p.id, available(sell(p, 1.2)), f.time);
  const dir = await mkdtemp(join(tmpdir(), "paper-plan-")); let store = await PaperStore.open(dir);
  await store.update(state => { Object.assign(state, s); }); await store.close(); store = await PaperStore.open(dir);
  assert.deepEqual(store.read().positions[0]!.plan, p.plan);
  assert.deepEqual(store.read().positions[0]!.management, p.management); await store.close();
  const legacy = JSON.parse(JSON.stringify(s)); legacy.schemaVersion = 1;
  delete legacy.positions[0].plan; delete legacy.positions[0].management;
  legacy.config.MAX_POSITION_USD = 10; legacy.config.STOP_LOSS_PERCENT = -10; legacy.config.TAKE_PROFIT_PERCENT = 20;
  await writeFile(join(dir, "state.json"), JSON.stringify(legacy));
  store = await PaperStore.open(dir);
  assert.equal(store.read().schemaVersion, 2); assert.equal(store.read().cash, s.cash);
  assert.equal(store.read().positions[0]!.quantity, p.quantity);
  assert.ok((await readdir(dir)).some(n => n.startsWith("schema-v1-backup-")));
  assert.ok((await readFile(join(dir, "state.json"), "utf8")).includes("Migrated historical position"));
  await store.close();
});

test("optional gas/slippage stay unknown and reasons are deduplicated", async () => {
  const { f, s, p } = await open(); assert.equal(p.entry.costs.gasUsd, null); assert.equal(p.entry.costs.slippageUsd, null);
  const c = liveCandidate(f.launch); c.quote = { status: "NOT_PAPER_TRADABLE", reason: "QUOTE_UNAVAILABLE", details: ["QUOTE_UNAVAILABLE", "offline", "offline"] };
  enterPaper(s, c, 1, f.time);
  assert.deepEqual(s.decisions.at(-1)!.details, ["offline"]);
  const fresh = await f.buy(10); assert.equal(fresh.status, "AVAILABLE");
  if (fresh.status === "AVAILABLE") assert.ok(proposeTradePlan(initialPaperState(f.time), c, fresh.quote, f.time).approvedSizeUsd === 0);
});
