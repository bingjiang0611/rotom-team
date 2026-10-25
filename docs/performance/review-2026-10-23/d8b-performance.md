# D8b — 性能证据与开销

最终 worker 源码摘要：`c00a3abf5a1a40fe253b2ec698beddcbdd84129b02f9e0ed75317a1f6df7328f`。文件清单见 [JSON](d8b-performance.json)。

- 环境：darwin-arm64，Node 24.18.0，Apple M1 (8 cores)；pinned rotom 0.1.26、Pi Durable 1.0.2；仅合成账号/loopback。
- 默认关闭的 `perf:ci -- origin/main --runs 1` 已运行；其工作计数有效，但该次没有 timing lock，毫秒结论为 **unavailable**。下面 main→off 是同一 instrument 的计数比较，不冒充锁内成对计时。
- D8a→off 锁内对照：359856 ms（包括随后一轮 on），load 1.26→4.55/8，highLoad=false。
- 最终 off/on 共用上述同一把锁；测量在父环境关闭顺序及报告导出修复后完成，产品源码与最终功能验证相同。此前报告丢弃了未注册的 V8/传输计数，不能用于这部分体积证据；现导出 186 个真实观测，并由报告级负控验证。
- off/on gating 均通过，两个 CI 的 ledger guard 均通过；没有修改 workload、ledger、quiet、容差或 ceiling。每边只有 **1 次**；保留比较器 verdict，不宣称稳定速度收益。

| 对照           | worse 计数 | slower timing | 范围                                   |
| -------------- | ---------: | ------------: | -------------------------------------- |
| main→最终 off  |         39 |   unavailable | 含 A–D8a 的累积变化；只作计数比较      |
| 已核验 D8a→off |         14 |            23 | 锁内；额外状态/JSON 采样，逐项保留限制 |
| off→on         |         12 |            41 | 锁内；显式增加 RPC/序列化/启动开销     |

## 工作去了哪里

SQL 与存储 JSON 工作迁入 worker，未消失；worker 计数由 preload 回传，与父线程合并一次。真实本地/worker 对照校验 SQL、JSON、room/table 归因与 projection 调用数。缺少 preload 的负控必须失败。历史 query 的 observer 也迁入两边共用的 counter driver，不能因父线程 monkeypatch 看不见 worker 而报告假零。

首次 on 报告把转发 scope 误算为第二次 projection，已作废并保留；改用纯 AsyncLocalStorage 传播，重复计数负控再次失败。初版还在 worker 启动时加载整个公开 SDK 根导出，仅为识别 StorageRejected。现仅在 Storage 异常时动态读取这个公开 class，不用私有模块路径：启动 reads 749→29、bytes 1715449→356670。工作延后到首次 Storage 错误，并非从所有路径删除。相关 conformance/错误身份测试通过。

默认 off→最终 on 的 app-open 为 70.9→142.1 ms，app-close 为 46.9→55.1 ms。worker 启动仍有 15 次额外 reads；这是有成本的选择，不是全面提速。阻塞 worker 时父线程 setImmediate 仍完成的故障测试，只证明等待路径已分离，不等于生产延迟改善。

## 序列化、传输与关闭

V8 call/byte 计数覆盖两端；parent/worker 的 serialize/deserialize 时间分开。request/reply 字节显示复制量；分页使用转移 Buffer，每页仍有显式复制与接收拼接，且两端物化完整值。round-trip 包含分页复制、调度及 ACK，不是独立 structured-clone 计时；与 worker/encode 时间重叠，不能相加。关闭阶段来自原 startup.restart，不扩写 workload。

| scenario                 | request bytes | reply bytes | parent serialize ms | parent deserialize ms | worker serialize ms | worker deserialize ms | queue ms | round-trip ms |
| ------------------------ | ------------: | ----------: | ------------------: | --------------------: | ------------------: | --------------------: | -------: | ------------: |
| startup.restart          |         45961 |       58644 |                 0.8 |                   1.1 |                   1 |                     1 |      0.2 |         137.3 |
| turn.warm                |         81884 |       86755 |                 0.5 |                   0.4 |                 0.4 |                   0.7 |      3.1 |          20.4 |
| projection.large.paced   |        131135 |      322308 |                 1.9 |                   2.5 |                 1.8 |                   2.3 |      6.1 |          94.1 |
| session.open.native-long |          1050 |        7302 |                 0.2 |                   0.3 |                 0.2 |                   0.2 |        0 |           8.2 |

