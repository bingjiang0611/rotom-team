# D8a — 第 11 轮提交的既有性能证据

本记录整理已有结果，未新增实验或重跑。采用 HANDOFF 第 11 轮口径：测试与 gating/guard 通过，
逐条说明候选差异；多轮不能稳定复现的采样差异保留“未归因”，不以零差异为提交前提。
D8a 提交供核验，不代表已核验；D8b 等待审查。

## 证据范围

- [机器可读证据](d8-performance-evidence.json)保留两组全部 worse 数值、五轮样本及33项main单轮slower，另附三项诊断摘要。
- 隔离比较：原测量基线`0785f51` → `93dbc7c`加最终产品改动，每侧5轮；25 worse /0 slower。
- main比较：`e649d9d8a0ff`，每侧1轮；52 worse /33 slower；`perf:ci -- origin/main --runs 1`的check/guard通过。
  包含A–D7，不能全部归因D8a；单轮毫秒值不作稳定回归或速度收益结论。
- rebase后测量基线为`4e8571a`、产品改动父提交为`28dd658`；`c6947a8`只改HANDOFF。
  备份逐字节比较确认恢复的产品/test文件（含新测试）不变；原始日志哈希不重写。
- 原始报告与日志在`/tmp/rotom-review-D8/`；此JSON是选取的计数/时间线证据，不冒充完整原始报告。
- 具体功能、负控、670/670全量结果及诊断限制见[D8验证记录](d8-validation.md)。

## D8a 隔离比较：全部25项

warm 的计数确实增加，并非计数器不准确。extra view 的查询/解析/发送是可定位的真实工作；
未稳定复现的是导致额外中间状态的时序。三view受控对照表明当前实现没有增加该状态组的工作。
原慢样本缺少字段时间线，不能将其全部延迟追溯认定为同一原因；没有延迟或抑制合法状态。

