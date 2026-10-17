# Measure full-history visits during room view projection

Third experiment in this climb batch: stage-3 measurement only. `Room.push` already sends only new entries and omits
unchanged slow fields, but it still loops over every Durable entry to rebuild order for every projected view. Publish
only the number of entries visited while a controlled benchmark subscribes. No entry content, session ID, tab/user
identity, production journal field, protocol behavior or timing window changes.

Report `view.entry.visits` for session open, warm/paced turn, and web open. It is a CPU work counter. Existing
`push.view.count/bytes` remain the transport evidence. Browser JSON counters remain excluded as before; this counter
is emitted by the server projection itself.

## Two-times baseline

Five fresh runs per report on macOS arm64 / Apple M1 eight cores / Node 24.18.0; timing lock `highLoad: false`.
Reports `/tmp/rt-view-visits-a.json` (load 2.27→3.38) and `/tmp/rt-view-visits-b.json` (3.03→2.28).

| Scenario     | Entry visits in every run | Existing relevant fixture                 |
| ------------ | ------------------------: | ----------------------------------------- |
| Session open |                        56 | seeded 12-turn session; first full view   |
| Warm turn    |                         8 | fresh session's second prompt             |
| Paced turn   |                        82 | third prompt, repeated streaming views    |
| Web open     |                        28 | seeded session until final answer appears |

Counts have zero spread across ten runs. They show real repeated traversal, especially streaming, but current fixtures
are small: they do not establish large-history scaling or user-visible latency. `web.open` is roughly 125–149 ms and
paces no answer during open; no causal claim is made. The counter also does not yet separate per-client fanout,
`projectStats` reverse scans, order allocation or browser Map copies.

Registered four candidates from both reports. Ledger guard and ratchet check pass; no promotion, raise or tolerance
change. `npm run check`, `npm run lint`, `npm run format:check` and seven ratchet tests pass. Full product tests passed
before this content-free instrumentation in the same batch (440 tests); targeted performance/journal tests and type/lint
cover the instrument. No service, account, UI or deployment used.

## Decision and next action

Keep the instrument. It is not an optimisation and reaches no L1/L2/L3 level. Next batch should add a long-history
and multi-tab workload under new keys, then remove repeated full-order/history visits with an explicit revisioned
projection. Entry deltas already exist; do not redesign durability. The first candidate change is server-side cached
order plus append/reset invalidation, followed by protocol/client copy work only if its own counters justify it.
