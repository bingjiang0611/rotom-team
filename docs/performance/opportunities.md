# Performance opportunities

Leads for the climb, each with the evidence that raised it. A lead is a question, not a finding: confirm it with a
counter or the journal before changing code. Record each tried idea here with its outcome, kept or reverted, and link
its experiment file in `experiments/`.

Workload: `test/perf/workload.ts` as of 2026-10-16 (12 seeded turns of 6000-character answers). Numbers are the
`darwin-arm64` ledger baselines (worst of 10 runs from temporary checkouts) and benchmark medians, Apple M1, load below
the core count.

## Program 2, step 3 — 2026-10-20

Session-list refreshes now send versioned changed/removed rows to opted-in tabs, with a full snapshot on first
connect, reconnect, permission refresh or a missed version. Four same-member tabs, two single-session renames:
pushed bytes 43,288 → 4,296 (−90.1%), stringify characters 44,420 → 16,162, SQL statements 49 → 43. **L1 only**;
rename latency is unchanged (~823 ms). Immediate-base and origin/main three-run comparisons passed with
`highLoad: false`. 525 final tests pass; an earlier unchanged native-watch burst test failed and its cause remains
open. Next: browser view cache, then paged history, as the owner chose.
[Experiment and compatibility-probe correction](experiments/2026-10-20-session-list-deltas.md).

## Program 2, step 2 — 2026-10-20

Open Changes tabs are told when the repository moves (macOS/Windows watch) instead of re-reading after every entry.
Chromium: a person's new file shows in ~0.5 s (was not within 8 s); six non-edit entries cause 0 reads (was 1, and
one per 4-8 s while Pi works). Cost: one small event per attach, one read per 30 s per visible open panel. L1, not
measured on a model turn. Next, as the owner chose: session-list deltas, browser view cache, paged history.
[Experiment](experiments/2026-10-20-changes-watch.md).

## Program 2, step 1 — 2026-10-20

Changes no longer folds a session's whole history per listing: each session's Pi-edit log is kept and caught up
from the last entry id, and concurrent listings share a Git run that started after they arrived. On
`changes.poll.images` (four tabs, two rounds, 24 image entries) parsed characters fall 504.8 M → 63.1 M, Git
processes 24 → 12, and time 633.6 → 388.2 ms (`faster`, `highLoad: false`): **L2**. Remaining leads here: the first
fold after a restart (Durable parses whole image records), and the client-protocol items, which wait for the
owner. [Experiment](experiments/2026-10-20-changes-edit-index.md).

## Program 1 accepted — 2026-10-20

