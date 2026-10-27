# D9b performance acceptance

Inventory and final runs used the unchanged machine lock, workload, ledger, tolerance and quiet rules. The separately authorized image-completion correction is documented in [measurement validation](d9b-measurement-validation.md) and delivered as `c59b1c7` (original patch commit `0d5410a`). Final comparisons use the same corrected instrument on both sides; the old inventory/main pair is retained only as historical acceptance evidence:

`node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs D9b-{inventory,final-fixed} -- npm run perf:ci -- origin/main --out /tmp/rotom-review-D9b/perf-{inventory,final-fixed}`

- Main: `e649d9d8a0ff8d56d241d9a4c54b1a6ca81a7a92`. Inventory runtime is D9a `9562e79`; final runtime is identified by [source hashes](d9b-source-files.json). Node 24.18.0, darwin-arm64, M1 / 8 cores.
- Inventory: exit 0, 661822 ms, load 2.65 → 2.50, highLoad=false. Final: exit 0, 656179 ms, load 5.69 → 5.36, highLoad=false. The additional corrected-instrument D9a baseline took 334990 ms, load 11.58 → 8.85, **highLoad=true**; it supports the work-counter comparison, not latency conclusions. Both gating and ledger guard passed. No tuning changed; only the separately committed completion receipt changed measurement synchronization.
- Counters use the ratchet's maximum-of-three/tolerance comparison, not the median. No unavailable observations. Earlier and later timing samples are not simultaneous matched pairs. No claimed user-latency win.

| Scope         | Worse counters | Slower timings |
| ------------- | -------------: | -------------: |
| inventoryMain |             80 |              4 |
| finalMain     |             74 |              5 |
| d9b           |             20 |              5 |

## Explanation codes

