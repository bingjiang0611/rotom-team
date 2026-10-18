# Measure slow view-field serialization

Third experiment in the fourth climb batch: measurement only. `Room.push` omits slow-changing fields only after
serializing every candidate field for per-client equality. Count those JSON calls and output characters separately
from global `JSON.stringify` and actual SSE bytes. The signal contains only counts and sizes; no field names, values,
IDs or content. The production journal does not subscribe and its schema is unchanged.

## Two-times baseline

Five fresh runs per report on macOS arm64 / Apple M1 eight cores / Node 24.18.0 / pinned rotom 0.1.25. Timing locks
reported `highLoad: false`. `/tmp/rt-view-fields-a.json` load 3.15→3.30;
`/tmp/rt-view-fields-b.json` 3.34→2.87. All new counters have zero spread across ten runs.

| Scenario             | Slow-field JSON calls | Serialized characters | Actual view bytes (range) |
| -------------------- | --------------------: | --------------------: | ------------------------: |
| Four-tab open        |                   168 |                41,328 |                   112,462 |
| Four-tab paced reply |                   432 |               107,892 |           183,616–190,016 |

There are exactly 12 candidate fields for each of 14 and 36 view pushes. The serialized field values average only 246
and 250 characters per push in this fixture. They are meaningful repeated CPU/allocation work, but smaller than actual
view payloads and do not establish a user-visible wait. Actual paced bytes vary because the unchanged 90 ms coalescing
races the deliberately paced model; the slow-field count is stable.

Registered candidates for session-open, warm/paced turn, web-open and both large projection scenarios from both
reports. Ledger guard and ratchet check pass; no promotion or tolerance increase. Type/lint/format, 22 targeted tests,
full 444 tests after rerunning the known drop-in watcher flake alone, and synthetic kernel proof pass. The first full
run was 443/444 with the documented pre-existing drop-in watcher timeout; isolated rerun passed in 418 ms, and the
unchanged full suite then passed 444/444. Kernel proof reports `passed`, 82 loopback requests, no real provider/UI.

## Decision

Keep measurement only; no L1/L2/L3 claim. Do not add another broad cache yet: every candidate field has different
invalidation (documents, Git branch, native goal, schedules), and the measured values are small. Next batch should
measure the large live/inbox/kernel portions and actual client JSON parsing/copy work before considering protocol
pagination or deltas. This batch stops after three experiments.
