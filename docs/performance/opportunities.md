# Performance opportunities

Leads for the climb, each with the evidence that raised it. A lead is a question, not a finding: confirm it with a
counter or the journal before changing code. Record each tried idea here with its outcome, kept or reverted, and link
its experiment file in `experiments/`.

Workload: `test/perf/workload.ts` as of 2026-10-16 (12 seeded turns of 6000-character answers). Numbers are the
`darwin-arm64` ledger baselines (worst of 10 runs from temporary checkouts) and benchmark medians, Apple M1, load below
the core count.

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

## Open

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
