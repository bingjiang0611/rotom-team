# Send correlation: immediate parent counter comparison

Base: `5cfc7769f769`. Candidate: `5cfc7769f769-dirty`, final runtime sources before documentation-only edits.
Report: `/tmp/rt-send-trace-accepted-parent/{base,head}.json`. One measured run per side.
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

| Scenario / counter                                          |   Base | Candidate | Increase | Explanation |
| ----------------------------------------------------------- | -----: | --------: | -------: | :---------: |
| `turn.paced/json.stringify.chars`                           | 143323 |    143923 |     +600 |      T      |
| `turn.paced/push.bytes`                                     |  57561 |     58161 |     +600 |      T      |
| `turn.paced/push.view.bytes`                                |  48670 |     49270 |     +600 |      T      |
| `web.open/http.requests`                                    |     82 |        88 |       +6 |      M      |
| `web.open/cdp.LayoutCount`                                  |      7 |         8 |       +1 |      R      |
| `web.open/cdp.Nodes`                                        |   1114 |      1126 |      +12 |      R      |
| `session.history.earlier/json.stringify.chars`              | 243098 |    243132 |      +34 |      W      |
| `web.open.long/http.requests`                               |     81 |        87 |       +6 |      M      |
| `web.open.long/cdp.Nodes`                                   |   1703 |      1715 |      +12 |      R      |
| `web.reopen/http.requests`                                  |     80 |        86 |       +6 |      M      |
| `web.reopen/cdp.RecalcStyleCount`                           |     14 |        16 |       +2 |      R      |
| `web.paced/sql.statements`                                  |    254 |       263 |       +9 |      T      |
| `web.paced/sql.rows`                                        |    266 |       274 |       +8 |      T      |
| `web.paced/view.fields.stringify.calls`                     |    143 |       156 |      +13 |      T      |
| `web.paced/view.fields.stringify.chars`                     |   7094 |      7743 |     +649 |      T      |
| `web.paced/view.live.project.calls`                         |     11 |        12 |       +1 |      T      |
| `web.paced/view.inbox.project.calls`                        |     11 |        12 |       +1 |      T      |
| `web.paced/view.kernel.project.calls`                       |     11 |        12 |       +1 |      T      |
| `web.paced/view.kernel.sql.statements`                      |     44 |        48 |       +4 |      T      |
| `web.paced/view.kernel.sql.heads`                           |     11 |        12 |       +1 |      T      |
| `web.paced/view.kernel.sql.attempts`                        |     22 |        24 |       +2 |      T      |
| `web.paced/view.kernel.sql.command_inputs`                  |     11 |        12 |       +1 |      T      |
| `web.paced/view.kernel.sql.rows`                            |     32 |        35 |       +3 |      T      |
| `web.paced/view.kernel.json.parse.calls`                    |     22 |        24 |       +2 |      T      |
| `web.paced/view.kernel.json.parse.chars`                    |  11902 |     12984 |    +1082 |      T      |
| `web.paced/push.events`                                     |     15 |        16 |       +1 |      T      |
| `web.paced/push.bytes`                                      |  29897 |     31718 |    +1821 |      T      |
| `web.paced/push.view.count`                                 |     11 |        12 |       +1 |      T      |
| `web.paced/push.view.bytes`                                 |  27559 |     29380 |    +1821 |      T      |
| `web.paced/cdp.RecalcStyleCount`                            |     48 |        50 |       +2 |      R      |
| `web.paced/web.event.parse.calls`                           |     13 |        14 |       +1 |      T      |
| `web.paced/web.event.parse.chars`                           |  28448 |     30249 |    +1801 |      T      |
| `web.paced/web.view.apply.calls`                            |     11 |        12 |       +1 |      T      |
| `web.send.poll/push.bytes`                                  |  60563 |     60764 |     +201 |      T      |
| `web.send.poll/push.view.bytes`                             |  48104 |     48305 |     +201 |      T      |
| `web.send.poll/http.requests`                               |     22 |        23 |       +1 |      T      |
| `web.send.poll/cdp.Nodes`                                   |   1595 |      1630 |      +35 |      R      |
| `web.send.stream/cdp.LayoutCount`                           |     17 |        18 |       +1 |      R      |
| `web.send.stream/cdp.RecalcStyleCount`                      |    109 |       110 |       +1 |      R      |
| `web.send.stream/cdp.Nodes`                                 |   1630 |      1644 |      +14 |      R      |
| `commands.discover.cold/json.stringify.chars`               |  33820 |     33854 |      +34 |      W      |
| `turn.prepared/json.stringify.chars`                        | 119701 |    119735 |      +34 |      W      |
| `projection.large.open/json.parse.chars`                    | 217479 |    217487 |       +8 |      W      |
| `projection.large.open/json.parse.durableStorage.chars`     | 106460 |    106464 |       +4 |      W      |
| `projection.large.open/json.parse.journalSegments.chars`    |  93707 |     93711 |       +4 |      W      |
| `projection.large.open/json.stringify.chars`                | 181974 |    182008 |      +34 |      W      |
| `projection.large.paced/fs.read.bytes`                      | 350088 |    350096 |       +8 |      W      |
| `projection.large.paced/json.parse.chars`                   | 538728 |    538740 |      +12 |      W      |
| `projection.large.paced/json.parse.journalSegments.chars`   | 194331 |    194339 |       +8 |      W      |
| `projection.large.paced/json.parse.nativeReadback.chars`    | 150025 |    150029 |       +4 |      W      |
| `projection.large.paced/json.parse.nativeJsonl.chars`       | 100633 |    100637 |       +4 |      W      |
| `projection.large.paced/json.parse.nativeJsonlIngest.chars` | 100633 |    100637 |       +4 |      W      |
| `assets.first/http.requests`                                |     54 |        60 |       +6 |      M      |
| `assets.first/http.body.bytes`                              | 408479 |    412119 |    +3640 |      M      |
| `assets.validated/http.requests`                            |     54 |        60 |       +6 |      M      |
| `web.send.poll.network/push.bytes`                          |  61694 |     61920 |     +226 |      T      |
| `web.send.poll.network/push.view.bytes`                     |  48627 |     48853 |     +226 |      T      |
| `web.send.poll.network/cdp.LayoutCount`                     |     15 |        16 |       +1 |      R      |
| `web.send.poll.network/cdp.Nodes`                           |   1638 |      1671 |      +33 |      R      |
| `web.send.stream.network/cdp.RecalcStyleCount`              |    112 |       113 |       +1 |      R      |
| `web.send.stream.network/cdp.Nodes`                         |   1736 |      1744 |       +8 |      R      |

Total: 61 larger measured counters. No ledger, tolerance, workload key or ceiling was changed.
