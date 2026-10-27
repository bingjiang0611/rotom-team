# Send correlation: mainline counter comparison

Base: `c379bb7cfb57`. Candidate: `5cfc7769f769-dirty`, final runtime sources before documentation-only edits.
Report: `/tmp/rt-send-trace-accepted-main/{base,head}.json`. One measured run per side.
Every strictly larger measured work counter is listed. These are observations, not established regressions.

- **M**: necessary module-split cost: six extra JS resources, including six conditional requests on revalidation;
  gzip response bodies increase by 3,640 bytes. Same increase occurs against both bases.
- **T**: scheduling/refresh-boundary candidate, not a new fixed query contract. A/A also adds a view, nine SQL
  statements/eight rows in a turn and changes pushed bytes/JSON work. This does not prove this row is harmless;
  the owner should repeat the named scenario if selecting it for the next climb. No baseline was raised.
- **R**: browser rendering/DOM/GC sample. A/A changes render and node counts too. Exact attribution is unavailable;
  additional module bookkeeping may contribute. No stable DOM, CPU or latency improvement is claimed.
- **W**: payload-width/background serialization variation with unchanged relevant call counts; A/A also varies
  by 34-byte JSON records and small payload widths. The reports do not retain the exact changed field.
  This remains a measurement lead, not a proven new fixed amount of product work.

Mainline includes earlier branch work; the immediate-parent comparison is the primary isolation of this change.
The corrected A/A report is `/tmp/rt-send-trace-aa-control/{base,head}.json` (47 larger counters, also noncausal).