每项 worse 均列在下表。未保存原始事件体/分配栈的项目明确保留归因限制，不改 verdict，不重开已被否决的 JSONL 分批或浏览器帧边界实验。真实账号、生产并发/容量和长期延迟未测；默认保持关闭。未来若要默认开启或宣称 L2 收益，需 owner 另行批准容量/延迟验收。`journal.large` 仍是原直接 core probe，不能当作 worker 大历史时延证明；实际 worker 大历史功能由多 MiB 与 >64 MiB proof 覆盖。

## D8a→off：逐项 worse

| 指标                                            |   base |   head | 依据与限制                                                                                                                                                                                                 |
| ----------------------------------------------- | -----: | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| startup.restart/json.parse.durableStorage.calls |    458 |    459 | 本轮多一次公开 Storage JSON 解码、19 字符；没有该值的原始调用栈。默认 off 仍用原 Storage，不能将额外解码擅自解释为固定算法回归或宣称其不存在。                                                             |
| startup.restart/json.parse.durableStorage.chars |  51416 |  51435 | 本轮多一次公开 Storage JSON 解码、19 字符；没有该值的原始调用栈。默认 off 仍用原 Storage，不能将额外解码擅自解释为固定算法回归或宣称其不存在。                                                             |
| session.open/sql.statements                     |     43 |     44 | 该窗口 events 9→10、rows 92→105；异步 view/warm 完成跨窗口会改变观察的状态。数据说明多观察了一批内容，但未保留其逐条 payload，不能把每个字节差都归于 RPC。静态同数据跨开关完整 room payload 等价测试通过。 |
| session.open/sql.rows                           |     92 |    105 | 该窗口 events 9→10、rows 92→105；异步 view/warm 完成跨窗口会改变观察的状态。数据说明多观察了一批内容，但未保留其逐条 payload，不能把每个字节差都归于 RPC。静态同数据跨开关完整 room payload 等价测试通过。 |
| session.open/json.stringify.chars               |  84622 |  88107 | 该窗口 events 9→10、rows 92→105；异步 view/warm 完成跨窗口会改变观察的状态。数据说明多观察了一批内容，但未保留其逐条 payload，不能把每个字节差都归于 RPC。静态同数据跨开关完整 room payload 等价测试通过。 |
| session.open/push.events                        |      9 |     10 | 该窗口 events 9→10、rows 92→105；异步 view/warm 完成跨窗口会改变观察的状态。数据说明多观察了一批内容，但未保留其逐条 payload，不能把每个字节差都归于 RPC。静态同数据跨开关完整 room payload 等价测试通过。 |
| session.open/push.bytes                         |  82236 |  86312 | 该窗口 events 9→10、rows 92→105；异步 view/warm 完成跨窗口会改变观察的状态。数据说明多观察了一批内容，但未保留其逐条 payload，不能把每个字节差都归于 RPC。静态同数据跨开关完整 room payload 等价测试通过。 |
| turn.warm/json.parse.chars                      | 290753 | 290760 | 此项只有 JSON 字符数变化，调用次数没有同时变差。动态计时/状态字段可能改变长度，但本轮没保存原文，具体字段未归因。                                                                                          |
| turn.warm/json.stringify.chars                  |  85248 |  85250 | 此项只有 JSON 字符数变化，调用次数没有同时变差。动态计时/状态字段可能改变长度，但本轮没保存原文，具体字段未归因。                                                                                          |
| turn.paced/json.parse.chars                     | 382220 | 382223 | 此项只有 JSON 字符数变化，调用次数没有同时变差。动态计时/状态字段可能改变长度，但本轮没保存原文，具体字段未归因。                                                                                          |
| session.history.earlier/json.stringify.chars    | 243098 | 243132 | 差值是既有 head timer 17 字符的整数倍；只是与历史观察相容，本轮无对应调用栈，不写成确定根因。                                                                                                              |
| turn.prewarmed/fs.read.calls                    |     25 |     26 | 本轮 reads 25→26，另有公开 Storage parse 18→20、字符 +302。没有原始文件/JSON 调用栈，不能把历史分批观察当作当前确定根因，也不能证明这两种增量同源。                                                        |
| turn.prewarmed/json.parse.durableStorage.calls  |     18 |     20 | 本轮 reads 25→26，另有公开 Storage parse 18→20、字符 +302。没有原始文件/JSON 调用栈，不能把历史分批观察当作当前确定根因，也不能证明这两种增量同源。                                                        |
| turn.prewarmed/json.parse.durableStorage.chars  |   1122 |   1424 | 本轮 reads 25→26，另有公开 Storage parse 18→20、字符 +302。没有原始文件/JSON 调用栈，不能把历史分批观察当作当前确定根因，也不能证明这两种增量同源。                                                        |

