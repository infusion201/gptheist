# V5 zero-trade investigation

## Findings

The supplied Railway dashboard has $250 equity and a $5 all-in allocation cap. The local $50 snapshot is a different account snapshot and does not explain that dashboard. No account was reset or funded during this work.

Confirmed implementation defects:

1. V5 required BUY and full-position SELL quotes from the same block, but the quote reader requested a new latest head for each. All 78 available pairs in the frozen local tape use different blocks. V5 now pins the round-trip SELL to the BUY block. Reorg and freshness checks remain.
2. Quote-history collection required both reserves and integer curve progress to increase in consecutive observations. This discarded the initial funded observation, plateaus and withdrawals, delaying evidence and hiding useful risk history. V5 now collects verified funded observations on distinct blocks at ten-second spacing. Collection does not approve an entry.
3. V5 saved a 5% downside policy but sized using the older dynamically calculated downside. It now sizes against its actual saved policy. Final entry also checks the plan and includes known entry gas in exposure and risk limits.
4. Cost failures at the minimum legal ticket could be overwritten by a later size failure. V5 preserves the actual friction rejection.

The supplied active-candidate rows do not show a healthy rejected opportunity: PAIRCAT has no positive reserves/progress; VWHALE has zero recent reserve growth; SILEX has only two confirmations across eleven seconds. These remain valid reasons to wait. Old launches must remain rejected; their repeated activity is not evidence of new opportunities. The new dashboard shows current entry-window assessments separately, stage results, exact blockers and last eligibility time.

## Scope and evidence

The fixes are local and have not been deployed. They cannot yet change Railway behavior. The supplied dashboard does not prove that any token passed all safety rules during the full session. No complete Railway export was provided; the frozen local tape and archived decisions cannot establish the cause of every Railway rejection or historical replay profitability.

See `v5-entry-evidence.json` for recorded local evidence, `v5-entry-validation.json` for chronological synthetic integration scenarios, and `v5-entry-memory.json` for a short infrastructure stress test. Synthetic entries are not historical profits or real transactions. The validation includes the supplied $250 balance and $0.010651 swap gas estimate.

No liquidity threshold, fee limit, position limit or confirmation requirement was relaxed. There is no guarantee of a trade if actual candidates remain unhealthy or too costly. V4 behavior, saved accounts, trade history and authenticated ZIP export are preserved. No commit, push, restart or deployment was performed.

## Changed files

Production: `src/paper.ts`, `src/paper-policy.ts`, `src/paper-quotes.ts`, `src/paper-service.ts`, new `src/paper-entry-diagnostics.ts`, and `assets/desk/paper.html`, `paper.js`, `paper.css`.

Validation: `tests/paper-fixtures.ts`, new `tests/paper-v5-entry.test.ts`, `tests/v5-entry-flow-fixture.ts`, `fixtures/v5-recorded-entry-rejection.json`, `scripts/v5-entry-audit.py`, `scripts/v5-entry-validation.mjs`, and the reports in this folder.

After approval, deploy these source changes through the existing V5 Railway deployment process with its existing persistent volume and environment settings. Do not reset the account or change the separate V4 service. Then use the new funnel and authenticated export to verify actual candidate outcomes.

## Verified results

The complete suite passed: 258 tests, zero failures. The updated focused suite passed all 9 tests, including the $250 balance and displayed gas cost. Ten synthetic scenarios produced four eligible healthy entries and six rejected unsafe or undersized cases. Current stage totals: {"discovered": 10, "traction": 8, "momentum": 4, "liquidity": 5, "sizing": 5, "eligible": 4}. Stage counts are separate checks, not an enforced sequential funnel.

The short memory stress run lasted 15.9 seconds: peak RSS 372.6 MiB, final RSS 340.2 MiB, five open positions retained, bounded candidate memory and drained request queue. This is a short synthetic test, not proof of 24/7 Railway memory behavior. Browser JavaScript syntax and diff whitespace checks passed.
