# Batch fresh Git metadata

## Question and change

Can normal Changes/list and diff requests launch fewer Git processes without caching mutable repository state?
`git rev-parse --show-toplevel HEAD --abbrev-ref HEAD` emits root, OID, then branch in one process. Decode only the
last two lines as metadata so repository paths containing newlines remain intact. Keep porcelain-v1 status, prefix
permission filtering, numstat and actual diff commands unchanged. No TTL, watcher, new status protocol or larger
buffer/timeout is introduced. Each request still reads Git again.

Unborn/ambiguous/unusual HEAD output falls back to the original scalar reads rather than guessing from failed or
partial output. This exceptional path performs one extra attempted metadata command; outside-Git failure similarly
has an extra attempt. This is a retained limitation, not an all-path speed claim. A scoped path retains its separate
prefix query. Revert/mutating Git paths are unchanged.

## Method and numbers

Baseline measurement registration: [git-diff-measurement](2026-10-17-git-diff-measurement.md), commit `03c9795`.
Both baseline and head include the same existing user dirty files and the same instrument/workload. Five fresh runs
per report under the timing lock; macOS arm64 / Apple M1 eight cores / Node 24.18.0.

| Item                  | Baseline-b     | Head           | Interpretation                      |
| --------------------- | -------------- | -------------- | ----------------------------------- |
| Git listing processes | 5 each run     | 3 each run     | L1, 40% fewer launches              |
| Git diff processes    | 4 each run     | 3 each run     | L1, 25% fewer launches              |
| Diff response bytes   | 1,195 each run | 1,195 each run | Same asserted fixture content       |
| Listing time median   | 264.8 ms       | 217.0 ms       | Comparison says `noise`, not faster |
| Diff time median      | 202.4 ms       | 165.9 ms       | Comparison says `noise`, not faster |
| Load before → after   | 18.85 → 12.73  | 4.46 → 3.16    | Baseline highLoad true; head false  |

Reports: `/tmp/rt-phase1-base-b.json`, `/tmp/rt-phase1-git-head.json`. Comparison/check outputs:
`/tmp/rt-phase1-git-compare.txt`, `/tmp/rt-phase1-git-check.txt`. Baseline load and overlapping/spread timings prevent
an L2 claim. No production deployment or L3 check.

Removed work is two metadata process launches per ordinary listing and one per ordinary diff, not work moved outside
the window/process. No historical JSON/SQL reduction is claimed here. Unrelated warm-turn pushes/SQL and browser
counters varied with timing; the head ratchet passes gates but retains 28 candidate warnings versus the old ledger.
These are not silently raised, nor attributed to this Git-only change.

## Validation and decision

- `node --test test/changes-metadata.test.ts test/changes.test.ts`: 16 passed. Covers fresh external branch/commit
  changes, detached/unborn HEAD, staged/untracked content, newline/tab paths, linked worktrees, scoped visibility,
  literal patterns, rename diffs, symlink attribution and outside-Git errors.
- The four new metadata fixtures passed on the original implementation before optimisation.
- `npm run check && npm run lint && npm test`: passed, 438 tests, zero failures/skips.
- `perf:check` passed; `perf:propose --write` tightened the Git gate 5→3 and Git diff candidate process counts 4→3;
  no promotion/raise. Its incidental lower candidate baselines (startup rows, body/stringify bytes) are automatic
  ratchet proposals, not claimed optimisation wins. Ledger guard passed.

Keep for L1 work reduction. No claim of measured faster latency. Further quiet paired timing is needed for L2.
Next independent hypothesis: avoid decoding already-mirrored native journal history on each progress notification.
