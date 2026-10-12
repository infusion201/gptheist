# Local V5 improvements — 12 October 2026

One existing V5 was updated locally. No deployment, restart of the existing monitor, account reset, history deletion, commit, push, wallet, signing or real trade was performed. V4 strategy thresholds, trade plans and exit rules were not changed. Shared quote diagnostics, optional observation metadata and memory pressure thresholds also serve the existing infrastructure.

## Changes and reasons

- V5 entry now needs three spaced, pinned ETH/token price observations with positive growth across both intervals. A single jump cannot satisfy this rule. All intervening saved samples are checked for price reversals and real ETH reserve withdrawals. Historical observations can have different position sizes; momentum uses the pinned reserve ratio, not their dollar proceeds. These observations measure reserve and price persistence, not a verified count of buy transactions.
- The buy and full-position round-trip sell must use the same block and block hash. Existing full-quantity, quote-age, coverage, participation, real reserve, impact and trading-cost checks remain in place.
- The existing adaptive profit system now gives the wider trail only after three recent observations of rising full-position sell proceeds after known gas costs, with stable/growing real reserves. Old observations without net proceeds cannot be assumed healthy. Weak momentum uses the existing tighter trail. No fixed profit target was raised.
- A V5 quote with unknown gas cannot mark or close a position. It leaves cash and the position intact and records a pending exit. The stop remains a trigger, not a guaranteed price; existing final fresh sell verification remains required.
- V5 validation cannot report TARGET_MET below profit factor 2.0, without recorded losing trades, or before 100 completed V5 trades. This is an evidence minimum, not a statistical guarantee.
- Memory warnings start at 500 MiB; critical cleanup starts at 650 MiB. Existing bounded collections and reserved exit work remain. Position size and account settings were not changed.
- Quote health now includes degradation reasons and quote age. V5 displays these details alongside the existing stale-account-value warning.

## Verification

`npm test`: 242 passed, zero failed. Full checks include entry rejection, strong winners, reversals, reserve emergencies, missing quotes, quote blocks, gas, restarts, durable archives and V4 behavior. New scenario tests use explicitly synthetic fixtures and are safety tests, not profit evidence. JavaScript syntax and `git diff --check` also passed.

The updated V5 stress run lasted 62.7 seconds with a 384 MiB Node heap cap. It created 2,640 synthetic candidate arrivals, preserved five active positions and completed two account restarts. Peak RSS was 443.7 MiB; final-period average was 424.2 MiB. Queues drained and all memory acceptance checks passed. The machine did not enforce a 1 GiB container limit. This does not prove a 24-hour or production memory ceiling.

Offline comparison used the previous V5 source from HEAD and the modified V5 on the same frozen 51 saved chronological market frames. Both completed zero trades, with no missing exact quotes required by V5 in these frames. A later 26-frame holdout also completed zero trades. No future quotes were used, no missing fills were inferred, and no thresholds were tuned using holdout returns. This small inactive tape cannot measure profit factor, average winners, loss reduction or generalization. It also cannot supply later sell quotes for earlier closed trades.

The existing local monitor returned HTTP 200 with recent blockchain snapshots, live gas and ETH/USD, and no queued RPC work in the captured health snapshot. Quote health remained DEGRADED with an old last quote and no open positions. Therefore that label alone is not proof of RPC failure. The captured service runs the previous code; it was not restarted. This does not establish Railway health. Gas remains the existing 200,000-unit assumption, not measured transaction gas. Existing real reserve versus virtual reserve and curve versus post-migration sell protections were reviewed and retained.

## Requested comparison

The reported baseline below was supplied by the owner and is not a verified local V5 cohort. Improved values cannot be measured from zero completed trades.

| Metric | Reported old V5 | Improved V5 evidence |
|---|---:|---:|
| Trades | 81 | 0 replay completions |
| Win rate | 53.09% | Unavailable |
| Profit factor | 0.65 | Unavailable |
| Average win | $0.35 | Unavailable |
| Average loss | $0.60 | Unavailable |
| Worst loss | Not supplied | Unavailable |
| Net profit | -$7.89 | Unavailable as a strategy result |
| Max drawdown | Not supplied | Unavailable |
| RAM | Not supplied | 443.7 MiB stress peak |

