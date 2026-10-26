# Legacy Durable archives (D9a / D9b / D9c)

Only the native rotom backend executes new work. A persisted session without `backend: "rotom"` is a legacy archive. Disabling the kernel never changes that classification or enables Durable execution.

## What remains available

- Open and read history, retained goals/plans/schedules, spend and configuration snapshots.
- Export history and read authorized workspace files. File reads show the current filesystem, not a historical filesystem snapshot.
- Manage access grants using the existing authorization rules. Read/unread and delivery bookkeeping remain available.
- Native sessions retain their existing commands, payer routing, permissions and unknown-outcome fences.

Archives reject new sessions/forks, model dispatch, replay/resume, shell/tool calls, chat/notes/reactions, configuration/title/instructions, uploads, workspace changes, plan/goal/schedule changes and session-budget changes. Personal budget management remains separately authorized; it does not make archived sessions executable. The UI removes mutation controls and shows the read-only reason. Direct HTTP and internal command paths also enforce the boundary.

`--no-rotom-kernel` means **read-only archive access**, not the old product. It still refuses startup when native ownership/pending-work checks would be bypassed. `--storage-worker` cannot be combined with it. No production or test option re-enables legacy execution.

D9c removes the repository's nine old `src/server/extensions/` modules. Neither mode loads or watches data-folder drop-ins: user source files and enabled/disabled records are retained unchanged. Extension management endpoints remain unavailable. Native Agent Extensions use the separate configuration contract in [AGENT-CONFIGURATION.md](AGENT-CONFIGURATION.md).

## Startup quarantine

`src/server/legacy-archive.ts` uses only the public Durable Storage API, before Harness takes ownership. It does not run or abort an old task callback and never resumes Harness's legacy scheduler.

1. Read legacy roots from the persisted session catalog. Follow the complete immutable conversation ownership closure, without a fixed depth cutoff.
2. Collect pending/running/waiting/completing tasks and queued/placed submissions for that root and its owned descendants.
3. Preserve full original task records (including memo/checkpoint state) in private `LegacyTaskArchiveDoc` documents. Preserve interrupted Live content in private `LegacyLiveArchiveDoc` documents. These recovery records are not transcript entries.
4. Terminalize unfinished work, clear stale live/busy indicators, mark active plans/goals and retained schedules as archived, and append one bounded explanatory note to the root. Completed goals retain their completed status. Original transcript entries, ownership and historical usage are not rewritten.
5. Commit the entire root closure once. A pre-commit failure leaves that closure unchanged. A successful commit whose acknowledgement is lost is recognized from persisted terminal/archive state on reopening, without duplicate notes or recovery records. Different roots are separate atomic units.

The public note reports the archival boundary and unconfirmed external effects, not raw task arguments, tool output, credentials, partial text or recovery records. An unfinished task is **not evidence that its external effects failed or were rolled back**. Inspect the real external system before considering any new action. Native unknown receipts are not reclassified or replayed by this migration.

The migration scope is cataloged legacy roots and their owned descendants, matching the bundled historical create/fork/subagent paths. It is not a scan-and-repair utility for arbitrary unregistered ownerless roots created by third-party code.

### Explicit bound and failure ownership

A complete encoded root-closure operation larger than **256 MiB** fails closed before its first commit. Do not split it into partial quarantine writes or raise the limit silently. If a real database reaches this bound, stop startup, preserve an offline backup, and design a separately reviewed migration/Storage capacity change that retains root atomicity.

Startup cleanup must close whichever component owns Storage. Failure to prove cleanup retains writer fencing; it is not permission to remove lease files or launch a second writer. No journal `user_version` change, private SQLite-table patch or vendor modification is part of D9a.

## Upgrade and rollback

Use [DEPLOYMENT.md](DEPLOYMENT.md), including stopping the service, waiting for both leases to close, and taking an offline backup **before the first D9a startup**. Do not use a checkout or live production data as a test fixture.

A code revert alone does not resurrect quarantined tasks. Their complete records remain private recovery data, not a supported import/resume interface. To restore the pre-upgrade product/data pair, stop the service, keep the post-upgrade data as a separate backup, and restore the matching pre-upgrade backup with `scripts/data.mjs restore` before starting the old release. This discards post-backup application changes from the restored copy; the operator must explicitly accept that loss. Do not merge SQLite files or automatically replay externally uncertain work after rollback.

D9b deletes the inventoried legacy execution bodies and service loader, not persisted history or definitions. It does not change the journal version or add a data migration. Returning from D9b to D9a (`9562e79`) can open the same post-D9b data without restoring a backup; this was checked with synthetic data in kernel-off, kernel-on and storage-worker modes. D9a still quarantines legacy work, so this code rollback does **not** resurrect archived tasks. The offline backup/restore procedure above applies when returning to a pre-D9a product/data pair.

D9c deletes only the inventoried repository extension modules and their exclusive tests/helpers. It changes no persistent format and adds no migration: D9b (`2676e7f`) and D9a (`9562e79`) can reopen post-D9c data without a restore, and still quarantine rather than resurrect old work. User drop-in source and enabled/disabled records, `PocketHost` types, independent Approvals/Lancet/parser tests, public Storage/Harness, historical task identities/versions/input/checkpoint/result shapes and private archive documents remain. Definitions needed to decode history are not permission to execute it. See the [D9c deletion inventory](performance/review-2026-10-23/d9c-inventory.md), [D9b inventory](performance/review-2026-10-23/d9b-inventory.md) and [D9b validation](performance/review-2026-10-23/d9b-validation.md).

## Evidence and fixture boundaries

- `test/legacy-archive.test.ts`: pinned nonempty old-version data, deep ownership, whole-closure failure atomicity, lost-acknowledgement idempotence, startup cleanup and early mutation rejection.
- `test/legacy-archive-ui.test.ts`: real Chromium, stream and poll delivery, read-only controls and switching back to native composition. This uses presentation fixtures; startup correctness is proved separately above.
- Historical read fixtures append explicit public records; they never invoke the old application or pretend those records were native inference.
- `openNativeApp` is native **metadata-only**, with an unreachable loopback model endpoint. Real execution is proved separately by the loopback `team-kernel-proof.ts` and `native-commands-proof.ts`, with storage worker off and on.
- [Fixture provenance](performance/review-2026-10-23/d9a-fixture-provenance.md) records the old source revision, hashes, offline materialization and manual regeneration. The default suite reads the saved artifact; it neither uses `.git` nor runs historical code.
- [Test migration map](performance/review-2026-10-23/d9a-test-migration.md) distinguishes preserved independent assertions, native replacements and retired behavior.
