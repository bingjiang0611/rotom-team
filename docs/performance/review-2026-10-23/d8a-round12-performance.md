# D8a 第12轮 — 最终性能逐项记录

最终版本运行 `perf:ci -- origin/main --runs 1`，gating/guard通过；243298 ms，load 2.58→5 /8，highLoad=false。
main：34 worse /17 slower；旧D8a五轮→当前单轮：4 worse /5 slower。保留比较器原 verdict，单个head样本不作稳定延迟归因或速度收益结论。

[机器可读记录](d8a-round12-performance.json)保留所有候选值、解释与timing verdict；[修复审计](d8a-round12-validation.md)列出677/677验证。

首次版本的main CI为40 worse，highLoad=true；其后代码修正了授权后的存储等待，再对新版本验证。不是为去除候选或高负载重跑。
没有新增JSONL/帧边界实验，没有修改测量实现、ledger、容差或workload。原始报告在`/tmp/rotom-review-D8-round12/{ci-main,final-ci-main}/`。

新增reserve事务每次+2 SQL；删除授权后重复receipt读取会省去receipt及command-input的2次查询。普通有gate的路径可能相抵；
discovery没有inference gate，净+2明确保留。权限/lifecycle依据是active latch在finish/fail之前清除，不是为了计数省掉必要检查。

## 既有五轮D8a → 最终单轮：4项

使用既有`final-head5.json`，不是本轮同时间交错对照。

| 计数器                                |  基线 |  当前 | 来源与限定                                                                                                                                          |
| ------------------------------------- | ----: | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| web.send.stream/push.bytes            | 91804 | 92005 | 两项同增201 bytes，来源是view正文而非额外非view事件。中间状态正文受推送时序影响，具体字段未留trace；采样差异，未归因，不抑制合法状态。              |
| web.send.stream/push.view.bytes       | 77986 | 78187 | 两项同增201 bytes，来源是view正文而非额外非view事件。中间状态正文受推送时序影响，具体字段未留trace；采样差异，未归因，不抑制合法状态。              |
| commands.discover.cold/sql.statements |    87 |    89 | reserve新增BEGIN IMMEDIATE/COMMIT，恰+2；discovery没有inference gate，不能被删除的授权后重复receipt读取抵消。正确性所需成本，未改workload或ledger。 |
| commands.discover.warm/sql.statements |    79 |    81 | reserve新增BEGIN IMMEDIATE/COMMIT，恰+2；discovery没有inference gate，不能被删除的授权后重复receipt读取抵消。正确性所需成本，未改workload或ledger。 |

## origin/main → 最终单轮：34项

包含A–D7及先前D8a成本；历史来源见[先前记录](d8-performance-review.md)，不当作本轮新trace。

