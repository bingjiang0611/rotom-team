# D9a performance acceptance

## Scope and method

Final production/helper source matches the 396-file [source manifest](d9a-source-files.json). The default suite passed 723/723 before the final four native proofs. No benchmark workload, ledger, tolerance, quiet rule or gating ceiling changed in D9a.

Final command: `node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs D9a-final -- npm run perf:ci -- origin/main --out /tmp/rotom-review-D9a/perf-final`.
The machine lock covered the complete paired run. Exit 0; gating and ledger guard passed. Darwin arm64, Node 24.18.0, 8 cores, three runs, 672411 ms, load 3.07 → 3.53, `highLoad:false`. Main reference is `e649d9d8a0ff8d56d241d9a4c54b1a6ca81a7a92`. [Complete CI output](d9a-perf-ci.txt) and [structured worse/slower evidence with timing samples](d9a-performance.json) are retained.

| Comparison                   | Worse counters | Slower timings | Meaning                                                                     |
| ---------------------------- | -------------: | -------------: | --------------------------------------------------------------------------- |
| Final paired origin/main     |             63 |              5 | Includes the already-reviewed D1–D8b branch changes, not just D9a           |
| Saved pre-D9 7478123 → final |             47 |              1 | Same workload; baseline was measured earlier, not a simultaneous final pair |
| Previous D9 snapshot → final |             26 |             15 | Earlier incomplete D9 source, not an identical-code repeat                  |
| Ledger historical candidates |            233 |              — | Historical reference, not the paired main baseline; no gating failure       |

Earlier accepted-command runs are not substituted for final evidence: the pre-D9 paired run reported 46 worse/1 slower, and the earlier main pair 70 worse/9 slower. Both predate readOnly propagation and later guards. The final snapshot adds necessary archive semantics; it is not a claimed performance optimization. No L2 or real-use L3 improvement is claimed. No ledger warning is paid for with an unrelated improvement.

## Counter explanations

Each worse row below has its own reference and explanation code. The pre-D9 column prevents inherited main/ledger differences from being attributed to D9a.

- **A — necessary startup safety work.** Before Harness opens, the public Storage session-catalog lookup adds exactly 6 SQL statements, 39 returned rows/parses and 4828 parsed characters versus 7478123. Native-only catalogs avoid the full task scan. General stringify adds 19 characters for public SQLite address encoding (`"pocket.sessions"` plus the empty key). This is the required pre-scheduler archive classification, not a new polling loop. Actual legacy closures add workload-dependent migration work that this native benchmark does not measure; correctness/atomicity is covered separately.
- **B — required explicit read-only state.** Room views now include `readOnly:null` for native sessions and a reason for archives. One extra field is serialized per examined view (+1 call/+4 field characters); a full native view costs 16 wire characters. Four full projection views cost 64 bytes. Store propagation is necessary: the retained browser negative control fails when this field is dropped. Timed/coalesced events can have different counts; registered tolerances are unchanged.
- **C — shipped archive UI.** First-load compressed body bytes rise 408346 → 408479 (+133) versus 7478123. This contains read-only controls/state propagation; the workload and HTTP compression did not change. The extra asset request against main predates D9a (see E).
- **D — general serialization residual.** These are general aggregate serialization counts, not a direct field-level attribution. The measured view-field additions are explained in B. Exact small residuals (+8 command discovery, +34 earlier history, +74/+114 large projections and +20 session open) are recorded, not declared zero or fully explained by the view-field counter. No extra SQL/process work accompanies these D9 comparisons. Character-level attribution beyond B is unverified; do not claim a serialization optimization from these values.
- **E — no new D9 increase beyond the existing tolerance.** The final value is unchanged/better against saved 7478123 under the unmodified ledger tolerance. Main/ledger differences include previously reviewed D1–D8b native lifecycle/delivery work and scheduled browser variation; see [D8b performance](d8b-performance.md). This is comparison evidence, not proof of an individual event's causal origin. Values and the pre-D9 reference remain visible on every row.

## Every paired-main worse counter

