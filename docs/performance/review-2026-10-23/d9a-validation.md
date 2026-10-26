# D9a — read-only legacy archive validation

## Delivered scope

Pre-D9 implementation baseline: `7478123983cd9d9a2ff25782f87523043bdfe181`. Inventory was committed first as `6c217635727f3b988fff3f630c39953eccdc6f28`. D9a retains legacy data/backend identity and read/export/access capabilities, but removes its executable product path. D9b/D9c deletion work is not included.

- Persisted-root guards reject creation, execution, recovery and ordinary mutations, including direct note/session-budget writes. Unknown sessions retain 404; non-owner budget changes remain 403; invalid budgets remain 400. Existing archives reject valid writes with the read-only reason.
- Public Storage quarantines each complete cataloged legacy ownership closure atomically before Harness opens. Private task and Live originals remain recoverable; public notes do not expose those snapshots. No old run/abort callback or Harness resume executes.
- Startup failure cleanup closes the actual Storage owner or retains writer fencing. Native payer and unknown-outcome rules are unchanged.
- Both transports propagate readOnly state to real browser controls. Archived plan/goal/spend/schedule presentation stays readable; native composition and native/personal budget controls remain available.
- Legacy source, extension directories and enabled/disabled records remain. Both startup modes leave the loader absent. CLI/product/configuration/architecture/deployment documentation now says read-only archive, including rollback limits.

[Archive contract and rollback](../../LEGACY-ARCHIVE.md) · [Exact test migration map](d9a-test-migration.md) · [Fixture provenance](d9a-fixture-provenance.md)

## Final checks

Environment: macOS darwin-arm64, Node 24.18.0, pinned rotom 0.1.26 and Durable 1.0.2. Temporary data and synthetic loopback credentials only.

| Check                                                                      | Result                                                               | Evidence                                                                                                         |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                                            | exit 0                                                               | [Static check output](d9a-static-checks.txt); TypeScript, final runtime/helper source                            |
| `npm run lint`                                                             | exit 0                                                               | ESLint, final runtime/helper source                                                                              |
| `npm run format:check`                                                     | exit 0                                                               | Prettier and ESLint; user files preserved                                                                        |
| `npm test`                                                                 | **723/723**, 0 fail/cancel/skip/todo                                 | [Complete output](d9a-default-suite.txt); unchanged `node --test --test-concurrency=2 test/*.test.ts`, 236341 ms |
| `npm run test:kernel:app`                                                  | passed; 85 loopback requests                                         | [worker off](d9a-native-app-off.txt)                                                                             |
| `npm run test:kernel:app -- --storage-worker`                              | passed; 86 loopback requests                                         | [worker on](d9a-native-app-on.txt)                                                                               |
| `node test/native-commands-proof.ts`                                       | exit 0; 19 inferences, 25 checks                                     | [worker off](d9a-native-commands-off.txt)                                                                        |
| `node test/native-commands-proof.ts -- --storage-worker`                   | exit 0; 19 inferences, 25 checks                                     | [worker on](d9a-native-commands-on.txt)                                                                          |
| Locked `perf:ci -- origin/main`                                            | exit 0; gating and guard passed; no unavailable comparisons          | [Performance report](d9a-performance.md), [CI output](d9a-perf-ci.txt)                                           |
| `node bin/rotom-team.js --data /tmp/rotom-review-D9a/cli-help-data --help` | exit 0; explicitly says no legacy execution                          | `--no-rotom-kernel opens read-only archives; it does not enable legacy execution.`                               |
| Source identity                                                            | 396 files unchanged across final native proofs/performance packaging | [SHA-256 manifest](d9a-source-files.json)                                                                        |

The native app proof deliberately logs its configuration-staging fault injection before reporting `status:passed`; this is an asserted negative scenario, not an ignored unexpected failure. Its `webUiVerified:false` remains honest: browser coverage is supplied by the default real-Chromium tests, not the app proof.

New native assertions independently cover supported shared-worktree forks (real native history, cwd/file sharing, no extra checkout and unchanged source history), other-member steer/follow-up/model/thinking refusal during an actual held run, provider-login refusal while the payer runs, and native compact USD-budget admission with no receipt/provider dispatch. A Durable-path 409 is not used as their substitute.

## Negative controls and audit corrections

Stored control logs normalize trailing whitespace only; assertion text and results are unchanged.

- The current deep-ownership test passes in the default suite. Restoring the old 32-edge cutoff **in memory only** makes that same test fail with `running` instead of `terminal`: [output](d9a-depth-negative.txt), [hook](d9a-depth-negative.mjs). Reproduce from the repository root with `node --import ./docs/performance/review-2026-10-23/d9a-depth-negative.mjs --test --test-name-pattern='deeper than 32' test/legacy-archive.test.ts`; exit 1 is expected. The hook does not edit repository source.
- Earlier browser control: dropping store readOnly propagation failed both stream/poll cases (0/2); restoring it passed both (2/2). [Negative](d9a-ui-negative.txt), [positive](d9a-ui-positive.txt), [reverse patch](d9a-ui-negative.patch). Apply the patch only in a throwaway checkout. These historical control logs precede the added spend assertions; the final 723-test run includes the stronger current tests.
- Final auditing found a missing-session guard returning archive409; the guard now returns 404 before classifying an absent session. The HTTP unknown-upload assertion was restored to its original 404 contract. Viewer submit/abort checks are strict 403 again, not 403-or409. Unsupported native shell/revert endpoints remain explicit 409, separately from viewer-policy tests.
- Archived upload refusal no longer contains an unreachable legacy-success branch. The separate genuine-native upload case still checks byte limits, duplicate names, cancelled-body cleanup, permission boundaries and persistence. No parser, credential, authorization, filesystem or history assertion is replaced solely with an archive refusal.
- The read-only scout found and the parent repaired the native live-exclusion, compact-budget and shared-checkout-fork proof gaps. Its source-only review was not counted as test execution.

## Limits and handoff

- No real-account OAuth/billing, production upgrade or deployed end-to-end outcome was tested. Nothing was installed, deployed or restarted on the team service.
- Quarantine has a documented 256 MiB encoded root-closure bound and covers cataloged roots/owned descendants, not arbitrary unregistered third-party roots. Production-size legacy migration timing is not measured by the native performance workload.
- Final paired-main comparison reports 63 worse counters and 5 slower timings. All 47 D9-reference worse counters and 233 historical ledger warnings are itemized. Some serialization residuals and elapsed-time causes remain unverified; no speedup or absence of a timing regression is claimed, and no ledger limit was relaxed. See the performance report for the next profiling action.
- A code revert does not resurrect quarantined tasks. Restoring pre-upgrade behavior requires the matching offline data backup and explicit acceptance of post-backup data loss; external unknown effects remain fenced.
- User-owned `docs/performance/opportunities.md` and `docs/performance/2026-10-21-proposals.md` are excluded from staging and compared byte-for-byte with their initial backups.
- Review owner should pull the pushed D9a commits and independently verify this evidence. Execution stops at **已推送待核验（D9a）**; no D9b/D9c work is authorized by this handoff.
