# Main integration: all larger measured counters

One measured run per side; these are observations, not established regressions or speed claims.
Both runs passed gating and the ledger guard under the timing lock with highLoad:false.

- **M**: the already-reviewed application module split costs six extra resource requests and 3,640 gzip bytes
  versus old main. Benchmark-only extraction adds no fixed asset cost versus incoming 7d606c6.
- **R**: browser rendering/DOM/GC sample. The earlier same-revision A/A control also varies these counters.
  Exact attribution is unavailable; no stable renderer or latency claim is made.
- **T**: scheduling, coalescing or readback-boundary candidate. The earlier A/A run also varies SQL/readback work
  and pushes. This does not prove each row harmless; keep it as a named lead for repeated isolated measurement.
- **W**: small payload-width/background serialization variation. Exact fields are not retained in these reports.
  No extra per-record work is inferred from character count alone, and no tolerance was changed.

## Against origin/main c379bb7

Reports: `/tmp/rt-main-merge-ci/{base,head}.json`; 34 strictly larger counters.

| Scenario / counter                                |   Base |  Merge | Increase | Explanation |
| ------------------------------------------------- | -----: | -----: | -------: | :---------: |
| `git.changes/json.stringify.chars`                |   2536 |   2538 |       +2 |      W      |
| `git.changes/http.body.bytes`                     |   2536 |   2538 |       +2 |      W      |
| `web.open/http.requests`                          |     82 |     88 |       +6 |      M      |
| `web.open.long/http.requests`                     |     81 |     87 |       +6 |      M      |
| `web.open.long/cdp.LayoutCount`                   |      8 |      9 |       +1 |      R      |
| `web.open.long/cdp.RecalcStyleCount`              |     17 |     19 |       +2 |      R      |
| `web.open.long/cdp.Nodes`                         |   1703 |   1715 |      +12 |      R      |
| `turn.prewarmed/sql.statements`                   |    190 |    191 |       +1 |      T      |
| `turn.prewarmed/sql.rows`                         |    118 |    123 |       +5 |      T      |
| `turn.prewarmed/json.parse.calls`                 |    159 |    164 |       +5 |      T      |
| `turn.prewarmed/json.parse.chars`                 | 481009 | 521280 |   +40271 |      T      |
| `turn.prewarmed/json.parse.journalSegments.calls` |      6 |     11 |       +5 |      T      |
| `turn.prewarmed/json.parse.journalSegments.chars` |  46769 |  87040 |   +40271 |      T      |
| `turn.prewarmed/json.stringify.chars`             | 122598 | 122612 |      +14 |      W      |
| `turn.prewarmed/push.bytes`                       |  15939 |  15953 |      +14 |      T      |
| `turn.prewarmed/push.view.bytes`                  |   9790 |   9804 |      +14 |      T      |
| `web.reopen/http.requests`                        |     80 |     86 |       +6 |      M      |
| `web.reopen/cdp.Nodes`                            |   1232 |   1244 |      +12 |      R      |
| `web.paced/cdp.Nodes`                             |   1417 |   1433 |      +16 |      R      |
| `web.send.poll/push.bytes`                        |  60965 |  61166 |     +201 |      T      |
| `web.send.poll/push.view.bytes`                   |  48506 |  48707 |     +201 |      T      |
| `web.send.poll/cdp.RecalcStyleCount`              |    112 |    115 |       +3 |      R      |
| `web.send.poll/cdp.Nodes`                         |   1592 |   1606 |      +14 |      R      |
| `web.send.stream/cdp.RecalcStyleCount`            |    109 |    111 |       +2 |      R      |
| `web.send.stream/cdp.Nodes`                       |   1631 |   1641 |      +10 |      R      |
| `commands.discover.cold/json.stringify.chars`     |  33820 |  33854 |      +34 |      W      |
| `changes.poll.images/json.stringify.chars`        |  20288 |  20304 |      +16 |      W      |
| `changes.poll.images/http.body.bytes`             |  20288 |  20304 |      +16 |      W      |
| `assets.first/http.requests`                      |     54 |     60 |       +6 |      M      |
| `assets.first/http.body.bytes`                    | 408479 | 412119 |    +3640 |      M      |
| `assets.validated/http.requests`                  |     54 |     60 |       +6 |      M      |
| `web.send.poll.network/cdp.Nodes`                 |   1656 |   1666 |      +10 |      R      |
| `web.send.stream.network/cdp.LayoutCount`         |     18 |     19 |       +1 |      R      |
| `web.send.stream.network/cdp.Nodes`               |   1732 |   1744 |      +12 |      R      |