## off→on：逐项 worse

| 指标                                        |   base |   head | 依据与限制                                                                                                                                                                                   |
| ------------------------------------------- | -----: | -----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| startup.restart/fs.read.calls               |     14 |     29 | 新 isolate 的公开 Storage/journal 模块及计数 preload 冷加载。已将仅用于 Storage 异常分类的公开 SDK 根导出延后；剩余 +15 reads / +257798 bytes 是此 instrumented 启动的实际成本。             |
| startup.restart/fs.read.bytes               |  98872 | 356670 | 新 isolate 的公开 Storage/journal 模块及计数 preload 冷加载。已将仅用于 Storage 异常分类的公开 SDK 根导出延后；剩余 +15 reads / +257798 bytes 是此 instrumented 启动的实际成本。             |
| turn.cold/push.events                       |      5 |      6 | 本轮多一个 74 字节小事件；业务推理次数断言未变。事件体未保存，不能仅按长度认定是哪一条事件。                                                                                                 |
| turn.cold/push.bytes                        |  18599 |  18673 | 本轮多一个 74 字节小事件；业务推理次数断言未变。事件体未保存，不能仅按长度认定是哪一条事件。                                                                                                 |
| git.changes/json.stringify.chars            |   2539 |   3104 | changes 返回值/序列化字节的样本差。D8b 未改 changes 查询或响应格式；未保存原始响应，不能确定具体可变字段。此项仍列作成本，不给出无证据的根因。                                               |
| web.reopen/cdp.Nodes                        |   1208 |   1232 | CDP 的布局/存活节点观测；D8b 没有 web 改动。未记录本轮分配/帧 trace，不能据一个样本归因固定 DOM 膨胀或声称已消除。                                                                           |
| web.send.stream/push.bytes                  |  91804 |  92005 | 同样业务断言下，取样窗口里的中间推送体积不同；同一持久状态的 mirror、roomInfo、roomState 在切换开关后全量相等。没有保存当时每一帧，具体中间状态/批次未归因；保留实测额外字节，不宣称零开销。 |
| web.send.stream/push.view.bytes             |  77986 |  78187 | 同样业务断言下，取样窗口里的中间推送体积不同；同一持久状态的 mirror、roomInfo、roomState 在切换开关后全量相等。没有保存当时每一帧，具体中间状态/批次未归因；保留实测额外字节，不宣称零开销。 |
| commands.discover.cold/json.stringify.chars |  33812 |  33846 | 差值是既有 head timer 17 字符的整数倍；只是与历史观察相容，本轮无对应调用栈，不写成确定根因。                                                                                                |
| projection.large.paced/json.stringify.chars | 421137 | 421699 | 同样业务断言下，取样窗口里的中间推送体积不同；同一持久状态的 mirror、roomInfo、roomState 在切换开关后全量相等。没有保存当时每一帧，具体中间状态/批次未归因；保留实测额外字节，不宣称零开销。 |
| projection.large.paced/push.bytes           | 247428 | 248028 | 同样业务断言下，取样窗口里的中间推送体积不同；同一持久状态的 mirror、roomInfo、roomState 在切换开关后全量相等。没有保存当时每一帧，具体中间状态/批次未归因；保留实测额外字节，不宣称零开销。 |
| projection.large.paced/push.view.bytes      | 206056 | 206656 | 同样业务断言下，取样窗口里的中间推送体积不同；同一持久状态的 mirror、roomInfo、roomState 在切换开关后全量相等。没有保存当时每一帧，具体中间状态/批次未归因；保留实测额外字节，不宣称零开销。 |