| Counter                                           | Reference → final | D9 reference (7478123) → final | Explanation |
| ------------------------------------------------- | ----------------: | -----------------------------: | ----------- |
| `startup.restart/sql.statements`                  |         848 → 857 |                      851 → 857 | A           |
| `startup.restart/sql.rows`                        |         528 → 542 |                      503 → 542 | A           |
| `startup.restart/json.parse.durableStorage.calls` |         458 → 498 |                      459 → 498 | A           |
| `startup.restart/json.parse.durableStorage.chars` |     51416 → 56263 |                  51435 → 56263 | A           |
| `startup.restart/json.stringify.chars`            |     18739 → 18758 |                  18739 → 18758 | A           |
| `session.open/sql.rows`                           |          94 → 105 |                      105 → 105 | E           |
| `session.open/json.stringify.chars`               |     84622 → 88127 |                  88107 → 88127 | D           |
| `session.open/view.fields.stringify.calls`        |           12 → 13 |                        12 → 13 | B           |
| `session.open/view.fields.stringify.chars`        |         600 → 604 |                      600 → 604 | B           |
| `session.open/push.events`                        |            9 → 10 |                        10 → 10 | E           |
| `session.open/push.bytes`                         |     82236 → 86328 |                  86312 → 86328 | B           |
| `session.open/push.view.bytes`                    |     76276 → 76292 |                  76276 → 76292 | B           |
| `turn.cold/json.stringify.chars`                  |   126795 → 127088 |                128685 → 127088 | E           |
| `turn.warm/json.stringify.chars`                  |     89122 → 93561 |                  99702 → 93561 | E           |
| `turn.warm/view.fields.stringify.calls`           |           48 → 52 |                        48 → 52 | B           |
| `turn.warm/view.fields.stringify.chars`           |         558 → 619 |                      603 → 619 | B           |
| `turn.warm/push.events`                           |             5 → 6 |                          6 → 6 | E           |
| `turn.warm/push.bytes`                            |     15621 → 20066 |                  26142 → 20066 | E           |
| `turn.warm/push.view.bytes`                       |     11175 → 11451 |                  17251 → 11451 | E           |
| `turn.paced/view.fields.stringify.calls`          |         132 → 143 |                      132 → 143 | B           |
| `turn.paced/view.fields.stringify.chars`          |       2232 → 2276 |                    2232 → 2276 | B           |
| `web.open/view.fields.stringify.calls`            |           12 → 13 |                        12 → 13 | B           |
| `web.open/view.fields.stringify.chars`            |         600 → 604 |                      600 → 604 | B           |
| `web.open/push.events`                            |           10 → 11 |                        11 → 11 | E           |
| `web.open/push.bytes`                             |     83736 → 83980 |                  83964 → 83980 | B           |
| `web.open/push.view.bytes`                        |     76309 → 76349 |                  76333 → 76349 | B           |
| `web.open/cdp.Nodes`                              |        996 → 1138 |                    1138 → 1138 | E           |
| `web.open/web.event.parse.calls`                  |            9 → 10 |                        10 → 10 | E           |
| `web.open/web.event.parse.chars`                  |     82941 → 83157 |                  83141 → 83157 | B           |
| `session.open.long/view.fields.stringify.calls`   |           12 → 13 |                        12 → 13 | B           |
| `session.open.long/view.fields.stringify.chars`   |           73 → 77 |                        73 → 77 | B           |
| `session.open.long/push.bytes`                    |   179320 → 179336 |                179320 → 179336 | B           |
| `session.open.long/push.view.bytes`               |   165843 → 165859 |                165843 → 165859 | B           |
| `session.history.earlier/json.stringify.chars`    |   243098 → 243132 |                243098 → 243132 | D           |
| `web.open.long/view.fields.stringify.calls`       |           12 → 13 |                        12 → 13 | B           |
| `web.open.long/view.fields.stringify.chars`       |           73 → 77 |                        73 → 77 | B           |
| `web.open.long/push.view.bytes`                   |   165859 → 165899 |                165883 → 165899 | B           |
| `web.open.long/http.requests`                     |           80 → 81 |                        81 → 81 | E           |
| `web.open.long/cdp.Nodes`                         |       1585 → 1703 |                    1703 → 1703 | E           |
| `web.open.long/web.event.parse.calls`             |             8 → 9 |                          9 → 9 | E           |
| `web.open.long/web.event.parse.chars`             |   173290 → 173508 |                173492 → 173508 | B           |
| `native.warm/sql.rows`                            |           10 → 11 |                        11 → 11 | E           |
| `web.reopen/view.fields.stringify.calls`          |           12 → 13 |                        12 → 13 | B           |
| `web.reopen/view.fields.stringify.chars`          |         645 → 649 |                      645 → 649 | B           |
| `web.reopen/push.events`                          |            9 → 10 |                        10 → 10 | E           |
| `web.reopen/push.bytes`                           |     10313 → 10557 |                  10541 → 10557 | B           |
| `web.reopen/push.view.bytes`                      |       2001 → 2041 |                    2025 → 2041 | B           |
| `web.reopen/cdp.Nodes`                            |       1090 → 1232 |                    1232 → 1232 | E           |
| `web.reopen/web.event.parse.calls`                |             8 → 9 |                          9 → 9 | E           |
| `web.reopen/web.event.parse.chars`                |       9527 → 9743 |                    9727 → 9743 | B           |
| `web.paced/cdp.Nodes`                             |       1300 → 1425 |                    1422 → 1425 | E           |
| `web.send.poll/cdp.Nodes`                         |       1475 → 1596 |                    1617 → 1596 | E           |
| `web.send.stream/push.bytes`                      |     91693 → 92005 |                  92005 → 92005 | E           |
| `web.send.stream/push.view.bytes`                 |     77899 → 78187 |                  78187 → 78187 | E           |
| `web.send.stream/cdp.RecalcStyleCount`            |         105 → 115 |                      111 → 115 | E           |
| `web.send.stream/cdp.Nodes`                       |       1517 → 1654 |                    1651 → 1654 | E           |
| `web.send.stream/web.event.parse.chars`           |     30133 → 30445 |                  30445 → 30445 | E           |
| `commands.discover.cold/json.stringify.chars`     |     33846 → 33854 |                  33846 → 33854 | D           |
| `commands.discover.warm/json.stringify.chars`     |     27263 → 27271 |                  27297 → 27271 | E           |
| `projection.large.open/push.bytes`                |   164251 → 164315 |                164251 → 164315 | B           |
| `projection.large.open/push.view.bytes`           |   114758 → 114822 |                114758 → 114822 | B           |
| `assets.first/http.requests`                      |           53 → 54 |                        54 → 54 | E           |
| `assets.validated/http.requests`                  |           53 → 54 |                        54 → 54 | E           |

## Every worse counter against the saved pre-D9 baseline

