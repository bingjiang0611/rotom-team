# Controlled performance benchmarks

This guide contains the fixed workloads and ratchet rules used by the [performance loop](PERFORMANCE.md).

## Controlled benchmarks

`npm run perf:measure -- [--runs N] [--out FILE]` runs [test/perf/scenarios.ts](../test/perf/scenarios.ts) N times
(default 3), each in a fresh process on fresh temporary data, and writes `perf-results/<revision>.json`. The runs use a
temporary checkout of what is on disk ([test/perf/checkout.ts](../test/perf/checkout.ts)), never the working folder:
the server's data lists bundled resources by path, so character and byte counters change with the checkout path's
length. Temporary checkouts have one path length on one machine.

Each run is the service's real path: kernel mode, real rotom child processes, the real HTTP handler, a real
event-stream tab, and a loopback OpenAI-compatible model that streams a fixed answer. No real account or network is
used. The workload is fixed in [test/perf/workload.ts](../test/perf/workload.ts):

| Scenario                   | What it does                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startup.restart`          | close the app on seeded data (13 sessions, one with 12 turns) and open it again                                                                                                                                                       |
| `sessions.rename.tabs`     | Four delta-capable SSE tabs receive two renames, with initial catalogue setup unmeasured on both sides; every reconstructed list must equal the server list                                                                           |
| `sessions.list`            | `GET /api/sessions`                                                                                                                                                                                                                   |
| `session.open`             | a new event-stream tab on the 12-turn session, until its first full view                                                                                                                                                              |
| `turn.cold`                | first prompt of a new session (starts its rotom process), until settled + quiet                                                                                                                                                       |
| `turn.warm`                | the next prompt of that session                                                                                                                                                                                                       |
| `turn.paced`               | a prompt whose answer streams 25 ms per chunk, as a real model does                                                                                                                                                                   |
| `git.changes`              | `GET changes` in a Git workspace with 20 changed files                                                                                                                                                                                |
| `git.branches`             | `GET branches`                                                                                                                                                                                                                        |
| `commands.list`            | `GET` the native slash-command list                                                                                                                                                                                                   |
| `web.open`                 | headless Chromium opens `/s/<session>` until the last answer is in the page                                                                                                                                                           |
| `session.reclaim`          | after an unmeasured tab loads the 12-turn view, a new tab connects claiming every entry it held, until its full view; the rebuilt transcript must equal the held one                                                                  |
| `web.reopen`               | Chromium opens the session in one tab (until saved, where the page keeps copies), closes it, then opens it in a fresh tab until the server-confirmed answer shows; `firstShownMs` is the first appearance from any source             |
| `session.open.long`        | after all other scenarios, a new event-stream tab on a separate 600-entry native history (seeded directly), asking for the newest 240 entries as the web app does, until its full view; every entry it got must equal an unpaged view |
| `session.history.earlier`  | that tab then reads every entry it lacks, page by page, until it holds the whole history (a tab that got everything asks nothing)                                                                                                     |
| `web.open.long`            | headless Chromium opens the long session until its newest answer is in the page                                                                                                                                                       |
| `native.warm`              | after all other scenarios, a new native session; its member asks to warm it (as focusing the message box does), until the answer                                                                                                      |
| `turn.prewarmed`           | the first prompt of that session after `native.warm`, until settled and quiet                                                                                                                                                         |
| `native.validate`          | the team validator a subagent start runs (`rotom-child.ts`, its own Node process) in that member's HOME, until it exits                                                                                                               |
| `image.single`             | retrieve one stored image from a separate 24-image native-format Durable mirror                                                                                                                                                       |
| `image.concurrent`         | retrieve four distinct images concurrently from that mirror, through exact binary readback                                                                                                                                            |
| `image.thumbs.first`       | request four previously unrequested stored images as thumbnails, including generation and writes                                                                                                                                      |
| `image.thumbs.again`       | request those same four thumbnails again, without a browser cache                                                                                                                                                                     |
| `image.thumbs.network`     | Chromium downloads and decodes four other first-time thumbnails with cache disabled on a CDP-emulated 4 Mbit/s, 40 ms link                                                                                                            |
| `image.paste.network`      | Chromium prepares and uploads a deterministic large clipboard PNG on a 4 Mbit/s uplink; includes browser resize, HTTP upload, readback and decode, without model inference                                                            |
| `image.original.again`     | Repeat the four originals from image.concurrent, preserving exact binary readback                                                                                                                                                     |
| `image.original.validated` | Repeat those originals with If-None-Match; require either exact original bytes or a matching 304 with no body                                                                                                                         |

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
window. The probe scopes both legacy `entryImage` and shared `storedImage` entry points where present, counting
actual base64 conversions rather than wrapper invocations. Old baselines and nested delegation are therefore
observed without missing or double-counting decode work.

## Ledger and ratchet

[test/perf/ledger.json](../test/perf/ledger.json) is a schema-2 index of bounded JSON parts in
`test/perf/ledger/`, grouped by scenario and counter responsibility. The assembled schema-1 ledger still keys each
counter by `scenario/metric` and preserves its workload, source, status, tolerance, and baselines or ceiling.
Use `readLedger()` from `test/perf/ledger.ts` rather than parsing the index as a metric map. The loader also reads
legacy flat snapshots for historical guards; CI reads every historical part from that same Git revision.
Missing or duplicate parts/keys fail, never silently disappear. `propose --write` and `register --write` retain the
bounded format; all outputs are checked against 20,000 bytes before writing. If a domain or the index reaches that
limit, split its responsibility further before retrying; do not raise the limit. The existing CLI is unchanged:
[test/perf/ratchet.ts](../test/perf/ratchet.ts):

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

Gating now: `git.changes/subprocess.git` (ceiling 3) and `git.branches/subprocess.git` (ceiling 2), with the evidence in
[performance/experiments/2026-10-16-gate-git-counters.md](performance/experiments/2026-10-16-gate-git-counters.md).
Everything else is a candidate with a `darwin-arm64` baseline. Counts may differ by platform: a `linux-x64` baseline is
registered from Linux reports, never copied from macOS.
