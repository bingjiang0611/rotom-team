# Split native roomState SQL by table

Second experiment in the sixth climb batch: measurement only. While the existing synchronous kernel projection span
is active, the benchmark's SQLite wrapper classifies executed statement `sourceSQL` by its first FROM table. Register
separate fixed-work counters for heads, sessions, attempts, command-input fences and resume plans. Instrumentation is
entirely in `test/perf`; no runtime/schema/protocol/journal change. Classification does not hide statements: category
sums are checked against the existing total below.

## Two-times baseline

Five fresh runs per report on macOS arm64 / Apple M1 eight cores / Node 24.18.0 / rotom 0.1.25; `highLoad: false`.
`/tmp/rt-kernel-query-a.json` load 2.20→2.80; `/tmp/rt-kernel-query-b.json` 2.32→4.82.

| Scenario             | Heads | Sessions | Attempts | Command inputs | Resume | Total |
| -------------------- | ----: | -------: | -------: | -------------: | -----: | ----: |
| Four-tab open        |    28 |       14 |       42 |             14 |      0 |    98 |
| Four-tab paced reply |    72 |       36 |      140 |             68 |      0 |   316 |

Every category has zero spread across ten runs, and sums equal the total. The attempts table dominates remaining reads:
`pendingConversation` selects an ID then `receipt` selects the full row; `latest` does the same. Receipt binding decode
and unresolved-command-input lookup remain separate and mandatory. Resume zero here is a fixture fact, not permission
to remove the clean-stop/resume path.

Registered five categories for all projection scenarios as candidates from both reports; guard and ratchet pass. No
gate promotion, raise or tolerance increase. Type/lint and both real native/Chromium benchmark reports pass. No L1/L2/L3
result is claimed for measurement.

## Decision

Next experiment: change only `latest` and `pendingConversation` to select the full same receipt row on the first query,
then reuse one receipt-decoding helper. Preserve query filter/order/limit, all receipt fields, unresolved-input fence,
current status, phase/failure and thrown unknown-receipt errors. No cache; decoding and the fence query remain fresh.