| Counter                                              | Reference → final | D9 reference (7478123) → final | Explanation |
| ---------------------------------------------------- | ----------------: | -----------------------------: | ----------- |
| `startup.restart/sql.statements`                     |         851 → 857 |                      851 → 857 | A           |
| `startup.restart/sql.rows`                           |         503 → 542 |                      503 → 542 | A           |
| `startup.restart/json.parse.calls`                   |         473 → 512 |                      473 → 512 | A           |
| `startup.restart/json.parse.chars`                   |     65619 → 70447 |                  65619 → 70447 | A           |
| `startup.restart/json.parse.durableStorage.calls`    |         459 → 498 |                      459 → 498 | A           |
| `startup.restart/json.parse.durableStorage.chars`    |     51435 → 56263 |                  51435 → 56263 | A           |
| `startup.restart/json.stringify.chars`               |     18739 → 18758 |                  18739 → 18758 | A           |
| `session.open/json.stringify.chars`                  |     88107 → 88127 |                  88107 → 88127 | D           |
| `session.open/view.fields.stringify.calls`           |           12 → 13 |                        12 → 13 | B           |
| `session.open/view.fields.stringify.chars`           |         600 → 604 |                      600 → 604 | B           |
| `session.open/push.bytes`                            |     86312 → 86328 |                  86312 → 86328 | B           |
| `session.open/push.view.bytes`                       |     76276 → 76292 |                  76276 → 76292 | B           |
| `turn.warm/view.fields.stringify.calls`              |           48 → 52 |                        48 → 52 | B           |
| `turn.warm/view.fields.stringify.chars`              |         603 → 619 |                      603 → 619 | B           |
| `turn.paced/view.fields.stringify.calls`             |         132 → 143 |                      132 → 143 | B           |
| `turn.paced/view.fields.stringify.chars`             |       2232 → 2276 |                    2232 → 2276 | B           |
| `web.open/view.fields.stringify.calls`               |           12 → 13 |                        12 → 13 | B           |
| `web.open/view.fields.stringify.chars`               |         600 → 604 |                      600 → 604 | B           |
| `web.open/push.bytes`                                |     83964 → 83980 |                  83964 → 83980 | B           |
| `web.open/push.view.bytes`                           |     76333 → 76349 |                  76333 → 76349 | B           |
| `web.open/web.event.parse.chars`                     |     83141 → 83157 |                  83141 → 83157 | B           |
| `session.open.long/view.fields.stringify.calls`      |           12 → 13 |                        12 → 13 | B           |
| `session.open.long/view.fields.stringify.chars`      |           73 → 77 |                        73 → 77 | B           |
| `session.open.long/push.bytes`                       |   179320 → 179336 |                179320 → 179336 | B           |
| `session.open.long/push.view.bytes`                  |   165843 → 165859 |                165843 → 165859 | B           |
| `session.history.earlier/json.stringify.chars`       |   243098 → 243132 |                243098 → 243132 | D           |
| `web.open.long/view.fields.stringify.calls`          |           12 → 13 |                        12 → 13 | B           |
| `web.open.long/view.fields.stringify.chars`          |           73 → 77 |                        73 → 77 | B           |
| `web.open.long/push.view.bytes`                      |   165883 → 165899 |                165883 → 165899 | B           |
| `web.open.long/web.event.parse.chars`                |   173492 → 173508 |                173492 → 173508 | B           |
| `web.reopen/view.fields.stringify.calls`             |           12 → 13 |                        12 → 13 | B           |
| `web.reopen/view.fields.stringify.chars`             |         645 → 649 |                      645 → 649 | B           |
| `web.reopen/push.bytes`                              |     10541 → 10557 |                  10541 → 10557 | B           |
| `web.reopen/push.view.bytes`                         |       2025 → 2041 |                    2025 → 2041 | B           |
| `web.reopen/web.event.parse.chars`                   |       9727 → 9743 |                    9727 → 9743 | B           |
| `web.send.stream/view.fields.stringify.calls`        |         144 → 156 |                      144 → 156 | B           |
| `web.send.stream/view.fields.stringify.chars`        |       8798 → 8846 |                    8798 → 8846 | B           |
| `commands.discover.cold/json.stringify.chars`        |     33846 → 33854 |                  33846 → 33854 | D           |
| `projection.large.open/json.stringify.chars`         |   181858 → 181972 |                181858 → 181972 | D           |
| `projection.large.open/view.fields.stringify.calls`  |           48 → 52 |                        48 → 52 | B           |
| `projection.large.open/view.fields.stringify.chars`  |     11808 → 11824 |                  11808 → 11824 | B           |
| `projection.large.open/push.bytes`                   |   164251 → 164315 |                164251 → 164315 | B           |
| `projection.large.open/push.view.bytes`              |   114758 → 114822 |                114758 → 114822 | B           |
| `projection.large.paced/json.stringify.chars`        |   426772 → 426846 |                426772 → 426846 | D           |
| `projection.large.paced/view.fields.stringify.calls` |         132 → 143 |                      132 → 143 | B           |
| `projection.large.paced/view.fields.stringify.chars` |     32922 → 32966 |                  32922 → 32966 | B           |
| `assets.first/http.body.bytes`                       |   408346 → 408479 |                408346 → 408479 | C           |

## Timings and limitations

**T — measured separation is not causal attribution.** Main session.open adds historical branch SQL rows/events plus B; long open and large projection add B, but those small payloads do not establish the cause of the full elapsed-time increase. git.changes retains its three Git subprocesses and has no D9 production implementation change; host/process scheduling is a possible explanation, not a demonstrated one. web.paced viewApply includes the new field merge and scheduled browser work; its 0.8 ms absolute increase is retained rather than rounded away. Earlier-history serialization has the D residual. Raw three-run samples are in the JSON.

The previous D9 snapshot comparison also separates unchanged Git/image/journal paths. It demonstrates substantial cross-run variation, but is not an identical-code control and does not prove that final regressions are absent. These non-gating elapsed-time causes remain unverified. A future performance investigation should isolate these five paired-main paths with profiling and repeated same-revision controls before proposing an optimization; it must not loosen the ledger. D9a retains the required safety behavior and reports these candidates for verification.

### Final paired main