| 计数器                                         | 基线最差值 | 当前最差值 | 来源及限定                                                                                                                                                                                                       |
| ---------------------------------------------- | ---------: | ---------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| turn.warm/sql.statements                       |        158 |        168 | 额外两次 view 触发 room/kernel 的读查询；同为三次 view 的受控样本 statements 173→159。                                                                                                                           |
| turn.warm/sql.rows                             |        112 |        127 | 额外 view 读取当时的 session/receipt 行；同为三次 view 的受控样本 rows 131→119。                                                                                                                                 |
| turn.warm/json.parse.calls                     |        140 |        156 | 额外投影解码 journal/状态；同为三次 view 的受控样本总 parse 153→151。                                                                                                                                            |
| turn.warm/json.parse.chars                     |     291842 |     343670 | 额外投影解码当时的状态正文；随可见中间状态增加，不能用总字符数推断单次读取变贵。                                                                                                                                 |
| turn.warm/json.parse.journal.calls             |         32 |         41 | 额外 kernel 投影需要解码 session/receipt；保留原 journal/thinking 归因，不以移出 span 获益。                                                                                                                     |
| turn.warm/json.parse.journal.chars             |      22924 |      27792 | 额外 kernel 投影解码 session/receipt 正文；receipt 相同 ID 时已合并读取。                                                                                                                                        |
| turn.warm/json.stringify.chars                 |      85250 |      89122 | 额外状态和 push 序列化正文；状态长度也随阶段变化，原慢样本未留完整字段正文。                                                                                                                                     |
| turn.warm/view.entry.visits                    |          8 |         15 | 额外 view 再访问当时的 entry 集合；中间状态的条目数不同。                                                                                                                                                        |
| turn.warm/view.stats.entry.scans               |          8 |         15 | 额外 view 重新扫描统计 entry 集合；未通过延迟合法状态来减少扫描。                                                                                                                                                |
| turn.warm/view.fields.stringify.calls          |         24 |         48 | 投影从两次变四次，每次字段序列化次数不变：24→48。                                                                                                                                                                |
| turn.warm/view.fields.stringify.chars          |        279 |        558 | 字段按额外投影序列化；隔离比较 279→558，main 的额外差值受字段值影响。                                                                                                                                            |
| turn.warm/view.live.project.calls              |          2 |          4 | view 两次→四次，每次执行一次 live 投影。                                                                                                                                                                         |
| turn.warm/view.inbox.project.calls             |          2 |          4 | view 两次→四次，每次执行一次 inbox 投影。                                                                                                                                                                        |
| turn.warm/view.kernel.project.calls            |          2 |          4 | view 两次→四次，每次执行一次 kernel 投影。                                                                                                                                                                       |
| turn.warm/view.kernel.sql.heads                |          2 |          4 | 额外 kernel 投影各读一次 head：2→4。                                                                                                                                                                             |
| turn.warm/view.kernel.sql.attempts             |          4 |          8 | 额外 kernel 投影各读 pending/latest：4→8。                                                                                                                                                                       |
| turn.warm/view.kernel.sql.command_inputs       |          3 |          4 | 额外 pending/latest receipt 的输入读取；同 ID 已复用，是否有 pending 随阶段变化。                                                                                                                                |
| turn.warm/push.events                          |          3 |          5 | 额外 view 增加发送事件；main 单轮还含其他状态事件，不能把所有差值归为重复 view。                                                                                                                                 |
| turn.warm/push.bytes                           |      13102 |      15621 | 额外 view/状态事件增加正文；随中间状态内容变化。                                                                                                                                                                 |
| turn.warm/push.view.count                      |          2 |          4 | 慢阶段暴露更多中间 view。双方受控样本均出现；原 244.8 ms 的具体延迟来源为采样差异，未归因。                                                                                                                      |
| turn.warm/push.view.bytes                      |       8656 |      11175 | 额外中间 view 增加正文；相同三次语义状态组双方均为 10202 bytes，不等于逐字段等价。                                                                                                                               |
| turn.prewarmed/fs.read.calls                   |         25 |         26 | 来源是父线程 readSync。六次诊断均为 21 次资源文件、1 次 204-byte 文件、2 次 NativeTail 增量、1 次尾部校验。原第3轮多一次但总字节同为242540；原调用栈缺失。分批读取是候选解释，不是已证明根因；采样差异，未归因。 |
| turn.prewarmed/json.parse.durableStorage.calls |         18 |         20 | 来源是公开 Durable Storage 解析；六次诊断均18次，包含两份native-mirror metadata。原第3轮多2次，和额外metadata读取相容但原正文/调用栈未留存；采样差异，未归因，不宣称已证明重复镜像。                             |
| turn.prewarmed/json.parse.durableStorage.chars |       1122 |       1424 | 原第3轮增加302字符；诊断所见native-mirror metadata每份151字符，2×151仅是候选解释。六次均1122字符，未复现1424；采样差异，未归因。                                                                                 |
| web.send.poll/cdp.LayoutCount                  |         18 |         19 | 原18→19；六次带frame过滤的trace均18且与CDP一致，无超时/截断。原19次无trace；采样差异，未归因。                                                                                                                   |

## 对 main：全部52项

此表保留跨A–D7的历史成本；既有解释引用[D6完整记录](d6-validation.md)。历史解释不是本次新增测量。
未归因项不伪装成已确认根因，也不清除原差值。

