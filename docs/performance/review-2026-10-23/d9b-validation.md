# D9b validation and handoff

Final runtime verification and corrected common-instrument performance acceptance pass. Three earlier performance failures remain recorded; the user separately authorized the measurement prerequisite, inventoried in `da28f55` and delivered as `c59b1c7` (the same patch was originally committed as `0d5410a`). The user chose isolated delivery to exclude concurrent unrelated commit `5bde0dd`. The isolated `delivery/d9b` branch starts at remote `9562e79`, retains only this task's inventory commits, and cherry-picks the measurement patch without rebasing or force-pushing. Original workspace edits and unrelated history are retained. D9c has not started.

## Scope and sequence

Baseline: D9a review-approved `9562e79`, branch `review/2026-10-23-perf-design-arch`. Inventory was committed first as `a3d4d39`; `f5bd709` clarified the real `projectsChanged` location and the single spend fixture helper before their deletion/change. Implementation follows inventory B1–B9; D9c is not started.

Removed service `ExtensionLoader` and drop-in preparation, loader success APIs, production Lancet construction/discovery, Durable command/HTTP execution bodies, shell/schedule/goal/resend execution, project/budget abort loops and old execution admission. Native creation, ownership/account locking, accounting, history, files, grants and native routing remain. The Durable compaction hook now explicitly declines every provider; a conditional hook that returned `undefined` for non-team providers was not a complete refusal boundary.

This is deletion of the inventoried execution path, **not** a claim that every legacy symbol or historical helper has no references. See [before references](d9b-references-before.txt), [after references](d9b-references-after.txt), and [inventory](d9b-inventory.md).

### Retained closure

