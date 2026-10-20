# Program 2, step 1: keep each session's Pi edits, share fresh Git runs

## Hypothesis

The journal's largest Changes cost (139 listings, 26.75 s, 2026-10-19 snapshot) is the server folding a session's
**whole history** on every listing, per tab, on every 4-8 s browser poll; with images in history, every image's
stored JSON is parsed again. Git runs once per tab, too. Keeping the fold and joining concurrent Git runs should
remove the repeat parsing and half the Git processes without changing any answer, protocol or permission.

## Instrument (separate commit `95c3836`)

`changes.poll.images`: after the image scenarios, the 24-entry image session (each entry a 1024×640 PNG) is listed
by four concurrent tabs, then by the same four again with nothing changed. Every answer must be identical. Counters
include `json.parse.chars`, `subprocess.git` and HTTP bytes. One pre-change run at load 1.98 (`highLoad: false`):
638 ms, 504,775,744 parsed characters, 24 Git processes for 8 listings.

## Change (`3860e40`)

1. `changes.ts`: the edit fold becomes `PiEditLog`, which takes entries one at a time. It keeps recorded paths with
   their first and last edit and resolves them per request, so symlink changes behave as before, and returns exactly
   what setting every edit in order on a map gave (same order and newest reply, path aliases included). The Git part
   (`repositoryChanges`) is split from matching Pi's edits (`withPiEdits`); `changesIn` keeps its old signature.
2. `transcripts.ts`: `entriesAfter(id, after)` reads with Durable's `minEntryId`. Entry ids are safe as a high-water
   mark: Durable mints them inside commits serialized on its one mutation line, a commit is visible whole or not at
   all, and entries are never updated or deleted (no `UPDATE`/`DELETE FROM entries` in its SQLite storage).
3. `workspace.ts`: each session's log is kept, at most 32 sessions (least recently used dropped) and 100,000 calls and
   paths each; a larger one is folded again per request instead of kept. Each request catches its log up first.
4. `fresh-runs.ts`: concurrent identical requests (Git per folder and scope, catch-up per session) share one run
   **only if it has not started yet**. A caller arriving while a run is going waits for the next one, so no answer
   is older than its request (for example a Changes request right after a revert never gets the pre-revert list).
   Permission checks (`requireSee`, `requireSteer`) and the invited-guest folder scope still run on every request.

Where the removed work went: repeat reads of unchanged history are gone, not moved. The first listing of a session
after a server start still folds the whole history once (the remaining 63 MB parse here). Git still runs on every
request; concurrent requests of one folder share at most two runs (the one going and the one queued behind it).

## Results

Alternating three-run `perf:ci -- 95c3836` (`timing-run.mjs p2-ci`, load 1.96→3.42, **highLoad: false**), ledger
guard passed; plus an independent three-run head report (`p2-repeat`, load 2.68→3.22, `highLoad: false`).

| Measure                                              |        Base |                          Head | Level                                                                                                                            |
| ---------------------------------------------------- | ----------: | ----------------------------: | -------------------------------------------------------------------------------------------------------------------------------- |
| `changes.poll.images` parsed characters              | 504,775,744 |           63,097,108 (−87.5%) | L1                                                                                                                               |
| `changes.poll.images` Durable SQL rows / parse calls |   208 / 208 |                       40 / 40 | L1                                                                                                                               |
| `changes.poll.images` Git processes (8 listings)     |          24 |                            12 | L1                                                                                                                               |
| `changes.poll.images` time, median                   |    633.6 ms |     388.2 ms (`faster`, −39%) | **L2**                                                                                                                           |
| repeat head report                                   |           — | 367.4–407.1 ms, same counters | agrees                                                                                                                           |
| `git.changes` (one listing, small history)           |    132.9 ms |                      212.2 ms | noise (head runs 221.1 / 212.2 / 135.6; same counters except +563 stringify chars from the guard test file's harness, see below) |

Other counters that rose between base and head:

- `session.open` second view flush (+16 SQL, +123,642 parsed chars in the median). Pre-existing and bimodal: base
  runs of this and earlier comparisons show 1 or 2 view pushes too (e.g. `ffe763a` base `[1,1,2]`, `58fa3ce` base
  `[2,2,2]`). This change does not touch the session-open path. Not attributed to it; still not explained.
- `git.changes/json.stringify.chars` 2,542→3,105 median, varying by run; `commands.discover.warm` +34,
  `web.open/cdp.Nodes` +24: same small, unattributed drifts as in Program 1's acceptance.

## Tests and controls

`test/changes-incremental.test.ts`:

- The kept fold equals the old whole-history fold at **every** split point of a history with aliases (`a.txt`,
  `./a.txt`, `sub/../c.txt`), absolute paths, failed and orphaned script calls.
- `FreshRuns`: callers during a run share the queued next run, never the running one; idle keys are forgotten;
  a failed run does not fail the one queued behind it.
- Through the real app and Git: the first listing folds the whole history; after a new edit and a person's change,
  four concurrent listings agree, show the new edit, read at most twice, and the read starts after the last seen id;
  a further listing with nothing new reads zero entries and answers the same.
- Controls: with the high-water mark not stored, the app test fails; with callers allowed to join a running run,
  the freshness test fails.

`npm run format:check`, `check`, `lint`, `npm test` (**513 pass**). The existing `changes.test.ts` and
`changes-metadata.test.ts` suites (symlinks, guest scope, renames, unborn branches, linked worktrees) pass unchanged.

## Ledger

48 `changes.poll.images` counters registered as candidates from the two head reports (none gating); `perf:propose
--write` tightened 39 existing candidate baselines (`turn.paced`, `turn.prepared`, two others). Guard passed; nothing
raised or promoted.

## Not done here

Watch-driven Git with a pushed `changes` event, session-list deltas, one stream per tab, browser-side cached views and
paged history change the client protocol or store transcripts in the browser. The proposal names these as owner
decisions; they wait for the owner's answers. The first fold after restart still parses every image entry: avoiding
it needs a Durable read that skips image payloads, which this fork does not change.
