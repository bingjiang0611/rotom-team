# Performance loop

How rotom team finds where people wait, proves a change made it faster, and keeps it from getting slower again. Three
parts, each with its own evidence:

```
 daily journal (real use)          controlled benchmarks (fixed work)          ledger + ratchet (guard)
 <data>/performance/*.jsonl  ──►   test/perf/scenarios.ts, measure.ts   ──►    test/perf/ledger.json
 npm run perf:report               npm run perf:measure / perf:ci              npm run perf:check / perf:propose
        │                                    │                                         │
   where people wait               what the server does for it                 what may not get worse
   (milliseconds, L3)              (work counters L1, milliseconds L2)         (gating counters fail a change)
```

The agent skill [`.agents/skills/rotom-team-performance-climb`](../.agents/skills/rotom-team-performance-climb/SKILL.md)
runs the loop: analyse the journal, climb (one hypothesis at a time), maintain the ledger.

## Terms

- **Work counter**: how much work one fixed scenario does: SQL statements and rows, child processes (by program),
  JSON parse/stringify calls and characters, events and bytes pushed to tabs, HTTP requests, and in Chromium layouts,
  style recalculations, and DOM nodes. A counter does not move with machine load the way milliseconds do.
- **Candidate**: a counter in the ledger with a per-platform baseline. It is reported as `better`, `worse`, or
  `unchanged`, and never fails a change.
- **Gating counter**: a counter with a ceiling. It fails a change when it goes above the ceiling (plus tolerance),
  when repeat runs disagree more than the tolerance (`unstable`), or when it could not be measured (`unavailable`).
- **Ratchet**: ceilings and baselines move down by themselves (`perf:propose`) and up only by an approved raise.
- **L1 / L2 / L3**: the three levels of "faster". L1: a work counter went down. L2: the controlled benchmark's
  milliseconds went down, with the runs separated beyond noise on a quiet machine. L3: the daily journal shows it after
  the release ran in real use (≥ 30 samples of the same route or run outcome, from ≥ 2 server sessions). Never call
  L1 "faster" without L2, and never call L2 an improvement people feel without L3.

## Controlled benchmarks

`npm run perf:measure -- [--runs N] [--out FILE]` runs [test/perf/scenarios.ts](../test/perf/scenarios.ts) N times
(default 3), each in a fresh process on fresh temporary data, and writes `perf-results/<revision>.json`. The runs use a
temporary checkout of what is on disk ([test/perf/checkout.ts](../test/perf/checkout.ts)), never the working folder:
the server's data lists bundled resources by path, so character and byte counters change with the checkout path's
length. Temporary checkouts have one path length on one machine.

Each run is the service's real path: kernel mode, real rotom child processes, the real HTTP handler, a real
event-stream tab, and a loopback OpenAI-compatible model that streams a fixed answer. No real account or network is
used. The workload is fixed in [test/perf/workload.ts](../test/perf/workload.ts):

