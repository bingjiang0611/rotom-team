# D9c deletion and rollback verification

D9c implements the fourth C4 step on approved D9b `2676e7f`. The isolated worktree is `/private/tmp/rotom-review-D9b/delivery`, branch `delivery/d9c`. It was clean before the fast-forward and inventory. The original dirty workspace, its unrelated commits, user files and concurrent worktrees are untouched.

## Scope and ordering

- First commit: **`6f51f4e`**, [inventory](d9c-inventory.md) and [pre-deletion references](d9c-references-before.txt). No implementation was deleted before that commit.
- Remove exactly nine repository modules (2156 lines), twelve exclusive tests, and their private helper/import closure. `test/codemode.test.ts` is the only whole test file removed. Shared helpers, standalone Approvals/Lancet/parsers and mixed-file historical/refusal coverage remain.
- Add one real CLI-help test in `test/legacy-archive.test.ts`; centralized help distinguishes removed repository modules from retained user source/switches. It executes `bin/rotom-team.js --data <synthetic dir> --help`, verifies exact guidance and byte-preserved files, and verifies no startup-created files.
- Update current CLI/product/configuration/architecture/map/archive guidance and affected authoring/self-editing instructions. Historical review evidence, upstream tour status, legacy examples and original reviewer probes remain.
- [Post-deletion references](d9c-references-after.txt) retain only two historical path comments and an unrelated native resource path. No executable importer/discovery or exported plan/slug helper use remains. TypeScript verifies the retained caller set.

No persisted task/document identity, version, input, state/checkpoint, result, scope, history/fork setting, journal `user_version`, storage implementation, archive/export/auth path, native gate, credential routing or unknown-outcome rule changed. No vendor, dependency, workload, measurement, ledger or tolerance change. The only modified retained production file is `src/server/constants/copy.ts`, for help text. Deleted modules were already unloaded in D9b.

## Verification results

Node **24.18.0**, darwin-arm64, pinned rotom **0.1.26**; only synthetic data and loopback models. Runtime/web/test/tool source identity is recorded in [403 source hashes](d9c-source-files.json). [Structured verification](d9c-verification.json) contains exact deleted/added names, logs' SHA-256, native reports and every probe result.

| Check                                                       | Result                                             | Evidence / scope                                                                      |
| ----------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Before deletion: `npm test`                                 | 723/723; 0 failed/skipped/cancelled; 232684 ms     | `/tmp/rotom-review-D9c/baseline-test.log`                                             |
| `npm run check`                                             | pass                                               | `final-check.log`                                                                     |
| `npm run lint`                                              | pass                                               | `final-lint.log`                                                                      |
| `npm run format` and `npm run format:check`                 | pass                                               | `format.log`, `final-format-check.log`; no unrelated formatting                       |
| After deletion: `npm test`                                  | **712/712**; 0 failed/skipped/cancelled; 229327 ms | `final-test.log`; Chromium checks included                                            |
| `node --test test/legacy-archive.test.ts`                   | 10/10                                              | `legacy-archive-final.log`                                                            |
| Archive/plan/Approvals/Lancet/schedule/prompt focused suite | 30/30                                              | `retained-contracts.log`; independent implementations remain exercised                |
| `npm run test:kernel:app`                                   | passed, 85 loopback requests                       | `native-app-off.log`; native ownership/lifecycle/authorization/account/unknown checks |
| `npm run test:kernel:app -- --storage-worker`               | passed, 86 loopback requests                       | `native-app-on.log`; includes worker failure fencing                                  |
| `node test/native-commands-proof.ts`                        | passed, 19 inferences                              | `native-commands-off.log`; realAccounts=false                                         |
| Same command with `--storage-worker`                        | passed, 19 inferences                              | `native-commands-on-final.log`; realAccounts=false                                    |
| Original three-mode archive probe + D9b and D9a reopen      | 9 processes / **18 opens**, all checks pass        | [Probe results](d9c-verification.json), details below                                 |
| Locked main performance CI + two matched D9b CIs            | all exit 0; gating and ledger guard pass           | [Per-counter report](d9c-performance.md)                                              |

### Default-test reconciliation and negative control

**723 − 12 + 1 = 712.** The inventory lists every removed test by exact name and why its exclusive implementation disappears. AST comparison against `2676e7f` verified exactly those twelve deletions and one addition, and that **all 31 retained test bodies in the edited/deleted test-file set remain byte-identical**. No test was skipped or weakened to pass. Shared files such as `test/helpers.ts`, `approvals.test.ts`, `lancet.test.ts` and `schedules.test.ts` have no diff.