## main→off（累积）：逐项 worse

| 指标                                            |   base |   head | 依据与限制                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | -----: | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| startup.restart/sql.statements                  |    848 |    851 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                  |
| startup.restart/json.parse.durableStorage.calls |    458 |    459 | 本轮多一次公开 Storage JSON 解码、19 字符；没有该值的原始调用栈。默认 off 仍用原 Storage，不能将额外解码擅自解释为固定算法回归或宣称其不存在。                                                                                                                                             |
| startup.restart/json.parse.durableStorage.chars |  51416 |  51435 | 本轮多一次公开 Storage JSON 解码、19 字符；没有该值的原始调用栈。默认 off 仍用原 Storage，不能将额外解码擅自解释为固定算法回归或宣称其不存在。                                                                                                                                             |
| session.open/sql.rows                           |     94 |    105 | 该窗口 events 9→10、rows 92→105；异步 view/warm 完成跨窗口会改变观察的状态。数据说明多观察了一批内容，但未保留其逐条 payload，不能把每个字节差都归于 RPC。静态同数据跨开关完整 room payload 等价测试通过。                                                                                 |
| session.open/json.stringify.chars               |  84622 |  88107 | 该窗口 events 9→10、rows 92→105；异步 view/warm 完成跨窗口会改变观察的状态。数据说明多观察了一批内容，但未保留其逐条 payload，不能把每个字节差都归于 RPC。静态同数据跨开关完整 room payload 等价测试通过。                                                                                 |
| session.open/push.events                        |      9 |     10 | 该窗口 events 9→10、rows 92→105；异步 view/warm 完成跨窗口会改变观察的状态。数据说明多观察了一批内容，但未保留其逐条 payload，不能把每个字节差都归于 RPC。静态同数据跨开关完整 room payload 等价测试通过。                                                                                 |
| session.open/push.bytes                         |  82236 |  86312 | 该窗口 events 9→10、rows 92→105；异步 view/warm 完成跨窗口会改变观察的状态。数据说明多观察了一批内容，但未保留其逐条 payload，不能把每个字节差都归于 RPC。静态同数据跨开关完整 room payload 等价测试通过。                                                                                 |
| web.open/push.events                            |     10 |     11 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.open/push.bytes                             |  83736 |  83964 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.open/push.view.bytes                        |  76309 |  76333 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.open/http.requests                          |     81 |     82 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：main比较81→82，D6新增native.css的一次请求；相对旧D8a五轮最差值82没有变差。                                                                                                                                                                  |
| web.open/cdp.Nodes                              |    996 |   1138 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1114→1114；另有节点分配/回收取样，不等于持久 DOM 或泄漏。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。     |
| web.open/web.event.parse.calls                  |      9 |     10 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.open/web.event.parse.chars                  |  82941 |  83141 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| session.history.earlier/json.stringify.chars    | 243098 | 243132 | 差值是既有 head timer 17 字符的整数倍；只是与历史观察相容，本轮无对应调用栈，不写成确定根因。                                                                                                                                                                                              |
| web.open.long/push.view.bytes                   | 165859 | 165883 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.open.long/http.requests                     |     80 |     81 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：D6 新增 native.css 一请求；步骤② web.open 在拆 CSS 前也曾 81→83，不能将 main 全部增量归到 CSS。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                  |
| web.open.long/cdp.Nodes                         |   1561 |   1703 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1703→1703；另有节点分配/回收取样，不等于持久 DOM 或泄漏。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。     |
| web.open.long/web.event.parse.calls             |      8 |      9 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.open.long/web.event.parse.chars             | 173290 | 173492 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| native.warm/sql.rows                            |     10 |     11 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                  |
| turn.prewarmed/fs.read.calls                    |     25 |     26 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：本轮再现旧D8a已有的26 reads、20 parses/1424chars组合，并非本轮首次出现。旧诊断观测NativeTail分批读取及151字符native-mirror metadata；本轮未保存对应调用栈，不能把分批/重复metadata假设写成确定根因。采样差异，未归因。                      |
| turn.prewarmed/json.parse.durableStorage.calls  |     18 |     20 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：本轮再现旧D8a已有的26 reads、20 parses/1424chars组合，并非本轮首次出现。旧诊断观测NativeTail分批读取及151字符native-mirror metadata；本轮未保存对应调用栈，不能把分批/重复metadata假设写成确定根因。采样差异，未归因。                      |
| turn.prewarmed/json.parse.durableStorage.chars  |   1122 |   1424 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：本轮再现旧D8a已有的26 reads、20 parses/1424chars组合，并非本轮首次出现。旧诊断观测NativeTail分批读取及151字符native-mirror metadata；本轮未保存对应调用栈，不能把分批/重复metadata假设写成确定根因。采样差异，未归因。                      |
| web.reopen/push.events                          |      9 |     10 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.reopen/push.bytes                           |  10313 |  10541 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.reopen/push.view.bytes                      |   2001 |   2025 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.reopen/cdp.Nodes                            |   1090 |   1208 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1208→1232；另有节点分配/回收取样，不等于持久 DOM 或泄漏。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。     |
| web.reopen/web.event.parse.calls                |      8 |      9 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.reopen/web.event.parse.chars                |   9527 |   9727 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                      |
| web.paced/cdp.Nodes                             |   1296 |   1423 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1424→1421；另有节点分配/回收取样，不等于持久 DOM 或泄漏。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。     |
| web.send.poll/cdp.Nodes                         |   1472 |   1594 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1603→1620；另有节点分配/回收取样，不等于持久 DOM 或泄漏。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。     |
| web.send.stream/push.bytes                      |  91492 |  91804 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 包装；D6 隔离本次数据长度增量未精确归因，未保存正文。同一最终代码两轮 91603→91603；保留差值，不把源码等价当作零成本。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。 |
| web.send.stream/push.view.bytes                 |  77698 |  77986 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 包装；D6 隔离本次数据长度增量未精确归因，未保存正文。同一最终代码两轮 77785→77785；保留差值，不把源码等价当作零成本。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。 |
| web.send.stream/cdp.RecalcStyleCount            |    101 |    108 | CDP 的布局/存活节点观测；D8b 没有 web 改动。未记录本轮分配/帧 trace，不能据一个样本归因固定 DOM 膨胀或声称已消除。                                                                                                                                                                         |
| web.send.stream/cdp.Nodes                       |   1510 |   1628 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1579→1654；另有节点分配/回收取样，不等于持久 DOM 或泄漏。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。     |
| web.send.stream/web.event.parse.chars           |  30133 |  30445 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：main 含 D5 包装；D6 隔离本次数据长度增量未精确归因，未保存正文。同一最终代码两轮 30445→30445；保留差值，不把源码等价当作零成本。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。 |
| assets.first/http.requests                      |     53 |     54 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：新增 native.css，首次与条件请求都各 +1；条件响应正文仍为 0。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                                     |
| assets.validated/http.requests                  |     53 |     54 | 沿用已核验 D8a 的历史说明（不是本轮重新归因）：既有成本/采样来源（历史说明）：既有D6记录：新增 native.css，首次与条件请求都各 +1；条件响应正文仍为 0。 本次D8五轮隔离比较未判worse。 本轮没有新增该路径的逐字段trace。                                                                     |
