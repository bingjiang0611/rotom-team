# Proposal 2, the rest: live text deltas, stream reprobe, warm on open — 2026-10-22

## Question

Can the remaining client-side parts of proposal 2 cut what a streaming answer pushes, get remote tabs back onto the
event stream, and start the native process earlier, without new journal fields or deployment changes?

## Changes

1. **Live text deltas** (`src/server/live-delta.ts`, `room.ts`, `http/events.ts`, `web/store.js`). A tab that connects
   with `live=delta` (both transports) gets each live view with a version; a text or thinking block that only grew by
   more than 128 characters is sent as its new suffix, with `livePatch: { base, append: [{ index, at }] }`. Every
   other change (replacement, shrink, tool calls, retries, compaction) is a full snapshot, and every full view starts a
   new baseline. The browser applies a patch only when its version, block type and prefix length all match; anything
   else reconnects for a full view, read only, and never resends a message. Tabs without `live=delta` (older tabs, the
   benchmark's Node tabs) get full live state as before. The server keeps one baseline per connection in a `WeakMap`.
2. **Stream reprobe** (`web/store.js`). After a remote stream fails to deliver its first full batch in six seconds the
   tab polls, as before, but for one hour instead of 24, and it then tries the stream again by itself, without
   navigation; hidden or offline tabs wait until visible and online. The poll is closed before the stream opens, so one
   transport is active. A stream that delivers its first batch clears the saved choice. Stale 401 answers from an old
   connection no longer sign out a newer one, and a poll batch stops dispatching once a handler replaced the connection.
3. **Warm on open** (`web/store.js`). The tab asks `POST /api/c/:id/warm` after the session's first authoritative full
   view, again when an initializing session becomes ready, and on becoming visible. Composer focus stays a fallback. The
   client gates are unchanged (own account, idle, steerable, not checking, the open session) plus a visible tab; a
   declined warm no longer suppresses the fallback for four minutes. The server's admission checks and limits (one
   unused process per member, three in all, five minutes unused) are unchanged.

## Method

`npm run perf:ci -- HEAD --runs 2` (this change alone, `/tmp/rt-p2-own`, `highLoad: false`), and five alternating runs
against `origin/main` (`/tmp/rt-proposal2-final2`, `highLoad: false`; includes the earlier local commits). The
benchmark instrument fix for page-started warming is its own commit (`2026-10-22-open-warm-accounting.md`). A
throwaway real-Chromium check forced a remote-named tab onto long polling with a loopback model streaming 30 chunks.

## Numbers

Work, this change alone (base → head):

| Counter                             |  Before |                         After |
| ----------------------------------- | ------: | ----------------------------: |
| `web.paced/push.view.bytes`         |  49,847 |                27,626 (−44 %) |
| `web.paced/web.event.parse.chars`   |  50,716 |                28,515 (−44 %) |
| `web.paced/cdp.RecalcStyleCount`    |     164 |                            43 |
| `web.send.stream/push.view.bytes`   |  97,554 |                77,899 (−20 %) |
| `projection.large.paced/push.bytes` | 257,828 |                       252,228 |
| `web.open/subprocess.total`         |       0 | 1 (warm start, moved earlier) |
| `web.open/sql.statements`           |      18 |                            31 |

Long polling, throwaway check (one run each): 17 patches, one poll session (no reconnect), final text exact; poll
answer bytes 43,327 with deltas and 90,282 without (−52 %). The ledger has no poll body-byte counter (poll pushes
publish `bytes: null`), so this is not in the comparison: unmeasured there, not zero.

Milliseconds, five runs against `origin/main` (medians): `web.paced` 3447 → 921 ms; `web.send.poll` reply on screen
1212 → 1102 ms, message on screen 147 → 12 ms; `web.send.stream` reply 1185 → 1100 ms, message 115 → 12 ms. Part of
these come from the earlier local commits (quiet-start push, optimistic send). `web.paced` fell most because the open
tab is no longer rebuilding a growing 6,000-character live message per push (style recalculations 164 → 43).

## Where the work went

- Live text: not sent again. Each patch carries only new text; full state still goes on every full view.
- Warming: done earlier, not removed. Opening one's own idle session now starts a native process (about 330 MiB RSS,
  13 more SQL statements, one more HTTP request) whether or not the person sends. The instrument now charges it to the
  open that caused it.
- `turn.prewarmed`, `turn.paced` and `web.send.poll` showed higher bytes or rows in one of two runs, with the other run
  equal to the base: push timing races, not new work.

## Decision

Keep. The ratchet and ledger guard passed; baselines for 33 counters moved down (`perf:propose --write`, no ceiling or
tolerance changed).

## Limits

- L1/L2 on loopback with synthetic models. Real remote latency, proxies and tunnels are not reproduced.
- Not done, needs the owner: serving the existing TLS/HTTP/2 listener with a private trusted certificate on the
  deployment, and journaling why a tab fell back to polling (a journal change). Without the certificate, a buffering
  proxy can still force polling; the hourly reprobe only limits how long a tab stays there.
- Warm-on-open costs memory for people who open a session and do not send; the server's limits bound it.
