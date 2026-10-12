# V5 authenticated ZIP export

Implemented locally on the existing V5 dashboard. No commit, push, deployment, account reset or strategy change was performed for this feature. Earlier uncommitted strategy improvements remain separate changes in the workspace. The running local monitor and separate V4 Railway service were not restarted or contacted for this feature.

## Owner workflow

1. Open the V5 `/paper` dashboard.
2. Unlock it using the V5 access password. This is required once per browser session (up to eight hours). The password is not saved in browser storage or placed in a URL.
3. Click **📥 Export V5 Data**. A progress message appears while the snapshot is packaged; position monitoring continues.
4. The browser downloads `gptheist-v5-export-YYYY-MM-DD.zip` directly to a file. There is no in-browser ZIP/Blob buffering.
5. Upload the ZIP into Codespaces and ask Codex to inspect `export_manifest.json` and `sources.json` before calculating results.

The dashboard was previously unauthenticated. One-time unlock is necessary to keep trading history private; subsequent exports require only the button. A stable password allows the signed browser session to survive a server restart. An unfinished export job does not survive a restart; click the button again to build a fresh snapshot.

## ZIP contents

| Entry | Contents |
|---|---|
| `account.json` | Current balance, account creation time, saved accounting totals and snapshot time |
| `trades.json` | All recorded closed-trade occurrences, wrapped as `{sourceFile, record}` |
| `open_positions.json` | Current open positions, original entry, current saved quote, pending exits and quote status |
| `quotes.json` | Current saved quote occurrences and unavailable quote results, with their JSON paths |
| `reserve_history.json` | Current saved liquidity and traction histories |
| `candidates.json` | Current decisions, rejections, research ledger and watchlist |
| `strategy_config.json` | Exact saved current strategy settings |
| `account_balance_history.json` | Current resident balance history; older samples remain in history entries |
| `events.json` | Current recorded events |
| `snapshot/state.json` | Full sanitized frozen current account state |
| `history/*.json` | Every available allowlisted audit archive and reset/schema/monitor recovery snapshot predating the snapshot cutoff |
| `market_observations/*.jsonl` | Available pinned forward research frames at or before the snapshot cutoff |
| `sources.json` | Original source file sizes/hashes, record counts and current-account versus legacy/recovery labels |
| `export_manifest.json` | Schema versions, timestamps, counts, exported-file hashes, redactions, missing-data notes and replay limitations |

Historical quotes, reserve changes, momentum, rejected candidates and risk triggers remain inside the original complete history records. The exporter does not invent missing data, infer fills or change any price, return, gas null, exit reason or account value. Quote and trade occurrence counts can include duplicates retained in overlapping recovery snapshots; they are not a count of unique trades.

For current-account profit factor, select records from `snapshot/state.json` and the history sources marked `currentAccount: true`, then deduplicate trade IDs. Do not add overlapping backup histories to current results. Select other historical account cohorts separately, using source and saved strategy labels. Accounting-versus-reachable-trade-count differences, when available, are called out as missing history. Unknown historical gas remains unknown.

The export can support profit factor, average win/loss, catastrophic-loss analysis and quote/entry/exit investigation to the extent observations were saved. Full replay is not guaranteed: it requires exact-sized entry and full-position sell quotes at every decision, including after the original exit. Pruned or never-recorded observations and another Railway service's data are not recoverable from this export.

## Authentication and safety

- Reuses `PAPER_EXPORT_TOKEN` as the owner's access password. No password or signing key is embedded in the dashboard.
- Unlock uses a same-origin JSON POST with bounded request size and bounded failed-attempt tracking. Password comparison is constant-time for equal-length inputs.
- A signed, expiring, HttpOnly, SameSite=Strict cookie permits normal browser downloads. Production cookies are Secure; localhost test cookies work over local HTTP. Rotating the password invalidates existing sessions.
- V5 `/api/paper`, history, settings/reset and export routes reject unauthenticated requests. Existing V3/V4 account routes retain their behavior. Health and public market observation routes do not grant export access.
- ZIP job creation is a same-origin authenticated POST; progress and download also require authentication. Job IDs contain no credentials.
- Snapshots and ZIP generation only read account storage. Sources are allowlisted; environment files, locks, state temp files and unrelated paths are excluded. Sensitive fields, credential URLs and known configured secret values are redacted. Export contents are not logged.
- Missing or corrupt linked archives, invalid JSON or unsafe source symlinks fail the job rather than claim a complete, usable backup. The account is left unchanged. Failed partial ZIPs are removed.

