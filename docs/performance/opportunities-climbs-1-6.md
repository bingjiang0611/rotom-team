# Performance opportunities: climbs 1–6 (historical)

Archived from `opportunities.md` to keep edited files within 20,000 bytes. Bodies below are unchanged.

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
