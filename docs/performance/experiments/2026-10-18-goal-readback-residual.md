# Rank parsing after same-fanout native Goal reuse

Third experiment of the eighth climb batch. Reuse the five-run head report `/tmp/rt-goal-fanout-head.json` to choose the
next measurement, not another unmeasured cache. Instrument and optimization are commits `2398415` and `2a6c07c`.

| JSON source calls            | Four-tab open | Four-tab paced |
| ---------------------------- | ------------: | -------------: |
| Journal full segment entries |           660 |          1,198 |
| Native readback              |             0 |            319 |
| Journal other                |            61 |            206 |
| Durable storage              |           139 |             14 |
| Journal mirror               |             0 |              4 |
| HTTP / other                 |         0 / 0 |         1 / 24 |
| **Total**                    |       **860** |      **1,766** |

Counts have zero spread; exclusive source counts/chars still sum exactly to totals. Segment readback remains
76.7%/67.8% of calls, about 468.6k/851.8k characters. Every fanout now has only one Goal read, so another fanout cache
would need cross-call invalidation and is not authorized by this result.

`TeamKernel.nativeGoal` still requests a full fresh current segment. `currentBranchGoalState` then builds a map for
all entries and walks selected ancestors until it finds the newest `goal-state` custom entry. Most entry bodies are
unrelated messages. No finding here permits skipping current head, live Goal precedence, reset/fork/handoff or unknown
safety reads. The parent totals include neither native-child parsing nor a large-history Chromium scaling test.

## Next owner/action

The coding agent's next independent hypothesis is a targeted **fresh readback**, not a cache: ask the journal for
selected-branch Goal metadata without decoding unrelated message bodies. First measure/index-plan and test parity
against the existing reducer using linear histories, abandoned branches, unflushed/live precedence, Goal clear,
fork/handoff/restart, malformed data and missing links. Preserve existing errors and selected-leaf semantics. Choose
whether a recursive indexed ancestry read or metadata-only extraction actually reduces work; do not change the schema,
stored document kinds or audit history to manufacture a smaller counter. Do not implement pagination/protocol deltas
without long-history browser/payload evidence.

This batch stops after three experiments. Retained fanout reuse reaches L1: total parse calls open 2,057→860 (58.2%)
and paced 5,387→1,766 (67.2%); kernel safety SQL and push counts remain unchanged. Timing comparisons remain noise.
Final type/lint/format, 451 tests, synthetic kernel (82 loopback requests), native command/browser proof (28 synthetic
inferences; Goal waiting/wake/start/edit/clear and mobile checks) pass. No production service/data or real account was
used; no push, deployment or service restart. Temporary reports/control logs remain under `/tmp/rt-parse-source-*` and
`/tmp/rt-goal-fanout-*`; browser proof screenshots remain in its printed temporary native-commands data directory.
