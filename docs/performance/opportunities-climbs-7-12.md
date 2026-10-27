# Performance opportunities: climbs 7–12 and original leads (historical)

Archived from `opportunities.md` to keep edited files within 20,000 bytes. Bodies below are unchanged.

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
