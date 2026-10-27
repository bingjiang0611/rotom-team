# Worse-counter inventory: room append (2026-10-26)

Companion to [the experiment](2026-10-26-room-append-prefix.md). Values are the worst measured run, as `perf:compare` defines them. Every counter marked worse is listed. No threshold/tolerance was raised, and no improvement in another counter is used to cancel these increases.

## Isolated five-run comparison

- **P**: extra coalescing-sensitive view pushes. Cold: 3 → 3/4; stream: 24 → 24/26/28. Associated SQL/projection/serialization/browser work follows those pushes. First three head stream runs retain exactly the baseline's 24 pushes and 316 SQL statements. Scheduling was not changed; loaded-run timing is not a speed result.
- **R**: restart has no attached client or append projection; the changed suffix loop is not executed in this scenario. +1 storage parse / +19 characters is outside this optimisation's path. No new storage query is introduced.
- **S**: small serialized-size variation, without a new field or protocol change. The changed code retains identical full entry/order values; the existing semantic assertions remain. Exact per-record byte differences were not retained, so no additional optimisation claim is made from these variations.

| Counter                                           | Base (5 runs) | Head (5 runs) | Explanation |
| ------------------------------------------------- | ------------: | ------------: | ----------- |
| `startup.restart/json.parse.durableStorage.calls` |           498 |           499 | R           |
| `startup.restart/json.parse.durableStorage.chars` |         56263 |         56282 | R           |
| `session.open/json.parse.chars`                   |        253825 |        253830 | S           |
| `session.open/json.parse.durableStorage.chars`    |        130178 |        130181 | S           |
| `turn.cold/json.parse.chars`                      |        678549 |        720148 | P           |
| `turn.cold/json.parse.journal.calls`              |            41 |            44 | P           |
| `turn.cold/json.parse.journal.chars`              |         65705 |         67328 | P           |
| `turn.cold/json.parse.journalSegments.calls`      |             6 |            11 | P           |
| `turn.cold/json.parse.journalSegments.chars`      |         46770 |         87042 | P           |
| `turn.cold/json.stringify.chars`                  |        127088 |        128701 | P           |
| `turn.cold/push.events`                           |             5 |             6 | P           |
| `turn.cold/push.bytes`                            |         18599 |         19834 | P           |
| `turn.cold/push.view.count`                       |             3 |             4 | P           |
| `turn.cold/push.view.bytes`                       |          9781 |         11016 | P           |
| `git.changes/json.parse.chars`                    |        122740 |        122742 | S           |
| `git.changes/json.parse.durableStorage.chars`     |        122740 |        122742 | S           |
| `git.changes/json.stringify.chars`                |          3108 |          3139 | S           |
| `web.paced/view.fields.stringify.chars`           |          7698 |          7743 | S           |
| `web.send.stream/sql.statements`                  |           316 |           342 | P           |
| `web.send.stream/sql.rows`                        |           330 |           352 | P           |
| `web.send.stream/view.fields.stringify.calls`     |           156 |           182 | P           |
| `web.send.stream/view.fields.stringify.chars`     |          8846 |         10328 | P           |
| `web.send.stream/view.live.project.calls`         |            24 |            28 | P           |
| `web.send.stream/view.inbox.project.calls`        |            24 |            28 | P           |
| `web.send.stream/view.kernel.project.calls`       |            24 |            28 | P           |
| `web.send.stream/view.kernel.sql.statements`      |            96 |           112 | P           |
| `web.send.stream/view.kernel.sql.heads`           |            24 |            28 | P           |
| `web.send.stream/view.kernel.sql.attempts`        |            48 |            56 | P           |
| `web.send.stream/view.kernel.sql.command_inputs`  |            24 |            28 | P           |
| `web.send.stream/view.kernel.sql.rows`            |            70 |            82 | P           |
| `web.send.stream/view.kernel.json.parse.calls`    |            48 |            56 | P           |
| `web.send.stream/view.kernel.json.parse.chars`    |         25968 |         30296 | P           |
| `web.send.stream/push.events`                     |            30 |            34 | P           |
| `web.send.stream/push.bytes`                      |         92005 |         95928 | P           |
| `web.send.stream/push.view.count`                 |            24 |            28 | P           |
| `web.send.stream/push.view.bytes`                 |         78187 |         82110 | P           |
| `web.send.stream/web.event.parse.calls`           |            15 |            17 | P           |
| `web.send.stream/web.event.parse.chars`           |         30447 |         32810 | P           |
| `web.send.stream/web.view.apply.calls`            |            12 |            14 | P           |
| `projection.large.open/json.stringify.chars`      |        181972 |        182006 | S           |

## Required origin/main CI comparison

`origin/main=e649d9d8a0ff` predates many changes already present in the frozen base `e2a1eb0b59c5`. This one-run CI is not an isolated attribution experiment.

- **B**: CI head is at or below the already measured frozen-base worst. This counter's increase over origin/main is already present within the pre-optimisation branch evidence, not a new demonstrated regression from this change.
- **T**: exceeds the frozen-base worst by only 1 DOM node or 3 style recalculations, within the existing tolerance of 5. The isolated five-run comparison does not classify these as worse. No tolerance was widened.

