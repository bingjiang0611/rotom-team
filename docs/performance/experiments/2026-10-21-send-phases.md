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

## Change: push the first change at once, answer a waiting poll at once

`src/server/room.ts` `schedule()` still sends at most one push per client every 90 ms, but after a quiet spell the
first change goes out on the next timer turn instead of 90 ms later. A full `pushAll` (a tab attaching) now cancels a
scheduled push, which would find nothing new. `src/server/http/events.ts` answers a waiting long poll once the current
synchronous burst of events is queued (timer 0) instead of after a 30 ms pause.

`perf:ci -- HEAD --runs 5` (base and head alternating, same benchmark, `highLoad: false`), medians in ms:

| Phase                         | poll before | poll after | stream before | stream after |
| ----------------------------- | ----------: | ---------: | ------------: | -----------: |
| first reply chunk on the wire |        1187 |       1094 |          1169 |         1084 |
| **first reply chunk painted** |    **1228** |   **1108** |      **1183** |     **1089** |
| own message on the wire       |         107 |        106 |           106 |          107 |
| **own message painted**       |     **151** |    **116** |       **116** |      **119** |

Every head run of `reply.first` is faster than every base run on both transports: −120 ms on poll (−90 ms
coalescing, −30 ms poll pause) and −94 ms on the event stream. `send.shown` gains about 35 ms on poll (the poll pause)
and nothing on the event stream. The own message does not wait on coalescing: it reaches the view only when the
native process journals the user entry (`onProgress` → `mirror` in `team-kernel.ts`), about 100 ms after Enter here.
Showing it sooner needs the optimistic display by `requestId` (Proposal 2), not push timing.

Work that grew, all necessary for the earlier push: a burst that starts after a quiet spell now goes out in two pushes
(the first change at once, the rest at most 90 ms later) instead of one. That is one extra push per client per such
burst: about 7–14 more SQL statements and up to 50 KB more JSON parsed (`turn.warm` 143 → 157 statements, view pushes
1 → 2; `web.send.*` 18 → 24–26 view pushes). The push rate during streaming is unchanged (still one per 90 ms at
most). Opening a session does less: `session.open` 61 → 46 statements and 2 → 1 view pushes,
`projection.large.open` 123 → 98, because a full push now cancels the redundant scheduled one. Poll requests in
`web.send.poll` 16 → 18. The ratchet check and the ledger guard pass.

`turn.cold` was 1684 → 1751 ms in this comparison, all of it in `nativeStartRpcInitializeMs` (the rotom child
process starting). Across the other reports of the same code it overlaps: old code 1659–1724 ms, new code
1704–1751 ms, and in the first `perf:ci` (against `origin/main`) base runs 1614–1772 against head 1625–1772. Read
as noise in the child's start, not a cost of this change; not proven.

The first comparison also showed `session.open.long` doing more work. That was the benchmark: the server notices a
closed event stream on its next write, and with pushes timed differently the reference tab's departure fell inside
the counted window. Fixed in the benchmark in its own commit (push once and wait for the departure before the window).

## Change: show a native message at once, replaced by its own entry

The web app now puts a native message in the transcript the moment it is sent, marked as sending
(`.user-row.sending`), when the session is idle and the message is not a slash command. Its row stays until the
server's user entry for the same browser `requestId` and member arrives, and that entry takes its place without
sliding in again. The mirror (`team-kernel.ts`) now stores that request id in the mirrored entry's data, and the
projection sends it with user entries. A send the server refuses (an answer below 500, or
`rejected`) takes the row away and leaves the text in the box, as before. Any other failure is of unknown outcome: no
answer, a server failure, `unknown` or `interrupted`, a run that ends without the entry, or two minutes without it.
That row stays, marked "outcome unknown", with a warning, until the entry with its request id comes after all (then it
went) or the sender dismisses it; it is never shown as sent by itself and never sent again. The text stays in the box.
Durable (non-native) sessions are unchanged: their entries carry no request id.

`perf:ci -- HEAD --runs 5`, alternating, `highLoad: false`, medians in ms:

| Phase                                    | poll before | poll after | stream before | stream after |
| ---------------------------------------- | ----------: | ---------: | ------------: | -----------: |
| **message on screen** (`userEchoedMs`)   |     **116** |     **10** |       **121** |        **9** |
| server's entry on screen (`userShownMs`) |         116 |        114 |           121 |          115 |
| journal `send.shown` (`appSendShownMs`)  |         113 |        111 |           119 |          111 |
| first reply chunk painted                |        1101 |       1097 |          1097 |         1098 |

Every head run of `userEchoedMs` (6–16 ms) is below every base run (110–129 ms). Nothing else moved past noise.
Work grew by the request id in each user entry: 96–279 more pushed bytes per scenario that sends or opens a session
with native user messages. `commands.list` read 26 → 47 ms in this comparison with identical work counters; across
nine reports of this and earlier code it ranges 23–64 ms, and in an earlier comparison of this change under load the
head was the faster side. Read as noise; not proven.

The journal's `send.shown` still ends at the server's entry, not at the row the tab shows by itself: changing what it
means is a journal change for the owner to decide. In the field, the message on screen now no longer waits on the
network at all; `send.shown` keeps measuring the round trip.

`test/sending-ui.test.ts` (real Chromium, real kernel, loopback model) checks that the row shows, that only the entry
with the request id replaces it without a second slide-in, that a refused send takes it away, that a send that never
arrived stays marked unknown until dismissed, and that one whose answer was lost shows unknown, then its entry, once. It
fails with the web change removed (no sending row) and with the request id removed from the mirror.

## Next

1. Add injected round-trip latency (for example 150 ms per request) to `web.send.poll`, under a new key, to see whether
   poll reconnects make up the real 1.2 s `send.shown`.
2. Decide whether the journal's `send.shown` should end at the row the tab shows by itself.
3. Confirm in the journal after deployment: current-release `reply.first` on poll, once the group has 30 samples.