Restoring only the old `ARCHIVE_COPY.cliMode` made the new focused CLI test fail on the missing repository-removal guidance (`cli-negative.log`, exit 1, expected assertion). Restoring the final help text passed the archive suite. This negative control did not alter parser/security/archive assertions or any persistent contract.

## Original reviewer probes and same-data rollback

The producer and positive control are copied unchanged from the review's `d9a-review-probe-*.ts.txt` and run with historical **`7478123`** code. The head probe is also copied unchanged, using its existing `KEEP` option. [Hashes](d9c-probe-hashes.txt) prove the copies match. No assertions, waits or task behavior were changed.

- Producer creates root 3 with history, a scheduled message, a held tool and queued input. Public Storage scans after close prove **2 running + 1 waiting tasks**, **1 queued + 1 placed submissions**: this is not an empty fixture.
- Old-code positive reopening reports **`sentinelChanged: true`**, proving the fixture's old executable work can actually run.
- Each head mode (`off`, `on`, `worker`) opens twice. Then D9b **`2676e7f`** opens the **same KEEP directory** twice, without recopying the producer. D9a **`9562e79`** additionally opens that same directory twice. No backup restore is interposed.
- All 18 opens preserve `PROBE-HISTORY` and `old reply` in exports; submit returns the exact canonical **409** archive message; archive notes remain **1**; scheduled sends **0**; new work **false**; active tasks and open submissions **0**; closed harness/kernel lease lists **empty**. Sentinel remains unchanged in every head/rollback process.
- After both rollbacks, the original drop-in source is byte-identical, and enabled/disabled records equal the producer's values in every mode. They survive, but never load.
- [Historical source comparison](d9c-rollback-source-check.json) verifies every tracked file against `git archive`: old producer 557 files, D9b 599, D9a 588. Extra probe files are separate temporary runners, not changes to historical application code. Dependency manifests match between D9a and D9b; runtime copies are real directories, not symlinked kernel installations.

Successful retained data directories are `/private/tmp/rotom-review-D9c/post-off/data`, `post-on-final/data`, and `post-worker-final/data`. This proves D9c→D9b and D9c→D9b→D9a compatibility for the synthetic fixture, not arbitrary production-data health or recovery of uncertain external effects. The pre-D9a matched-backup rule remains unchanged.

## Attempts and limitations retained honestly

- A combined four-proof shell call reached its 300-second tool deadline after three successful reports and while starting commands/worker. No proof process remained. Its empty `native-commands-on.log` is **interrupted, not passed**. Only that unfinished scenario was rerun on a fresh synthetic fixture; `native-commands-on-final.log` passed. The first three completed proofs were not replayed.
- The first kernel-on probe used a noncanonical `/tmp/...` KEEP path. The native journal correctly refused it (`Kernel journal directory must be canonical and private`). That failed fixture and its `harness.lock` fence remain untouched at `/tmp/rotom-review-D9c/post-on`; no manual lease removal or continuation was attempted. New on/worker fixtures used canonical `/private/tmp/...` paths. Successful probe results do not include the failed attempt.
- An older D9a experiment tree had the previously accepted measurement repair copied into three files. It was rejected as rollback provenance. A fresh `git archive 9562e79` tree was used and verified instead.
- The main performance run is **highLoad=true**; its timing verdicts do not establish L2 latency evidence. Both matched D9b runs are highLoad=false. First-pair 30 worse counters do not reproduce; the repeat's seven worse counters are different. Each is reported as **采样差异，未归因**, with all samples, not hidden or assigned a fabricated cause. No user-speed claim; all gating/guard checks passed unchanged.
- No real provider/account, production data, deployment, service restart, force-push, rebase or main merge. Native proofs explicitly do not establish real-provider or separate manual web-UI success; the default suite covers its own browser fixtures.

## Evidence and delivery boundary

Full local logs, raw performance reports, source/probe snapshots and synthetic retained data remain under `/tmp/rotom-review-D9c`. No verification server or proof process remains running. Successful probe leases closed; the failed noncanonical fixture retains its fence intentionally. Historical fixture runners also leave their own disposable temporary data/work folders; no user data was removed.

The implementation and this evidence are committed together after review of the final diff. Delivery uses only `D9c:` commits from the clean isolated worktree, fast-forward to `origin/review/2026-10-23-perf-design-arch`. The subsequent HANDOFF records the pushed implementation hash and changes D9 to **已推送待核验(D9c)**. Stop there for independent review; do not deploy or start another stage.
