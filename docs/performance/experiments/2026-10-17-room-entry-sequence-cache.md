# Share the projected entry sequence across room pushes

Second experiment in the third climb batch. Hypothesis: cache the projected active entry sequence and order per Room,
keyed by the immutable Durable entries array, to avoid rebuilding the same order for every tab and doc-only streaming
update. No wire-protocol or client-state change.

## Implementation and behavior

`src/server/room.ts` stores one source array reference, projected sequence, order and order key. Durable replaces the
entry array on append/head reset and preserves it for doc-only commits (confirmed in pinned Durable 1.0.2 view code and
by a real Harness test). Rebuild on any changed array, not merely length or tail. Rebuild is intentionally conservative:
even append still scans the entire source. The Room cache is cleared on close, never shared across rooms/accounts.

Per-client sent entry sets and slow-field state stay independent. Full/reconnect sends the full active sequence;
head reset still changes order and removes old entries from active display. Live state, inbox, permissions, personal
kernel projection, stats and current Git branch are read exactly as before.

Removed work is no longer done on unchanged arrays and is done once per array rather than once per tab. Cached
projected entries are still scanned for each client's missing IDs; stats and slow-field JSON work are unchanged.
The counter still counts actual Durable source entries visited, including every cache rebuild, in the same scenario
window. No production performance journal collection changed.

## Base/head, five fresh runs each

macOS arm64 / Apple M1 eight cores / Node 24.18.0 / pinned rotom 0.1.25. Base
`/tmp/rt-projection-large-base-b.json`, load 2.98→2.62; head `/tmp/rt-projection-cache-head.json`, load 2.64→3.77.
Both timing locks `highLoad: false`.

| Scenario              | Source entry visits base → head | View pushes / bytes base = head | Duration median base → head |
| --------------------- | ------------------------------: | ------------------------------: | --------------------------: |
| Four-tab open         |                     1,848 → 132 |                    14 / 112,462 |      47.1 → 49.6 ms (noise) |
| Four-tab paced answer |                     4,792 → 267 |                    36 / 190,016 |    881.8 → 879.4 ms (noise) |
| Existing session open |                         56 → 28 |                       unchanged |      25.3 → 25.2 ms (noise) |
| Existing paced turn   |                      82–83 → 19 |                       unchanged |    882.2 → 887.2 ms (noise) |

All five head visit counts agree. The four-tab reductions are 92.9% and 94.4%. Warm turn remains 8 (both user and
assistant append require rebuild). `web.open` drops 28→0 because earlier session open built the same Room's sequence;
its rebuild remains counted in `session.open`, not shifted to setup. The protocol and its payload are not reduced.
An unrelated verify subspan compares `faster`; Room caching cannot cause it, so it is not credited as L2.

## Verification and decision

- Two new real-Harness tests in `test/room-projection.test.ts`: shared sequence, tab independence, hidden system
  entries, append, doc-only usage freshness, full resend, head reset/post-reset append, fork and restart.
- Cache disabled: tests fail on repeated scans (`3 !== 0`). Cache never invalidated: append test fails (`0 !== 4`).
  Logs `/tmp/rt-projection-no-cache-control.log` and `/tmp/rt-projection-stale-control.log`; restored fix passes both tests.
- `npm run check`, `npm run lint`, `npm run format:check`, full 442 unit tests and synthetic `test:kernel:app` pass.
  Kernel proof has 82 loopback requests; its configuration-gap stack is an intentional injected fixture, and final
  report status is `passed`, `realProvider: false`, `webUiVerified: false`.
- `perf:check`, `perf:propose --write` and ledger guard pass. Candidates lowered; no gate promotion. Propose also
  mechanically lowered eleven unrelated timing-sensitive candidate baselines; those are not credited as cache wins.

Keep as **L1 only**, no L2/L3 claim. Long-history scaling beyond 64 turns, UI behavior under real accounts and Linux
remain unverified. Next measurement should separately count cached per-client scans and `projectStats` reverse scans
before attempting append cursors, stats caching, pagination or protocol changes.
