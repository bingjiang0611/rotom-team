# Performance opportunities: earlier journals (historical)

Archived from `opportunities.md` to keep edited files within 20,000 bytes. Bodies below are unchanged.

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
