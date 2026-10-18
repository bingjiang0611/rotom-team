# Count native roomState storage and decode work

Third experiment in the fifth climb batch: measurement only. Publish a content-free start/end pair around the existing
synchronous Room projection spans. The controlled benchmark snapshots its existing SQL/JSON counters at start and
diffs them at end. No production journal subscriber, cache, durability/permission/credential behavior or payload change.
The begin event changes no existing construction-count semantics: only one call is counted per span.

## Two-times baseline

Five fresh runs per report on macOS arm64 / Apple M1 eight cores / Node 24.18.0 / rotom 0.1.25; both timing locks
`highLoad: false`. `/tmp/rt-kernel-roomstate-a.json` load 2.60→5.07;
`/tmp/rt-kernel-roomstate-b.json` 4.02→2.54.

| Scenario             | Kernel projections | SQL statements |    Rows | JSON decodes | Decoded chars |
| -------------------- | -----------------: | -------------: | ------: | -----------: | ------------: |
| Four-tab open        |                 14 |            140 |     112 |           42 |        22,722 |
| Four-tab paced reply |              32–36 |        376–424 | 312–352 |      124–140 | 67,084–75,740 |
| Existing paced turn  |                  9 |            106 |      88 |           35 |        18,935 |

Open and ordinary paced counts have zero spread across ten runs. Large paced has one 32-push sample due to unchanged
streaming coalescing; candidates preserve that measured spread. Per quiet/open push there are ten SQL statements,
eight returned rows and three binding decodes. More statements are needed while a pending receipt exists. These are
actual on-path work, not cost guessed from code.

Code follow-through: `TeamKernel.roomState` reads session, pending and cutoff on every call. Its `#commandSnapshot`
reads presence/session again before exact viewer/member/segment/binding equality; `#cutOff` reads latest receipt and
resume policy. `RotomJournal.receipt` decodes binding and checks unresolved command input. `commandCatalogRevision`
itself is only a captured-time/staleness string, not an expensive catalog hash. The main lead is repeated fresh
journal reads/decodes, not command-name enumeration. No optimization is applied in this experiment.

Registered all new kernel SQL/JSON observations from both reports. Ledger guard and ratchet check pass; no promotion
or tolerance increase. Final type/lint/format checks, 447 tests and synthetic kernel proof pass (82 loopback requests,
no real provider, `webUiVerified: false`). Real Chromium benchmark validates open plus streamed final-answer readback;
it is not full real-account/UI acceptance.

## Decision and next action

Batch stops after three experiments. Next hypothesis: pass the already-read exact session snapshot into
`#commandSnapshot` inside the same synchronous `roomState` call, eliminating duplicated presence/session/binding decode
without any cross-call cache. Keep viewer/member/segment/model/binding comparison, current pending/unknown fences and
cutoff policy unchanged. Broader batching of receipt/session reads may follow only with independent evidence and
negative controls. Pagination/delta protocols remain unjustified by these small-browser counters.
