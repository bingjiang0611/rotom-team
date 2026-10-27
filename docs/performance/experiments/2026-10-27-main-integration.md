# Main integration: send measurements and bounded benchmarks — 2026-10-27

## Scope and authorisation

The owner requested merging the branch into main, then explicitly approved splitting the remaining four oversized
benchmark files, preserving all counters/thresholds, validating, merging and pushing. Deployment is not authorised.
The four incoming commits are `44b01fe`, `5cfc776`, `955bb11` and `7d606c6`; existing main is `c379bb7cfb57`.
A non-fast-forward merge keeps all four commits and main's hook infrastructure/review history.

The last two feature commits already met the size gate. The older network-profile commits still changed
`test/perf/ledger.json` (1,458,455 bytes), `scenarios.ts` (44,976), `send-phases.ts` (23,956) and `workload.ts` (31,365).
The merge must satisfy the full staged-file rule too. No hook, exclusion, Git setting, ceiling, baseline or tolerance
was bypassed or relaxed to make it commit.

## Responsibility changes

- `scenarios.ts` remains the entry point/setup and delegates image, history, native, phased-send and isolated-probe
  workloads through explicitly typed capabilities. Measurement actions/quiet windows and native account assertions
  remain. `send-phases-browser.ts` owns the page script/watcher; the Node measurement orchestration remains separate.
- Workload constants, scenario descriptions and metric/reported catalogs are leaf modules behind the original
  `workload.ts` exports. Parent-owned deep comparisons against the snapshot confirm all constants, 43 exact scenario
  strings/reported lists and all 90 referenced metric specs are unchanged.
- `ledger.json` becomes a schema-2 index of 204 scenario/responsibility parts. `readLedger()` assembles the same
  schema-1 metric map. Parent `assert.deepStrictEqual` confirms all 1,830 metric objects match the pre-split flat
  ledger, including both gates, every candidate, platform baseline, tolerance, source, evidence and raise metadata.
  The layout groups system work, delivery, journal parsing, native runtime/history and remaining CPU work; it does
  not split by arbitrary line count. Each part and the index are below 20,000 bytes.
- `ledger.ts` reads indexed files and legacy flat snapshots needed for Git-history guards. It refuses duplicates,
  missing or malformed parts and escaping references. Writes precheck every output's size, write the index last,
  and remove only obsolete parts previously owned by that index. This is not a multi-file atomic-write promise.
- The touched 26 KB ratchet implementation is separated into core policy, comparison/reporting, CLI and a stable
  facade. Six core functions (`validateLedger`, `validateReport`, `check`, `propose`, `register`, `guard`) and both
  formatters match their original TypeScript AST-printed functions. The comparison error helper is inlined as the
  same thrown Error; policy, comparison thresholds and CLI argument behaviour are unchanged.
- CI assembles old and new on-disk layouts from the selected base revision's own blobs. Only absence of the root
  ledger means a pre-benchmark base. A missing indexed fragment is a hard failure, not a way to skip the guard.
- The benchmark guide documents the index/loader/write boundary. Its stale Git-changes ceiling text is corrected
  from 5 to the ledger's already-existing 3; the actual ceiling did not change.

## Review correction and controls

Independent read-only review found one blocker: the initial extraction grouped `journal.large` and asset probes,
placing assets before `session.open.native-long`. Parent restored the original order:

```text
images → history → native warm → established sends → journal.large
       → native-long → assets.first/assets.validated → shaped sends
```

A new AST-based orchestration test fails when the asset/native-long calls are swapped, and passes when restored.
The negative control is `/tmp/rt-main-order-negative.log`. No scenario, assertion or count window was removed.
The first 740-test suite predates this correction; final acceptance below supersedes it.

New ledger tests run the actual cloned CLI without touching the real ledger: propose tightens only, register adds
only candidates, and an increased baseline still fails guard. They cover legacy/index equivalence, duplicate and
missing data, path escape, oversized output refusal before mutation, obsolete-part ownership and historical Git
fragments. The historical test changes current on-disk baselines, then proves that reading the prior commit's
index and parts still returns the old values. Existing ratchet assertions are retained; their committed-ledger
read now calls the loader, not raw JSON.parse on an index.

## Final verification

Node 24.18.0, darwin-arm64; isolated synthetic/native-loopback workloads, no real model account or production data.
Tests and timing runs unset all six HTTP/HTTPS/ALL proxy variables and set `NODE_USE_ENV_PROXY=0`.

| Check                                   | Result                                                                                | Evidence                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run format:check`, `npm run check` | pass; format check includes ESLint                                                    | final benchmark/runtime source                                                          |
| `npm test`                              | 743 pass, 0 fail/cancel/skip; 233,620 ms                                              | `/tmp/rt-main-merge-accepted-suite.log`                                                 |
| Data/schema and policy parity           | 1,830 records, 43 scenarios, 90 metric specs; six core functions/two formatters match | parent comparison with `/tmp/rt-main-merge-before-split/test/perf/`                     |
| `perf:ci -- origin/main --runs 1`       | gating and ledger guard pass; 258,071 ms; `highLoad:false`                            | `/tmp/rt-main-merge-ci/{base,head}.json`, `/tmp/rt-main-merge-ci.log`                   |
| `perf:ci -- 7d606c6 --runs 1`           | gating and ledger guard pass; 257,228 ms; `highLoad:false`                            | `/tmp/rt-main-merge-incoming-ci/{base,head}.json`, `/tmp/rt-main-merge-incoming-ci.log` |
| Scenario-order negative control         | expected failure with calls swapped; restored version passes                          | `/tmp/rt-main-order-negative.log`                                                       |
| Staged size/whitespace checks           | pass, no exemptions                                                                   | `node scripts/check-staged-file-size.mjs`, `git diff --cached --check`                  |

Both timing comparisons use the skill's lock wrapper and the same current instrument on both sides. The incoming
comparison isolates runtime changes from the merge-time benchmark reorganisation: application `src`/`web` code is
unchanged from `7d606c6`. Both runs exercise real Chromium, shaped-network calibration and all 43 scenarios. New
format guards are also exercised through real CLI and Git-blob tests, not merely parse-count checks.

## Counters and limits

All larger observations are retained in the [complete comparison record](2026-10-27-main-integration-counters.md):
34 against old main, 35 against the incoming feature. Against old main the already-reviewed application module
split adds six static resource requests and 3,640 gzip body bytes. No fixed static-asset increase appears against
the incoming feature; the additional merge-time modules are benchmark-only, not browser/runtime assets.

Other larger values are sampled rendering/DOM work, paced push boundaries, readback/SQL boundary work and small
payload-width differences. The earlier same-revision A/A control also shows these families varying; it does not
prove every new row harmless. They remain named measurement leads. No baseline was raised to hide them.
One pair per base is insufficient to claim faster latency, and this merge claims no new L1/L2/L3 gain.
Production's previous 1.554 s wait remains unattributed. Deployment and paired production collection require a
separate owner decision; this merge/push does not restart, install or deploy the service.