On the combined rotom 0.1.26 tree, against a base of the first batch plus only the pin commit, a quiet alternating
three-run comparison (`highLoad: false`) gives **L2**: pasted-screenshot prepare+upload 31,365→13,837 ms (−56%) and
conditional originals 55.4→18.4 ms (−67%); repeated full originals are L1 only. 510 tests and the synthetic kernel
proof pass. 98 new counters registered as candidates from two reports. One unexplained `turn.warm` extra-flush
run (2 of 23 head runs, 0 of 15 base) stays open for Program 2. Details: [experiment](experiments/2026-10-20-bytes-remainder.md#acceptance-on-the-combined-rotom-0126-tree).

## Approved programs: second implementation batch — 2026-10-20

Program 1's selected local features are implemented; performance acceptance remains pending. Added opt-in TLS/HTTP2
(default HTTP listener unchanged), approved HTTP/2 journal coverage with unavailable wire bytes, single-copy browser
paste resizing, and byte-identical original caching with ETag/Range/HEAD. Both real Chromium protocol paths and
**510 tests** pass at runtime commit `0f411eb` / rotom 0.1.25; the synthetic kernel proof passes too.

Alternating three-run comparison vs `19f2ad5`: upload 15,482,499→6,772,807 bytes, repeat-original SQL 4→0, conditional
original response bodies 7,868,332→0 bytes. These are **L1**, not L2: `highLoad: true`, 8-core load 7.99→23.86. New
counters remain unregistered pending an independent report; no threshold or journal retention is loosened. Timing
observations on this loaded machine are not a speed claim. First calls add cache writes; Range still reads/hashes the
whole cached file. See [second-batch experiment](experiments/2026-10-20-bytes-remainder.md) for costs and open items.

Another task updated the native pin to 0.1.26 during the benchmark. Preserve those changes; this batch does not verify
the combined new-pin tree. Coding-agent next action: after that upgrade completes, revalidate and quietly remeasure,
register candidates from two reports, propose tightening and guard, then enter Program 2. Programs 2/3 remain not
started. No push, live restart, real account or deployment.

## Approved programs: first implementation batch — 2026-10-19

Program 1 is **partial**; Programs 2 and 3 have not started. Four transcript thumbnails send 7,868,332→422,503
bytes (94.6% less). Final alternating three-run comparison on a quiet-enough machine (`highLoad: false`) gives
repeated loopback retrieval 53.1→9.3 ms, and previously unrequested thumbnails through Chromium's emulated
4 Mbit/s / 40 ms link 15,808.2→989.1 ms, including generation (`faster` in both comparisons). First loopback
retrieval instead slows 46.9→233.3 ms: eight probe/resize subprocesses and private cache-record writes are new work.
This is L1 plus scenario-scoped L2, not L3 or universal first-image improvement.

Derived files are bounded and verified on read; originals and permission/fork checks remain authoritative. SSE/large
poll answers use gzip with q-aware negotiation, immediate event flush and bounded stream backlog. Full checks,
503 tests, 82-request synthetic kernel proof and real Chromium thumbnail/preview/original selection pass. The final
ratchet and ledger guard pass; new counters are candidates only. See
[experiment, costs, limits and exact next actions](experiments/2026-10-19-thumbnails-and-stream-compression.md).

Stop this batch after three experiments. Next coding-agent action, under the existing approval: finish Program 1's
remaining TLS/HTTP2, original-preserving paste and original-file delivery work before starting Program 2. No service,
account, native product, journal collection or deployment was changed.

## Journal refresh — 2026-10-19, 12:52 UTC

Read-only snapshot `/tmp/rt-journal-20261019T125200Z`: 7,322 complete records, no cut-off lines,
8 server sessions and 7 releases. The seven completed shutdown health reports report zero drops; the live
session has not reported shutdown health. The last 24 hours contain 3,356 records across 4 server sessions,
with 149.51 s summed HTTP duration. Overlapping requests are not unique user-wait seconds, and browser/native
intervals must not be added to HTTP totals. This refresh does not establish an L1/L2 or L3 improvement.

| Priority / lead               | Recent evidence                                                  | Next action and coverage                                                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Stored-message images      | 53 requests; p50/p95 1,271/4,973 ms; 79.46 s, 53.1% of HTTP time | `image.single`/`image.concurrent` now exist, but their quiet loopback batches do not reproduce seconds. Ask the owner to select and authorize one slow real-access session for paired browser/server timing; do not add a speculative cache. |
| 2. Changes listing            | 139 requests; p50/p95 181/293 ms; 26.75 s, 17.9%                 | Extend measurement beyond the existing 20-file `git.changes` fixture to representative workspace/history scale. Attribute transcript projection, Git and per-file stats before changing code.                                                |
| 3. File-location search       | 15 requests; p50/p95 869/1,485 ms; 13.83 s, 9.2%; small sample   | No dedicated scenario. Add serial/concurrent searches with hidden/ignored folders, truncation and permission parity; test whether identical in-flight walks can be shared without retaining stale results.                                   |
| 4. Command discovery / submit | POST discovery: 3 requests, 10.02 s; submit: 19 requests, 8.40 s | Existing `commands.discover.cold`/`.warm` and `turn.cold`/`.warm`/`.prepared` cover related paths. Split readiness from model wait; these small groups do not justify prewarming or changing trust checks.                                   |

Code reading at `aaaba3e` confirms `Workspace.changes` reads all transcript entries, then `changesIn` obtains
repository state, status, diff counts and bounded per-file stats. `Workspace.fileLocations` calls `locateFiles`,
which performs a fresh bounded `walkFiles(..., true)` before suffix filtering. This includes hidden/ignored paths,
unlike the cached mention-file list, so blindly reusing that list changes results. These are testable hypotheses,
not measured root causes or proven reductions. Relevant runtime files are unchanged from the sampled `8dcd0a00`.

Browser switching remains a separate UX lead: 69 visible stream samples across two server sessions,
p50/p95 482/1,562 ms, 39.33 s total. Add repeated browser switching with representative history; `session.open`,
`web.open` and `projection.large.open` are related but not an exact reproduction. Sending has only 8 visible
samples (p50 2,476 ms), first reply 7 (p50 5,816 ms). Native cold dispatch is p50 3,651 ms versus reused 79 ms;
these are different groups, not a measured potential saving. Completed native outcomes are 14 settled prompts
(15,871 s total), 7 handled discoveries (14.28 s), 4 handled commands (1.27 s), and one settled handoff (0.81 s).
Task duration includes model/tool work and is not infrastructure latency alone.

Across 1,440 process samples, median minute p99 is 2.3 ms, worst minute p99 55.2 ms, longest stall 979 ms;
median/worst busy share is 0.4%/11%. No sustained main-loop saturation is evident, but whole-machine/native-child
load and stall causes are unmeasured. Stream view/session-list traffic is 646,321/458,602 bytes per active minute
across tabs; long-poll events are unsized. Neither figure establishes a regression.

The latest release `58fa3ce` now has 57 minutes and one server session, two submits, no completed prompt-phase
records, and still no image or changes samples. The image, changes and file-search groups each come from one
server session on `8dcd0a00`; they cannot establish an improvement across releases. No benchmark was rerun and
no runtime code, journal collection, service, credentials or deployment was changed. Only this aggregate record
is updated. Recommended next coding task without production access: a measurement-only file-location workload;
image attribution instead needs the owner's authorization and selected slow session.

## Journal analysis — 2026-10-19

Read-only snapshot at 12:08 UTC: 7,257 complete records from October 16 15:42 through October 19 12:08,
8 server sessions, 7 releases, no cut-off lines. All seven recorded shutdown health reports show zero drops;
the running session has no shutdown health report yet. The primary window below is the last 24 hours:
3,334 records, 1,502 HTTP requests, 4 server sessions, 3 releases, 147.76 s summed HTTP duration.
This is journal evidence, not an L1/L2 experiment or a demonstrated L3 improvement. Concurrent HTTP durations
are not unique user-wait seconds; HTTP, native runs, and browser timings overlap and must not be added.

### Ranked HTTP leads

| Lead                   | Count |        p50 / p95 |           Total | Coverage and next measurement                                                                               |
| ---------------------- | ----: | ---------------: | --------------: | ----------------------------------------------------------------------------------------------------------- |
| Stored-message images  |    53 | 1,271 / 4,973 ms | 79.46 s (53.8%) | No dedicated image scenario. Add representative image retrieval with concurrent requests before optimizing. |
| Changes listing        |   139 |     181 / 293 ms | 26.75 s (18.1%) | `git.changes` exists; reproduce the workspace scale before choosing another reduction.                      |
| File-location search   |    15 |   869 / 1,485 ms |  13.83 s (9.4%) | No dedicated scenario. Add bounded workspace-search coverage; small sample.                                 |
| POST command discovery |     3 | 3,583 / 3,750 ms |  10.02 s (6.8%) | `commands.discover.cold` and `.warm` now exist; compare readiness phases, not just GET command listing.     |
| Submit                 |    18 |    45 / 4,592 ms |   7.28 s (4.9%) | `turn.cold`, `.warm`, and `.prepared` cover related synthetic paths; 17 responses are 200 and one is 409.   |

The first four groups all belong to one server session on `8dcd0a00`; even the larger counts do not meet the
two-session requirement for an L3 improvement claim. All responses in those four groups were 200. Image requests
occurred at 07:05–08:04 UTC and reported about 1.87 MB mean wire bytes. HTTP timing ends at server response finish:
it does not separate history lookup, image decoding, response transmission, or browser rendering. Code reading
shows `entryImage → visibleEntry → harness.commit` followed by base64 decoding; that identifies the path, not its
bottleneck. Image, workspace, file-search, and conversation-route source files have no changes between `8dcd0a00`
and the current checkout `58fa3ce`, but this alone cannot establish current runtime latency.

### Browser, native execution, and server health

- **Session switching is the strongest repeated browser signal:** stream transport has 69 visible samples across
  two server sessions, p50 482 ms, p95 1,562 ms, max 2,330 ms, total 39.33 s. `session.open`, `web.open`, and
  `projection.large.open` cover related work, but there is no dedicated repeated-browser-switch scenario.
  Next measurement: repeated switching with representative history; the journal cannot attribute the delay to
  network, projection, or painting.
- **Sending and first output remain multi-second hints:** visible `send.shown` has 8 samples, p50 2,476 ms,
  p95 4,369 ms; `reply.first` has 7, p50 5,816 ms, p95 10,095 ms. Native started-process dispatch has 5 samples,
  p50 3,651 ms, versus 79 ms for 9 reused-process samples. First native output after dispatch is p50 6,664 ms
  for started processes (one without output) and 5,041 ms for reused processes. These medians cannot be added
  into a paired end-to-end estimate, and native output is not necessarily first visible text.
- Native outcomes: 14 `prompt:settled` runs total 15,871 s, p50 414 s, max 5,077 s; 6 `discover:handled` total
  14.02 s; 3 `command:handled` total 0.81 s; one `handoff:settled` is 0.81 s. Tool-active shares are 35% of
  started-process run time and 17% of reused-process run time. Long tasks are not proof of infrastructure delay
  or a slow model; the rest includes model time, setup, and finalization. Runs not yet finished are not represented.
- Across 1,440 process samples, event-loop p99 median is 2.3 ms, worst minute p99 55.2 ms, longest stall 979 ms.
  Event-loop busy share is 0.4% median and 11% worst; peak RSS is 599 MiB. No sustained main-loop saturation is
  evident. Whole-machine/native-child load and the cause of stalls remain unmeasured; use a controlled reproduction
  if stall attribution becomes the selected experiment.
- Push volume per active minute: view 655,986 bytes, session list 465,269 bytes, presence 18,199 bytes, aggregated
  across tabs. Long-poll events are counted but unsized. These figures do not establish a bandwidth regression:
  workloads and transport mix differ. `turn.warm`, `turn.paced`, and projection scenarios cover related push work.

### Current release and decision

The latest release `58fa3ce` has only 14 minutes of observations (11:54–12:08 UTC), one server session, one submit
(4,592 ms), and no completed prompt-phase record. Startup open is 1,524 ms (one sample); visible session opens
have two poll samples, p95 2,676 ms. Its event-loop p99 median is 2.2 ms, longest stall 642 ms. There are no image
or changes-list samples for this release. Do not infer a release speedup or regression from this sparse window.

Recommended next experiment: the coding agent adds an image-retrieval scenario in a measurement-only branch/commit,
then separates lookup/decode/response work on synthetic data before selecting an optimization. No production trace,
collection change, service restart, real account, benchmark, or runtime change was performed in this analysis.
Raw snapshots stay outside the repository; only aggregates are recorded here.

### Follow-up: image retrieval baseline — 2026-10-19

[Measurement](experiments/2026-10-19-image-retrieval-baseline.md) now adds `image.single` and
`image.concurrent`: a real kernel-mode Durable mirror containing 24 distinct 1,967,083-byte PNGs, exact HTTP
readback, and request-local lookup/decode/send-finish timings. Two five-run batches with `highLoad: false` give
single-image scenario medians 37.2/38.5 ms and four-image concurrent batch medians 83.5/80.8 ms. Single-image
lookup is 10.6/9.2 ms and decoding 1.2/1.0 ms. One image performs one SQL row lookup, one 2.63m-character JSON
parse, and one decode; it does not scan every image. The loopback workload does **not** reproduce the journal's
seconds. No runtime optimization or speedup claim; 102 new counters are candidates only, with prior ledger entries
unchanged. Next: the coding agent asks the owner to authorize/select one slow real-access session for paired
browser/server timing; neither a speculative cache nor broader production tracing is justified yet.

## Journal analysis — 2026-10-17

L3 observations only, not a before/after speed claim. A read-only snapshot covers 2026-10-16 15:42 through
2026-10-17 01:33 UTC (about 9 h 51 min): 1,650 parsed records, 972 HTTP requests, four server sessions/releases,
no cut-off lines, and zero drops in the three shutdown health records. The latest release, `45d45275`, covers
18:12–01:33 UTC. There is no earlier journal in this snapshot, so this does not establish a recent regression.
Groups below 30 samples are leads, not findings. Route and native durations overlap; do not add them together.

### Ranked leads

1. **Task execution has the largest observed duration, mostly tools in the longest run.** Four settled prompts
   total 94.9 s (range 4.8–55.5 s). The 55.5 s run contains 45.2 s with a tool running; tool-active time totals
   54.1 s across the four prompts. The journal does not identify tools, so this is not proof of a slow model or a
   Team bug. First native `message_update` arrives 2.84–4.17 s after dispatch; it is not necessarily visible text
   or a first token. Benchmark: `turn.cold`, `turn.warm`, and `turn.paced` cover synthetic prompts, but no scenario
   reproduces the observed long tool. Next: create a separate deterministic slow-tool measurement before trying
   to optimise this path; identifying the real tool needs an explicitly scoped private trace review, not broader
   journal collection.
2. **Changes is the strongest repeated HTTP lead.** Diff: 35 requests, p50 141 ms, p95 222 ms, total 5.26 s.
   Listing: 13 requests, p50 216 ms, max 495 ms, total 3.32 s (small sample). Together they account for 8.58 s,
   about 33% of the 25.91 s summed HTTP durations. In the latest release alone, diff has 21 samples, p50 134 ms,
   total 3.08 s; listing has seven, p50 201 ms, total 1.59 s. Code reading confirms `diffOf` runs four sequential
   Git commands on the ordinary path, including whole-repository status for each file; `changesIn` runs five
   and `Workspace.changes` also reads transcript entries. These modules match the deployed release by SHA-256.
   Benchmark: `git.changes` covers listing, **not diff**. Next: add a `git.diff` scenario in a measurement-only
   commit, then test reducing repeated work without weakening path permissions or freshness.
3. **Native discovery and cold dispatch cause multi-second interaction tails.** Across releases, submit totals
   6.59 s over 11 requests (p50 98 ms, max 3.87 s); POST prompts totals 4.59 s over five (p50 142 ms, max 4.09 s).
   The 3.87 s submit coincides with a 3.63 s discovery, and the latest release's 4.09 s prompts request coincides
   with a 3.80 s discovery. Other discoveries take 58–154 ms. For the four measured prompts, started-process
   dispatch takes 2.67/3.45 s versus 48/52 ms when reused. This supports investigating the startup path; discovery
   itself has no phase breakdown, so its cold-start attribution remains unverified. Benchmark: `turn.cold` and
   `turn.warm` cover prompt startup; `commands.list` only issues GET and does not reproduce POST discovery.
   Next: add cold/warm POST-discovery coverage, preserving member routing and native resource freshness.
4. **Configuration has a 2.92 s tail, but only one sample.** Its native command takes 2.90 s; the latest release
   also has a 1.82 s submit coinciding with a 1.80 s command. Command names and phases are not recorded, so these
   cannot be assigned to a specific setting. No current scenario reproduces configure. Next: add a synthetic
   configure scenario before selecting an optimisation.

### Cross-checks and limits

- Event-loop p99 median is 2.3 ms, worst minute p99 28.3 ms; longest individual stall is 607 ms. Server event-loop
  utilization median is 0.4%, worst 2.7%. This does not suggest sustained main-loop saturation, but does not
  measure whole-machine or native-child load. The 607 ms stall has no causal profile; attribution needs a
  controlled reproduction, not a production restart or profiler enabled without approval.
- Push traffic averages 70,253 view bytes and 65,415 session-list bytes per active minute (all sized stream
  events). These are totals sent to tabs, not per-tab sizes. Existing `turn.warm`/`turn.paced` and `sessions.list`
  scenarios are relevant; this snapshot alone does not establish a bandwidth bottleneck.
- Startup open time is 2.33–3.21 s across four starts; `startup.restart` covers that path. Task process startup
  and server startup are different measurements.
- Browser timings are mostly unavailable: 14 hidden-tab observations and only one usable session-open sample
  (1.33 s). There is not enough evidence to rank rendering or network latency. `web.open` is the existing
  controlled scenario; further real-use evidence needs a visible-tab sample, not treating hidden values as zero.
- No controlled timing run, L1 counter reduction, or L2 speedup was measured. No service, account, journal
  collection, ceiling, or runtime code was changed. Recommended first climb: add diff coverage, then reduce Git
  work in the Changes path; discovery startup is the next, higher-tail but lower-sample lead.

## First climb batch — 2026-10-17

User approved all three [programs](2026-10-17-proposals.md), delivered incrementally. Current results are L1 only:

- **Git metadata batching retained:** ordinary listing launches 3 instead of 5 processes; diff 3 instead of 4.
  State remains freshly queried; porcelain-v1 status and path checks are unchanged. Unusual/unborn HEAD falls back
  to original scalar reads and has one extra attempted command. See [experiment](experiments/2026-10-17-git-metadata-batch.md).
- **Mirror suffix decoding retained:** warm JSON parses 203→145, characters about 559k→343k; paced parses 353→279,
  characters about 1.07m→823k. SQL statements and payload sizes do not increase. First history inspection remains
  after restart; the branch-notice negative control fails when it is removed. SQLite OFFSET still scans the prefix;
  only returned rows/parent decoding were removed. See [experiment](experiments/2026-10-17-native-mirror-suffix.md).
- **Native discovery is now reproduced:** two five-run samples measure cold explicit discovery at about 1.63–1.67 s,
  warm discovery at 85–88 ms, and a first prompt on the retained segment at 106–109 ms. Discovery makes no model
  request; process starts are 1/0/0 respectively. This measures existing retention, not a new prewarming optimisation.
  See [measurement](experiments/2026-10-17-native-readiness-measurement.md).

No comparison qualifies as `faster`; initial Git baselines were loaded, later comparisons were noise even when
`highLoad: false`. Tests: 439 passed, synthetic kernel/native-command proofs passed; no browser/device or production
speedup is claimed. Three experiments close this session. Next: controlled native startup phase measurement, then
one measured resource/bootstrap optimisation. Stage 3 projection/protocol redesign remains unimplemented.

## Second climb batch — 2026-10-17

Three experiments completed; still no L2/L3 claim:

- **Cold startup is native initialization, not process creation.** Stage spans show about 2–3 ms Team pin validation,
  67–76 ms resource preparation, 0.5–0.6 ms OS spawn, and 1.5–1.6 s native RPC readiness. Leave safety checks intact.
  Native module/extension/MCP breakdown is not yet measured. See [measurement](experiments/2026-10-17-native-start-phases.md).
- **Identical resource writes retained as an L1 win.** Cold discovery parent writes 4→1, bytes 1,213→396, renames 3→0.
  Unchanged private regular files keep inode/mtime; matching public-mode files still get private atomic replacement.
  Policy, package resolution and exact byte comparisons stay on the path. Total latency compares as noise.
  See [experiment](experiments/2026-10-17-skip-identical-resource-writes.md).
- **View traversal is measured.** Two five-run reports reproduce entry visits 56/session open, 8/warm turn, 82/paced
  turn, 28/web open. Small fixtures do not establish large-history cost. Four new candidates, no promotion. See
  [measurement](experiments/2026-10-17-view-entry-visits.md).

Final current-code checks pass (440 unit tests; synthetic kernel proof with 82 loopback requests), no account/service
use. Next authorised experiment: large-history/multi-tab projection workload, then cached order with exact append/reset
invalidation. Native startup internals remain another lead needing a supported phase/profile investigation, not a
raw-Pi or shared-credential shortcut.

## Third climb batch — 2026-10-17

Large-history/four-tab measurement and one L1 optimisation completed:

- Source projection/order visits fell **1,848→132** on four-tab open and **4,792→267** on a paced answer. View push
  counts/bytes are identical; durations are noise. Room cache invalidates on immutable entry-array replacement, so
  append and head reset remain fresh; full reconnect, fork and restart are covered. See
  [experiment](experiments/2026-10-17-room-entry-sequence-cache.md).
- Residual exact counts show the next work: four-tab open still performs 1,792 cached visible-entry scans and 1,848
  stats-entry scans; paced performs 4,648 and 4,792. See
  [measurement](experiments/2026-10-17-room-projection-residual-work.md).

L1 only; no L2/L3 claim or gate promotion. Next authorised hypothesis is room-wide stats caching by both immutable
entries-array and usage-document identities. Per-client append/reset cursors follow only after that. Wire pagination
still needs payload/browser-copy evidence.

## Fourth climb batch — 2026-10-17

Two L1 changes retained; still no L2/L3 claim:

- **Room-wide stats cache:** scans 1,848→132 on four-tab open; 4,792→267 on the paced reply. Invalidates on exact
  entries and usage-doc revision, so usage-only commits and head reset stay fresh. See
  [experiment](experiments/2026-10-17-room-stats-cache.md).
- **Client projection cursor:** visible-entry scans 1,792→512 at open; 4,648→8 on paced reply. Full reconnect/reset
  or missed revision safely rescans active order. No retained history chain, no protocol change. See
  [experiment](experiments/2026-10-17-room-client-cursors.md).
- **Slow-field JSON measured:** open 168 calls / 41,328 chars; paced 432 / 107,892, zero spread in ten runs. Fields
  are only about 250 chars per push, so another broad cache is not the next justified investment. See
  [measurement](experiments/2026-10-17-view-field-serialization.md).

Final type/lint/format, 444 tests and synthetic kernel proof pass. First full run hit the documented drop-in watcher
flake; isolated then unchanged full rerun pass. Next authorised measurement: live/inbox/kernel payload and browser
parse/copy work, before any pagination/delta protocol decision. No service, account or deployment used.

## Fifth climb batch — 2026-10-17

- **Browser Map reuse retained as L1:** ten paced view events carry two new entries; existing Map copies fall
  248→49, zero spread across five runs. Full/reconnect/reset/switch/deltas keep snapshot isolation. Parse/apply is
  only about 1 ms and all timing comparisons are noise. See
  [experiment](experiments/2026-10-17-browser-entry-map-reuse.md).
- **Kernel projection is the next read-path lead:** four-tab open does 140 SQL statements / 42 JSON decodes;
  paced does 376–424 / 124–140, including duplicate session reads in command snapshot validation. Command revision
  itself is cheap. See [measurement](experiments/2026-10-17-kernel-roomstate-work.md).

Final type/lint/format, 447 tests and synthetic kernel proof pass; real Chromium open/stream readback verified without
real accounts. No L2/L3, production or protocol claim. Next authorised hypothesis: reuse the already-read session
snapshot inside the same synchronous roomState call, not a cross-call cache; keep exact viewer/binding and fresh
unknown/pending/cutoff checks. Polling, long browser history and full device/UI acceptance remain unverified.

## Sixth climb batch — 2026-10-17

Two L1 wins; no L2/L3:

- **Same-call session reuse:** full exact catalog binding comparison still runs, but duplicate session/presence reads
  do not. Open kernel SQL 140→98; paced 424→316. See
  [experiment](experiments/2026-10-17-roomstate-session-reuse.md).
- **Complete receipt row read:** latest/pending preserve filters/errors and required fresh unresolved-input queries.
  Open kernel SQL 98→84; paced 316→248; parses and fences unchanged. See
  [experiment](experiments/2026-10-17-receipt-row-read.md).

Final type/lint/format, 448 tests, synthetic kernel and native-command proofs pass; real Chromium readback succeeds.
Cumulative common/worst SQL reduction is 40% at open and about 42% at paced. No timing improvement, production or real
account claim. Next authorised hypothesis: combine presence/head/session with a fresh joined query, after error/parity
and query-plan verification. Current unknown/input fences must not be cached away.

## Seventh climb batch — 2026-10-18

- **Fresh head/session JOIN retained as L1:** open kernel SQL 84→56; paced 248→176, zero spread. Presence and
  duplicate head/result crossings disappear; segment/model lookups remain indexed within the JOIN. Exact bindings,
  missing-versus-corrupt behavior, fresh receipts/input fences and cutoff/recovery remain unchanged. See
  [experiment](experiments/2026-10-18-roomstate-head-session-join.md).
- **Change the next measurement focus:** kernel binding parsing is now 28/2,057 calls at open and 104/5,387 at paced.
  The parent parser source is not yet attributed. The coding agent's next task is content-free scoped attribution for
  native readback, journal mirror and Durable projection/storage; do not assume another room-state cache is the biggest
  win. See [residual measurement](experiments/2026-10-18-roomstate-residual-work.md).

Final type/lint/format, 449 tests, synthetic kernel and native-command proofs pass; real Chromium open/stream readback
succeeds. Cumulative common/worst kernel SQL is 140→56 and 424→176. L2 remains noise; L3 and real-device/account paths
are unverified. No production action. Stop this batch after three experiments; pagination remains gated by long-history
browser/payload evidence.

## Eighth climb batch — 2026-10-18

- **Source attribution registered:** all parent JSON calls/chars partition exactly. Before optimization, journal full
  segment reads are about 89% of four-tab large-history decode calls; Durable is 139/14 calls and mirror 0/4.
  See [measurement](experiments/2026-10-18-parse-source-attribution.md).
- **Native Goal fanout reuse retained as L1:** share one fresh Goal snapshot only inside one synchronous fanout.
  Open total parses 2,057→860; paced 5,387→1,766. Per-viewer safety SQL, push counts/bytes, Goal freshness/error/live
  precedence and privacy remain unchanged. See [experiment](experiments/2026-10-18-native-goal-fanout.md).
- **Next measurement:** test targeted current-branch Goal metadata/ancestry readback against full reducer parity. Full
  segment parsing still contributes 660/1,198 calls; no cross-fanout cache or schema/protocol change is justified.
  See [residual ranking](experiments/2026-10-18-goal-readback-residual.md).

Final type/lint/format, 451 tests, synthetic kernel/native/browser proofs pass. L2 remains noise; L3, real accounts and
physical devices are unverified. No production action. Stop after three experiments.

## Ninth climb batch — 2026-10-18

- **Targeted SQL Goal read rejected:** current full-history malformed-JSON errors and duplicate-key parsing differ
  from selective ancestry/SQLite extraction. No schema/parser contract change. See
  [probe](experiments/2026-10-18-targeted-goal-query-rejected.md).
- **Same-call full-entry reuse retained as L1:** Goal and dormant thinking now share one complete parsed segment
  during roomInfo, with exact segment IDs and no next-call cache. Dormant open parses 165→109, rows 177→121;
  public agent sharing also reduces large open/paced SQL 163→118 and 647→512. Per-viewer kernel safety SQL and push
  counts stay unchanged. See [experiment](experiments/2026-10-18-room-info-entry-reuse.md).

Final type/lint/format, 452 tests, synthetic kernel and native command/Chromium proofs pass. Timing comparisons remain
noise, no L3/production/real-account claim. Stop after three experiments. Next coding-agent action: finer source
attribution within the 319 paced native-readback parses, separating RPC records, JSONL prefix/suffix and gate before
optimizing again. The full-history corruption contract stays intact; long-history browser evidence still precedes
pagination/protocol changes.

## Tenth climb batch — 2026-10-18

- **Native readback attribution:** nested counters partition every native parse exactly into RPC, JSONL and gate.
  Four-tab large paced is 48 RPC + 270 JSONL + 1 gate; history growth is the JSONL prefix, not the fresh 60-byte gate.
  See [measurement](experiments/2026-10-18-native-readback-sources.md).
- **Active tail entry reuse retained as L1:** snapshots reuse run-owned, already validated entry objects while still
  re-reading and hashing every prefix byte. Large paced JSONL parses 270→135 and all native readback 319→184; warm
  18→9 and 67→58. Parent read calls/bytes stay constant, malformed/rewritten prefixes fall back to the original full
  parse, and journal delivery remains independent. See
  [experiment](experiments/2026-10-18-native-tail-entry-reuse.md).

Final type/lint/format, 454 tests, 82-request kernel proof and 28-inference native command/Chromium proof pass.
Timing remains noise, so L1 only; no L3/production/real-account claim. Stop after three experiments. Remaining native
readback is RPC 48 plus fresh JSONL 135 plus gate 1 in the large paced case; further progress needs a new batch and a
new attribution inside the fresh half, not weaker prefix/error checking.

## Eleventh climb batch — 2026-10-18

- **Retained-memory cost measured:** unbounded tail reuse retained about 8 MiB heap for an 8 MiB text history and
  about 65–70 MiB for a 70 MiB image-sized history. It reduced three-snapshot process high-water RSS, but that does
  not justify lifetime-proportional heap. See
  [measurement](experiments/2026-10-18-native-tail-memory-baseline.md).
- **Entry reuse bounded at 1 MiB:** small histories keep the previous JSONL reduction; larger prefixes release cached
  bodies and use the original fresh full parse. The 8/70 MiB idle heap returns to pre-reuse levels. ID-tree validation
  and undelivered journal entries remain live, so append, corruption, selected branch and finalization semantics stay
  unchanged. See [experiment](experiments/2026-10-18-native-tail-bounded-cache.md).
- **Remaining JSONL is first ingestion:** all ten runs partition exactly. Large paced JSONL 135 = ingestion 135 +
  snapshot/fallback 0; warm 9 = 9 + 0. There is no duplicate prefix parse left in controlled turns. Do not remove this
  validation without a separately approved protocol/storage contract change. See
  [attribution](experiments/2026-10-18-native-jsonl-ingest-attribution.md).

Final type/lint/format, 456 tests, 82-request kernel proof and 28-inference native command/Chromium proof pass. Timing
remains noise, so L1 only; no L3/production/real-account claim. Stop after three experiments. Next batch may split the
stable 48 RPC parses into transport records and nested bridge payloads before choosing another optimization; the fresh
one-call gate is not a lead.

## Twelfth climb batch — 2026-10-18

- **RPC sources measured, no duplicate notify work:** warm/paced/large-paced 48 parses = 47 transport records + one
  90-character notify payload; cold 59 = 57 + 2. All calls/chars partition exactly across ten runs. No event cache or
  protocol optimization justified. See [measurement](experiments/2026-10-18-native-rpc-parse-sources.md).
- **Formerly unclassified turn work explained:** 24 calls / 103,190 chars = pin 9/19,002 + pinned resolver 13/84,008
    - resource settings 1/90 + event-control 1/90. This is reclassification, not a reduction. Resolver validates fork
      identities, archive/source integrity and executable/export paths; do not cache verification across calls or edit the
      fixed product to lower the number. See [measurement/decision](experiments/2026-10-18-native-identity-parse-sources.md).

Both measurements have two separate five-run reports and passing global/nested partition checks. Final type/lint/format,
456 tests, 82-request kernel proof and 28-inference native command/Chromium proof pass. Candidates only, no promotion or
relaxation. No new L1 reduction or L2/L3 claim. Close after two measurements because the proposed shortcut crosses the
trusted-native boundary. Next coding-agent action: add a distinct 60-session startup workload and measure restoration
SQL/JSON growth before choosing an optimization. Production/real accounts remain out of scope.

## Original leads (historical baselines)

The values below predate the climb batches. Use the batch results above for current counters; they are not new
regressions or unsolved attribution findings. Startup scaling remains the next measurement lead.

- **A warm turn parses about 93 times its answer as JSON.** `turn.warm/json.parse.chars` 558 969 for a
  6 000-character answer; `turn.paced` 1 069 876; `turn.cold` 873 804. Next: find which reads parse (kernel journal
  entries, session JSONL, projections) and whether each turn re-reads the whole session; measure with 24 seeded turns
  to see whether it grows with history.
- **Changes runs 5 Git commands and parses 122 kB of JSON.** `git.changes/subprocess.git` 5 (gating),
  `json.parse.chars` 122 459, `sql.rows` 30, about 300 ms. Next: see whether fewer Git calls (one
  `git status --porcelain=v2`) give the same answer, and what the 30 rows read are for.
- **Opening a session parses 4.6 times what it sends.** `session.open/json.parse.chars` 373 917 against `push.bytes`
  81 884. Next: check whether entries are parsed once per projection, or the same records are read twice.
- **Startup runs 848 SQL statements and 527 JSON parses for 13 sessions.** `startup.restart/sql.statements` 848,
  `json.parse.calls` 527. Next: measure with 60 sessions (a deployment's size) to see whether it is per session; the
  journal's `startup` record gives the real open time.

## Needs measurement first

- **A cold turn starts one rotom process and takes about 1.7 s.** `turn.cold` median 1 690 to 1 760 ms,
  `subprocess.rotom` 1. Next: split the time (process start, kernel handshake, first token) before trying anything;
  this may be the floor of the native path.
- **Each streaming update resends the whole live message.** `turn.paced`: 9 view pushes, 43 671 view bytes for a
  6 000-character answer. Next: measure the live part's size per push with a longer answer; a delta would change the
  client contract.