## Consistency and resource use

The store's completed update barrier is used to clone one committed account snapshot. Its immutable linked archive chain determines current-account history. Older standalone archives and recovery snapshots are included separately, so older cash or positions cannot contradict the frozen current account.

Research capture briefly joins the optional recorder's queue to open existing files and freeze descriptor/byte boundaries. Its normal append and pruning work then resumes. Position monitoring does not take this research queue. Open descriptors preserve captured bytes even if normal retention later unlinks a tape. Later frames and a partially written last line are excluded and counted in the manifest.

One worker builds one ZIP at a time with a 128 MiB worker heap limit. Large JSON archives are token-streamed and redacted without retaining whole arrays. ZIP entries compress and stream to private temporary disk; only the closed-trade index is spooled separately. The browser streams the ready ZIP from disk. No slow download owns the paper-account write queue. Temporary files require sufficient free disk space; failure leaves account data intact. Jobs expire after one hour and server shutdown cleans up job files.

The ZIP library handles large archives and ZIP64 automatically; its output supports stream backpressure. [yazl documentation](https://github.com/thejoshwolfe/yazl). The JSON parser is configured to discard emitted array records from its retained stack. [Streaming parser source](https://github.com/juanjoDiaz/streamparser-json).

## Verification

Final full suite: **249 passed, zero failed**. Chromium downloaded `gptheist-v5-export-2026-10-12.zip` with no page errors. The synthetic 269.3 MiB export peaked at **298.3 MiB RSS**, averaged **250.4 MiB** in final samples and completed **104 position quote checks** during export. Cash and position identity stayed unchanged. Test counts and memory/browser results are recorded in the adjacent `v5-export-*.json` and `.log` artifacts. Tests cover archived and current trade counts, open positions, unknown quote results, secret redaction, file hashes, frozen snapshots, research appends/pruning/partial tails, missing/corrupt archives, unsafe symlinks, session expiry/tampering/rotation, restart behavior, V4 access and monitoring during export.

The synthetic large-export test uses approximately 269 MiB of archive records and an active paper position. It checks process RSS (including the worker), unchanged cash/position identity, no fabricated exit and ongoing fresh marks. This is a local test, not a hard 1 GiB cgroup enforcement or a long-running Railway measurement. The Chromium browser check verifies unlock, button click, actual download, ZIP signature and session retention on page reload.

## Exact files changed for this feature

- `assets/desk/paper.html`
- `assets/desk/paper.js`
- `assets/desk/paper.css`
- `src/server.ts`
- `src/cli.ts` (allowlists the two export runtime dependencies)
- `src/paper-store.ts`
- `src/paper-service.ts`
- `src/paper-forward.ts`
- `src/paper-export.ts` (new)
- `src/paper-export-worker.ts` (new)
- `src/paper-export-auth.ts` (new)
- `package.json`
- `package-lock.json`
- `tests/paper-export.test.ts` (new)
- `scripts/v5-export-stress.mjs` (new)
- `scripts/v5-export-browser-check.mjs` (new)
- `reports/V5_EXPORT_REPORT.md` (new)
- `reports/v5-export-tests.json`, `reports/v5-export-tests.log`, `reports/v5-export-memory.json`, `reports/v5-export-browser.json` (new verification artifacts)

Other currently modified files belong to the earlier V5 engineering order; this feature did not change strategy thresholds, position sizing or exit decisions.

## Deployment when approved

1. Preserve the existing V5 data before any redeploy. Verify that the existing `PAPER_DATA_DIR` points to the service's already-persistent Railway volume. If the account is on ephemeral storage, recover it before redeployment; a new volume does not automatically preserve old container files. Follow `reports/V5_RAILWAY_MIGRATION.md` for the existing preservation procedure.
2. On the **V5 service only**, configure a strong private `PAPER_EXPORT_TOKEN` through Railway Variables. Keep this value stable across restarts. Changing Railway variables can itself trigger a redeploy, so do step 1 first.
3. After explicit approval, deploy the reviewed code and dependency lockfile using the existing Railway build/start configuration. Do not change V5 strategy settings, reset the account, initialize a fresh account or alter V4.
4. Open the HTTPS `/paper` dashboard, unlock once and click the export button. Verify that the downloaded ZIP opens and its current-account counts match the dashboard/history.

No deployment was attempted. Normal exports require no terminal commands.
