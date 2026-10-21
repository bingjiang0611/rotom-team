# Send, message shown, first reply: a phased benchmark (2026-10-21)

Measurement only: no product code changed. Revision `3922102` plus the new scenarios, macOS arm64, 8 cores, two
`perf:measure --runs 5` reports at different times under the timing lock (`highLoad: false` both). Level reached:
**L1** (synthetic model, loopback server, headless Chromium).

## What it measures

`web.send.poll` and `web.send.stream` (`test/perf/send-phases.ts`), last in `scenarios.ts` so nothing before them
changes. Headless Chromium opens the History session on `perf-remote.test` (mapped to 127.0.0.1 inside Chromium only),
so the web app picks its transport as it does for a remote member: long polling when told to, the event stream
otherwise. The page focuses the message box, which warms the native process, then types and presses Enter. The
synthetic model waits `SPLIT_FIRST_OUTPUT_MS` (1000 ms) before its first chunk, as a real model thinks first; that
chunk starts with a reply marker.

Every phase is milliseconds after the Enter key event, on one clock. Page stamps are mapped over DevTools
(`clockUncertaintyMs` ≤ 2 ms in every run). Server stamps come from `kernelRunChannel` and from a second (Node) tab on
the event stream that notes when each marker is on the wire. `appSendShownMs` / `appReplyFirstMs` are the app's own
`send.shown` / `reply.first` (`web/perf.js`), the numbers the daily journal holds. They agree with the page's own
`userShownMs` / `replyShownMs` to within 5 ms, so this benchmark measures the same waits as the journal.

## Results (median of 10 runs, ms after Enter)

| Phase                                             |     poll |   stream | Where  |
| ------------------------------------------------- | -------: | -------: | ------ |
| submit request sent                               |        3 |        3 | page   |
| run admitted                                      |        9 |        8 | server |
| submit answered                                   |       20 |       26 | page   |
| prompt dispatched to the warm process             |       53 |       44 | server |
| own message on the wire                           |      106 |      107 | server |
| own message reaches the page                      |      140 |      106 | page   |
| **own message painted** (`send.shown`)            |  **150** |  **114** | page   |
| model's first output (includes the 1000 ms pause) |     1089 |     1069 | server |
| first reply chunk on the wire                     |     1183 |     1164 | server |
| first reply chunk reaches the page                |     1217 |     1163 | page   |
| **first reply chunk painted** (`reply.first`)     | **1230** | **1172** | page   |

Across the ten runs every phase stays within about 40 ms (the widest is dispatch, 41–77 ms on poll). Counters
were registered as `candidate` entries in `test/perf/ledger.json`. On poll, push counts vary by one or two events in
one run of ten (90 ms coalescing, as in `turn.paced`). `push.*.bytes` count event-stream frames only (poll frames are
`null`), so poll and stream bytes are not comparable.

## What the phases say

- **About 95 ms between "the server has it" and "the server pushes it", twice.** The own message goes out about 97 ms
  after the run is admitted. The first reply chunk goes out about 94 ms after the model's first output. The likely
  cause is the room's 90 ms push coalescing (`schedule()` in `src/server/room.ts`). That is inferred from the size of
  the gap, not yet proven by turning it off.
- **Long polling adds about 34 ms per hop** over the event stream: the poller's 30 ms burst pause (`answerPoll` in
  `src/server/http/events.ts`), plus the answer and the next request.
- **Paint takes 8–13 ms.** Submit, admission and dispatch together take under 60 ms.
- In this setup the part the server controls is about 150 ms of `send.shown` and about 140 ms of `reply.first` on top
  of the model. The journal's current-release medians are 1.22 s (`send.shown`) and 11.19 s (`reply.first`), both
  under 30 samples. Most of the real `send.shown` gap is therefore outside what loopback can show: the remote member's
  network and proxy round trips, a poll answer that is already in flight, a larger session view, or a slower device.
  This is unverified, and needs a field measurement or a scenario with injected latency to decide.

## Next

1. Turn the 90 ms coalescing off for the first push after a send (own message) and for the first delta of a reply, and
   check whether ~95 ms leaves both phases (expected L1 win: ~190 ms across the two waits, on both transports).
2. Answer a waiting poll at once for those two events instead of after the 30 ms burst pause.
3. Add injected round-trip latency (for example 150 ms per request) to `web.send.poll`, under a new key, to see whether
   poll reconnects make up the real 1.2 s.
