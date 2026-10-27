# D9c performance acceptance

Same instrument, workload, ledger, tolerance and quiet rule on both sides. Every run used the unchanged machine-wide `timing-run.mjs` lock and three alternating base/head samples. No unavailable counters. No performance claim is made for deleting modules that D9b already did not load.

Commands (from the isolated delivery worktree):

```sh
node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs D9c-main-final -- npm run perf:ci -- origin/main --out /tmp/rotom-review-D9c/perf-main
node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs D9c-D9b-scope -- npm run perf:ci -- 2676e7f --out /tmp/rotom-review-D9c/perf-d9b
node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs D9c-D9b-repeat -- npm run perf:ci -- 2676e7f --out /tmp/rotom-review-D9c/perf-d9b-repeat
```

Main is `e649d9d8a0ff8d56d241d9a4c54b1a6ca81a7a92`; D9b is `2676e7f`. Head is `6f51f4e` plus the implementation diff, fixed throughout all three runs and identified by [source hashes](d9c-source-files.json). Node 24.18.0, darwin-arm64, Apple M1 / 8 cores. Raw reports/logs stay under `/tmp/rotom-review-D9c`; [committed numerical evidence](d9c-performance.json) contains hashes, metadata, all timing comparisons and every worse counter with all six samples per pair.

| Pair       | Wall ms | Load before → after | highLoad | Worse counters | Slower timings | Gating / guard |
| ---------- | ------: | ------------------- | -------- | -------------: | -------------: | -------------- |
| main       |  671612 | 5.07 → 12.28        | true     |             65 |              4 | pass / pass    |
| d9b        |  661995 | 5.8 → 6.25          | false    |             30 |              2 | pass / pass    |
| d9b-repeat |  661656 | 6.35 → 3.76         | false    |              7 |              0 | pass / pass    |

## Interpretation

- **P — no D9c increase in either matched D9b comparison.** Both later columns are same/better under the original tolerance. Main differs by the preceding D1–D9b work and sampling; these rows do not identify a new deletion regression. Existing archive/quarantine fields/assets and unavailable-guard wording are explained in [D9a](d9a-performance.md) and [D9b](d9b-performance.md). This is not an invented causal attribution for every inherited event.
- **S — 采样差异，未归因.** A worse value appears in one matched D9b pair but not the other. All 30 initial worse counters failed to reproduce as worse; the repeat has seven different worse counters, none worse in the first pair. Event/serialization and DOM counts can vary; their exact causes are not established. No requirement or threshold was weakened and no samples were discarded.
- The runtime diff adds no request-path work: nine already-unloaded modules disappear; the sole retained production edit is centralized CLI help. Shared request/native/storage/web code and the measurement instrument are byte-unchanged from D9b. This source observation does not prove all timing variation harmless.
- Main highLoad=true: its timing verdicts are diagnostic, **not L2 evidence**. First matched D9b run has two slower sub-millisecond timings; neither repeats. The repeat has zero slower timings. No user-latency improvement or absence of every possible regression is claimed.

## Every main worse counter

