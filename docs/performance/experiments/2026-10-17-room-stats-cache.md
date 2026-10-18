# Share room stats across pushes

First experiment in the fourth climb batch. Hypothesis: `projectStats` is room-wide, so cache it by the exact immutable
Durable entries array and `pi.usage` document value instead of rescanning history for every client push.

## Implementation and behavior

`Room.#projectStats` retains those two input identities and the derived `{cost, cacheRate?, contextTokens?}`. Any entry
append or head reset replaces the entries array. Any usage change replaces the usage document value. Either identity
change recomputes. Full reconnect does not invalidate room-wide data. Cache is private to one Room and cleared when it
closes, so it cannot cross conversations, forks, accounts or restarts.

A real-Harness test covers sharing across tabs, cost freshness after a usage-only commit, newest-answer context tokens,
full resend, and head reset dropping prior context tokens. Cache-disabled negative control fails (`1 !== 0` for the
second tab); unconditional stale-cache control fails after usage and append. Logs:
`/tmp/rt-stats-no-cache-control.log` and `/tmp/rt-stats-stale-control.log`.

## Base/head, five fresh runs each

macOS arm64 / Apple M1 eight cores / Node 24.18.0 / pinned rotom 0.1.25. Base
`/tmp/rt-stats-cache-base.json`, load 4.36→5.19; head `/tmp/rt-stats-cache-head.json`, load 1.50→4.12. Timing locks
reported `highLoad: false` (the lock uses its own threshold; absolute load is recorded here).

| Scenario              | Stats entry scans base → head | Duration median base → head |
| --------------------- | ----------------------------: | --------------------------: |
| Four-tab open         |                   1,848 → 132 |      47.2 → 49.6 ms (noise) |
| Four-tab paced answer |                   4,792 → 267 |    874.8 → 884.1 ms (noise) |
| Session open          |                       56 → 28 |      25.0 → 25.7 ms (noise) |
| Paced turn            |                       82 → 19 |    880.8 → 885.4 ms (noise) |

All work counts have zero spread. Reductions on the large scenarios are 92.9% and 94.4%. Warm remains 8 because each
new user/assistant entry changes the exact entries input. `web.open` 28→0 reuses the Room stats computed in the earlier
session-open scenario; the work remains counted there. View payload behavior is unchanged. One unrelated native verify
subspan compares `faster`; this change cannot cause it and receives no L2 credit. The prepared-turn push-byte increase
is unrelated run variability and no tightened ledger entry records it.

`perf:check`, `perf:propose --write` and ledger guard pass. The five stats candidates are tightened; propose also
mechanically lowered four unrelated JSON candidate baselines, not credited as cache wins. Type check, lint, targeted
projection/cache tests and the full product verification are recorded with the batch close.

## Decision

Keep as **L1 only**. No controlled duration or production L3 improvement is claimed. Removed stats scans are done once
per exact input revision, not shifted outside the window. Next experiment may target per-client visible-entry scans,
but must preserve independent sent state, full resend, append, hidden entries and head-reset order exactly.
