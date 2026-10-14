import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionResult, parseAbi, toFunctionSelector, type Hex } from "viem";
import { AGENTS } from "../src/simulation.js";
import { PONS_FACTORY, type LiveLaunchDecision, type LiveSnapshot, type RpcCaller } from "../src/live.js";
import { PONS_SELECTORS } from "../src/market.js";
import { readPaperQuote, type UsdRate } from "../src/paper-quotes.js";
const abi = parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)"]);
const word = (n: bigint | number | string): string => BigInt(n).toString(16).padStart(64, "0");
const data = (...n: (bigint | number | string)[]): Hex => `0x${n.map(word).join("")}`;
const token = `0x${"1".repeat(40)}`;
const curve = `0x${"2".repeat(40)}`;
const deployer = `0x${"3".repeat(40)}`;
const zero = `0x${"0".repeat(40)}`;
const eth = 10n ** 18n;

export function chronology(time: number) {
  return { launchBlock: 1, launchTimestamp: Math.floor(time / 1000), currentBlock: 2,
    currentTimestamp: Math.floor(time / 1000), tokenAgeSeconds: 0, firstBlockSeenByProcess: 2,
    eventMode: "LIVE" as const, launchBlockHash: `0x${"a".repeat(64)}`, currentBlockHash: `0x${"b".repeat(64)}`,
    recentTraction: { status: "VERIFIED" as const, progressChangeBps: 1, reserveChangeWei: "1", toTimestamp: Math.floor(time / 1000), lastVerifiedActivityTime: null, explanation: "TEST" } };
}
export function fixture() {
  const time = Date.now();
  const stamp = new Date(time).toISOString();
  const launch: LiveLaunchDecision = {
    chronology: chronology(time),
    token, curve, deployer, pairToken: zero, launchConfigId: "0", graduationThreshold: (2n * eth).toString(),
    blockNumber: 1, transactionHash: `0x${"a".repeat(64)}`, logIndex: 0, verdict: "WATCH", pairLabel: "ETH",
    market: { status: "VERIFIED", creatorFeeRecipient: deployer, creatorTaxBps: 100, buybackEnabled: false, phase: "CURVE",
      quoteReserve: (2n * eth).toString(), tokenReserve: (1_000_000n * eth).toString(), realQuoteReserve: eth.toString(),
      graduationThreshold: (2n * eth).toString(), progressBps: 5000, currentSnipeTaxBps: 0 },
    metadata: { status: "UNAVAILABLE", reason: "TEST" },
    assessment: { verdict: "WATCH", score: 100, reasons: [], blockers: [], unknowns: ["Social quality"] },
    handoffs: AGENTS.map((a, i) => ({ agent: a.name, role: a.role, sequence: i + 1, timestamp: stamp,
      outcome: ["RIO", "LISBON", "PALERMO", "PROFESSOR"].includes(a.name) ? "PASS" : "INFO", message: "TEST full live chain" })),
    deployerResearch: { windowBlocks: 100, priorLaunches: 0, priorGraduations: 0 }
  };
  const state = { reserve: 2n * eth, real: eth, sellable: 500_000n * eth, fee: 100n, creatorTax:100n, snipe: 0n,
    phase: 0, ready: false, graduated: false, decimals: 18, supply: 1_000_000_000n * eth as bigint | null, identity: token, fail: false, reorg: false,
    headBlock: 2, blockTime: Math.floor(time / 1000), headerReads: 0, chain: "0x1237", usd: { bid: 2000, ask: 2000, timestamp: stamp, source: "TEST ETH/USD" } as UsdRate };
  const methods: string[] = [];
  const rpc: RpcCaller = async (method, params) => {
    methods.push(method);
    if (state.fail) throw new Error("TEST RPC outage");
    if (method === "eth_chainId") return state.chain;
    if (method === "eth_blockNumber") return `0x${state.headBlock.toString(16)}`;
    if (method === "eth_getBlockByNumber") {
      state.headerReads++;
      return { number: `0x${state.headBlock.toString(16)}`, hash: `0x${(state.reorg && state.headerReads % 2 === 0 ? "c" : "b").repeat(64)}`, timestamp: `0x${state.blockTime.toString(16)}` };
    }
    assert.equal(method, "eth_call", "Only read-only calls are allowed");
    assert.equal(params?.[1], `0x${state.headBlock.toString(16)}`, "Every read is pinned");
    const call = params![0] as { data: Hex };
    const decoded = decodeFunctionData({ abi, data: call.data });
    const results = decoded.args[0].map(c => {
      const selector = c.callData.slice(0, 10);
      let result: Hex | undefined;
      if (selector === PONS_SELECTORS.getLaunchedToken) result = data(token, curve, deployer, deployer, zero, 2n * eth, 0, 0, state.creatorTax, 0, state.phase, 0, 0, 0, 1);
      if (selector === PONS_SELECTORS.getReserves) result = data(state.reserve, 1_000_000n * eth);
      if (selector === PONS_SELECTORS.realQuoteReserve) result = data(state.real);
      if (selector === PONS_SELECTORS.currentSnipeTaxBps) result = data(state.snipe);
      const reads: Record<string, bigint | number | string> = {
        "feeBps()": state.fee, "sellableTokens()": state.sellable, "graduated()": Number(state.graduated),
        "readyToGraduate()": Number(state.ready), "token()": state.identity, "factory()": PONS_FACTORY, "pairToken()": zero, "decimals()": state.decimals, ...(state.supply === null ? {} : { "totalSupply()": state.supply })
      };
      for (const [signature, value] of Object.entries(reads)) if (selector === toFunctionSelector(signature)) result = data(value);
      return { success: result !== undefined, returnData: result ?? "0x" as Hex };
    });
    return encodeFunctionResult({ abi, functionName: "aggregate3", result: results });
  };
  const snapshot: LiveSnapshot = { chainId: 4663, headBlock: 2, fetchedAt: stamp, source: "Robinhood Chain RPC", mode: "read-only", historyWindowBlocks: 100, launches: [launch] };
  const buy = (sizeUsd = 10) => readPaperQuote(rpc, async () => state.usd, launch, { side: "BUY", sizeUsd }, () => time);
  return { time, launch, state, rpc, buy, snapshot, methods };
}

