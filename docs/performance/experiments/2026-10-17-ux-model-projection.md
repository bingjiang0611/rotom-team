# Current native model labels without per-row journal reads

## Question and method

The UX repair needs the native journal's current head/model override, not the old Durable model preference. The first,
unmerged scalar implementation called `hasConversation` + `session` for each session row. The existing benchmark
revealed unnecessary repeated SQL; it was replaced with one read joining `kernel_heads`, `kernel_sessions` and
`kernel_segment_models`, projecting only conversation id and model with SQLite JSON extraction.

No benchmark instrument, workload, ledger, ceiling or trusted-native/account/unknown behavior was changed. Both runs
used `perf:ci` against `45d45275c4fec52c44561443cbb43f8666554c7d` with `--runs 1`, Node 24.18.0, darwin-arm64, Apple M1
(8 cores), isolated pinned rotom 0.1.25 and synthetic loopback models. The head includes uncommitted UX changes.
Product-only diff SHA-256 (`git diff --binary HEAD -- src/server web`):
`1d0e0a85930ac3e0d26654f2254535fa45c64b702dd0750674e563d37852b5b7`.

Private temporary reports:

- Scalar candidate: `/tmp/rotom-ux-followup-perf/{base,head}.json`.
- Final batch candidate: `/tmp/rotom-ux-followup-perf-batch/{base,head}.json`.
- Commands used the skill's `timing-run.mjs` lock, labels `ux-followup` and `ux-followup-batch`.

## Work counters and decision

| Fixed workload counter           | Deployed base | Scalar UX candidate | Final batch UX candidate |
| -------------------------------- | ------------: | ------------------: | -----------------------: |
| `sessions.list/sql.statements`   |             0 |                  39 |                        1 |
| `sessions.list/json.parse.calls` |             1 |                  14 |                        1 |
| `sessions.list/http.body.bytes`  |          3980 |                3980 |                     3980 |
| `web.open/sql.statements`        |            22 |                 232 |                       27 |

Keep the batch projection: it removes the introduced per-row SQL and JavaScript binding parses. It does not claim to
beat the old, incorrect cached display's zero SQL. The remaining one query returns 13 head models in this workload;
no second model cache or invalidation protocol was added. The journal is authoritative after switches, unknown
intent, committed handoff and restart. Tests check immutable old receipt bindings and uncommitted handoff exclusion.

Other observed correctness/presentation costs remain visible rather than hidden: the final fresh base/head comparison
has `commands.list/http.body.bytes` 6859 → 9549 (+2690) for Web capability/argument guidance, unchanged command-list
SQL (10) and JSON parse calls (31), and `web.open/sql.statements` 22 → 27 because session-list updates now read current
native state. Older ledger candidate baselines differ from this fresh base report; they are not interchangeable.

Both runs exited 0: the two gating Git-process counters and ledger guard passed. Candidate counters were not promoted,
removed or given larger tolerances. This is L1 work-counter evidence for avoiding introduced redundant work, not a
claim that all counters improved.

## Limits and verification

Both timing wrappers reported `highLoad: true` (scalar wrapper load 2.50 → 11.67; batch wrapper 2.76 → 8.17). Tests ran
concurrently and there was one sample per side. **No L2 millisecond/faster claim is valid**; do not quote their apparent
speedups/slowdowns as product performance conclusions. No Linux or live-user L3 measurement was run.

The final product source passed 445 unit/integration/browser tests, the opt-in native command HTTP/UI proof (including
sidebar A→B update without reload), the synthetic member-private MCP OAuth proof, TypeScript, formatting, lint and
whitespace checks. The output-list browser fixture is explicitly synthetic public projection plus real authorized
file opening; no real paid account, installation or external workflow was run for this experiment.