| Scenario                   | What it does                                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startup.restart`          | close the app on seeded data (13 sessions, one with 12 turns) and open it again                                                                                            |
| `sessions.list`            | `GET /api/sessions`                                                                                                                                                        |
| `session.open`             | a new event-stream tab on the 12-turn session, until its first full view                                                                                                   |
| `turn.cold`                | first prompt of a new session (starts its rotom process), until settled + quiet                                                                                            |
| `turn.warm`                | the next prompt of that session                                                                                                                                            |
| `turn.paced`               | a prompt whose answer streams 25 ms per chunk, as a real model does                                                                                                        |
| `git.changes`              | `GET changes` in a Git workspace with 20 changed files                                                                                                                     |
| `git.branches`             | `GET branches`                                                                                                                                                             |
| `commands.list`            | `GET` the native slash-command list                                                                                                                                        |
| `web.open`                 | headless Chromium opens `/s/<session>` until the last answer is in the page                                                                                                |
| `image.single`             | retrieve one stored image from a separate 24-image native-format Durable mirror                                                                                            |
| `image.concurrent`         | retrieve four distinct images concurrently from that mirror, through exact binary readback                                                                                 |
| `image.thumbs.first`       | request four previously unrequested stored images as thumbnails, including generation and writes                                                                           |
| `image.thumbs.again`       | request those same four thumbnails again, without a browser cache                                                                                                          |
| `image.thumbs.network`     | Chromium downloads and decodes four other first-time thumbnails with cache disabled on a CDP-emulated 4 Mbit/s, 40 ms link                                                 |
| `image.paste.network`      | Chromium prepares and uploads a deterministic large clipboard PNG on a 4 Mbit/s uplink; includes browser resize, HTTP upload, readback and decode, without model inference |
| `image.original.again`     | Repeat the four originals from image.concurrent, preserving exact binary readback                                                                                          |
| `image.original.validated` | Repeat those originals with If-None-Match; require either exact original bytes or a matching 304 with no body                                                              |

A scenario's window ends when the server is quiet (no push and no SQL for 400 ms), not when its request answered:
pushes coalesce over 90 ms and native runs finish asynchronously. `web.open` is unavailable, not zero, where the
machine has no Chromium.

Counters are counted in the server process by [test/perf/counters.ts](../test/perf/counters.ts), and pushes and native
runs through the server's own diagnostics channels ([src/server/perf-channels.ts](../src/server/perf-channels.ts)),
which cost one check while nobody listens. The benchmark's own JSON uses the unwrapped functions, so its bookkeeping is
not counted as the server's work.

Image scenarios install benchmark-local, request-scoped wrappers in [test/perf/images.ts](../test/perf/images.ts)
only after the other workloads. Lookup includes queue waiting; decoding measures actual base64 conversion;
`end` to server `finish` does not prove client receipt. Client-body timing is separate. Concurrent phase timings
sum per-request intervals, not batch wall time. Failed or unfinished responses cannot become measured zeros.
Retrieval fixtures are synthetic persisted mirrors, not cold OS caches or production network replays. The separate
paste scenario constructs a browser PNG and performs a real authenticated upload; preparation is inside its measured
window. The probe scopes the shared `storedImage` decoder (also called by legacy `entryImage`) so a cache miss cannot
bypass decode attribution merely by taking a different caller path.

## Ledger and ratchet

[test/perf/ledger.json](../test/perf/ledger.json) keys each counter by `scenario/metric` and records its workload,
source, status, tolerance, and baselines or ceiling. [test/perf/ratchet.ts](../test/perf/ratchet.ts):

- `npm run perf:check -- <report>`: the report against the ledger; exit 1 when a gating counter fails.
- `npm run perf:propose -- <report> [--write]`: lower ceilings and this platform's candidate baselines to what was
  measured. Refuses a failing report, and any report measured with an injected regression.
- `node test/perf/ratchet.ts register <report…> [--write]`: add new counters as candidates. The baseline is the worst
  run across the reports, the tolerance their combined spread. Take the reports at different times: one report hides
  noise.
- `node test/perf/ratchet.ts guard <base-ledger> <head-ledger>`: fail when a ledger edit loosens anything without
  `ROTOM_TEAM_PERF_RAISE_APPROVED=1` (a higher ceiling also needs a matching `raise` record). Changing a key's
  workload, unit, or layer is never an edit: register a new key.
- `npm run perf:compare -- <base-report> <head-report>`: counters that moved, and milliseconds called `faster` or
  `slower` only past 20 % and when every run of one side is beyond every run of the other.

Promoting a candidate to gating is a reviewed edit with three pieces of evidence, written into the entry:

1. **Stability**: repeat fresh-process runs agree (spread within tolerance, ideally 0) on this platform.
2. **Sensitivity**: a deliberate regression moves the counter and `perf:check` fails. `ROTOM_TEAM_PERF_INJECT=git`
   runs every Git command twice; a report measured with it is marked and can never become a baseline.
3. **Correlation**: the same regression costs milliseconds people would wait for.

Gating now: `git.changes/subprocess.git` (ceiling 5) and `git.branches/subprocess.git` (ceiling 2), with the evidence in
[performance/experiments/2026-10-16-gate-git-counters.md](performance/experiments/2026-10-16-gate-git-counters.md).
Everything else is a candidate with a `darwin-arm64` baseline. Counts may differ by platform: a `linux-x64` baseline is
registered from Linux reports, never copied from macOS.

## Before and after a change

`npm run perf:ci -- <base-ref> [--runs N]` measures the base revision and this checkout (with its uncommitted edits),
each in a temporary checkout carrying this checkout's benchmark, so both sides use one instrument at paths of one
length. Base and head runs alternate so a load change falls on both. It
prints the head report, the comparison, the ratchet check, and the ledger guard, and exits 1 when the check or the guard
fails. Root dependencies are shared with a checkout only when its lock file and runtime patch list are identical;
otherwise it installs its own. The rotom kernel is always installed per checkout: its trust check refuses a kernel
reached through a symbolic link. A base that predates the benchmark is reported as not comparable.

[.github/workflows/performance.yml](../.github/workflows/performance.yml) runs it on pull requests (macOS arm64, to match
the ledger's platform) and uploads the reports.

## Daily journal

The running server writes [src/server/perf-journal.ts](../src/server/perf-journal.ts) records to
`<data>/performance/performance-0.jsonl`:

| Record       | When                    | What                                                                  |
| ------------ | ----------------------- | --------------------------------------------------------------------- |
| `startup`    | once per start          | how long opening the app took                                         |
| `http`       | each answered request   | method, route shape, status, duration, bytes written                  |
| `kernel-run` | each native run         | duration from admission to receipt, `<operation>:<status>` or `error` |
|              | (a run that prompted)   | phases: `prompt.process`, `dispatchMs`, `firstOutputMs`, `toolMs`     |
| `web`        | each wait in a tab      | wait name, transport, ms (or `unavailable: hidden`)                   |
| `push`       | each minute with pushes | per event name: count, and bytes where the transport sizes them       |
| `process`    | each minute             | event-loop delay p50/p99/max, event-loop busy share, CPU, RSS, heap   |
| `health`     | at shutdown             | records dropped from a full queue                                     |

Content stays out by construction: a route shape keeps only lowercase route words (`/api/c/12/changes/diff?path=…`
is `/api/c/:n/changes/diff`; ids, names, file paths, tokens, and queries are dropped), and nothing else carries text.
Event streams and long polls are left out of `http`: their duration is how long a tab stayed. A run answered from an
existing receipt (a resent request) is recorded too, and is fast.

A run that sent a prompt to the native process says where its time went: `process` is `started` (it launched a new
native process) or `reused` (the session's running one); `dispatchMs` runs from admission to the prompt's dispatch
(authorization, process start, resource reload, command catalog); `firstOutputMs` from dispatch to the model's first
streamed output, null when none came; `toolMs` is the time with at least one tool running (parallel tools count once)
over `tools` executions. The rest of the run is the model and finalization.

Browser tabs time what people wait for, from their action to the first paint that shows its result
([web/perf.js](../web/perf.js)), and report in batches to `POST /api/perf` (not itself an `http` record):

| Wait                        | From                        | To, on screen                               |
| --------------------------- | --------------------------- | ------------------------------------------- |
| `open.home`, `open.session` | the page's navigation start | the session list, or the session            |
| `switch`                    | picking another session     | its view                                    |
| `send.shown`                | sending to an idle session  | the message (in the transcript or queued)   |
| `reply.first`               | the same send               | the first of the answer (streamed or saved) |

A wait the tab was hidden for did not paint, so it is `unavailable: hidden`, never a duration. The server accepts only
these names, `stream`/`poll`, and durations up to 10 minutes; a report with anything else is refused whole. A lost
report is a gap in the journal: the tab never retries it.

A full file (5 MiB) is renamed to `performance-<UTC stamp>-<id>.jsonl` and gzip-compressed off the write path;
compressed archives are capped at 64 MiB, oldest first. Writing fails open: a broken disk stops the journal with one
log line, never the server. Records are local; nothing sends them anywhere.

Read it from a snapshot, since the service keeps writing:

```sh
npm run perf:report -- snapshot ~/rotom-team-deployment/data /tmp/journal-snapshot
npm run perf:report -- report /tmp/journal-snapshot [--since 2026-10-20] [--release <commit>] [--json]
```

The report ranks routes by total time (count × duration), and gives native runs by outcome, prompt runs by phase
(new and reused process apart), browser waits by name and transport, the event loop, memory, and pushed bytes per
active minute. A group with fewer than 30 samples is marked as too few to call a change.

## Rules

- Unmeasured is `unavailable` with a reason, never zero. Do not skip, weaken assertions, add sleeps or retries, or
  widen timeouts to make a check pass.
- Each counter is judged by itself: one getting better does not pay for another getting worse.
- Speed never costs correctness: do not cache what can change without invalidating it, and do not loosen the trusted
  native boundary, credential routing, or unknown outcomes.
- Measurement code (`test/perf/`, the channels, the ledger's workloads) and optimisations go in separate commits, so a
  smaller number can be traced to less work, not to a changed instrument.
- Millisecond runs on a shared machine go through the skill's `scripts/timing-run.mjs` lock; `highLoad: true` makes
  their milliseconds untrustworthy. Counters need no lock.