| 计数器                                   |   main |   当前 | 来源及限定                                                                                                                                                                 |
| ---------------------------------------- | -----: | -----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| startup.restart/sql.statements           |    848 |    851 | 既有D6记录：main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。 本次D8五轮隔离比较未判worse。                                  |
| turn.warm/sql.statements                 |    157 |    169 | 额外两次 view 触发 room/kernel 的读查询；同为三次 view 的受控样本 statements 173→159。                                                                                     |
| turn.warm/sql.rows                       |    116 |    141 | 额外 view 读取当时的 session/receipt 行；同为三次 view 的受控样本 rows 131→119。                                                                                           |
| turn.warm/json.parse.calls               |    147 |    156 | 额外投影解码 journal/状态；同为三次 view 的受控样本总 parse 153→151。                                                                                                      |
| turn.warm/json.parse.chars               | 338695 | 343677 | 额外投影解码当时的状态正文；随可见中间状态增加，不能用总字符数推断单次读取变贵。                                                                                           |
| turn.warm/json.parse.journal.calls       |     32 |     41 | 额外 kernel 投影需要解码 session/receipt；保留原 journal/thinking 归因，不以移出 span 获益。                                                                               |
| turn.warm/json.parse.journal.chars       |  22923 |  27793 | 额外 kernel 投影解码 session/receipt 正文；receipt 相同 ID 时已合并读取。                                                                                                  |
| turn.warm/json.stringify.chars           |  85248 |  93866 | 额外状态和 push 序列化正文；状态长度也随阶段变化，原慢样本未留完整字段正文。                                                                                               |
| turn.warm/view.entry.visits              |      8 |     15 | 额外 view 再访问当时的 entry 集合；中间状态的条目数不同。                                                                                                                  |
| turn.warm/view.stats.entry.scans         |      8 |     15 | 额外 view 重新扫描统计 entry 集合；未通过延迟合法状态来减少扫描。                                                                                                          |
| turn.warm/view.fields.stringify.calls    |     24 |     48 | 投影从两次变四次，每次字段序列化次数不变：24→48。                                                                                                                          |
| turn.warm/view.fields.stringify.chars    |    279 |    603 | 字段按额外投影序列化；隔离比较 279→558，main 的额外差值受字段值影响。                                                                                                      |
| turn.warm/view.live.project.calls        |      2 |      4 | view 两次→四次，每次执行一次 live 投影。                                                                                                                                   |
| turn.warm/view.inbox.project.calls       |      2 |      4 | view 两次→四次，每次执行一次 inbox 投影。                                                                                                                                  |
| turn.warm/view.kernel.project.calls      |      2 |      4 | view 两次→四次，每次执行一次 kernel 投影。                                                                                                                                 |
| turn.warm/view.kernel.sql.heads          |      2 |      4 | 额外 kernel 投影各读一次 head：2→4。                                                                                                                                       |
| turn.warm/view.kernel.sql.attempts       |      4 |      8 | 额外 kernel 投影各读 pending/latest：4→8。                                                                                                                                 |
| turn.warm/view.kernel.sql.command_inputs |      3 |      4 | 额外 pending/latest receipt 的输入读取；同 ID 已复用，是否有 pending 随阶段变化。                                                                                          |
| turn.warm/push.events                    |      3 |      6 | 额外 view 增加发送事件；main 单轮还含其他状态事件，不能把所有差值归为重复 view。                                                                                           |
| turn.warm/push.bytes                     |  13102 |  20342 | 额外 view/状态事件增加正文；随中间状态内容变化。                                                                                                                           |
| turn.warm/push.view.count                |      2 |      4 | 慢阶段暴露更多中间 view。双方受控样本均出现；原 244.8 ms 的具体延迟来源为采样差异，未归因。                                                                                |
| turn.warm/push.view.bytes                |   8656 |  11451 | 额外中间 view 增加正文；相同三次语义状态组双方均为 10202 bytes，不等于逐字段等价。                                                                                         |
| git.changes/json.stringify.chars         |   2539 |   3108 | 既有D6记录：同一最终代码两轮 3105→3106；只有序列化字符数差异；未改相应路径/调用顺序，未留正文，字段级来源 unknown。 本次D8五轮隔离比较未判worse。                          |
| web.open/push.events                     |     10 |     11 | 既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。                                                      |
| web.open/push.bytes                      |  83736 |  83964 | 既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。                                                      |
| web.open/push.view.bytes                 |  76309 |  76333 | 既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。                                                      |
| web.open/cdp.Nodes                       |    972 |   1138 | 既有D6记录：main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1114→1114；另有节点分配/回收取样，不等于持久 DOM 或泄漏。 本次D8五轮隔离比较未判worse。     |
| web.open/web.event.parse.calls           |      9 |     10 | 既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。                                                      |
| web.open/web.event.parse.chars           |  82941 |  83141 | 既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。                                                      |
| web.open.long/push.view.bytes            | 165859 | 165883 | 既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。                                                      |
| web.open.long/http.requests              |     80 |     81 | 既有D6记录：D6 新增 native.css 一请求；步骤② web.open 在拆 CSS 前也曾 81→83，不能将 main 全部增量归到 CSS。 本次D8五轮隔离比较未判worse。                                  |
| web.open.long/cdp.Nodes                  |   1585 |   1703 | 既有D6记录：main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1703→1703；另有节点分配/回收取样，不等于持久 DOM 或泄漏。 本次D8五轮隔离比较未判worse。     |
| web.open.long/web.event.parse.calls      |      8 |      9 | 既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。                                                      |
| web.open.long/web.event.parse.chars      | 173290 | 173492 | 既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。                                                      |
| native.warm/sql.rows                     |     10 |     11 | 既有D6记录：main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。 本次D8五轮隔离比较未判worse。                                  |
| web.reopen/push.events                   |      9 |     10 | 既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。                                                      |
| web.reopen/push.bytes                    |  10313 |  10541 | 既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。                                                      |
| web.reopen/push.view.bytes               |   2001 |   2025 | 既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。                                                      |
| web.reopen/cdp.Nodes                     |   1090 |   1232 | 既有D6记录：main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1208→1232；另有节点分配/回收取样，不等于持久 DOM 或泄漏。 本次D8五轮隔离比较未判worse。     |
| web.reopen/web.event.parse.calls         |      8 |      9 | 既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。                                                      |
| web.reopen/web.event.parse.chars         |   9527 |   9727 | 既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。                                                      |
| web.paced/cdp.Nodes                      |   1294 |   1412 | 既有D6记录：main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1424→1421；另有节点分配/回收取样，不等于持久 DOM 或泄漏。 本次D8五轮隔离比较未判worse。     |
| web.send.poll/cdp.Nodes                  |   1481 |   1614 | 既有D6记录：main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1603→1620；另有节点分配/回收取样，不等于持久 DOM 或泄漏。 本次D8五轮隔离比较未判worse。     |
| web.send.stream/push.bytes               |  91291 |  91804 | 既有D6记录：main 含 D5 包装；D6 隔离本次数据长度增量未精确归因，未保存正文。同一最终代码两轮 91603→91603；保留差值，不把源码等价当作零成本。 本次D8五轮隔离比较未判worse。 |
| web.send.stream/push.view.bytes          |  77497 |  77986 | 既有D6记录：main 含 D5 包装；D6 隔离本次数据长度增量未精确归因，未保存正文。同一最终代码两轮 77785→77785；保留差值，不把源码等价当作零成本。 本次D8五轮隔离比较未判worse。 |
| web.send.stream/cdp.Nodes                |   1492 |   1628 | 既有D6记录：main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1579→1654；另有节点分配/回收取样，不等于持久 DOM 或泄漏。 本次D8五轮隔离比较未判worse。     |
| web.send.stream/web.event.parse.chars    |  30133 |  30445 | 既有D6记录：main 含 D5 包装；D6 隔离本次数据长度增量未精确归因，未保存正文。同一最终代码两轮 30445→30445；保留差值，不把源码等价当作零成本。 本次D8五轮隔离比较未判worse。 |
| projection.large.paced/push.bytes        | 245028 | 250628 | 既有D6记录：同一最终代码两轮 246628→254628；RPC/SQL/view 次数相同但字节量不同。无正文 trace，无法精确字段归因；不声称性能等价。 本次D8五轮隔离比较未判worse。              |
| projection.large.paced/push.view.bytes   | 203656 | 209256 | 既有D6记录：同一最终代码两轮 205256→213256；RPC/SQL/view 次数相同但字节量不同。无正文 trace，无法精确字段归因；不声称性能等价。 本次D8五轮隔离比较未判worse。              |
| changes.poll.images/json.stringify.chars |  20346 |  20396 | 已有3秒head timer的34字符来源探针；响应还包含size:mtimeMs长度变化。不能精确拆解此次+50，保留字段级未归因；D8五轮隔离未判worse。                                            |
| assets.first/http.requests               |     53 |     54 | 既有D6记录：新增 native.css，首次与条件请求都各 +1；条件响应正文仍为 0。 本次D8五轮隔离比较未判worse。                                                                     |
| assets.validated/http.requests           |     53 |     54 | 既有D6记录：新增 native.css，首次与条件请求都各 +1；条件响应正文仍为 0。 本次D8五轮隔离比较未判worse。                                                                     |

## 三项诊断结论

1. 自然warm五对：10/10均2views，未复现慢样本。
2. 状态屏障三对：双方都出现长等待和额外view；相同三view时SQL173→159、rows131→119、parse153→151，view bytes均10202。原244.8ms样本没有相应时间戳。
3. prewarmed/Layout三对：六轮均25reads、18parses/1122chars、目标frame18次Layout；原额外read/parse/Layout未复现，标记采样差异、未归因。

22个fixture均exit0，三次highLoad=false；受控模型屏障、trace和截短流程只用于诊断。
不增加第四项实验，不执行建议过的JSONL分批或帧边界对照。按第11轮提交待核验，D8b不开始。