| 计数器                                         |   基线 |   当前 | 来源与限定                                                                                                                                                                                                                                  |
| ---------------------------------------------- | -----: | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| startup.restart/sql.statements                 |    848 |    851 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                  |
| web.open/push.events                           |     10 |     11 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.open/push.bytes                            |  83736 |  83964 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.open/push.view.bytes                       |  76309 |  76333 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.open/http.requests                         |     81 |     82 | main比较81→82，D6新增native.css的一次请求；相对旧D8a五轮最差值82没有变差。                                                                                                                                                                  |
| web.open/cdp.Nodes                             |    996 |   1138 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1114→1114；另有节点分配/回收取样，不等于持久 DOM 或泄漏。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。     |
| web.open/web.event.parse.calls                 |      9 |     10 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.open/web.event.parse.chars                 |  82941 |  83141 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.open.long/push.view.bytes                  | 165859 | 165883 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.open.long/http.requests                    |     80 |     81 | 既有成本/采样来源（历史说明）：既有D6记录：D6 新增 native.css 一请求；步骤② web.open 在拆 CSS 前也曾 81→83，不能将 main 全部增量归到 CSS。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                  |
| web.open.long/cdp.Nodes                        |   1585 |   1703 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1703→1703；另有节点分配/回收取样，不等于持久 DOM 或泄漏。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。     |
| web.open.long/web.event.parse.calls            |      8 |      9 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.open.long/web.event.parse.chars            | 173290 | 173492 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| native.warm/sql.rows                           |     10 |     11 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                  |
| turn.prewarmed/fs.read.calls                   |     25 |     26 | 本轮再现旧D8a已有的26 reads、20 parses/1424chars组合，并非本轮首次出现。旧诊断观测NativeTail分批读取及151字符native-mirror metadata；本轮未保存对应调用栈，不能把分批/重复metadata假设写成确定根因。采样差异，未归因。                      |
| turn.prewarmed/json.parse.durableStorage.calls |     18 |     20 | 本轮再现旧D8a已有的26 reads、20 parses/1424chars组合，并非本轮首次出现。旧诊断观测NativeTail分批读取及151字符native-mirror metadata；本轮未保存对应调用栈，不能把分批/重复metadata假设写成确定根因。采样差异，未归因。                      |
| turn.prewarmed/json.parse.durableStorage.chars |   1122 |   1424 | 本轮再现旧D8a已有的26 reads、20 parses/1424chars组合，并非本轮首次出现。旧诊断观测NativeTail分批读取及151字符native-mirror metadata；本轮未保存对应调用栈，不能把分批/重复metadata假设写成确定根因。采样差异，未归因。                      |
| native.validate/json.stringify.chars           |    617 |    685 | +68，和已确认的Room head timer四次17字符序列化相符；validator未改变，当前没有逐字段trace，不把全部差值伪装成新的固定validator开销。                                                                                                         |
| web.reopen/push.events                         |      9 |     10 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.reopen/push.bytes                          |  10313 |  10541 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.reopen/push.view.bytes                     |   2001 |   2025 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.reopen/cdp.Nodes                           |   1090 |   1232 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1208→1232；另有节点分配/回收取样，不等于持久 DOM 或泄漏。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。     |
| web.reopen/web.event.parse.calls               |      8 |      9 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.reopen/web.event.parse.chars               |   9527 |   9727 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.paced/cdp.Nodes                            |   1284 |   1422 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1424→1421；另有节点分配/回收取样，不等于持久 DOM 或泄漏。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。     |
| web.send.poll/cdp.Nodes                        |   1451 |   1597 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1603→1620；另有节点分配/回收取样，不等于持久 DOM 或泄漏。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。     |
| web.send.stream/push.bytes                     |  91291 |  92005 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 包装；D6 隔离本次数据长度增量未精确归因，未保存正文。同一最终代码两轮 91603→91603；保留差值，不把源码等价当作零成本。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。 |
| web.send.stream/push.view.bytes                |  77497 |  78187 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 包装；D6 隔离本次数据长度增量未精确归因，未保存正文。同一最终代码两轮 77785→77785；保留差值，不把源码等价当作零成本。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。 |
| web.send.stream/cdp.Nodes                      |   1492 |   1633 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1579→1654；另有节点分配/回收取样，不等于持久 DOM 或泄漏。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。     |
| web.send.stream/web.event.parse.chars          |  30133 |  30445 | 既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 包装；D6 隔离本次数据长度增量未精确归因，未保存正文。同一最终代码两轮 30445→30445；保留差值，不把源码等价当作零成本。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。 |
| projection.large.paced/push.bytes              | 245828 | 246628 | 既有成本/采样来源（历史说明）：既有D6记录：同一最终代码两轮 246628→254628；RPC/SQL/view 次数相同但字节量不同。无正文 trace，无法精确字段归因；不声称性能等价。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。              |
| projection.large.paced/push.view.bytes         | 204456 | 205256 | 既有成本/采样来源（历史说明）：既有D6记录：同一最终代码两轮 205256→213256；RPC/SQL/view 次数相同但字节量不同。无正文 trace，无法精确字段归因；不声称性能等价。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。              |
| assets.first/http.requests                     |     53 |     54 | 既有成本/采样来源（历史说明）：既有D6记录：新增 native.css，首次与条件请求都各 +1；条件响应正文仍为 0。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                                     |
| assets.validated/http.requests                 |     53 |     54 | 既有成本/采样来源（历史说明）：既有D6记录：新增 native.css，首次与条件请求都各 +1；条件响应正文仍为 0。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                                     |