- **G — necessary disabled-guard presentation.** Removing production Lancet discovery leaves an explicit unavailable status. Its truthful Team/native detail is 87 bytes versus the old 78-byte Pocket wording: +9 bytes per info frame, +36 across four clients. `PocketApp.info` includes `guardStatus`. The paired measurements below show those deltas; this is not extra polling or SQL. General stringify also retains its existing frame-count variation.
- **S — 采样差异，未归因.** Three-run values are printed below. The printed samples show differing maxima and event/serialization variation; these observations do not establish a repeatable causal regression or prove absence of one. No code-level attribution is established. The corrected D9a baseline is highLoad=true, so its timing verdicts are invalid as L2 evidence and are shown only diagnostically. No quiet rule, workload or ceiling was relaxed to hide these maxima.
- **P — no new D9b increase beyond the existing tolerance.** The corrected-instrument D9a → final column is same/better under the unmodified ratchet. Main and historical-ledger differences predate this deletion; they include D1–D9a changes. See [D9a's per-counter explanations](d9a-performance.md), including startup quarantine, read-only view fields and shipped archive assets. This is comparison evidence, not an invented causal attribution for each inherited event.

## Every D9b worse counter

| Counter                                          | D9a corrected-instrument runs | Final runs             | Explanation |
| ------------------------------------------------ | ----------------------------- | ---------------------- | ----------- |
| `session.open/json.stringify.chars`              | 88127, 88127, 88127           | 88136, 84651, 88136    | G           |
| `session.open/push.bytes`                        | 86328, 86328, 86328           | 86337, 82261, 86337    | G           |
| `web.open/push.bytes`                            | 83980, 83980, 83980           | 83989, 83989, 83989    | G           |
| `web.open/http.requests`                         | 82, 82, 82                    | 84, 82, 82             | S           |
| `web.open/web.event.parse.chars`                 | 83157, 83157, 83157           | 83166, 83166, 83166    | G           |
| `session.open.long/push.bytes`                   | 179336, 179336, 179336        | 179345, 179345, 179345 | G           |
| `web.open.long/cdp.LayoutCount`                  | 7, 7, 7                       | 7, 7, 10               | S           |
| `web.open.long/web.event.parse.chars`            | 173508, 173508, 173508        | 173517, 173517, 173517 | G           |
| `turn.prewarmed/fs.read.calls`                   | 25, 25, 25                    | 26, 25, 25             | S           |
| `turn.prewarmed/json.parse.durableStorage.calls` | 18, 18, 18                    | 20, 18, 18             | S           |
| `turn.prewarmed/json.parse.durableStorage.chars` | 1122, 1122, 1122              | 1424, 1122, 1122       | S           |
| `web.reopen/push.bytes`                          | 10557, 10557, 10557           | 10566, 10566, 10566    | G           |
| `web.reopen/web.event.parse.chars`               | 9743, 9743, 9743              | 9752, 9752, 9752       | G           |
| `web.send.stream/push.bytes`                     | 91804, 92005, 91804           | 92206, 92005, 91804    | S           |
| `web.send.stream/push.view.bytes`                | 77986, 78187, 77986           | 78388, 78187, 77986    | S           |
| `web.send.stream/cdp.Nodes`                      | 1629, 1628, 1631              | 1627, 1655, 1635       | S           |
| `projection.large.open/json.stringify.chars`     | 181972, 181972, 181972        | 181974, 182008, 182008 | G           |
| `projection.large.open/push.bytes`               | 164315, 164315, 164315        | 164351, 164351, 164351 | G           |
| `projection.large.paced/json.stringify.chars`    | 428379, 425219, 429978        | 430046, 422811, 428377 | S           |
| `image.thumbs.first/json.stringify.chars`        | 1372, 1372, 1372              | 1440, 1372, 1372       | S           |

## Every inventoryMain worse counter

| Counter                                           |     Main → head | D9a corrected → final | Explanation |
| ------------------------------------------------- | --------------: | --------------------: | ----------- |
| `startup.restart/sql.statements`                  |       848 → 857 |             857 → 857 | P           |
| `startup.restart/sql.rows`                        |       528 → 542 |             543 → 543 | P           |
| `startup.restart/json.parse.durableStorage.calls` |       458 → 498 |             499 → 499 | P           |
| `startup.restart/json.parse.durableStorage.chars` |   51416 → 56263 |         56282 → 56282 | P           |
| `startup.restart/json.stringify.chars`            |   18739 → 18758 |         18758 → 18758 | P           |
| `session.open/sql.rows`                           |        94 → 105 |             105 → 105 | P           |
| `session.open/json.stringify.chars`               |   84622 → 88127 |         88127 → 88136 | G           |
| `session.open/view.fields.stringify.calls`        |         12 → 13 |               13 → 13 | P           |
| `session.open/view.fields.stringify.chars`        |       600 → 604 |             604 → 604 | P           |
| `session.open/push.events`                        |          9 → 10 |               10 → 10 | P           |
| `session.open/push.bytes`                         |   82236 → 86328 |         86328 → 86337 | G           |
| `session.open/push.view.bytes`                    |   76276 → 76292 |         76292 → 76292 | P           |
| `turn.warm/sql.statements`                        |       157 → 168 |             158 → 149 | P           |
| `turn.warm/sql.rows`                              |       116 → 126 |             111 → 103 | P           |
| `turn.warm/json.parse.calls`                      |       147 → 155 |             143 → 138 | P           |
| `turn.warm/json.parse.chars`                      | 338702 → 343129 |       293458 → 290760 | P           |
| `turn.warm/json.parse.journal.calls`              |         32 → 40 |               35 → 30 | P           |
| `turn.warm/json.parse.journal.chars`              |   22924 → 27251 |         24546 → 21842 | P           |
| `turn.warm/json.stringify.chars`                  |   85250 → 91619 |         87164 → 85258 | P           |
| `turn.warm/view.entry.visits`                     |          8 → 15 |                 8 → 8 | P           |
| `turn.warm/view.stats.entry.scans`                |          8 → 15 |                 8 → 8 | P           |
| `turn.warm/view.fields.stringify.calls`           |         24 → 52 |               39 → 26 | P           |
| `turn.warm/view.fields.stringify.chars`           |       279 → 574 |             408 → 287 | P           |
| `turn.warm/view.live.project.calls`               |           2 → 4 |                 3 → 2 | P           |
| `turn.warm/view.inbox.project.calls`              |           2 → 4 |                 3 → 2 | P           |
| `turn.warm/view.kernel.project.calls`             |           2 → 4 |                 3 → 2 | P           |
| `turn.warm/view.kernel.sql.heads`                 |           2 → 4 |                 3 → 2 | P           |
| `turn.warm/view.kernel.sql.attempts`              |           4 → 8 |                 6 → 4 | P           |
| `turn.warm/view.kernel.sql.command_inputs`        |           3 → 4 |                 3 → 2 | P           |
| `turn.warm/push.events`                           |           3 → 5 |                 4 → 3 | P           |
| `turn.warm/push.bytes`                            |   13102 → 18796 |         14351 → 13102 | P           |
| `turn.warm/push.view.count`                       |           2 → 4 |                 3 → 2 | P           |
| `turn.warm/push.view.bytes`                       |    8656 → 11175 |           9905 → 8656 | P           |
| `turn.paced/view.fields.stringify.calls`          |       132 → 143 |             143 → 143 | P           |
| `turn.paced/view.fields.stringify.chars`          |     2232 → 2276 |           2276 → 2276 | P           |
| `git.changes/json.stringify.chars`                |     3105 → 3134 |           3137 → 3105 | P           |
| `web.open/view.fields.stringify.calls`            |         12 → 13 |               13 → 13 | P           |
| `web.open/view.fields.stringify.chars`            |       600 → 604 |             604 → 604 | P           |
| `web.open/push.events`                            |         10 → 11 |               11 → 11 | P           |
| `web.open/push.bytes`                             |   83736 → 83980 |         83980 → 83989 | G           |
| `web.open/push.view.bytes`                        |   76309 → 76349 |         76349 → 76349 | P           |
| `web.open/http.requests`                          |         81 → 82 |               82 → 84 | S           |
| `web.open/cdp.Nodes`                              |      996 → 1138 |           1138 → 1138 | P           |
| `web.open/web.event.parse.calls`                  |          9 → 10 |               10 → 10 | P           |
| `web.open/web.event.parse.chars`                  |   82941 → 83157 |         83157 → 83166 | G           |
| `session.open.long/view.fields.stringify.calls`   |         12 → 13 |               13 → 13 | P           |
| `session.open.long/view.fields.stringify.chars`   |         73 → 77 |               77 → 77 | P           |
| `session.open.long/push.bytes`                    | 179320 → 179336 |       179336 → 179345 | G           |
| `session.open.long/push.view.bytes`               | 165843 → 165859 |       165859 → 165859 | P           |
| `session.history.earlier/json.stringify.chars`    | 243098 → 243132 |       243098 → 243098 | P           |
| `web.open.long/view.fields.stringify.calls`       |         12 → 13 |               13 → 13 | P           |
| `web.open.long/view.fields.stringify.chars`       |         73 → 77 |               77 → 77 | P           |
| `web.open.long/push.view.bytes`                   | 165859 → 165899 |       165899 → 165899 | P           |
| `web.open.long/http.requests`                     |         80 → 81 |               81 → 81 | P           |
| `web.open.long/cdp.Nodes`                         |     1585 → 1727 |           1727 → 1727 | P           |
| `web.open.long/web.event.parse.calls`             |           8 → 9 |                 9 → 9 | P           |
| `web.open.long/web.event.parse.chars`             | 173290 → 173508 |       173508 → 173517 | G           |
| `native.warm/sql.rows`                            |         10 → 11 |               11 → 11 | P           |
| `web.reopen/view.fields.stringify.calls`          |         12 → 13 |               13 → 13 | P           |
| `web.reopen/view.fields.stringify.chars`          |       645 → 649 |             649 → 649 | P           |
| `web.reopen/push.events`                          |          9 → 10 |               10 → 10 | P           |
| `web.reopen/push.bytes`                           |   10313 → 10557 |         10557 → 10566 | G           |
| `web.reopen/push.view.bytes`                      |     2001 → 2041 |           2041 → 2041 | P           |
| `web.reopen/cdp.Nodes`                            |     1090 → 1232 |           1232 → 1232 | P           |
| `web.reopen/web.event.parse.calls`                |           8 → 9 |                 9 → 9 | P           |
| `web.reopen/web.event.parse.chars`                |     9527 → 9743 |           9743 → 9752 | G           |
| `web.paced/view.fields.stringify.calls`           |       144 → 156 |             156 → 156 | P           |
| `web.paced/view.fields.stringify.chars`           |     7695 → 7743 |           7743 → 7743 | P           |
| `web.paced/cdp.Nodes`                             |     1295 → 1422 |           1414 → 1423 | P           |
| `web.send.poll/cdp.Nodes`                         |     1478 → 1618 |           1619 → 1619 | P           |
| `web.send.stream/push.bytes`                      |   91492 → 91804 |         92005 → 92206 | S           |
| `web.send.stream/push.view.bytes`                 |   77698 → 77986 |         78187 → 78388 | S           |
| `web.send.stream/cdp.RecalcStyleCount`            |       103 → 112 |             110 → 112 | P           |
| `web.send.stream/cdp.Nodes`                       |     1518 → 1635 |           1631 → 1655 | S           |
| `web.send.stream/web.event.parse.chars`           |   30133 → 30445 |         30445 → 30445 | P           |
| `commands.discover.cold/json.stringify.chars`     |   33846 → 33854 |         33854 → 33854 | P           |
| `projection.large.open/push.bytes`                | 164251 → 164315 |       164315 → 164351 | G           |
| `projection.large.open/push.view.bytes`           | 114758 → 114822 |       114822 → 114822 | P           |
| `assets.first/http.requests`                      |         53 → 54 |               54 → 54 | P           |
| `assets.validated/http.requests`                  |         53 → 54 |               54 → 54 | P           |

## Every finalMain worse counter

| Counter                                           |     Main → head | D9a corrected → final | Explanation |
| ------------------------------------------------- | --------------: | --------------------: | ----------- |
| `startup.restart/sql.statements`                  |       848 → 857 |             857 → 857 | P           |
| `startup.restart/sql.rows`                        |       529 → 543 |             543 → 543 | P           |
| `startup.restart/json.parse.durableStorage.calls` |       459 → 499 |             499 → 499 | P           |
| `startup.restart/json.parse.durableStorage.chars` |   51435 → 56282 |         56282 → 56282 | P           |
| `startup.restart/json.stringify.chars`            |   18739 → 18758 |         18758 → 18758 | P           |
| `session.open/sql.rows`                           |        94 → 105 |             105 → 105 | P           |
| `session.open/json.stringify.chars`               |   84622 → 88136 |         88127 → 88136 | G           |
| `session.open/view.fields.stringify.calls`        |         12 → 13 |               13 → 13 | P           |
| `session.open/view.fields.stringify.chars`        |       600 → 604 |             604 → 604 | P           |
| `session.open/push.events`                        |          9 → 10 |               10 → 10 | P           |
| `session.open/push.bytes`                         |   82236 → 86337 |         86328 → 86337 | G           |
| `session.open/push.view.bytes`                    |   76276 → 76292 |         76292 → 76292 | P           |
| `turn.cold/json.stringify.chars`                  | 126795 → 127088 |       128972 → 127088 | P           |
| `turn.warm/json.stringify.chars`                  |   85248 → 85258 |         87164 → 85258 | P           |
| `turn.warm/view.fields.stringify.calls`           |         24 → 26 |               39 → 26 | P           |
| `turn.warm/view.fields.stringify.chars`           |       279 → 287 |             408 → 287 | P           |
| `turn.paced/view.fields.stringify.calls`          |       132 → 143 |             143 → 143 | P           |
| `turn.paced/view.fields.stringify.chars`          |     2232 → 2276 |           2276 → 2276 | P           |
| `web.open/view.fields.stringify.calls`            |         12 → 13 |               13 → 13 | P           |
| `web.open/view.fields.stringify.chars`            |       600 → 604 |             604 → 604 | P           |
| `web.open/push.events`                            |         10 → 11 |               11 → 11 | P           |
| `web.open/push.bytes`                             |   83736 → 83989 |         83980 → 83989 | G           |
| `web.open/push.view.bytes`                        |   76309 → 76349 |         76349 → 76349 | P           |
| `web.open/http.requests`                          |         81 → 84 |               82 → 84 | S           |
| `web.open/cdp.Nodes`                              |      996 → 1138 |           1138 → 1138 | P           |
| `web.open/web.event.parse.calls`                  |          9 → 10 |               10 → 10 | P           |
| `web.open/web.event.parse.chars`                  |   82941 → 83166 |         83157 → 83166 | G           |
| `session.open.long/view.fields.stringify.calls`   |         12 → 13 |               13 → 13 | P           |
| `session.open.long/view.fields.stringify.chars`   |         73 → 77 |               77 → 77 | P           |
| `session.open.long/push.bytes`                    | 179320 → 179345 |       179336 → 179345 | G           |
| `session.open.long/push.view.bytes`               | 165843 → 165859 |       165859 → 165859 | P           |
| `web.open.long/view.fields.stringify.calls`       |         12 → 13 |               13 → 13 | P           |
| `web.open.long/view.fields.stringify.chars`       |         73 → 77 |               77 → 77 | P           |
| `web.open.long/push.view.bytes`                   | 165859 → 165899 |       165899 → 165899 | P           |
| `web.open.long/http.requests`                     |         80 → 81 |               81 → 81 | P           |
| `web.open.long/cdp.Nodes`                         |     1561 → 1727 |           1727 → 1727 | P           |
| `web.open.long/web.event.parse.calls`             |           8 → 9 |                 9 → 9 | P           |
| `web.open.long/web.event.parse.chars`             | 173290 → 173517 |       173508 → 173517 | G           |
| `native.warm/sql.rows`                            |         10 → 11 |               11 → 11 | P           |
| `turn.prewarmed/fs.read.calls`                    |         25 → 26 |               25 → 26 | S           |
| `turn.prewarmed/json.parse.durableStorage.calls`  |         18 → 20 |               18 → 20 | S           |
| `turn.prewarmed/json.parse.durableStorage.chars`  |     1122 → 1424 |           1122 → 1424 | S           |
| `web.reopen/view.fields.stringify.calls`          |         12 → 13 |               13 → 13 | P           |
| `web.reopen/view.fields.stringify.chars`          |       645 → 649 |             649 → 649 | P           |
| `web.reopen/push.events`                          |          9 → 10 |               10 → 10 | P           |
| `web.reopen/push.bytes`                           |   10313 → 10566 |         10557 → 10566 | G           |
| `web.reopen/push.view.bytes`                      |     2001 → 2041 |           2041 → 2041 | P           |
| `web.reopen/cdp.Nodes`                            |     1090 → 1232 |           1232 → 1232 | P           |
| `web.reopen/web.event.parse.calls`                |           8 → 9 |                 9 → 9 | P           |
| `web.reopen/web.event.parse.chars`                |     9527 → 9752 |           9743 → 9752 | G           |
| `web.paced/view.fields.stringify.calls`           |       132 → 156 |             156 → 156 | P           |
| `web.paced/view.fields.stringify.chars`           |     7050 → 7743 |           7743 → 7743 | P           |
| `web.paced/view.live.project.calls`               |         11 → 12 |               12 → 12 | P           |
| `web.paced/view.inbox.project.calls`              |         11 → 12 |               12 → 12 | P           |
| `web.paced/view.kernel.project.calls`             |         11 → 12 |               12 → 12 | P           |
| `web.paced/view.kernel.sql.heads`                 |         11 → 12 |               12 → 12 | P           |
| `web.paced/view.kernel.sql.attempts`              |         22 → 24 |               24 → 24 | P           |
| `web.paced/view.kernel.sql.rows`                  |         32 → 35 |               35 → 35 | P           |
| `web.paced/push.events`                           |         15 → 16 |               16 → 16 | P           |
| `web.paced/push.view.count`                       |         11 → 12 |               12 → 12 | P           |
| `web.paced/cdp.Nodes`                             |     1295 → 1423 |           1414 → 1423 | P           |
| `web.paced/web.event.parse.calls`                 |         13 → 14 |               14 → 14 | P           |
| `web.paced/web.view.apply.calls`                  |         11 → 12 |               12 → 12 | P           |
| `web.send.poll/cdp.Nodes`                         |     1454 → 1619 |           1619 → 1619 | P           |
| `web.send.stream/cdp.RecalcStyleCount`            |       106 → 112 |             110 → 112 | P           |
| `web.send.stream/cdp.Nodes`                       |     1517 → 1655 |           1631 → 1655 | S           |
| `commands.discover.cold/json.stringify.chars`     |   33846 → 33854 |         33854 → 33854 | P           |
| `commands.discover.warm/json.stringify.chars`     |   27229 → 27271 |         27271 → 27271 | P           |
| `turn.prepared/json.parse.durableStorage.calls`   |         19 → 21 |               21 → 21 | P           |
| `turn.prepared/json.parse.durableStorage.chars`   |     1412 → 1710 |           1710 → 1710 | P           |
| `projection.large.open/push.bytes`                | 164251 → 164351 |       164315 → 164351 | G           |
| `projection.large.open/push.view.bytes`           | 114758 → 114822 |       114822 → 114822 | P           |
| `assets.first/http.requests`                      |         53 → 54 |               54 → 54 | P           |
| `assets.validated/http.requests`                  |         53 → 54 |               54 → 54 | P           |

## Every slower timing

| Scope / timing                                    | Before → after (ms) | Interpretation                                                   |
| ------------------------------------------------- | ------------------: | ---------------------------------------------------------------- |
| inventoryMain / `startup.restart/appOpenMs`       |         28.3 → 40.6 | 采样差异，未归因; main comparison includes older branch changes. |
| inventoryMain / `session.open/ms`                 |           36 → 50.6 | 采样差异，未归因; main comparison includes older branch changes. |
| inventoryMain / `web.open/eventParseMs`           |           0.1 → 0.7 | 采样差异，未归因; main comparison includes older branch changes. |
| inventoryMain / `session.open.long/ms`            |            5 → 12.6 | 采样差异，未归因; main comparison includes older branch changes. |
| finalMain / `session.open/ms`                     |         38.2 → 54.3 | 采样差异，未归因; main comparison includes older branch changes. |
| finalMain / `session.open.long/ms`                |          5.2 → 12.9 | 采样差异，未归因; main comparison includes older branch changes. |
| finalMain / `web.paced/viewApplyMs`               |             1 → 1.9 | 采样差异，未归因; main comparison includes older branch changes. |
| finalMain / `commands.discover.warm/ms`           |         72.2 → 91.9 | 采样差异，未归因; main comparison includes older branch changes. |
| finalMain / `image.concurrent/imageLookupMs`      |         21.8 → 27.1 | 采样差异，未归因; main comparison includes older branch changes. |
| d9b / `web.paced/scriptMs`                        |         18.2 → 23.4 | INVALID L2: D9a baseline highLoad=true; diagnostic values only.  |
| d9b / `commands.discover.warm/ms`                 |         64.7 → 91.9 | INVALID L2: D9a baseline highLoad=true; diagnostic values only.  |
| d9b / `projection.large.open/roomKernelProjectMs` |           0.9 → 1.8 | INVALID L2: D9a baseline highLoad=true; diagnostic values only.  |
| d9b / `image.concurrent/imageLookupMs`            |         16.3 → 27.1 | INVALID L2: D9a baseline highLoad=true; diagnostic values only.  |
| d9b / `assets.validated/ms`                       |             32 → 44 | INVALID L2: D9a baseline highLoad=true; diagnostic values only.  |

## Every historical-ledger candidate warning

Inventory: 232; final: 233. Union below includes warnings that disappeared. All are candidates, not failed gates. A dash means the row was not worse in that run, not zero work.

| Counter                                                  | Historical reference | Inventory warning value | Final warning value | Explanation |
| -------------------------------------------------------- | -------------------: | ----------------------: | ------------------: | ----------- |
| `assets.first/http.requests`                             |                   53 |                      54 |                  54 | P           |
| `assets.validated/http.requests`                         |                   53 |                      54 |                  54 | P           |
| `changes.poll.images/json.stringify.chars`               |                20312 |                   20372 |               20346 | P           |
| `commands.discover.cold/fs.read.bytes`                   |               347249 |                  347277 |              347277 | P           |
| `commands.discover.cold/http.body.bytes`                 |                 7050 |                    9740 |                9740 | P           |
| `commands.discover.cold/json.parse.calls`                |                  114 |                     118 |                 118 | P           |
| `commands.discover.cold/json.parse.chars`                |               408633 |                  411248 |              411248 | P           |
| `commands.discover.cold/json.parse.journal.calls`        |                   19 |                      24 |                  24 | P           |
| `commands.discover.cold/json.parse.journal.chars`        |                10279 |                   12984 |               12984 | P           |
| `commands.discover.cold/json.parse.nativePin.chars`      |                44338 |                   44345 |               44345 | P           |
| `commands.discover.cold/json.parse.nativeResolver.chars` |               336032 |                  336036 |              336036 | P           |
| `commands.discover.cold/json.stringify.chars`            |                29321 |                   33854 |               33854 | P           |
| `commands.discover.cold/push.bytes`                      |                10499 |                   11726 |               11726 | P           |
| `commands.discover.cold/push.events`                     |                    3 |                       4 |                   4 | P           |
| `commands.discover.cold/push.view.bytes`                 |                 1052 |                    2279 |                2279 | P           |
| `commands.discover.cold/push.view.count`                 |                    1 |                       2 |                   2 | P           |
| `commands.discover.cold/sql.rows`                        |                   37 |                      73 |                  73 | P           |
| `commands.discover.cold/sql.statements`                  |                   80 |                      89 |                  89 | P           |
| `commands.discover.warm/fs.read.bytes`                   |               197932 |                  197948 |              197948 | P           |
| `commands.discover.warm/http.body.bytes`                 |                 7050 |                    9740 |                9740 | P           |
| `commands.discover.warm/json.parse.calls`                |                   67 |                      71 |                  71 | P           |
| `commands.discover.warm/json.parse.chars`                |               213297 |                  215918 |              215918 | P           |
| `commands.discover.warm/json.parse.journal.calls`        |                   19 |                      24 |                  24 | P           |
| `commands.discover.warm/json.parse.journal.chars`        |                10279 |                   12984 |               12984 | P           |
| `commands.discover.warm/json.parse.nativePin.chars`      |                25336 |                   25340 |               25340 | P           |
| `commands.discover.warm/json.parse.nativeResolver.chars` |               168016 |                  168018 |              168018 | P           |
| `commands.discover.warm/json.stringify.chars`            |                22738 |                   27237 |               27271 | P           |
| `commands.discover.warm/push.bytes`                      |                 5776 |                    7003 |                7003 | P           |
| `commands.discover.warm/push.events`                     |                    2 |                       3 |                   3 | P           |
| `commands.discover.warm/push.view.bytes`                 |                 1052 |                    2279 |                2279 | P           |
| `commands.discover.warm/push.view.count`                 |                    1 |                       2 |                   2 | P           |
| `commands.discover.warm/sql.rows`                        |                   38 |                      58 |                  58 | P           |
| `commands.discover.warm/sql.statements`                  |                   73 |                      81 |                  81 | P           |
| `commands.list/fs.read.bytes`                            |                49432 |                   49436 |               49436 | P           |
| `commands.list/http.body.bytes`                          |                 3283 |                    9549 |                9549 | P           |
| `commands.list/json.parse.chars`                         |               170825 |                  170827 |              170827 | P           |
| `commands.list/json.parse.nativePin.chars`               |                 6334 |                    6335 |                6335 | P           |
| `commands.list/json.parse.nativeResolver.chars`          |                84008 |                   84009 |               84009 | P           |
| `commands.list/json.stringify.chars`                     |                 3916 |                   10179 |               10145 | P           |
| `git.changes/json.parse.chars`                           |               122458 |                  122739 |              122738 | P           |
| `git.changes/json.parse.durableStorage.chars`            |               122458 |                  122739 |              122738 | P           |
| `git.changes/json.stringify.chars`                       |                 2539 |                    3134 |                3105 | P           |
| `image.concurrent/json.stringify.chars`                  |                    0 |                    1464 |                1430 | P           |
| `image.single/json.stringify.chars`                      |                   34 |                     417 |                 383 | P           |
| `native.warm/json.parse.calls`                           |                   58 |                      60 |                  60 | P           |
| `native.warm/json.parse.chars`                           |               210470 |                  210710 |              210710 | P           |
| `native.warm/json.parse.nativeReadback.calls`            |                    7 |                       9 |                   9 | P           |
| `native.warm/json.parse.nativeReadback.chars`            |                 2394 |                    2634 |                2634 | P           |
| `native.warm/json.parse.nativeRpc.calls`                 |                    7 |                       9 |                   9 | P           |
| `native.warm/json.parse.nativeRpc.chars`                 |                 2394 |                    2634 |                2634 | P           |
| `native.warm/json.parse.nativeRpcRecord.calls`           |                    6 |                       8 |                   8 | P           |
| `native.warm/json.parse.nativeRpcRecord.chars`           |                 2302 |                    2542 |                2542 | P           |
| `native.warm/sql.rows`                                   |                   10 |                      11 |                  11 | P           |
| `projection.large.open/json.parse.durableStorage.chars`  |               104782 |                  106466 |              106463 | P           |
| `projection.large.open/push.bytes`                       |               161655 |                  164315 |              164351 | G           |
| `projection.large.open/push.view.bytes`                  |               112462 |                  114822 |              114822 | P           |
| `projection.large.paced/json.parse.nativePin.chars`      |                19002 |                   19005 |               19005 | P           |
| `projection.large.paced/json.parse.nativeResolver.chars` |                84008 |                   84009 |               84009 | P           |
| `projection.large.paced/push.bytes`                      |               231388 |                  249828 |              256228 | P           |
| `projection.large.paced/push.events`                     |                   44 |                      52 |                  52 | P           |
| `projection.large.paced/push.view.bytes`                 |               190016 |                  208456 |              214856 | P           |
| `projection.large.paced/push.view.count`                 |                   36 |                      44 |                  44 | P           |
| `projection.large.paced/view.inbox.project.calls`        |                   36 |                      44 |                  44 | P           |
| `projection.large.paced/view.kernel.project.calls`       |                   36 |                      44 |                  44 | P           |
| `projection.large.paced/view.kernel.sql.attempts`        |                   72 |                      88 |                  88 | P           |
| `projection.large.paced/view.kernel.sql.heads`           |                   36 |                      44 |                  44 | P           |
| `projection.large.paced/view.live.project.calls`         |                   36 |                      44 |                  44 | P           |
| `session.history.earlier/json.stringify.chars`           |               243098 |                  243132 |                   — | P           |
| `session.open.long/json.stringify.chars`                 |               179791 |                       — |              179854 | P           |
| `session.open.long/push.bytes`                           |               179320 |                  179336 |              179345 | G           |
| `session.open.long/push.view.bytes`                      |               165843 |                  165859 |              165859 | P           |
| `session.open.long/view.fields.stringify.calls`          |                   12 |                      13 |                  13 | P           |
| `session.open.long/view.fields.stringify.chars`          |                   73 |                      77 |                  77 | P           |
| `session.open/json.parse.chars`                          |               253516 |                  253823 |              253821 | P           |
| `session.open/json.parse.durableStorage.chars`           |               129872 |                  130177 |              130176 | P           |
| `session.open/json.stringify.chars`                      |                84293 |                   88127 |               88136 | G           |
| `session.open/push.bytes`                                |                81884 |                   86328 |               86337 | G           |
| `session.open/push.events`                               |                    8 |                      10 |                  10 | P           |
| `session.open/push.view.bytes`                           |                75997 |                   76292 |               76292 | P           |
| `session.open/sql.rows`                                  |                   94 |                     105 |                 105 | P           |
| `session.open/view.fields.stringify.calls`               |                   12 |                      13 |                  13 | P           |
| `session.open/view.fields.stringify.chars`               |                  600 |                     604 |                 604 | P           |
| `session.reclaim/push.bytes`                             |                 9808 |                   13202 |               13211 | P           |
| `session.reclaim/push.view.bytes`                        |                 1985 |                    3088 |                3088 | P           |
| `sessions.list/json.parse.chars`                         |                   83 |                     114 |                 114 | P           |
| `sessions.list/json.stringify.chars`                     |                 4063 |                    4094 |                4094 | P           |
| `sessions.list/sql.rows`                                 |                    0 |                      13 |                  13 | P           |
| `sessions.list/sql.statements`                           |                    0 |                       1 |                   1 | P           |
| `startup.restart/fs.read.bytes`                          |                98864 |                   98872 |               98872 | P           |
| `startup.restart/json.parse.durableStorage.calls`        |                  458 |                     498 |                 499 | P           |
| `startup.restart/json.parse.durableStorage.chars`        |                51416 |                   56263 |               56282 | P           |
| `startup.restart/json.parse.nativePin.chars`             |                12668 |                   12670 |               12670 | P           |
| `startup.restart/json.stringify.chars`                   |                18515 |                   18758 |               18758 | P           |
| `startup.restart/sql.rows`                               |                  528 |                     542 |                 543 | P           |
| `startup.restart/sql.statements`                         |                  848 |                     857 |                 857 | P           |
| `turn.cold/fs.read.bytes`                                |               391847 |                  391871 |              391871 | P           |
| `turn.cold/json.parse.journal.calls`                     |                   36 |                      41 |                  41 | P           |
| `turn.cold/json.parse.journal.chars`                     |                63000 |                   65705 |               65705 | P           |
| `turn.cold/json.parse.nativePin.chars`                   |                38004 |                   38010 |               38010 | P           |
| `turn.cold/json.parse.nativeResolver.chars`              |               252024 |                  252027 |              252027 | P           |
| `turn.cold/json.stringify.chars`                         |               124912 |                  126807 |              127088 | P           |
| `turn.cold/push.bytes`                                   |                17352 |                   18599 |               18599 | P           |
| `turn.cold/push.events`                                  |                    4 |                       5 |                   5 | P           |
| `turn.cold/push.view.bytes`                              |                 8534 |                    9781 |                9781 | P           |
| `turn.cold/push.view.count`                              |                    2 |                       3 |                   3 | P           |
| `turn.cold/sql.rows`                                     |                  102 |                     135 |                 140 | P           |
| `turn.cold/sql.statements`                               |                  193 |                       — |                 212 | P           |
| `turn.paced/fs.read.bytes`                               |               269328 |                  269340 |              269342 | P           |
| `turn.paced/json.parse.journal.calls`                    |                   68 |                      75 |                  75 | P           |
| `turn.paced/json.parse.journal.chars`                    |                42408 |                   46195 |               46195 | P           |
| `turn.paced/json.parse.nativePin.chars`                  |                19002 |                   19005 |               19005 | P           |
| `turn.paced/json.parse.nativeResolver.chars`             |                84008 |                   84009 |               84009 | P           |
| `turn.paced/json.stringify.chars`                        |               130141 |                  144523 |              144323 | P           |
| `turn.paced/push.bytes`                                  |                46637 |                   58761 |               58561 | P           |
| `turn.paced/push.events`                                 |                   10 |                      13 |                  13 | P           |
| `turn.paced/push.view.bytes`                             |                37746 |                   49870 |               49670 | P           |
| `turn.paced/push.view.count`                             |                    8 |                      11 |                  11 | P           |
| `turn.paced/view.fields.stringify.calls`                 |                   96 |                     143 |                 143 | P           |
| `turn.paced/view.fields.stringify.chars`                 |                 1656 |                    2276 |                2276 | P           |
| `turn.paced/view.inbox.project.calls`                    |                    8 |                      11 |                  11 | P           |
| `turn.paced/view.kernel.project.calls`                   |                    8 |                      11 |                  11 | P           |
| `turn.paced/view.kernel.sql.attempts`                    |                   16 |                      22 |                  22 | P           |
| `turn.paced/view.kernel.sql.heads`                       |                    8 |                      11 |                  11 | P           |
| `turn.paced/view.kernel.sql.rows`                        |                   23 |                      32 |                  32 | P           |
| `turn.paced/view.kernel.sql.statements`                  |                   39 |                      44 |                  44 | P           |
| `turn.paced/view.live.project.calls`                     |                    8 |                      11 |                  11 | P           |
| `turn.prepared/fs.read.bytes`                            |               242536 |                  242548 |              242548 | P           |
| `turn.prepared/json.parse.calls`                         |                  152 |                     167 |                   — | P           |
| `turn.prepared/json.parse.durableStorage.calls`          |                   19 |                       — |                  21 | P           |
| `turn.prepared/json.parse.durableStorage.chars`          |                 1412 |                       — |                1710 | P           |
| `turn.prepared/json.parse.journal.calls`                 |                   30 |                      41 |                  39 | P           |
| `turn.prepared/json.parse.journal.chars`                 |                59757 |                   65708 |               64626 | P           |
| `turn.prepared/json.parse.nativePin.chars`               |                19002 |                   19005 |               19005 | P           |
| `turn.prepared/json.parse.nativeResolver.chars`          |                84008 |                   84009 |               84009 | P           |
| `turn.prepared/push.events`                              |                    2 |                       4 |                   4 | P           |
| `turn.prepared/push.view.count`                          |                    1 |                       3 |                   3 | P           |
| `turn.prewarmed/fs.read.calls`                           |                   25 |                       — |                  26 | S           |
| `turn.prewarmed/json.parse.durableStorage.calls`         |                   18 |                       — |                  20 | S           |
| `turn.prewarmed/json.parse.durableStorage.chars`         |                 1122 |                       — |                1424 | S           |
| `turn.prewarmed/push.bytes`                              |                14721 |                       — |               16004 | P           |
| `turn.prewarmed/push.view.bytes`                         |                 8572 |                       — |                9855 | P           |
| `turn.warm/fs.read.bytes`                                |               255920 |                  255932 |              255934 | P           |
| `turn.warm/json.parse.calls`                             |                  135 |                     155 |                 138 | P           |
| `turn.warm/json.parse.chars`                             |               288675 |                  343129 |              290760 | P           |
| `turn.warm/json.parse.journal.calls`                     |                   26 |                      40 |                   — | P           |
| `turn.warm/json.parse.journal.chars`                     |                19677 |                   27251 |                   — | P           |
| `turn.warm/json.parse.nativePin.chars`                   |                19002 |                   19005 |               19005 | P           |
| `turn.warm/json.parse.nativeResolver.chars`              |                84008 |                   84009 |               84009 | P           |
| `turn.warm/json.stringify.chars`                         |                83294 |                   91619 |               85258 | P           |
| `turn.warm/push.bytes`                                   |                11828 |                   18796 |               13102 | P           |
| `turn.warm/push.events`                                  |                    2 |                       5 |                   3 | P           |
| `turn.warm/push.view.bytes`                              |                 7382 |                   11175 |                8656 | P           |
| `turn.warm/push.view.count`                              |                    1 |                       4 |                   2 | P           |
| `turn.warm/sql.rows`                                     |                   85 |                     126 |                 103 | P           |
| `turn.warm/sql.statements`                               |                  142 |                     168 |                 149 | P           |
| `turn.warm/view.entry.visits`                            |                    8 |                      15 |                   — | P           |
| `turn.warm/view.fields.stringify.calls`                  |                   12 |                      52 |                  26 | P           |
| `turn.warm/view.fields.stringify.chars`                  |                  162 |                     574 |                 287 | P           |
| `turn.warm/view.inbox.project.calls`                     |                    1 |                       4 |                   2 | P           |
| `turn.warm/view.kernel.json.parse.calls`                 |                    2 |                       8 |                   — | P           |
| `turn.warm/view.kernel.json.parse.chars`                 |                 1082 |                    4328 |                   — | P           |
| `turn.warm/view.kernel.project.calls`                    |                    1 |                       4 |                   2 | P           |
| `turn.warm/view.kernel.sql.attempts`                     |                    2 |                       8 |                   4 | P           |
| `turn.warm/view.kernel.sql.command_inputs`               |                    1 |                       4 |                   2 | P           |
| `turn.warm/view.kernel.sql.heads`                        |                    1 |                       4 |                   2 | P           |
| `turn.warm/view.live.project.calls`                      |                    1 |                       4 |                   2 | P           |
| `turn.warm/view.stats.entry.scans`                       |                    8 |                      15 |                   — | P           |
| `web.open.long/cdp.Nodes`                                |                 1585 |                    1727 |                1727 | P           |
| `web.open.long/http.requests`                            |                   78 |                      81 |                  81 | P           |
| `web.open.long/push.view.bytes`                          |               165843 |                  165899 |              165899 | P           |
| `web.open.long/sql.statements`                           |                   17 |                      26 |                  26 | P           |
| `web.open.long/subprocess.total`                         |                    0 |                       1 |                   1 | P           |
| `web.open.long/view.fields.stringify.calls`              |                   12 |                      13 |                  13 | P           |
| `web.open.long/view.fields.stringify.chars`              |                   73 |                      77 |                  77 | P           |
| `web.open.long/web.event.parse.calls`                    |                    8 |                       9 |                   9 | P           |
| `web.open.long/web.event.parse.chars`                    |               173274 |                  173508 |              173517 | G           |
| `web.open/cdp.Nodes`                                     |                  971 |                    1138 |                1138 | P           |
| `web.open/http.requests`                                 |                   73 |                      82 |                  84 | S           |
| `web.open/push.bytes`                                    |                83441 |                   83980 |               83989 | G           |
| `web.open/push.events`                                   |                   10 |                      11 |                  11 | P           |
| `web.open/push.view.bytes`                               |                76014 |                   76349 |               76349 | P           |
| `web.open/sql.rows`                                      |                   40 |                      63 |                  63 | P           |
| `web.open/sql.statements`                                |                   15 |                      28 |                  28 | P           |
| `web.open/subprocess.total`                              |                    0 |                       1 |                   1 | P           |
| `web.open/view.fields.stringify.calls`                   |                   12 |                      13 |                  13 | P           |
| `web.open/view.fields.stringify.chars`                   |                  600 |                     604 |                 604 | P           |
| `web.open/web.event.parse.calls`                         |                    9 |                      10 |                  10 | P           |
| `web.open/web.event.parse.chars`                         |                82646 |                   83157 |               83166 | G           |
| `web.paced/cdp.LayoutCount`                              |                   12 |                      15 |                  14 | P           |
| `web.paced/cdp.Nodes`                                    |                 1222 |                    1422 |                1423 | P           |
| `web.paced/http.requests`                                |                    4 |                       5 |                   5 | P           |
| `web.paced/push.events`                                  |                   14 |                      16 |                  16 | P           |
| `web.paced/push.view.count`                              |                   10 |                      12 |                  12 | P           |
| `web.paced/view.fields.stringify.calls`                  |                  120 |                     156 |                 156 | P           |
| `web.paced/view.fields.stringify.chars`                  |                 6405 |                    7743 |                7743 | P           |
| `web.paced/view.inbox.project.calls`                     |                   10 |                      12 |                  12 | P           |
| `web.paced/view.kernel.project.calls`                    |                   10 |                      12 |                  12 | P           |
| `web.paced/view.kernel.sql.attempts`                     |                   20 |                      24 |                  24 | P           |
| `web.paced/view.kernel.sql.heads`                        |                   10 |                      12 |                  12 | P           |
| `web.paced/view.kernel.sql.rows`                         |                   29 |                      35 |                  35 | P           |
| `web.paced/view.live.project.calls`                      |                   10 |                      12 |                  12 | P           |
| `web.paced/web.event.parse.calls`                        |                   12 |                      14 |                  14 | P           |
| `web.paced/web.view.apply.calls`                         |                   10 |                      12 |                  12 | P           |
| `web.reopen/cdp.Nodes`                                   |                 1090 |                    1232 |                1232 | P           |
| `web.reopen/http.requests`                               |                   78 |                      80 |                  80 | P           |
| `web.reopen/push.bytes`                                  |                10297 |                   10557 |               10566 | G           |
| `web.reopen/push.events`                                 |                    9 |                      10 |                  10 | P           |
| `web.reopen/push.view.bytes`                             |                 1985 |                    2041 |                2041 | P           |
| `web.reopen/sql.statements`                              |                   15 |                      16 |                  16 | P           |
| `web.reopen/view.fields.stringify.calls`                 |                   12 |                      13 |                  13 | P           |
| `web.reopen/view.fields.stringify.chars`                 |                  645 |                     649 |                 649 | P           |
| `web.reopen/web.event.parse.calls`                       |                    8 |                       9 |                   9 | P           |
| `web.reopen/web.event.parse.chars`                       |                 9511 |                    9743 |                9752 | G           |
| `web.send.poll/cdp.LayoutCount`                          |                   17 |                      18 |                  18 | P           |
| `web.send.poll/cdp.Nodes`                                |                 1349 |                    1618 |                1619 | P           |
| `web.send.poll/http.requests`                            |                   17 |                      23 |                  23 | P           |
| `web.send.poll/push.bytes`                               |                55026 |                   61823 |               61568 | P           |
| `web.send.poll/push.events`                              |                   26 |                      32 |                  30 | P           |
| `web.send.poll/push.view.bytes`                          |                42567 |                   49364 |               49109 | P           |
| `web.send.poll/push.view.count`                          |                   20 |                      26 |                  24 | P           |
| `web.send.poll/view.inbox.project.calls`                 |                   20 |                      26 |                  24 | P           |
| `web.send.poll/view.kernel.project.calls`                |                   20 |                      26 |                  24 | P           |
| `web.send.poll/view.kernel.sql.attempts`                 |                   40 |                      52 |                  48 | P           |
| `web.send.poll/view.kernel.sql.heads`                    |                   20 |                      26 |                  24 | P           |
| `web.send.poll/view.kernel.sql.rows`                     |                   58 |                      76 |                  70 | P           |
| `web.send.poll/view.live.project.calls`                  |                   20 |                      26 |                  24 | P           |
| `web.send.poll/web.view.apply.calls`                     |                   10 |                      13 |                  12 | P           |
| `web.send.stream/cdp.Nodes`                              |                 1388 |                    1635 |                1655 | S           |
| `web.send.stream/cdp.RecalcStyleCount`                   |                  104 |                     112 |                 112 | P           |
| `web.send.stream/http.requests`                          |                    4 |                       8 |                   8 | P           |
| `web.send.stream/push.events`                            |                   24 |                      30 |                  30 | P           |
| `web.send.stream/push.view.count`                        |                   18 |                      24 |                  24 | P           |
| `web.send.stream/view.inbox.project.calls`               |                   18 |                      24 |                  24 | P           |
| `web.send.stream/view.kernel.project.calls`              |                   18 |                      24 |                  24 | P           |
| `web.send.stream/view.kernel.sql.attempts`               |                   36 |                      48 |                  48 | P           |
| `web.send.stream/view.kernel.sql.heads`                  |                   18 |                      24 |                  24 | P           |
| `web.send.stream/view.kernel.sql.rows`                   |                   52 |                      70 |                  70 | P           |
| `web.send.stream/view.kernel.sql.statements`             |                   88 |                      96 |                  96 | P           |
| `web.send.stream/view.live.project.calls`                |                   18 |                      24 |                  24 | P           |
| `web.send.stream/web.event.parse.calls`                  |                   12 |                      15 |                  15 | P           |
| `web.send.stream/web.view.apply.calls`                   |                    9 |                      12 |                  12 | P           |

Raw reports/logs remain under `/tmp/rotom-review-D9b/`; portable comparison rows, samples, gate results and report hashes are in [d9b-performance.json](d9b-performance.json). This synthetic native workload does not measure large production legacy-catalog startup cost. D9a quarantine scanning remains unchanged; adding a persistent skip marker is outside this no-format-change deletion.