| Timing (ms)                | Reference → final | Interpretation                                                     |
| -------------------------- | ----------------: | ------------------------------------------------------------------ |
| `session.open/ms`          |       32.2 → 50.7 | T; separated in these three samples, causal attribution unresolved |
| `git.changes/ms`           |     154.3 → 202.2 | T; separated in these three samples, causal attribution unresolved |
| `session.open.long/ms`     |        7.6 → 14.4 | T; separated in these three samples, causal attribution unresolved |
| `web.paced/viewApplyMs`    |         0.8 → 1.6 | T; separated in these three samples, causal attribution unresolved |
| `projection.large.open/ms` |       42.7 → 62.9 | T; separated in these three samples, causal attribution unresolved |

### Earlier pre-D9 baseline

| Timing (ms)                  | Reference → final | Interpretation                                                     |
| ---------------------------- | ----------------: | ------------------------------------------------------------------ |
| `session.history.earlier/ms` |       19.2 → 24.9 | T; separated in these three samples, causal attribution unresolved |

### Earlier D9 snapshot (diagnostic only)

| Timing (ms)                        | Reference → final | Interpretation                                                     |
| ---------------------------------- | ----------------: | ------------------------------------------------------------------ |
| `turn.cold/nativeStartResourcesMs` |       44.5 → 62.9 | T; separated in these three samples, causal attribution unresolved |
| `git.branches/ms`                  |       59.3 → 94.4 | T; separated in these three samples, causal attribution unresolved |
| `session.history.earlier/ms`       |         15 → 24.9 | T; separated in these three samples, causal attribution unresolved |
| `web.paced/scriptMs`               |       14.2 → 23.1 | T; separated in these three samples, causal attribution unresolved |
| `web.paced/taskMs`                 |       36.6 → 58.6 | T; separated in these three samples, causal attribution unresolved |
| `web.paced/eventParseMs`           |         0.3 → 0.7 | T; separated in these three samples, causal attribution unresolved |
| `web.paced/viewApplyMs`            |         1.1 → 1.6 | T; separated in these three samples, causal attribution unresolved |
| `image.single/ms`                  |       15.2 → 18.4 | T; separated in these three samples, causal attribution unresolved |
| `image.single/imageSendFinishMs`   |         2.9 → 4.5 | T; separated in these three samples, causal attribution unresolved |
| `image.single/imageServerMs`       |       11.1 → 13.7 | T; separated in these three samples, causal attribution unresolved |
| `image.single/imageClientMs`       |       14.7 → 17.9 | T; separated in these three samples, causal attribution unresolved |
| `image.thumbs.again/ms`            |           10 → 14 | T; separated in these three samples, causal attribution unresolved |
| `journal.large/ms`                 |       12.8 → 17.2 | T; separated in these three samples, causal attribution unresolved |
| `journal.large/segmentEntriesMs`   |         6.1 → 8.4 | T; separated in these three samples, causal attribution unresolved |
| `journal.large/creditsMs`          |         4.5 → 7.8 | T; separated in these three samples, causal attribution unresolved |

## Every ledger candidate still worse

These are the 233 historical candidate warnings, not 233 gating regressions. All are reported independently; gates and guard passed without raising any limit.

