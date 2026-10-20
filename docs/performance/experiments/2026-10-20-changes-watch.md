# Program 2, step 2: tell open Changes tabs when the repository moves

## Owner decision

The owner chose server push plus a slow fallback read for Changes, session-list deltas, a browser cache of recent
views that is cleared on sign-out, and paged history (2026-10-20). One stream per tab was not chosen. This step
implements only the first choice.

## Hypothesis

An open Changes tab reads `GET changes` 1.2 s after every new entry when quiet, and every 4-8 s while Pi works, even
when the turn edits nothing; and it never notices a person's own edit until an entry arrives. Telling tabs when the
repository moves should remove the entry-driven reads and show outside edits quickly.

## Change (`fa33a24`)

- `src/server/change-watch.ts`: one recursive `fs.watch` per repository top folder (plus a linked worktree's git
  folder), shared by the sessions in it, reference counted, `persistent: false`. Only on macOS and Windows, where the
  system watches a tree cheaply; elsewhere `watching: false`. Git objects, reflogs and git lock files are ignored
  (only inside the git folder: a person's `yarn.lock` still counts). Events are told 300 ms after the last one, at
  most 2 s after the first. A watch error turns watching off and tells listeners. `git` already runs with
  `GIT_OPTIONAL_LOCKS=0`, so our own `git status` does not rewrite the index and re-trigger the watch.
- `room.ts`/`app.ts`: a room starts watching when a tab attaches, and stops when the room closes (30 s after the
  last tab) or the app closes. Each attached tab that may steer gets `changes {conversationId, watching, moved}`; a
  viewer gets nothing. The event names nothing that moved: the tab then asks `GET changes`, so permission checks and
  the guest's folder scope stay on every request.
- `web/store.js`/`web/diff.js`: tabs count moves (a reconnect counts as one). A watched, open Changes tab reads
  again on a move, after write/edit/codemode results (which may name files outside the repository), when it is shown
  or another session is opened, and every 30 s while visible. Hidden panels mark their cached answer stale instead.
  Without watching, the old entry-driven reads remain, plus the 30 s read.

Where the work went: entry-driven reads for entries that edit nothing are gone, not moved. Git now runs for real file
changes instead. New work: one watch per open room, one small event per attach and per burst of changes, and one
read per 30 s per visible open Changes panel (before, a quiet panel never re-read).

## Evidence

Chromium diagnostic (real browser and server, two runs of each client; old client = `web/diff.js` at `fffe72f`
with the same server):

| Client | Person adds a file, panel shows it | `GET changes` for that |  Six non-edit entries, 400 ms apart | Level               |
| ------ | ---------------------------------- | ---------------------- | ----------------------------------: | ------------------- |
| old    | not within 8 s (both runs)         | 0                      | 1 read (1 per 4-8 s while Pi works) |                     |
| new    | 516 ms, 463 ms                     | 1                      |                             0 reads | L1 (request counts) |

This is a functional diagnostic, not a ledger scenario: no `faster` claim. The busy-turn saving was not measured with
a model turn. `test/changes-ui.test.ts` keeps the check: with the old client it fails ("count is 1").

`perf:ci -- fffe72f --runs 3` (`timing-run.mjs p2b-ci`, load 4.14→4.19, `highLoad: false`): no `slower` timing; guard
passed. Counters that rose are the named cost: `web.open` +1 push event (+73 bytes, +50 parsed chars),
`projection.large.open` +4 events (+300 bytes, +208 stringify chars, one per tab). `session.open` fell to one view
push in this run's median (−16 SQL); that is the pre-existing bimodal second flush, not this change.
`perf:propose --write` then tightened 22 `session.open` candidates and one other to that lower mode: later two-flush
runs will show as candidate "worse" until the flush is explained. Guard passed; nothing gating, raised or promoted.

## Tests

- `test/change-watch.test.ts`: a burst of 20 writes is told once; git objects and locks alone are not told; a
  person's `yarn.lock` is; closing the last listener stops the watch; non-recursive platforms and folders outside a
  repository; through the app, an owner tab hears `moved` after a person's edit and a viewer hears nothing, and
  closing the app stops every watch.
- `test/changes-ui.test.ts` (Chromium): the open Changes tab shows a person's new file without any entry, using one
  or two reads, and four non-edit entries that reach the tab cause no read.
- `npm run format:check`, `check`, `lint`, `npm test`: **517 pass**, 0 skipped on this Mac.

## Not verified

- Linux and other platforms are not watched by design; their behaviour is the old one plus the 30 s read. Windows was
  not run.
- FSEvents dropping events under heavy load, network file systems, and very large trees (only a cost of the system
  service, not of Node, but unmeasured here).
- A real model turn with edits, and the journal effect: requires deployment, which is not authorized.
