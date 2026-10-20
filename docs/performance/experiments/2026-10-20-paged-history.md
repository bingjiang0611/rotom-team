# Program 2, step 5: paged history

## Owner choice and scope

The owner chose paged history: send the newest entries first and load earlier ones as the reader scrolls up. Export and
search still read the whole history. This step does that. It does not change the journal, Durable stored data,
credentials, native execution or permission checks. No production service, real model account, push or deployment was
used.

## Measurement first (`18b0d39`)

Three scenarios, appended after all others (including `web.reopen`) so earlier inputs stay unchanged:

- `session.open.long`: a separate native history of 300 user/assistant turns (600 entries, 1,200-character answers),
  seeded directly into the Durable mirror as the native backend stores it (no model). A new event-stream tab connects
  with `tail=240`, as the web app now does, until its full view. Every entry it received must equal the same entry of an
  unpaged reference view taken just before, and the order must be identical. Old servers ignore `tail` and send all.
- `session.history.earlier`: that tab then reads every entry it lacks, page by page (`GET /api/c/:id/entries`), until
  it holds the whole history, and checks each entry against the reference. On a server that sent everything it asks
  nothing. This is the cost moved out of the open: the scenario exists so the moved work stays visible.
- `web.open.long`: headless Chromium opens the long session until its newest answer is in the page.

Before the change (`/tmp/rt-p2-page-baseline.json`, 3 runs, load 3.7 → 3.0): `session.open.long` pushed 422,380 bytes;
`web.open.long` pushed 416,525 bytes and parsed 416,334 event characters in the page, 134–159 ms.

A separate measurement fix (`a0c54ee`): the ledger passed one megabyte with step 4, and `perf:ci` read the base's ledger
through `git show` with Node's default 1 MiB output limit. The overflow was caught as "no ledger", so `perf:ci` reported
"predates the performance benchmark" and exited 0 without comparing. It now allows 256 MiB, and only a base where the
file does not exist counts as predating; any other git failure fails the run. `checkout.ts` got the same limit.

## Implementation (`326e431`)

- **Server** (`src/server/room.ts`, `src/server/http/events.ts`, `src/server/http/conversation-routes.ts`):
    - A connection may ask for `tail=<n>` (1–100,000; anything else is ignored and the tab gets everything). Its view
      still carries the whole `order`, but sends only entries from position `order.length − n` on, plus `start` on a
      full view. Later updates scan from `max(appended-from, floor)`, so a new entry is still a one-entry delta and
      nothing older comes with it. An entry a tab holds is never sent again, as before. A claim (step 4) still applies.
    - `GET /api/c/:id/entries?before=<entry id>&limit=<1..200>` returns up to 200 entries just before that entry in the
      room's current order, oldest first, from the room's own projection: byte-identical to what a view sends. It is in
      the conversation routes, behind the same visibility check as every read of the session, and in the native
      backend's read-only list. An id not in the order returns nothing (the tab's order is stale; a view on its way
      corrects it). The room is opened and released as for any read.
- **Browser** (`web/store.js`, `web/transcript.js`, `web/sheets/find.js`, `web/sheets/viewers.js`, `web/chat.js`,
  `web/app.js`, `web/sheets/menu.js`, `web/view-cache.js`):
    - `TRANSCRIPT_TAIL = 240` entries on connect (the transcript shows 60 rows; 240 entries leaves room for tool
      results between them).
    - `heldFrom(view)`: where the gap-free run of held entries starts. `loadEarlier()` reads one page before it, one
      request at a time per position, and merges only entries still in the order. `loadAllEntries()` repeats until
      nothing is missing or a page adds nothing (at most 100 pages).
    - The transcript's "Show earlier messages" divider shows while rows are hidden or entries are not held. Scrolling up
      into the top screenful, or pressing it, shows 60 more rows, reading a page first when fewer than 60 hidden rows are
      held. The rows on screen keep their place.
    - Find reads the whole view first, then pre-compaction history as before. The Outputs sheet reads the whole view;
      its count and the badges read `n+` while entries are missing. A jump to a pinned or quoted message the tab does
      not hold reads the rest first, then jumps.
    - A saved copy (step 4) now stores the newest gap-free run the tab holds, up to 400 entries; before, a gap in the
      newest 400 skipped saving. A claim after reconnecting checks only positions from `start` on.

## Tests