## Against incoming feature 7d606c6

Reports: `/tmp/rt-main-merge-incoming-ci/{base,head}.json`; 35 strictly larger counters.

| Scenario / counter                                          |   Base |  Merge | Increase | Explanation |
| ----------------------------------------------------------- | -----: | -----: | -------: | :---------: |
| `turn.paced/json.stringify.chars`                           | 142923 | 143123 |     +200 |      T      |
| `turn.paced/push.bytes`                                     |  57161 |  57361 |     +200 |      T      |
| `turn.paced/push.view.bytes`                                |  48270 |  48470 |     +200 |      T      |
| `git.changes/json.stringify.chars`                          |   2540 |   2541 |       +1 |      W      |
| `git.changes/http.body.bytes`                               |   2540 |   2541 |       +1 |      W      |
| `web.open/cdp.RecalcStyleCount`                             |     19 |     20 |       +1 |      R      |
| `turn.prewarmed/sql.statements`                             |    190 |    191 |       +1 |      T      |
| `turn.prewarmed/sql.rows`                                   |    118 |    123 |       +5 |      T      |
| `turn.prewarmed/json.parse.calls`                           |    159 |    164 |       +5 |      T      |
| `turn.prewarmed/json.parse.chars`                           | 481009 | 521280 |   +40271 |      T      |
| `turn.prewarmed/json.parse.journalSegments.calls`           |      6 |     11 |       +5 |      T      |
| `turn.prewarmed/json.parse.journalSegments.chars`           |  46769 |  87040 |   +40271 |      T      |
| `turn.prewarmed/json.stringify.chars`                       | 122598 | 122612 |      +14 |      W      |
| `turn.prewarmed/push.bytes`                                 |  15939 |  15953 |      +14 |      T      |
| `turn.prewarmed/push.view.bytes`                            |   9790 |   9804 |      +14 |      T      |
| `web.reopen/cdp.Nodes`                                      |   1220 |   1244 |      +24 |      R      |
| `web.paced/cdp.RecalcStyleCount`                            |     41 |     43 |       +2 |      R      |
| `web.send.poll/push.bytes`                                  |  60965 |  61166 |     +201 |      T      |
| `web.send.poll/push.view.bytes`                             |  48506 |  48707 |     +201 |      T      |
| `web.send.poll/cdp.RecalcStyleCount`                        |    113 |    117 |       +4 |      R      |
| `web.send.stream/cdp.RecalcStyleCount`                      |    109 |    113 |       +4 |      R      |
| `web.send.stream/cdp.Nodes`                                 |   1642 |   1666 |      +24 |      R      |
| `projection.large.open/json.parse.chars`                    | 217483 | 217493 |      +10 |      W      |
| `projection.large.open/json.parse.durableStorage.chars`     | 106462 | 106467 |       +5 |      W      |
| `projection.large.open/json.parse.journalSegments.chars`    |  93709 |  93714 |       +5 |      W      |
| `projection.large.paced/fs.read.bytes`                      | 350092 | 350102 |      +10 |      W      |
| `projection.large.paced/json.parse.chars`                   | 538734 | 538749 |      +15 |      W      |
| `projection.large.paced/json.parse.journalSegments.chars`   | 194335 | 194345 |      +10 |      W      |
| `projection.large.paced/json.parse.nativeReadback.chars`    | 150027 | 150032 |       +5 |      W      |
| `projection.large.paced/json.parse.nativeJsonl.chars`       | 100635 | 100640 |       +5 |      W      |
| `projection.large.paced/json.parse.nativeJsonlIngest.chars` | 100635 | 100640 |       +5 |      W      |
| `changes.poll.images/json.stringify.chars`                  |  20320 |  20328 |       +8 |      W      |
| `changes.poll.images/http.body.bytes`                       |  20320 |  20328 |       +8 |      W      |
| `web.send.poll.network/cdp.LayoutCount`                     |     15 |     16 |       +1 |      R      |
| `web.send.poll.network/cdp.RecalcStyleCount`                |    102 |    105 |       +3 |      R      |