| Item                                                                     | Actual reason                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reload.ts:watchTree`                                                    | Shared web watcher still calls it; only the loader was removed.                                                                                                                                                                   |
| `PocketHost`, Approvals, Lancet implementation                           | Retained extension sources need static types; standalone codemode/approval/Lancet tests still exercise these implementations. No production Lancet construction or loader remains.                                                |
| Historical task declarations                                             | Shell/schedule/resend identities, versions, input/state/result shapes remain for decoding; execution phases throw. Terminal abort callbacks only return an aborted outcome, not process execution. Quarantine does not call them. |
| Public Storage/Harness, document definitions, private archive documents  | Native mirror/projection/ownership and D9a recovery data still need them. `docs.ts`, `legacy-archive.ts`, journal schema and vendor source are unchanged.                                                                         |
| `TeamExecution` owner/provider indexes, locks, idle/account checks       | Native lifecycle/accounting and retained histories still call these. Old dispatch/admission succeeds nowhere.                                                                                                                     |
| Typed refusal methods and `loader = undefined`                           | Retained callers/tests need a stable rejection surface, not a fake successful loader. Authentication/backend/steer/archive fences remain before rejection.                                                                        |
| `envFor`, workspace readers and shared workspace helpers                 | Real retained callers remain, including `storage-worker-app.test.ts`; unreachable workspace mutations still cannot cross the Durable driver fence. They were not inventoried as agent execution bodies.                           |
| Extension directory, old test files, source and enabled/disabled records | D9c scope; untouched here.                                                                                                                                                                                                        |

`commands.note` is rejection-only. Its two production callers in workspace mutations first require the retired Durable driver; they were not evidence of a native note feature. The positive `test/spend.test.ts:recordRequester` fixture now appends an explicit public note entry and terminal write-submission record in a real Harness transaction. The real attribution commit listener and delayed-cost ordering remain under test. No assertion, backend classification, timeout or test was removed/relaxed; the fixture does not execute an old task or pretend to be inference.

## Final checks

Node 24.18.0, darwin-arm64, M1 / 8 cores, pinned rotom 0.1.26. All accounts/providers are synthetic or loopback. The [394 source hashes](d9b-source-files.json) cover runtime, web and tests frozen before final checks; they were rechecked during evidence packaging. The final default/static checks include the measurement correction. Native and archive/rollback proofs ran on byte-identical production source before that test-only correction; the measurement correction changes no production files.

| Check                                                 | Inventory/D9a runtime        | Final D9b runtime                                                                |
| ----------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `npm run check`                                       | exit 0                       | exit 0                                                                           |
| `npm run lint`                                        | exit 0                       | exit 0                                                                           |
| `npm run format:check`                                | exit 0                       | exit 0                                                                           |
| `npm test` / equivalent `npm run test`                | 723 passed                   | 723 passed, 0 failed/cancelled/skipped; 249392 ms                                |
| `npm run test:kernel:app`                             | passed                       | passed, realProvider=false                                                       |
| `npm run test:kernel:app -- --storage-worker`         | passed                       | passed, worker failure fencing assertion true                                    |
| `node test/native-commands-proof.ts`                  | passed                       | passed, 19 loopback inferences                                                   |
| `node test/native-commands-proof.ts --storage-worker` | passed                       | passed, 19 loopback inferences                                                   |
| Locked `npm run perf:ci -- origin/main`               | gating + ledger guard passed | corrected common instrument: three base/head pairs, gating + ledger guard passed |

Parent focused run: `node --test test/spend.test.ts test/legacy-archive.test.ts test/worktrees.test.ts test/team-durability.test.ts`, 26/26 passed. The final default suite re-ran the complete D9a legacy fixture, pinned nonempty historical artifact, deep ownership, lost acknowledgement, failure atomicity, cleanup fencing and read-only UI tests. Independent parser/security/policy/history/native tests remain in the default suite; generic archive refusals do not replace them.

Native app/commands proofs exercise actual loopback execution, payer handoff, authorization, compaction/fork, restart, private results and unknown-not-replayed behavior. These are not inferred from metadata-only helpers or HTTP 409s. Fault-injection stack traces in app logs are expected negative cases; each final report says `status:passed`. The app proof explicitly reports `webUiVerified:false`; browser coverage comes from the separate default UI tests, not that report.

[Performance evidence](d9b-performance.md) lists every worse counter and candidate warning for the final corrected-instrument run. Final main comparison: 74 worse counters and five slower timings. A separately remeasured D9a baseline uses the same corrected instrument: 20 worse counters, including ten necessary guard-text increases (+9 bytes per info frame, +36 for four clients). Other sampling differences are explicitly **采样差异，未归因**, with all three values shown. That additional D9a baseline was **highLoad=true**, so its five slower timing flags are diagnostic only, not valid L2 evidence. The final main/head pair was highLoad=false. No workload, ledger, tolerance or quiet rule changed; no latency improvement is claimed. The image-phase correction and its failing negative control are documented in [measurement validation](d9b-measurement-validation.md).

## Independent reviewer probes and rollback

The original `d9a-review-probe-{produce,reopen,head}.ts.txt` files were copied byte-for-byte, not edited. SHA-256:

- producer: `a68b33922bdbed2e387554568b8ef815da95df73e3d4c57bb3adea01da751408`
- old reopen: `e5324f60544c3610370dfeec9357ba694a32bf878560f3739efca9909604244d`
- head: `055fb7f088f765a07c69f5acfe8290ff8fc73475647baabcdd1e80c7153c2b19`

The producer and positive control ran in an isolated `git archive 7478123` tree. Producer returned `id:3`; old reopen returned `sentinelChanged:true`, proving the old pending work was nonempty and executable, rather than testing an inert empty database.

The unmodified head probe ran against D9b with kernel off, kernel on, and storage worker. Each run opened/reopened twice. A main-thread-only external `--import` observer copied the already-closed synthetic data just before probe cleanup; it required both lease files to be absent and never changed the probe or application. These post-D9b copies were then tested with the same head probe against an isolated D9a `9562e79` source tree, in the same three modes. [Portable raw results and task-shape evidence](d9b-probe-results.json) contain all six reports.

| Result                          | D9b off/on/worker         | D9a reopening post-D9b off/on/worker |
| ------------------------------- | ------------------------- | ------------------------------------ |
| Opens checked                   | 6                         | 6                                    |
| Original history in export      | all true                  | all true                             |
| Archive submission refusal      | canonical read-only 409   | canonical read-only 409              |
| Archive notes                   | exactly 1 after each open | exactly 1 after each open            |
| Scheduled sends / new work      | 0 / false                 | 0 / false                            |
| Active tasks / open submissions | 0 / 0                     | 0 / 0                                |
| Post-close leases               | none                      | none                                 |
| External sentinel               | unchanged                 | unchanged                            |

Task-shape validation parses old/current TypeScript and compares task generic shapes (expanding the new `ShellState` alias), name/version/initial state and retained type aliases. Comments are excluded from this structural comparison. It also byte-compares `docs.ts`, `legacy-archive.ts`, `rotom-journal.ts`, performance ledger and workload against D9a. This supplements, rather than replaces, the actual old-data reopen probes.

Two setup failures were corrected without changing production safeguards: the D9a isolated tree initially symlinked the native product directory, and canonical-path validation correctly refused it; it was replaced with an actual copy of the pinned local dependencies. The first worker capture observer incorrectly ran inside the worker, whose environment lacked its output path; startup cleanup remained fenced. The observer was limited to the main thread and a fresh synthetic copy was used. Failed copies were not reused and lease files were not manually removed. Packaging checks also exposed an inline-type/alias and comment-only difference; normalized shapes compare equal. None of these failed attempts is reported as a successful reopen.

D9b changes no persistent format or journal `user_version`. A rollback to D9a can use the same post-D9b data; D9a's quarantine remains active and **does not resurrect archived tasks**. Returning to pre-D9a requires the offline backup/product pairing described in [LEGACY-ARCHIVE.md](../../LEGACY-ARCHIVE.md); uncertain external effects must never be automatically replayed.

## Isolated delivery verification

Delivery worktree: `/private/tmp/rotom-review-D9b/delivery`, local branch `delivery/d9b`, target remote branch `review/2026-10-23-perf-design-arch`. All 394 runtime/web/test files exactly match the artifacts used for the final checks; this is a Git-history isolation, not a new implementation. The unrelated `5bde0dd` is not an ancestor. The isolated `opportunities.md` equals the remote baseline and the user's untracked proposals file was not copied.

In this worktree, `npm run check`, `npm run lint`, `npm run format:check`, pinned kernel identity validation and all four documentation example tests passed. Runtime/performance evidence above is reused only after exact file-hash equality, not merely because cherry-pick succeeded. The original worktree and its uncommitted D9b copy are left intact for the user; it is not the clean delivery branch.

## Evidence and limits

Raw logs, isolated source/dependency trees, closed synthetic copies and failed synthetic setup copies remain under `/tmp/rotom-review-D9b/` (some probe-created temporary directories use the OS temporary folder). Portable evidence is included beside this document. No real account, production data, deployment, service restart, merge, rebase or force-push was used.

The original content of both pre-existing user documents is preserved and outside this task's staging. A concurrent documentation commit added 32 lines to `opportunities.md`; those committed lines were restored alongside the original 70 uncommitted lines after the backup-restoration step was found to have removed them. The current user file is saved separately as `user-opportunities-concurrent-preserved.md`. No concurrent content is to be deleted or silently pushed. Large production legacy-catalog startup cost remains unmeasured; no persistent skip marker or D9a format change was added. The isolated delivery excludes the unrelated commit and both user documents. After push, the handoff becomes **已推送待核验(D9b)**. Do not begin D9c.