- `test/view-tail.test.ts` (2 tests): a tailed full view sends exactly the newest 5 entries and the whole order; pages
  equal the unpaged view's entries; the first page stops at the start; an unknown id returns nothing; a new entry is a
  one-entry delta. Over HTTP: page contents, 400 for a missing, zero, non-numeric, zero-limit or over-limit request, and
  a member limited to another session is refused without any entry text.
- `test/view-tail-ui.test.ts` (real Chromium, 400 user messages): the page opens holding 240, with no page request and
  without the first message. Scrolling up, as a reader does, reaches the first message through page requests, and the
  view then holds all 400 in order. After a fresh open, find lists a message the view did not send. After another,
  jumping to the third message shows it.
- Negative controls, each restored afterwards: never reading a page before showing earlier rows fails "scrolling up
  reaches the first message"; find without reading the rest times out on "find lists a message the view did not send";
  a server that ignores `tail` fails "only the newest five".
- Clean worktree at `a0c54ee`: format, check and lint pass; `npm test` 533/533 (load 2.4 → 4.7, `highLoad: false`);
  `npm run test:kernel:app` passed (no real provider).

## Results

`npm run perf:ci -- 18b0d39 --runs 3 --out /tmp/rt-p2-page-ci` in the clean worktree, load 2.9 → 4.0 on 8 cores,
`highLoad: false`. Ratchet passed; ledger guard passed.

| Counter                                   |  Before |   After | Note                                |
| ----------------------------------------- | ------: | ------: | ----------------------------------- |
| `session.open.long/push.bytes`            | 422,380 | 179,320 | −57.5%                              |
| `session.open.long/json.stringify.chars`  | 422,851 | 179,825 |                                     |
| `session.open.long/ms` (median)           |    24.7 |    17.3 | `faster`, −30% (L2)                 |
| `web.open.long/push.bytes`                | 416,525 | 173,465 | −58%                                |
| `web.open.long/web.event.parse.chars`     | 416,334 | 173,274 | parsed in the page                  |
| `web.open.long/web.view.delta.entries`    |     600 |     240 |                                     |
| `web.open.long/ms` (median)               |     134 |     135 | not faster on loopback              |
| `session.history.earlier/http.requests`   |       0 |       2 | the moved work                      |
| `session.history.earlier/http.body.bytes` |       0 | 243,098 | 179,320 + 243,098 ≈ the old 422,380 |
| `session.history.earlier/ms` (median)     |     3.4 |    18.6 | only when everything is read        |

Every other scenario's medians are unchanged or within their known bimodal spread (`web.open/cdp.Nodes` 996/972,
`session.reclaim/json.stringify.chars`, `git.changes` stringify, `turn.prepared` +51 view bytes in one base run). The
earlier scenarios do not page: their sessions are shorter than 240 entries.

**Level:** L2 for the server open of a long session's view (`session.open.long/ms` −30%, `faster`, `highLoad: false`):
it serialises and sends 57% less. L1 only for the browser: bytes and parsing fell by 58%, but the time to show the
newest answer on loopback is unchanged (134 → 135 ms). The page's own script time was 44 → 43 ms; the rest is fixed
page cost. The benefit should be larger on a slow link, but no slow-link scenario measures it.

Reading the whole history costs two requests and slightly more bytes than before in total, because each page repeats
the JSON envelope. Find, Outputs and jumps pay this when used; scrolling pays it a page at a time.

## Ledger

148 candidate counters registered from `/tmp/rt-p2-page-ci/head.json` and `/tmp/rt-p2-page-head2.json` (measured about
5 minutes apart, both `highLoad: false`), all as candidates. `perf:propose --write` tightened 2 baselines by 2
characters each (`session.reclaim/json.parse.chars` 129,810 → 129,808, `session.reclaim/json.parse.journalSegments.chars`
127,105 → 127,103). `node test/perf/ratchet.ts guard` against the ledger before passed. No ceiling or baseline was
raised.

## Not verified / limits

- Slow links, Safari and Firefox: unmeasured.
- Scrolling up is detected by scroll position; a reader who never scrolls (keyboard-only) uses the divider button. A
  touch device's momentum scrolling is untested.
- The server still projects the whole history once per room, as before; only sending and the browser's parsing shrink.
  Avoiding that projection needs Durable to read entries without the whole view, which is not changed here.
- "The message to Pi a reply answers" (`promptBefore`) looks only at held entries. For the oldest held reply it may not
  find its prompt until earlier entries are read.
- The Outputs and menu badges read `n+` until the whole history is read, instead of an exact count.