| Counter                                                  | Reference → final | D9 reference (7478123) → final | Explanation |
| -------------------------------------------------------- | ----------------: | -----------------------------: | ----------- |
| `startup.restart/sql.statements`                         |         848 → 857 |                      851 → 857 | A           |
| `startup.restart/sql.rows`                               |         528 → 542 |                      503 → 542 | A           |
| `startup.restart/json.stringify.chars`                   |     18515 → 18758 |                  18739 → 18758 | A           |
| `sessions.list/sql.statements`                           |             0 → 1 |                          1 → 1 | E           |
| `sessions.list/sql.rows`                                 |            0 → 13 |                        13 → 13 | E           |
| `sessions.list/json.parse.chars`                         |          83 → 114 |                      114 → 114 | E           |
| `sessions.list/json.stringify.chars`                     |       4063 → 4094 |                    4094 → 4094 | E           |
| `session.open/sql.rows`                                  |          94 → 105 |                      105 → 105 | E           |
| `session.open/json.parse.chars`                          |   253516 → 253819 |                253821 → 253819 | E           |
| `session.open/json.stringify.chars`                      |     84293 → 88127 |                  88107 → 88127 | D           |
| `session.open/push.events`                               |            8 → 10 |                        10 → 10 | E           |
| `session.open/push.bytes`                                |     81884 → 86328 |                  86312 → 86328 | B           |
| `session.open/push.view.bytes`                           |     75997 → 76292 |                  76276 → 76292 | B           |
| `turn.cold/sql.statements`                               |         193 → 212 |                      212 → 212 | E           |
| `turn.cold/sql.rows`                                     |         102 → 140 |                      148 → 140 | E           |
| `turn.cold/json.stringify.chars`                         |   124912 → 127088 |                128685 → 127088 | E           |
| `turn.cold/push.events`                                  |             4 → 5 |                          6 → 5 | E           |
| `turn.cold/push.bytes`                                   |     17352 → 18599 |                  19834 → 18599 | E           |
| `turn.cold/push.view.count`                              |             2 → 3 |                          4 → 3 | E           |
| `turn.cold/push.view.bytes`                              |       8534 → 9781 |                   11016 → 9781 | E           |
| `turn.warm/sql.statements`                               |         142 → 169 |                      169 → 169 | E           |
| `turn.warm/sql.rows`                                     |          85 → 140 |                      140 → 140 | E           |
| `turn.warm/json.parse.calls`                             |         135 → 155 |                      155 → 155 | E           |
| `turn.warm/json.parse.chars`                             |   288675 → 343136 |                343143 → 343136 | E           |
| `turn.warm/json.stringify.chars`                         |     83294 → 93561 |                  99702 → 93561 | E           |
| `turn.warm/push.events`                                  |             2 → 6 |                          6 → 6 | E           |
| `turn.warm/push.bytes`                                   |     11828 → 20066 |                  26142 → 20066 | E           |
| `turn.warm/push.view.count`                              |             1 → 4 |                          4 → 4 | E           |
| `turn.warm/push.view.bytes`                              |      7382 → 11451 |                  17251 → 11451 | E           |
| `turn.paced/json.stringify.chars`                        |   130141 → 144090 |                144479 → 144090 | E           |
| `turn.paced/push.events`                                 |           10 → 13 |                        13 → 13 | E           |
| `turn.paced/push.bytes`                                  |     46637 → 58361 |                  58761 → 58361 | E           |
| `turn.paced/push.view.count`                             |            8 → 11 |                        11 → 11 | E           |
| `turn.paced/push.view.bytes`                             |     37746 → 49470 |                  49870 → 49470 | E           |
| `git.changes/json.parse.chars`                           |   122458 → 122737 |                122738 → 122737 | E           |
| `git.changes/json.stringify.chars`                       |       2539 → 3105 |                    3133 → 3105 | E           |
| `commands.list/json.parse.chars`                         |   170825 → 170827 |                170827 → 170827 | E           |
| `commands.list/json.stringify.chars`                     |      3916 → 10145 |                  10179 → 10145 | E           |
| `commands.list/http.body.bytes`                          |       3283 → 9549 |                    9549 → 9549 | E           |
| `web.open/sql.statements`                                |           15 → 28 |                        28 → 28 | E           |
| `web.open/sql.rows`                                      |           40 → 63 |                        63 → 63 | E           |
| `web.open/subprocess.total`                              |             0 → 1 |                          1 → 1 | E           |
| `web.open/push.events`                                   |           10 → 11 |                        11 → 11 | E           |
| `web.open/push.bytes`                                    |     83441 → 83980 |                  83964 → 83980 | B           |
| `web.open/push.view.bytes`                               |     76014 → 76349 |                  76333 → 76349 | B           |
| `web.open/http.requests`                                 |           73 → 82 |                        82 → 82 | E           |
| `web.open/cdp.Nodes`                                     |        971 → 1138 |                    1138 → 1138 | E           |
| `commands.discover.cold/sql.statements`                  |           80 → 89 |                        89 → 89 | E           |
| `commands.discover.cold/sql.rows`                        |           37 → 73 |                        73 → 73 | E           |
| `commands.discover.cold/json.parse.calls`                |         114 → 118 |                      118 → 118 | E           |
| `commands.discover.cold/json.parse.chars`                |   408633 → 411248 |                411248 → 411248 | E           |
| `commands.discover.cold/json.stringify.chars`            |     29321 → 33854 |                  33846 → 33854 | D           |
| `commands.discover.cold/push.events`                     |             3 → 4 |                          4 → 4 | E           |
| `commands.discover.cold/push.bytes`                      |     10499 → 11726 |                  11726 → 11726 | E           |
| `commands.discover.cold/push.view.count`                 |             1 → 2 |                          2 → 2 | E           |
| `commands.discover.cold/push.view.bytes`                 |       1052 → 2279 |                    2279 → 2279 | E           |
| `commands.discover.cold/http.body.bytes`                 |       7050 → 9740 |                    9740 → 9740 | E           |
| `commands.discover.warm/sql.statements`                  |           73 → 81 |                        81 → 81 | E           |
| `commands.discover.warm/sql.rows`                        |           38 → 58 |                        58 → 58 | E           |
| `commands.discover.warm/json.parse.calls`                |           67 → 71 |                        71 → 71 | E           |
| `commands.discover.warm/json.parse.chars`                |   213297 → 215918 |                215918 → 215918 | E           |
| `commands.discover.warm/json.stringify.chars`            |     22738 → 27271 |                  27297 → 27271 | E           |
| `commands.discover.warm/push.events`                     |             2 → 3 |                          3 → 3 | E           |
| `commands.discover.warm/push.bytes`                      |       5776 → 7003 |                    7003 → 7003 | E           |
| `commands.discover.warm/push.view.count`                 |             1 → 2 |                          2 → 2 | E           |
| `commands.discover.warm/push.view.bytes`                 |       1052 → 2279 |                    2279 → 2279 | E           |
| `commands.discover.warm/http.body.bytes`                 |       7050 → 9740 |                    9740 → 9740 | E           |
| `turn.prepared/push.events`                              |             2 → 4 |                          4 → 4 | E           |
| `turn.prepared/push.view.count`                          |             1 → 3 |                          3 → 3 | E           |
| `turn.warm/view.entry.visits`                            |            8 → 15 |                        15 → 15 | E           |
| `projection.large.open/push.bytes`                       |   161655 → 164315 |                164251 → 164315 | B           |
| `projection.large.open/push.view.bytes`                  |   112462 → 114822 |                114758 → 114822 | B           |
| `projection.large.paced/push.events`                     |           44 → 52 |                        52 → 52 | E           |
| `projection.large.paced/push.bytes`                      |   231388 → 253028 |                253028 → 253028 | E           |
| `projection.large.paced/push.view.count`                 |           36 → 44 |                        44 → 44 | E           |
| `projection.large.paced/push.view.bytes`                 |   190016 → 211656 |                211656 → 211656 | E           |
| `turn.warm/view.stats.entry.scans`                       |            8 → 15 |                        15 → 15 | E           |
| `session.open/view.fields.stringify.calls`               |           12 → 13 |                        12 → 13 | B           |
| `session.open/view.fields.stringify.chars`               |         600 → 604 |                      600 → 604 | B           |
| `turn.warm/view.fields.stringify.calls`                  |           12 → 52 |                        48 → 52 | B           |
| `turn.warm/view.fields.stringify.chars`                  |         162 → 619 |                      603 → 619 | B           |
| `turn.paced/view.fields.stringify.calls`                 |          96 → 143 |                      132 → 143 | B           |
| `turn.paced/view.fields.stringify.chars`                 |       1656 → 2276 |                    2232 → 2276 | B           |
| `web.open/view.fields.stringify.calls`                   |           12 → 13 |                        12 → 13 | B           |
| `web.open/view.fields.stringify.chars`                   |         600 → 604 |                      600 → 604 | B           |
| `turn.warm/view.live.project.calls`                      |             1 → 4 |                          4 → 4 | E           |
| `turn.warm/view.inbox.project.calls`                     |             1 → 4 |                          4 → 4 | E           |
| `turn.warm/view.kernel.project.calls`                    |             1 → 4 |                          4 → 4 | E           |
| `turn.paced/view.live.project.calls`                     |            8 → 11 |                        11 → 11 | E           |
| `turn.paced/view.inbox.project.calls`                    |            8 → 11 |                        11 → 11 | E           |
| `turn.paced/view.kernel.project.calls`                   |            8 → 11 |                        11 → 11 | E           |
| `web.open/web.event.parse.calls`                         |            9 → 10 |                        10 → 10 | E           |
| `web.open/web.event.parse.chars`                         |     82646 → 83157 |                  83141 → 83157 | B           |
| `web.paced/view.fields.stringify.calls`                  |         120 → 143 |                      144 → 143 | E           |
| `web.paced/view.fields.stringify.chars`                  |       6405 → 7094 |                    7695 → 7094 | E           |
| `web.paced/view.live.project.calls`                      |           10 → 11 |                        12 → 11 | E           |
| `web.paced/view.inbox.project.calls`                     |           10 → 11 |                        12 → 11 | E           |
| `web.paced/view.kernel.project.calls`                    |           10 → 11 |                        12 → 11 | E           |
| `web.paced/push.events`                                  |           14 → 15 |                        16 → 15 | E           |
| `web.paced/push.view.count`                              |           10 → 11 |                        12 → 11 | E           |
| `web.paced/http.requests`                                |             4 → 5 |                          5 → 5 | E           |
| `web.paced/cdp.Nodes`                                    |       1222 → 1425 |                    1422 → 1425 | E           |
| `web.paced/web.event.parse.calls`                        |           12 → 13 |                        14 → 13 | E           |
| `web.paced/web.view.apply.calls`                         |           10 → 11 |                        12 → 11 | E           |
| `projection.large.paced/view.live.project.calls`         |           36 → 44 |                        44 → 44 | E           |
| `projection.large.paced/view.inbox.project.calls`        |           36 → 44 |                        44 → 44 | E           |
| `projection.large.paced/view.kernel.project.calls`       |           36 → 44 |                        44 → 44 | E           |
| `turn.warm/view.kernel.json.parse.calls`                 |             2 → 8 |                          8 → 8 | E           |
| `turn.warm/view.kernel.json.parse.chars`                 |       1082 → 4328 |                    4328 → 4328 | E           |
| `turn.paced/view.kernel.sql.statements`                  |           39 → 44 |                        44 → 44 | E           |
| `turn.paced/view.kernel.sql.rows`                        |           23 → 32 |                        32 → 32 | E           |
| `web.paced/view.kernel.sql.rows`                         |           29 → 32 |                        35 → 32 | E           |
| `turn.warm/view.kernel.sql.heads`                        |             1 → 4 |                          4 → 4 | E           |
| `turn.warm/view.kernel.sql.attempts`                     |             2 → 8 |                          8 → 8 | E           |
| `turn.warm/view.kernel.sql.command_inputs`               |             1 → 4 |                          4 → 4 | E           |
| `turn.paced/view.kernel.sql.heads`                       |            8 → 11 |                        11 → 11 | E           |
| `turn.paced/view.kernel.sql.attempts`                    |           16 → 22 |                        22 → 22 | E           |
| `web.paced/view.kernel.sql.heads`                        |           10 → 11 |                        12 → 11 | E           |
| `web.paced/view.kernel.sql.attempts`                     |           20 → 22 |                        24 → 22 | E           |
| `projection.large.paced/view.kernel.sql.heads`           |           36 → 44 |                        44 → 44 | E           |
| `projection.large.paced/view.kernel.sql.attempts`        |           72 → 88 |                        88 → 88 | E           |
| `startup.restart/json.parse.durableStorage.calls`        |         458 → 498 |                      459 → 498 | A           |
| `startup.restart/json.parse.durableStorage.chars`        |     51416 → 56263 |                  51435 → 56263 | A           |
| `session.open/json.parse.durableStorage.chars`           |   129872 → 130175 |                130176 → 130175 | E           |
| `turn.cold/json.parse.journal.calls`                     |           36 → 41 |                        46 → 41 | E           |
| `turn.cold/json.parse.journal.chars`                     |     63000 → 65705 |                  68410 → 65705 | E           |
| `turn.warm/json.parse.journal.calls`                     |           26 → 40 |                        40 → 40 | E           |
| `turn.warm/json.parse.journal.chars`                     |     19677 → 27252 |                  27253 → 27252 | E           |
| `turn.paced/json.parse.journal.calls`                    |           68 → 75 |                        75 → 75 | E           |
| `turn.paced/json.parse.journal.chars`                    |     42408 → 46195 |                  46195 → 46195 | E           |
| `git.changes/json.parse.durableStorage.chars`            |   122458 → 122737 |                122738 → 122737 | E           |
| `commands.discover.cold/json.parse.journal.calls`        |           19 → 24 |                        24 → 24 | E           |
| `commands.discover.cold/json.parse.journal.chars`        |     10279 → 12984 |                  12984 → 12984 | E           |
| `commands.discover.warm/json.parse.journal.calls`        |           19 → 24 |                        24 → 24 | E           |
| `commands.discover.warm/json.parse.journal.chars`        |     10279 → 12984 |                  12984 → 12984 | E           |
| `turn.prepared/json.parse.journal.calls`                 |           30 → 39 |                        39 → 39 | E           |
| `turn.prepared/json.parse.journal.chars`                 |     59757 → 64626 |                  64626 → 64626 | E           |
| `projection.large.open/json.parse.durableStorage.chars`  |   104782 → 106469 |                106467 → 106469 | E           |
| `startup.restart/fs.read.bytes`                          |     98864 → 98872 |                  98872 → 98872 | E           |
| `turn.cold/fs.read.bytes`                                |   391847 → 391871 |                391871 → 391871 | E           |
| `turn.warm/fs.read.bytes`                                |   255920 → 255934 |                255936 → 255934 | E           |
| `turn.paced/fs.read.bytes`                               |   269328 → 269342 |                269344 → 269342 | E           |
| `commands.list/fs.read.bytes`                            |     49432 → 49436 |                  49436 → 49436 | E           |
| `commands.discover.cold/fs.read.bytes`                   |   347249 → 347277 |                347277 → 347277 | E           |
| `commands.discover.warm/fs.read.bytes`                   |   197932 → 197948 |                197948 → 197948 | E           |
| `turn.prepared/fs.read.bytes`                            |   242536 → 242548 |                242548 → 242548 | E           |
| `projection.large.paced/fs.read.bytes`                   |   350084 → 350106 |                350102 → 350106 | E           |
| `startup.restart/json.parse.nativePin.chars`             |     12668 → 12670 |                  12670 → 12670 | E           |
| `turn.cold/json.parse.nativePin.chars`                   |     38004 → 38010 |                  38010 → 38010 | E           |
| `turn.cold/json.parse.nativeResolver.chars`              |   252024 → 252027 |                252027 → 252027 | E           |
| `turn.warm/json.parse.nativePin.chars`                   |     19002 → 19005 |                  19005 → 19005 | E           |
| `turn.warm/json.parse.nativeResolver.chars`              |     84008 → 84009 |                  84009 → 84009 | E           |
| `turn.paced/json.parse.nativePin.chars`                  |     19002 → 19005 |                  19005 → 19005 | E           |
| `turn.paced/json.parse.nativeResolver.chars`             |     84008 → 84009 |                  84009 → 84009 | E           |
| `commands.list/json.parse.nativePin.chars`               |       6334 → 6335 |                    6335 → 6335 | E           |
| `commands.list/json.parse.nativeResolver.chars`          |     84008 → 84009 |                  84009 → 84009 | E           |
| `commands.discover.cold/json.parse.nativePin.chars`      |     44338 → 44345 |                  44345 → 44345 | E           |
| `commands.discover.cold/json.parse.nativeResolver.chars` |   336032 → 336036 |                336036 → 336036 | E           |
| `commands.discover.warm/json.parse.nativePin.chars`      |     25336 → 25340 |                  25340 → 25340 | E           |
| `commands.discover.warm/json.parse.nativeResolver.chars` |   168016 → 168018 |                168018 → 168018 | E           |
| `turn.prepared/json.parse.nativePin.chars`               |     19002 → 19005 |                  19005 → 19005 | E           |
| `turn.prepared/json.parse.nativeResolver.chars`          |     84008 → 84009 |                  84009 → 84009 | E           |
| `projection.large.paced/json.parse.nativePin.chars`      |     19002 → 19005 |                  19005 → 19005 | E           |
| `projection.large.paced/json.parse.nativeResolver.chars` |     84008 → 84009 |                  84009 → 84009 | E           |
| `image.single/json.stringify.chars`                      |          34 → 417 |                      417 → 417 | E           |
| `image.concurrent/json.stringify.chars`                  |          0 → 1430 |                    1430 → 1430 | E           |
| `session.reclaim/push.bytes`                             |      9808 → 13202 |                  13186 → 13202 | E           |
| `session.reclaim/push.view.bytes`                        |       1985 → 3088 |                    3072 → 3088 | E           |
| `web.reopen/sql.statements`                              |           15 → 16 |                        16 → 16 | E           |
| `web.reopen/view.fields.stringify.calls`                 |           12 → 13 |                        12 → 13 | B           |
| `web.reopen/view.fields.stringify.chars`                 |         645 → 649 |                      645 → 649 | B           |
| `web.reopen/push.events`                                 |            9 → 10 |                        10 → 10 | E           |
| `web.reopen/push.bytes`                                  |     10297 → 10557 |                  10541 → 10557 | B           |
| `web.reopen/push.view.bytes`                             |       1985 → 2041 |                    2025 → 2041 | B           |
| `web.reopen/http.requests`                               |           78 → 80 |                        80 → 80 | E           |
| `web.reopen/cdp.Nodes`                                   |       1090 → 1232 |                    1232 → 1232 | E           |
| `web.reopen/web.event.parse.calls`                       |             8 → 9 |                          9 → 9 | E           |
| `web.reopen/web.event.parse.chars`                       |       9511 → 9743 |                    9727 → 9743 | B           |
| `session.open.long/json.stringify.chars`                 |   179791 → 179845 |                179825 → 179845 | E           |
| `session.open.long/view.fields.stringify.calls`          |           12 → 13 |                        12 → 13 | B           |
| `session.open.long/view.fields.stringify.chars`          |           73 → 77 |                        73 → 77 | B           |
| `session.open.long/push.bytes`                           |   179320 → 179336 |                179320 → 179336 | B           |
| `session.open.long/push.view.bytes`                      |   165843 → 165859 |                165843 → 165859 | B           |
| `session.history.earlier/json.stringify.chars`           |   243098 → 243132 |                243098 → 243132 | D           |
| `web.open.long/sql.statements`                           |           17 → 26 |                        26 → 26 | E           |
| `web.open.long/subprocess.total`                         |             0 → 1 |                          1 → 1 | E           |
| `web.open.long/view.fields.stringify.calls`              |           12 → 13 |                        12 → 13 | B           |
| `web.open.long/view.fields.stringify.chars`              |           73 → 77 |                        73 → 77 | B           |
| `web.open.long/push.view.bytes`                          |   165843 → 165899 |                165883 → 165899 | B           |
| `web.open.long/http.requests`                            |           78 → 81 |                        81 → 81 | E           |
| `web.open.long/cdp.Nodes`                                |       1585 → 1703 |                    1703 → 1703 | E           |
| `web.open.long/web.event.parse.calls`                    |             8 → 9 |                          9 → 9 | E           |
| `web.open.long/web.event.parse.chars`                    |   173274 → 173508 |                173492 → 173508 | B           |
| `native.warm/sql.rows`                                   |           10 → 11 |                        11 → 11 | E           |
| `native.warm/json.parse.calls`                           |           58 → 60 |                        60 → 60 | E           |
| `native.warm/json.parse.chars`                           |   210470 → 210710 |                210710 → 210710 | E           |
| `native.warm/json.parse.nativeReadback.calls`            |             7 → 9 |                          9 → 9 | E           |
| `native.warm/json.parse.nativeReadback.chars`            |       2394 → 2634 |                    2634 → 2634 | E           |
| `native.warm/json.parse.nativeRpc.calls`                 |             7 → 9 |                          9 → 9 | E           |
| `native.warm/json.parse.nativeRpc.chars`                 |       2394 → 2634 |                    2634 → 2634 | E           |
| `native.warm/json.parse.nativeRpcRecord.calls`           |             6 → 8 |                          8 → 8 | E           |
| `native.warm/json.parse.nativeRpcRecord.chars`           |       2302 → 2542 |                    2542 → 2542 | E           |
| `web.send.poll/view.live.project.calls`                  |           20 → 24 |                        24 → 24 | E           |
| `web.send.poll/view.inbox.project.calls`                 |           20 → 24 |                        24 → 24 | E           |
| `web.send.poll/view.kernel.project.calls`                |           20 → 24 |                        24 → 24 | E           |
| `web.send.poll/view.kernel.sql.heads`                    |           20 → 24 |                        24 → 24 | E           |
| `web.send.poll/view.kernel.sql.attempts`                 |           40 → 48 |                        48 → 48 | E           |
| `web.send.poll/view.kernel.sql.rows`                     |           58 → 70 |                        70 → 70 | E           |
| `web.send.poll/push.events`                              |           26 → 30 |                        30 → 30 | E           |
| `web.send.poll/push.bytes`                               |     55026 → 61166 |                  61166 → 61166 | E           |
| `web.send.poll/push.view.count`                          |           20 → 24 |                        24 → 24 | E           |
| `web.send.poll/push.view.bytes`                          |     42567 → 48707 |                  48707 → 48707 | E           |
| `web.send.poll/http.requests`                            |           17 → 23 |                        23 → 23 | E           |
| `web.send.poll/cdp.LayoutCount`                          |           17 → 18 |                        18 → 18 | E           |
| `web.send.poll/cdp.Nodes`                                |       1349 → 1596 |                    1617 → 1596 | E           |
| `web.send.poll/web.view.apply.calls`                     |           10 → 12 |                        12 → 12 | E           |
| `web.send.stream/view.live.project.calls`                |           18 → 24 |                        24 → 24 | E           |
| `web.send.stream/view.inbox.project.calls`               |           18 → 24 |                        24 → 24 | E           |
| `web.send.stream/view.kernel.project.calls`              |           18 → 24 |                        24 → 24 | E           |
| `web.send.stream/view.kernel.sql.statements`             |           88 → 96 |                        96 → 96 | E           |
| `web.send.stream/view.kernel.sql.heads`                  |           18 → 24 |                        24 → 24 | E           |
| `web.send.stream/view.kernel.sql.attempts`               |           36 → 48 |                        48 → 48 | E           |
| `web.send.stream/view.kernel.sql.rows`                   |           52 → 70 |                        70 → 70 | E           |
| `web.send.stream/push.events`                            |           24 → 30 |                        30 → 30 | E           |
| `web.send.stream/push.view.count`                        |           18 → 24 |                        24 → 24 | E           |
| `web.send.stream/http.requests`                          |             4 → 8 |                          8 → 8 | E           |
| `web.send.stream/cdp.LayoutCount`                        |           17 → 19 |                        18 → 19 | E           |
| `web.send.stream/cdp.RecalcStyleCount`                   |         104 → 115 |                      111 → 115 | E           |
| `web.send.stream/cdp.Nodes`                              |       1388 → 1654 |                    1651 → 1654 | E           |
| `web.send.stream/web.event.parse.calls`                  |           12 → 15 |                        15 → 15 | E           |
| `web.send.stream/web.view.apply.calls`                   |            9 → 12 |                        12 → 12 | E           |
| `assets.first/http.requests`                             |           53 → 54 |                        54 → 54 | E           |
| `assets.validated/http.requests`                         |           53 → 54 |                        54 → 54 | E           |