| Counter                                           |      Main → D9c | D9b → D9c, first        | D9b → D9c, repeat      | Explanation |
| ------------------------------------------------- | --------------: | ----------------------- | ---------------------- | ----------- |
| `startup.restart/sql.statements`                  |       848 → 857 | 857 → 857 (same)        | 857 → 857 (same)       | P           |
| `startup.restart/sql.rows`                        |       529 → 543 | 543 → 542 (same)        | 543 → 543 (same)       | P           |
| `startup.restart/json.parse.durableStorage.calls` |       459 → 499 | 499 → 498 (better)      | 499 → 499 (same)       | P           |
| `startup.restart/json.parse.durableStorage.chars` |   51435 → 56282 | 56282 → 56263 (better)  | 56282 → 56282 (same)   | P           |
| `startup.restart/json.stringify.chars`            |   18739 → 18758 | 18758 → 18758 (same)    | 18758 → 18758 (same)   | P           |
| `session.open/view.fields.stringify.calls`        |         12 → 13 | 13 → 13 (same)          | 13 → 13 (same)         | P           |
| `session.open/view.fields.stringify.chars`        |       600 → 604 | 604 → 604 (same)        | 604 → 604 (same)       | P           |
| `session.open/push.view.bytes`                    |   76276 → 76292 | 76292 → 76292 (same)    | 76292 → 76292 (same)   | P           |
| `turn.cold/json.parse.chars`                      | 680262 → 721230 | 678549 → 679876 (same)  | 678549 → 678549 (same) | P           |
| `turn.cold/json.parse.journalSegments.calls`      |          6 → 11 | 6 → 6 (same)            | 6 → 6 (same)           | P           |
| `turn.cold/json.parse.journalSegments.chars`      |   46770 → 87042 | 46770 → 46770 (same)    | 46770 → 46770 (same)   | P           |
| `turn.cold/json.stringify.chars`                  | 127076 → 134777 | 127088 → 128691 (worse) | 127088 → 127088 (same) | S           |
| `turn.cold/push.events`                           |           5 → 6 | 5 → 6 (worse)           | 5 → 5 (same)           | S           |
| `turn.cold/push.bytes`                            |   18599 → 25910 | 18599 → 19824 (worse)   | 18599 → 18599 (same)   | S           |
| `turn.cold/push.view.count`                       |           3 → 4 | 3 → 4 (worse)           | 3 → 3 (same)           | S           |
| `turn.cold/push.view.bytes`                       |    9781 → 17092 | 9781 → 11006 (worse)    | 9781 → 9781 (same)     | S           |
| `turn.paced/view.fields.stringify.calls`          |       132 → 143 | 143 → 143 (same)        | 143 → 143 (same)       | P           |
| `turn.paced/view.fields.stringify.chars`          |     2232 → 2276 | 2276 → 2276 (same)      | 2276 → 2276 (same)     | P           |
| `web.open/view.fields.stringify.calls`            |         12 → 13 | 13 → 13 (same)          | 13 → 13 (same)         | P           |
| `web.open/view.fields.stringify.chars`            |       600 → 604 | 604 → 604 (same)        | 604 → 604 (same)       | P           |
| `web.open/push.events`                            |         10 → 11 | 11 → 11 (same)          | 11 → 11 (same)         | P           |
| `web.open/push.bytes`                             |   83736 → 83989 | 83989 → 83989 (same)    | 83989 → 83989 (same)   | P           |
| `web.open/push.view.bytes`                        |   76309 → 76349 | 76349 → 76349 (same)    | 76349 → 76349 (same)   | P           |
| `web.open/http.requests`                          |         81 → 82 | 84 → 82 (better)        | 82 → 84 (worse)        | S           |
| `web.open/cdp.Nodes`                              |      996 → 1138 | 1138 → 1114 (better)    | 1138 → 1138 (same)     | P           |
| `web.open/web.event.parse.calls`                  |          9 → 10 | 10 → 10 (same)          | 10 → 10 (same)         | P           |
| `web.open/web.event.parse.chars`                  |   82941 → 83166 | 83166 → 83166 (same)    | 83166 → 83166 (same)   | P           |
| `session.reclaim/json.parse.journal.calls`        |          7 → 12 | 7 → 5 (same)            | 7 → 7 (same)           | P           |
| `session.reclaim/json.parse.journal.chars`        |     3787 → 6492 | 3787 → 2705 (same)      | 3787 → 3787 (same)     | P           |
| `session.reclaim/push.view.bytes`                 |     3072 → 4175 | 3088 → 2001 (same)      | 3088 → 3088 (same)     | P           |
| `session.open.long/view.fields.stringify.calls`   |         12 → 13 | 13 → 13 (same)          | 13 → 13 (same)         | P           |
| `session.open.long/view.fields.stringify.chars`   |         73 → 77 | 77 → 77 (same)          | 77 → 77 (same)         | P           |
| `session.open.long/push.bytes`                    | 179320 → 179345 | 179345 → 179345 (same)  | 179345 → 179345 (same) | P           |
| `session.open.long/push.view.bytes`               | 165843 → 165859 | 165859 → 165859 (same)  | 165859 → 165859 (same) | P           |
| `web.open.long/view.fields.stringify.calls`       |         12 → 13 | 13 → 13 (same)          | 13 → 13 (same)         | P           |
| `web.open.long/view.fields.stringify.chars`       |         73 → 77 | 77 → 77 (same)          | 77 → 77 (same)         | P           |
| `web.open.long/push.view.bytes`                   | 165859 → 165899 | 165899 → 165899 (same)  | 165899 → 165899 (same) | P           |
| `web.open.long/http.requests`                     |         80 → 81 | 81 → 81 (same)          | 81 → 81 (same)         | P           |
| `web.open.long/cdp.Nodes`                         |     1595 → 1703 | 1703 → 1727 (same)      | 1703 → 1727 (same)     | P           |
| `web.open.long/web.event.parse.calls`             |           8 → 9 | 9 → 9 (same)            | 9 → 9 (same)           | P           |
| `web.open.long/web.event.parse.chars`             | 173290 → 173517 | 173517 → 173517 (same)  | 173517 → 173517 (same) | P           |
| `native.warm/sql.rows`                            |         10 → 11 | 11 → 11 (same)          | 11 → 11 (same)         | P           |
| `turn.prewarmed/fs.read.calls`                    |         25 → 26 | 26 → 25 (better)        | 26 → 26 (same)         | P           |
| `turn.prewarmed/json.parse.durableStorage.calls`  |         18 → 20 | 20 → 18 (better)        | 18 → 18 (same)         | P           |
| `turn.prewarmed/json.parse.durableStorage.chars`  |     1122 → 1424 | 1424 → 1122 (better)    | 1122 → 1122 (same)     | P           |
| `web.reopen/view.fields.stringify.calls`          |         12 → 13 | 13 → 13 (same)          | 13 → 13 (same)         | P           |
| `web.reopen/view.fields.stringify.chars`          |       645 → 649 | 649 → 649 (same)        | 649 → 649 (same)       | P           |
| `web.reopen/push.events`                          |          9 → 10 | 10 → 10 (same)          | 10 → 10 (same)         | P           |
| `web.reopen/push.bytes`                           |   10313 → 10566 | 10566 → 10566 (same)    | 10566 → 10566 (same)   | P           |
| `web.reopen/push.view.bytes`                      |     2001 → 2041 | 2041 → 2041 (same)      | 2041 → 2041 (same)     | P           |
| `web.reopen/cdp.Nodes`                            |     1100 → 1232 | 1232 → 1232 (same)      | 1232 → 1232 (same)     | P           |
| `web.reopen/web.event.parse.calls`                |           8 → 9 | 9 → 9 (same)            | 9 → 9 (same)           | P           |
| `web.reopen/web.event.parse.chars`                |     9527 → 9752 | 9752 → 9752 (same)      | 9752 → 9752 (same)     | P           |
| `web.paced/cdp.Nodes`                             |     1302 → 1424 | 1423 → 1421 (same)      | 1422 → 1422 (same)     | P           |
| `web.send.poll/cdp.Nodes`                         |     1479 → 1615 | 1618 → 1616 (same)      | 1619 → 1621 (same)     | P           |
| `web.send.stream/push.bytes`                      |   91291 → 92005 | 92005 → 92005 (same)    | 92407 → 92005 (better) | P           |
| `web.send.stream/push.view.bytes`                 |   77497 → 78187 | 78187 → 78187 (same)    | 78589 → 78187 (better) | P           |
| `web.send.stream/cdp.RecalcStyleCount`            |       104 → 112 | 110 → 109 (same)        | 108 → 110 (same)       | P           |
| `web.send.stream/cdp.Nodes`                       |     1516 → 1654 | 1629 → 1656 (worse)     | 1631 → 1633 (same)     | S           |
| `web.send.stream/web.event.parse.chars`           |   30133 → 30445 | 30445 → 30445 (same)    | 30445 → 30445 (same)   | P           |
| `commands.discover.cold/json.stringify.chars`     |   33846 → 33854 | 33854 → 33854 (same)    | 33854 → 33871 (worse)  | S           |
| `projection.large.open/push.bytes`                | 164251 → 164351 | 164351 → 164351 (same)  | 164351 → 164351 (same) | P           |
| `projection.large.open/push.view.bytes`           | 114758 → 114822 | 114822 → 114822 (same)  | 114822 → 114822 (same) | P           |
| `assets.first/http.requests`                      |         53 → 54 | 54 → 54 (same)          | 54 → 54 (same)         | P           |
| `assets.validated/http.requests`                  |         53 → 54 | 54 → 54 (same)          | 54 → 54 (same)         | P           |