| Scenario / counter                                |   Base | Candidate | Increase | Explanation |
| ------------------------------------------------- | -----: | --------: | -------: | :---------: |
| `startup.restart/sql.rows`                        |    542 |       543 |       +1 |      T      |
| `startup.restart/json.parse.calls`                |    510 |       511 |       +1 |      T      |
| `startup.restart/json.parse.chars`                |  70223 |     70242 |      +19 |      W      |
| `startup.restart/json.parse.durableStorage.calls` |    498 |       499 |       +1 |      T      |
| `startup.restart/json.parse.durableStorage.chars` |  56263 |     56282 |      +19 |      W      |
| `sessions.rename.tabs/json.stringify.chars`       |  16128 |     16162 |      +34 |      W      |
| `turn.cold/fs.read.calls`                         |     50 |        51 |       +1 |      T      |
| `turn.cold/sql.statements`                        |    197 |       212 |      +15 |      T      |
| `turn.cold/sql.rows`                              |    133 |       140 |       +7 |      T      |
| `turn.cold/json.parse.calls`                      |    208 |       212 |       +4 |      T      |
| `turn.cold/json.parse.chars`                      | 677171 |    678549 |    +1378 |      T      |
| `turn.cold/json.parse.durableStorage.calls`       |     18 |        20 |       +2 |      T      |
| `turn.cold/json.parse.durableStorage.chars`       |   1102 |      1398 |     +296 |      T      |
| `turn.cold/json.parse.journal.calls`              |     39 |        41 |       +2 |      T      |
| `turn.cold/json.parse.journal.chars`              |  64623 |     65705 |    +1082 |      T      |
| `turn.cold/json.stringify.chars`                  | 126807 |    127088 |     +281 |      T      |
| `web.open/http.requests`                          |     82 |        88 |       +6 |      M      |
| `web.open/cdp.Nodes`                              |   1114 |      1126 |      +12 |      R      |
| `session.history.earlier/json.stringify.chars`    | 243098 |    243132 |      +34 |      W      |
| `web.open.long/http.requests`                     |     81 |        87 |       +6 |      M      |
| `native.validate/json.stringify.chars`            |     34 |        68 |      +34 |      W      |
| `web.reopen/http.requests`                        |     80 |        86 |       +6 |      M      |
| `web.reopen/cdp.Nodes`                            |   1232 |      1244 |      +12 |      R      |
| `web.paced/push.bytes`                            |  29897 |     30028 |     +131 |      T      |
| `web.paced/push.view.bytes`                       |  27559 |     27690 |     +131 |      T      |
| `web.paced/cdp.Nodes`                             |   1412 |      1435 |      +23 |      R      |
| `web.paced/web.event.parse.chars`                 |  28448 |     28579 |     +131 |      T      |
| `web.send.poll/sql.statements`                    |    324 |       335 |      +11 |      T      |
| `web.send.poll/sql.rows`                          |    330 |       339 |       +9 |      T      |
| `web.send.poll/view.fields.stringify.calls`       |    156 |       169 |      +13 |      T      |
| `web.send.poll/view.fields.stringify.chars`       |   8294 |      8989 |     +695 |      T      |
| `web.send.poll/view.live.project.calls`           |     24 |        26 |       +2 |      T      |
| `web.send.poll/view.inbox.project.calls`          |     24 |        26 |       +2 |      T      |
| `web.send.poll/view.kernel.project.calls`         |     24 |        26 |       +2 |      T      |
| `web.send.poll/view.kernel.sql.statements`        |     96 |       104 |       +8 |      T      |
| `web.send.poll/view.kernel.sql.heads`             |     24 |        26 |       +2 |      T      |
| `web.send.poll/view.kernel.sql.attempts`          |     48 |        52 |       +4 |      T      |
| `web.send.poll/view.kernel.sql.command_inputs`    |     24 |        26 |       +2 |      T      |
| `web.send.poll/view.kernel.sql.rows`              |     70 |        76 |       +6 |      T      |
| `web.send.poll/view.kernel.json.parse.calls`      |     48 |        52 |       +4 |      T      |
| `web.send.poll/view.kernel.json.parse.chars`      |  25968 |     28132 |    +2164 |      T      |
| `web.send.poll/push.events`                       |     30 |        32 |       +2 |      T      |
| `web.send.poll/push.bytes`                        |  60764 |     62027 |    +1263 |      T      |
| `web.send.poll/push.view.count`                   |     24 |        26 |       +2 |      T      |
| `web.send.poll/push.view.bytes`                   |  48305 |     49568 |    +1263 |      T      |
| `web.send.poll/http.requests`                     |     23 |        24 |       +1 |      T      |
| `web.send.poll/cdp.RecalcStyleCount`              |    109 |       113 |       +4 |      R      |
| `web.send.poll/web.view.apply.calls`              |     12 |        13 |       +1 |      T      |
| `web.send.stream/push.bytes`                      |  91603 |     92005 |     +402 |      T      |
| `web.send.stream/push.view.bytes`                 |  77785 |     78187 |     +402 |      T      |
| `web.send.stream/cdp.Nodes`                       |   1656 |      1667 |      +11 |      R      |
| `commands.discover.cold/json.stringify.chars`     |  33820 |     33854 |      +34 |      W      |
| `turn.prepared/sql.statements`                    |    177 |       186 |       +9 |      T      |
| `turn.prepared/sql.rows`                          |    109 |       117 |       +8 |      T      |
| `turn.prepared/json.parse.calls`                  |    155 |       160 |       +5 |      T      |
| `turn.prepared/json.parse.chars`                  | 478617 |    481322 |    +2705 |      T      |
| `turn.prepared/json.parse.journal.calls`          |     34 |        39 |       +5 |      T      |
| `turn.prepared/json.parse.journal.chars`          |  61921 |     64626 |    +2705 |      T      |
| `turn.prepared/json.stringify.chars`              | 119667 |    121551 |    +1884 |      T      |
| `turn.prepared/push.events`                       |      3 |         4 |       +1 |      T      |
| `turn.prepared/push.bytes`                        |  13379 |     14604 |    +1225 |      T      |
| `turn.prepared/push.view.count`                   |      2 |         3 |       +1 |      T      |
| `turn.prepared/push.view.bytes`                   |   8582 |      9807 |    +1225 |      T      |
| `image.thumbs.first/json.stringify.chars`         |   1372 |      1440 |      +68 |      W      |
| `assets.first/http.requests`                      |     54 |        60 |       +6 |      M      |
| `assets.first/http.body.bytes`                    | 408479 |    412119 |    +3640 |      M      |
| `assets.validated/http.requests`                  |     54 |        60 |       +6 |      M      |
| `web.send.poll.network/cdp.Nodes`                 |   1655 |      1667 |      +12 |      R      |
| `web.send.stream.network/cdp.LayoutCount`         |     18 |        19 |       +1 |      R      |
| `web.send.stream.network/cdp.RecalcStyleCount`    |    109 |       119 |      +10 |      R      |
| `web.send.stream.network/cdp.Nodes`               |   1731 |      1754 |      +23 |      R      |

Total: 71 larger measured counters. No ledger, tolerance, workload key or ceiling was changed.
