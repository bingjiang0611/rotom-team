# Large-history, multi-tab room projection baseline

First experiment in the third climb batch: measurement only. The earlier small fixture proved that every `Room.push`
walks the Durable entry array, but did not show large-history or client fanout. Add separate scenario keys after every
existing scenario so their inputs stay unchanged:

- seed a new 64-turn native session with deliberately short 120-character answers;
- open four real event-stream tabs sequentially;
- keep all four attached for one normal 6,000-character answer paced in 30 chunks.

The server, Durable journal, HTTP/SSE path, coalescing timer and synthetic-account boundary are unchanged. Short seed
answers control benchmark runtime; the entry counter and push count imply 132 active Durable entries at open.

## Two-times baseline

Five fresh runs per report on macOS arm64 / Apple M1 eight cores / Node 24.18.0. Timing lock reported `highLoad:
false`. Reports: `/tmp/rt-projection-large-base-a.json` (load 1.69→2.98) and
`/tmp/rt-projection-large-base-b.json` (2.98→2.62).

| Scenario                | Median duration A / B | Entry visits (all ten runs) | View pushes (all ten runs) |
| ----------------------- | --------------------: | --------------------------: | -------------------------: |
| Open four tabs          |        49.5 / 47.1 ms |                       1,848 |                         14 |
| Paced answer, four tabs |      881.2 / 881.8 ms |                       4,792 |                         36 |

The entry counter is stable with zero spread and exposes exact fanout: opening a tab also refreshes every existing tab,
so the four sequential opens produce 1+2+3+4=10 immediate full-history visits plus four quiet-window pushes;
paced streaming produces nine pushes for each of four tabs. The paced duration is deliberately dominated by 30×25 ms model pacing, so it is not latency
correlation evidence. The open scenario is a useful waiting-path benchmark, but ten timings are still noise evidence,
not an optimisation result.

All newly reported metrics were registered as candidates from both reports. Ledger guard and ratchet check pass; no
promotion or tolerance increase. Type check, lint and ratchet tests passed before measurement. No service, real model
account, production data or browser UI was used.

## Decision

Proceed with one hypothesis: cache only the immutable projected entry sequence/order at the Room level and rebuild it
when the Durable entries array identity changes. Keep per-client `sentEntries`, full/reset behavior, live/inbox/stats,
doc fields and SSE payload behavior unchanged. The removed work must be visible as fewer `view.entry.visits`; no
wire-protocol redesign is justified yet.