| Counter                                           | origin/main (1 run) | CI head (1 run) | Frozen-base worst (5 runs) | Explanation |
| ------------------------------------------------- | ------------------: | --------------: | -------------------------: | ----------- |
| `startup.restart/sql.statements`                  |                 848 |             857 |                        857 | B           |
| `startup.restart/sql.rows`                        |                 529 |             542 |                        542 | B           |
| `startup.restart/json.parse.durableStorage.calls` |                 459 |             498 |                        498 | B           |
| `startup.restart/json.parse.durableStorage.chars` |               51435 |           56263 |                      56263 | B           |
| `startup.restart/json.stringify.chars`            |               18739 |           18758 |                      18758 | B           |
| `session.open/view.fields.stringify.calls`        |                  12 |              13 |                         13 | B           |
| `session.open/view.fields.stringify.chars`        |                 600 |             604 |                        604 | B           |
| `session.open/push.view.bytes`                    |               76276 |           76292 |                      76292 | B           |
| `turn.warm/json.stringify.chars`                  |               85248 |           85258 |                      87164 | B           |
| `turn.warm/view.fields.stringify.calls`           |                  24 |              26 |                         39 | B           |
| `turn.warm/view.fields.stringify.chars`           |                 279 |             287 |                        408 | B           |
| `turn.paced/view.fields.stringify.calls`          |                 132 |             143 |                        143 | B           |
| `turn.paced/view.fields.stringify.chars`          |                2232 |            2276 |                       2276 | B           |
| `web.open/view.fields.stringify.calls`            |                  12 |              13 |                         13 | B           |
| `web.open/view.fields.stringify.chars`            |                 600 |             604 |                        604 | B           |
| `web.open/push.events`                            |                  10 |              11 |                         11 | B           |
| `web.open/push.bytes`                             |               83736 |           83980 |                      83980 | B           |
| `web.open/push.view.bytes`                        |               76309 |           76349 |                      76349 | B           |
| `web.open/http.requests`                          |                  81 |              82 |                         82 | B           |
| `web.open/cdp.Nodes`                              |                 972 |            1114 |                       1138 | B           |
| `web.open/web.event.parse.calls`                  |                   9 |              10 |                         10 | B           |
| `web.open/web.event.parse.chars`                  |               82941 |           83157 |                      83157 | B           |
| `session.open.long/view.fields.stringify.calls`   |                  12 |              13 |                         13 | B           |
| `session.open.long/view.fields.stringify.chars`   |                  73 |              77 |                         77 | B           |
| `session.open.long/push.bytes`                    |              179320 |          179336 |                     179336 | B           |
| `session.open.long/push.view.bytes`               |              165843 |          165859 |                     165859 | B           |
| `web.open.long/view.fields.stringify.calls`       |                  12 |              13 |                         13 | B           |
| `web.open.long/view.fields.stringify.chars`       |                  73 |              77 |                         77 | B           |
| `web.open.long/push.view.bytes`                   |              165859 |          165899 |                     165899 | B           |
| `web.open.long/http.requests`                     |                  80 |              81 |                         81 | B           |
| `web.open.long/cdp.Nodes`                         |                1561 |            1703 |                       1703 | B           |
| `web.open.long/web.event.parse.calls`             |                   8 |               9 |                          9 | B           |
| `web.open.long/web.event.parse.chars`             |              173290 |          173508 |                     173508 | B           |
| `native.warm/sql.rows`                            |                  10 |              11 |                         11 | B           |
| `web.reopen/view.fields.stringify.calls`          |                  12 |              13 |                         13 | B           |
| `web.reopen/view.fields.stringify.chars`          |                 645 |             649 |                        649 | B           |
| `web.reopen/push.events`                          |                   9 |              10 |                         10 | B           |
| `web.reopen/push.bytes`                           |               10313 |           10557 |                      10557 | B           |
| `web.reopen/push.view.bytes`                      |                2001 |            2041 |                       2041 | B           |
| `web.reopen/cdp.Nodes`                            |                1090 |            1208 |                       1232 | B           |
| `web.reopen/web.event.parse.calls`                |                   8 |               9 |                          9 | B           |
| `web.reopen/web.event.parse.chars`                |                9527 |            9743 |                       9743 | B           |
| `web.paced/cdp.Nodes`                             |                1289 |            1411 |                       1427 | B           |
| `web.send.poll/cdp.Nodes`                         |                1475 |            1621 |                       1620 | T           |
| `web.send.stream/push.bytes`                      |               91291 |           91804 |                      92005 | B           |
| `web.send.stream/push.view.bytes`                 |               77497 |           77986 |                      78187 | B           |
| `web.send.stream/cdp.RecalcStyleCount`            |                 106 |             115 |                        112 | T           |
| `web.send.stream/cdp.Nodes`                       |                1491 |            1581 |                       1658 | B           |
| `web.send.stream/web.event.parse.chars`           |               30133 |           30445 |                      30447 | B           |
| `commands.discover.warm/json.stringify.chars`     |               27229 |           27271 |                      27305 | B           |
| `projection.large.open/push.bytes`                |              164251 |          164315 |                     164315 | B           |
| `projection.large.open/push.view.bytes`           |              114758 |          114822 |                     114822 | B           |
| `projection.large.paced/push.bytes`               |              249028 |          252228 |                     257028 | B           |
| `projection.large.paced/push.view.bytes`          |              207656 |          210856 |                     215656 | B           |
| `assets.first/http.requests`                      |                  53 |              54 |                         54 | B           |
| `assets.validated/http.requests`                  |                  53 |              54 |                         54 | B           |
