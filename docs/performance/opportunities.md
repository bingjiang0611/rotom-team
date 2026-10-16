# Performance opportunities

Leads for the climb, each with the evidence that raised it. A lead is a question, not a finding: confirm it with a
counter or the journal before changing code. Record each tried idea here with its outcome, kept or reverted, and link
its experiment file in `experiments/`.

Workload: `test/perf/workload.ts` as of 2026-10-16 (12 seeded turns of 6000-character answers). Numbers are the
`darwin-arm64` ledger baselines (worst of 10 runs from temporary checkouts) and benchmark medians, Apple M1, load below
the core count.

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
