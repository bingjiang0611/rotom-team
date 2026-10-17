# Measure residual room projection scans

Third experiment in the third climb batch: measurement only. The Room sequence cache removed repeated source
projection/order construction, but `Room.push` still walks the cached visible sequence for each client and
`projectStats` walks source entries backwards looking for the newest usable usage record. Count both independently so
the prior L1 claim is not mistaken for eliminating all history-proportional work.

Signals are content-free integer counts, published only while a subscriber exists. The daily performance journal does
not subscribe and its schema is unchanged. Existing entry-visit semantics remain actual source entries projected on
cache rebuild. No behavior, payload, permissions, durability, timing window or protocol changes.

## Two-times baseline

Five fresh runs per report on macOS arm64 / Apple M1 eight cores / Node 24.18.0, both `highLoad: false`.
`/tmp/rt-projection-residual-a.json` load 2.01→3.28; `/tmp/rt-projection-residual-b.json` 3.00→2.88.
All counts below have zero spread across ten runs.

| Scenario              | Source projection visits | Per-client visible-entry scans | Stats source-entry scans |
| --------------------- | -----------------------: | -----------------------------: | -----------------------: |
| Four-tab open         |                      132 |                          1,792 |                    1,848 |
| Four-tab paced answer |                      267 |                          4,648 |                    4,792 |

The cache removed the dominant old source projection count (1,848/4,792 before; 132/267 now), but two equally
history/fanout-shaped loops remain. The visible-entry count is slightly lower because system/bookkeeping entries do
not project. Stats normally scans almost the complete history because the synthetic native entries in this fixture do
not carry a recognized per-entry usage payload; aggregate cost/cache rate still comes from the usage document.

Registered new metrics for the established session-open, warm/paced turn, web-open and large projection scenarios from
both reports. Ledger guard and ratchet check pass; no promotion or tolerance increase. Type check, lint and 20 targeted
projection/cache/ratchet tests pass. No service, real account, production data, browser UI or deployment used.

## Decision and next action

Keep the measurement. It is not an optimization and reaches no L1/L2/L3 level. This batch stops at three experiments.
Next batch should first cache stats by immutable entries array plus usage-doc identity, because its output is room-wide
and has a simple exact invalidation boundary. Per-client scans require a more careful append/reset cursor so full
reconnect, hidden entries and each tab's independent sent state remain exact; do that only after stats work. Protocol
pagination/versioning still lacks evidence that payload bytes, rather than these server loops, are the next win.
