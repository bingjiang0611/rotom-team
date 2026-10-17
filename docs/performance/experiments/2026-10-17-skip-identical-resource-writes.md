# Skip identical managed-resource writes

## Hypothesis

`prepareTeamResources` must still validate source policy, package resolution, managed/unmanaged collisions, removals,
digests and permissions on every cold startup. It does not need to replace a private regular managed file when its
current bytes exactly equal newly derived bytes. Compare only with `lstat`-proven non-symlink regular files at mode
0600; public-mode legacy files still take the original private atomic replacement path even when bytes match.
Changed/new/retiring files retain the original writes/removals.

Work is not moved outside the benchmark: the identical write, temporary file and rename are not done. Derivation,
reads, comparisons and later native loading still happen. The per-run gate file remains new and written once.

## Before and after

Baseline reports `/tmp/rt-resource-writes-a.json` and `/tmp/rt-resource-writes-b.json` each have five fresh runs,
registered at two different times. Head `/tmp/rt-resource-writes-head.json` has five fresh runs. macOS arm64 / Apple
M1 eight cores / Node 24.18.0; timing lock `highLoad: false` for all. Same cold explicit discovery workload and
instrument, loopback model only.

| Counter/phase               | Baseline (all ten runs) | Head (all five runs) | Result                            |
| --------------------------- | ----------------------: | -------------------: | --------------------------------- |
| Parent synchronous writes   |                       4 |                    1 | L1: 3 writes not done             |
| Bytes given to writes       |                   1,213 |                  396 | L1: 817 bytes not rewritten       |
| Atomic renames              |                       3 |                    0 | L1: 3 replacements not done       |
| Resource preparation median |        72.9 ms (base B) |              67.3 ms | `noise`, about -8%                |
| Cold discovery median       |              1,726.2 ms |           1,668.2 ms | `noise`, about -3%                |
| Native initialize median    |              1,592.5 ms |           1,542.6 ms | `noise`, variation not attributed |

Comparison: `/tmp/rt-resource-writes-compare.txt`. The same report shows no meaningful warm/prepared regression;
all milliseconds are `noise`. No L2/L3 claim. Native initialization remains about 1.5 seconds and dominates.

## Verification and controls

- Added a direct fixture: a second identical preparation keeps settings/resource-view inode and mtime and mode 0600;
  changing settings/resources is already covered by add/change/remove tests. Changing settings mode to 0644 causes
  an atomic rewrite back to 0600 even when bytes match.
- Negative control forces the old unconditional rewrite; the inode assertion fails exactly
  (`/tmp/rt-resource-write-negative-control.log`). Restored code passes.
- `node --test test/rotom-resources.test.ts test/team-resource-backup.test.ts`: 14 passed during implementation;
  final targeted resource run: 13 passed after keeping the existing backup test separate.
- `npm run check`, `npm run lint`, `npm run format:check` pass.
- Full `npm test`: 440 passed. Synthetic `test:kernel:app` reports `status: passed`, 82 loopback requests; its printed
  configuration-staging error is the intentional fixture. No real provider/UI/service.
- `perf:check` on head passes. `perf:propose --write` lowers the three write candidates to 1/396/0; ledger guard
  passes. It also mechanically lowers three variable prepared-turn candidates from the report; those are not claimed
  optimisation wins. Old write results correctly report the new candidates as `worse`, but candidates do not gate;
  no promotion or tolerance change was made.

Decision: keep for L1. Do not claim faster cold startup. A larger change inside the pinned native launcher would alter
the trusted-native boundary and is not made autonomously. Next safe program-3 step is measure server view projection
visits and copy/fanout work before choosing incremental protocol changes.