## Changed files

Strategy and execution: `src/paper-v5.ts`, `src/paper-strategy.ts`, `src/paper.ts`, `src/paper-liquidity.ts`, `src/paper-research.ts`.

Health and display: `src/runtime-limits.ts`, `src/paper-quotes.ts`, `assets/desk/paper.js`.

Verification and offline research: `tests/paper-v5.test.ts`, `tests/paper-policy.test.ts`, `scripts/v5-memory-stress.mjs`, `scripts/v5-replay.mjs`, `scripts/v5-loss-audit.py` and new reports. Original reports and account history were preserved.

Ready for controlled paper testing after operator review. Profitability is unproven. Further work needs the actual 81-trade V5 export and a longer chronological tape with candidate arrivals, exact-sized entry quotes and continued full-position exit quotes. The separate V4 Railway service was not contacted.

## Saved-loss audit

A read-only scan of 26,429 local audit archives found no closed trades in the current V5 account. Five other local retained artifacts supplied 37 unique older closed trades: nine explicitly V3 and 28 without a saved strategy version. None is labelled V5. This does not establish what exists on either Railway service.

There are 30 recorded losses, including 24 exceeding 10%. Six of those large losses already showed falling real reserves in their last verified observations before entry. Seven losing trades show entry-to-exit real reserve declines exceeding 80%. These endpoints prove reserve deterioration across the hold, not the cause or precise timing. BUSTO records a -89.81% result and 1,026 quote failures; its migrated exit has no curve reserve comparison. This supports treating quote failures as unresolved exposure rather than successful exits. All 30 losing trades have a recorded pre-entry full sell quote, but their saved sell gas is unknown. A full entry quote alone did not protect them from later collapse.

The audit preserves original accounting outcomes and lists every losing trade, entry inputs, pre-entry evidence, reserve changes, exit reason and missing facts in `v5-loss-audit.json`. Historical cohort figures are not newly verified executable profitability results. Buy/sell transaction flow, full price paths, reaction delay and whether later quotes could have limited each loss remain unknown. They were not invented.

Every recorded loss exceeding 10% is listed below. “Unlabelled” means the original saved plan did not record a strategy version; it is not assumed to be V4 or V5.

| Coin | Saved version | Recorded return | Reserve change during hold | Exit reason |
|---|---|---:|---:|---|
| Summer | Unlabelled | -19.11% | -22.69% | DYNAMIC_RISK_EXIT |
| HAWALA | Unlabelled | -20.70% | -36.36% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| NEARME | Unlabelled | -54.84% | -99.55% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| Apex | Unlabelled | -12.21% | -20.61% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| VORTEX | Unlabelled | -16.51% | -13.41% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| PENNYMARKETS | Unlabelled | -15.59% | -17.51% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| Coresecure | Unlabelled | -26.30% | -24.96% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| FLY | Unlabelled | -22.38% | -15.22% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| BRAIN | Unlabelled | -54.80% | -99.66% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| BUSTO | Unlabelled | -89.81% | Unknown / migrated | DYNAMIC_RISK_EXIT |
| SS | Unlabelled | -21.49% | -13.73% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| OPENDOTS | Unlabelled | -18.20% | -27.50% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| LAOTZU | Unlabelled | -12.71% | -21.78% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| 2o1 | Unlabelled | -33.28% | -35.24% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| ROUTER | Unlabelled | -55.26% | -99.53% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| EMBER | Unlabelled | -53.41% | -83.32% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| PFE | Unlabelled | -61.04% | -97.50% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| KMA | Unlabelled | -16.84% | -11.15% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| IS | Unlabelled | -51.78% | -92.04% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| CUEBOOK | 3 | -30.09% | -24.62% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| AI | 3 | -14.84% | -10.79% | TRAILING_EXIT |
| ANONT | 3 | -26.09% | -21.69% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| SMARTPAY | 3 | -15.63% | -11.64% | LIQUIDITY_OR_QUOTE_DETERIORATION |
| BIGCOIN | 3 | -76.61% | -99.55% | LIQUIDITY_OR_QUOTE_DETERIORATION |