## Every matched D9b worse counter (union of both runs)

Each row is S; the other pair is the non-reproducing control. Values are the original three samples, not an average substituted for the ratchet maximum.

| Counter                                         | First base → head runs                          | Repeat base → head runs                         | Verdict first / repeat |
| ----------------------------------------------- | ----------------------------------------------- | ----------------------------------------------- | ---------------------- |
| `changes.poll.images/json.stringify.chars`      | 20312, 20322, 20322 → 20328, 20362, 20322       | 20370, 20272, 20330 → 20346, 20314, 20354       | worse / same           |
| `commands.discover.cold/json.stringify.chars`   | 33854, 33820, 33854 → 33854, 33820, 33854       | 33854, 33820, 33820 → 33871, 33820, 33854       | same / worse           |
| `commands.discover.cold/push.bytes`             | 11726, 11726, 11726 → 11726, 11726, 11726       | 11726, 11726, 11726 → 11800, 11726, 11726       | same / worse           |
| `commands.discover.cold/push.events`            | 4, 4, 4 → 4, 4, 4                               | 4, 4, 4 → 5, 4, 4                               | same / worse           |
| `projection.large.open/json.stringify.chars`    | 182008, 182008, 182008 → 182076, 181974, 182008 | 182042, 182042, 181974 → 181974, 182008, 181974 | worse / better         |
| `projection.large.paced/json.stringify.chars`   | 425143, 425975, 429981 → 426746, 429179, 427544 | 422778, 421981, 425283 → 428411, 427582, 431647 | better / worse         |
| `projection.large.paced/push.bytes`             | 251428, 252228, 256228 → 253028, 255428, 253828 | 249028, 248228, 251428 → 254628, 253828, 257828 | better / worse         |
| `projection.large.paced/push.view.bytes`        | 210056, 210856, 214856 → 211656, 214056, 212456 | 207656, 206856, 210056 → 213256, 212456, 216456 | better / worse         |
| `turn.cold/json.parse.journal.calls`            | 39, 41, 41 → 44, 41, 41                         | 41, 41, 41 → 41, 39, 41                         | worse / same           |
| `turn.cold/json.parse.journal.chars`            | 64623, 65705, 65705 → 67328, 65705, 65705       | 65705, 65705, 65705 → 65705, 64623, 65705       | worse / same           |
| `turn.cold/json.stringify.chars`                | 126807, 127088, 127088 → 128691, 126807, 126807 | 126807, 127088, 126807 → 127088, 126807, 126807 | worse / same           |
| `turn.cold/push.bytes`                          | 18599, 18599, 18599 → 19824, 18599, 18599       | 18599, 18599, 18599 → 18599, 18599, 18599       | worse / same           |
| `turn.cold/push.events`                         | 5, 5, 5 → 6, 5, 5                               | 5, 5, 5 → 5, 5, 5                               | worse / same           |
| `turn.cold/push.view.bytes`                     | 9781, 9781, 9781 → 11006, 9781, 9781            | 9781, 9781, 9781 → 9781, 9781, 9781             | worse / same           |
| `turn.cold/push.view.count`                     | 3, 3, 3 → 4, 3, 3                               | 3, 3, 3 → 3, 3, 3                               | worse / same           |
| `turn.prepared/json.parse.durableStorage.calls` | 19, 19, 19 → 21, 19, 19                         | 19, 21, 19 → 19, 19, 19                         | worse / better         |
| `turn.prepared/json.parse.durableStorage.chars` | 1412, 1412, 1412 → 1710, 1412, 1412             | 1412, 1710, 1412 → 1412, 1412, 1412             | worse / better         |
| `web.open/http.requests`                        | 82, 84, 83 → 82, 82, 82                         | 82, 82, 82 → 82, 82, 84                         | better / worse         |
| `web.paced/push.events`                         | 15, 15, 15 → 16, 16, 15                         | 15, 15, 15 → 15, 15, 15                         | worse / same           |
| `web.paced/push.view.count`                     | 11, 11, 11 → 12, 12, 11                         | 11, 11, 11 → 11, 11, 11                         | worse / same           |
| `web.paced/sql.rows`                            | 266, 266, 266 → 274, 274, 266                   | 266, 266, 266 → 266, 266, 266                   | worse / same           |
| `web.paced/sql.statements`                      | 254, 254, 254 → 263, 263, 254                   | 254, 254, 254 → 254, 254, 254                   | worse / same           |
| `web.paced/view.fields.stringify.calls`         | 143, 143, 143 → 156, 156, 143                   | 143, 143, 143 → 143, 143, 143                   | worse / same           |
| `web.paced/view.fields.stringify.chars`         | 7094, 7094, 7094 → 7743, 7743, 7094             | 7094, 7094, 7094 → 7094, 7094, 7094             | worse / same           |
| `web.paced/view.inbox.project.calls`            | 11, 11, 11 → 12, 12, 11                         | 11, 11, 11 → 11, 11, 11                         | worse / same           |
| `web.paced/view.kernel.json.parse.calls`        | 22, 22, 22 → 24, 24, 22                         | 22, 22, 22 → 22, 22, 22                         | worse / same           |
| `web.paced/view.kernel.json.parse.chars`        | 11902, 11902, 11902 → 12984, 12984, 11902       | 11902, 11902, 11902 → 11902, 11902, 11902       | worse / same           |
| `web.paced/view.kernel.project.calls`           | 11, 11, 11 → 12, 12, 11                         | 11, 11, 11 → 11, 11, 11                         | worse / same           |
| `web.paced/view.kernel.sql.attempts`            | 22, 22, 22 → 24, 24, 22                         | 22, 22, 22 → 22, 22, 22                         | worse / same           |
| `web.paced/view.kernel.sql.command_inputs`      | 11, 11, 11 → 12, 12, 11                         | 11, 11, 11 → 11, 11, 11                         | worse / same           |
| `web.paced/view.kernel.sql.heads`               | 11, 11, 11 → 12, 12, 11                         | 11, 11, 11 → 11, 11, 11                         | worse / same           |
| `web.paced/view.kernel.sql.rows`                | 32, 32, 32 → 35, 35, 32                         | 32, 32, 32 → 32, 32, 32                         | worse / same           |
| `web.paced/view.kernel.sql.statements`          | 44, 44, 44 → 48, 48, 44                         | 44, 44, 44 → 44, 44, 44                         | worse / same           |
| `web.paced/view.live.project.calls`             | 11, 11, 11 → 12, 12, 11                         | 11, 11, 11 → 11, 11, 11                         | worse / same           |
| `web.paced/web.event.parse.calls`               | 13, 13, 13 → 14, 14, 13                         | 13, 13, 13 → 13, 13, 13                         | worse / same           |
| `web.paced/web.view.apply.calls`                | 11, 11, 11 → 12, 12, 11                         | 11, 11, 11 → 11, 11, 11                         | worse / same           |
| `web.send.stream/cdp.Nodes`                     | 1624, 1629, 1628 → 1655, 1656, 1625             | 1631, 1628, 1627 → 1629, 1578, 1633             | worse / same           |

## Every slower timing

| Pair | Timing                            | Base → head ms | Repeat matched verdict | Limitation                                        |
| ---- | --------------------------------- | -------------: | ---------------------- | ------------------------------------------------- |
| main | `session.open/ms`                 |    29.7 → 46.2 | noise                  | highLoad=true; no L2 conclusion                   |
| main | `session.open.long/ms`            |         5 → 13 | noise                  | highLoad=true; no L2 conclusion                   |
| main | `web.paced/viewApplyMs`           |      1.1 → 1.8 | noise                  | highLoad=true; no L2 conclusion                   |
| main | `projection.large.open/ms`        |    46.6 → 66.4 | noise                  | highLoad=true; no L2 conclusion                   |
| d9b  | `turn.cold/nativeStartValidateMs` |      0.2 → 0.3 | noise                  | not reproduced; sampling, not causally attributed |
| d9b  | `web.open/viewApplyMs`            |      0.2 → 0.6 | faster                 | not reproduced; sampling, not causally attributed |
