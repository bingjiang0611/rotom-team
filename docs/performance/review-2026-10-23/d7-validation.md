# D7 — public-history seed worker：验证与取舍

## 范围与版本

D6 审查通过后从 `7671c97` 开始。测量 `9e6412d`；同步文件阶段提取 `da1068c`；
固定 session-data loader 提取 `d71fd8d`；benchmark-only copy/closure 探针 `fa269fc`；
行为实现和测试 `acb36e5`。没有合并 main、改 ledger/schema/vendor/pin，也未部署、重启或做 D8/D9/C1。

Node v24.18.0、darwin-arm64、Apple M1 / 8 核、pinned rotom 0.1.26。
原始证据在 `/tmp/rotom-review-D7/`。CI 测量的 `fa269fca2733-dirty` 产品差分正是
随后提交的 `acb36e5`；`implementation.patch` 保存了实现差分。之后只有交接文档和一处澄清 SDK 依赖的源码注释。
本项目标是**降低 materialization 对父线程的阻塞**，不是缩短交接总耗时。
**owner 批准的一次默认全量重跑已通过：637/637，0 fail/skip。提交审查，不代表 D7 已核验通过。**

## 实现与所有权

- `RotomExecutions.#seed` 是 handoff、公用历史 fork/import 的共同边界。父线程保留授权、公开历史
  projection、receipt reservation、唯一 journal writer、最终授权和 finish。
- `rotom-executions/seed-files.ts` 先独立同步提取原阶段；目录 canonical/private 检查、0600 文件、
  文件/目录 fsync、原生 readback 与两个完整 stringify 的比较不变，没有流式截断或摘要替代。
- `seed.ts` 每个 materializing 执行拥有一个短生命周期 worker；`seed-worker.ts` 先准备目标，
  父线程 durable attach 后才发送 ACK/公开消息，worker 才能 append。结果必须等 exit 后才兑现；
  `#track` 在此之前不释放，close 仍拒绝 active execution。
- Stop 终止并 join worker。材料化开始后的 worker 错误、缺少完成结果、读回失败、停止或最终撤权保持
  unknown，绝不重放。空历史仍不建文件/worker。没有常驻池、独立队列、跨付费人共享或去重。
- 复用 `rotom-product.nativeSessionDataApi` 的原有 pin、resolver、canonical 检查，只加载固定
  session-data 模块；worker 不启动 agent、不解析个人凭据、不调用模型。原 `nativeSessionManager`
  的调用方与返回 API 保留。固定 SDK 的 session-manager 自身仍传递导入 pi-ai；这里省去的是完整
  process client 及其额外导入，不宣称完全不加载模型库或启动零成本。
- 第一版 worker 从完整 kernel 客户端导入，1 MiB 达 414–460 ms；证据保留在
  `head-heavy-bootstrap.{log,json}`。把不需要的 process/model 入口留在父层后采用最终方案。
  不通过小历史同步快路、常驻池或降低持久化要求掩盖启动成本。

## 专项测量：主线程停顿下降，总耗时和 RSS 增加

`base.{log,json}` 与 `head.{log,json}` 是主比较。每个大小独立子进程；64 条公开合成历史，
同一 payer 连续三次真实 handoff，**不是三个独立重复实验**。每次均确认新 segment 64 条、
共享枚举仍 64 条，再做真实 native open/warm；最后 warm 后做一轮 loopback 合成推理。
跨成员的 private HOME/public-only/usage 约束由专项测试覆盖，不把这个单 payer 基准当成多成员容量测试。
无真实模型账号；100 MiB 合成上下文不代表生产模型允许的上下文大小。

主比较计时锁均 highLoad=false：base 4.27→7.06/8 核、34.8 s；head 3.11→2.96/8 核、36.7 s。
初版 RSS 采样位置在额外 open/warm 之后，已在实施前修正；旧
`base-pre-rss-scope-fix.log` 不作验收证据。

以下三值按第 1/2/3 次交接排列，四舍五入到 ms/MiB；不把这些值叫 p95。
RSS 是整个父进程（含 worker 线程）截至该次返回的历史 peak，**不是单线程内存或每次独立 peak**，
也不包含原生推理子进程；先前的 open/warm 可影响后续 peak。JSON 另保留 before/after、
1 ms sampled peak 和 process peak before，不能把轮询未采到的同步峰值算作零。

| MiB | handoff ms（前→后）           | 最大 timer lag ms（前→后） | 进程累计 peak RSS MiB（前→后） |
| --- | ----------------------------- | -------------------------- | ------------------------------ |
| 1   | 40/56/60→301/286/276          | 22/21/24→5/7/8             | 217/262/263→266/299/299        |
| 10  | 139/162/157→445/437/426       | 122/114/118→46/49/43       | 311/363/402→377/437/441        |
| 100 | 1084/1110/1092→1362/1388/1380 | 1047/990/971→412/476/480   | 1139/1218/1335→1431/1523/1626  |

100 MiB 的剩余 0.4–0.5 s 卡顿主要仍含父线程同步 finish；projection 也未搬走。D7 不解决 D8。
1 MiB 的 worker 启动税非常明显，不能把 off-main 工作算作消失或宣称所有交互都更快。
没有全局 worker 内存 admission cap；每个既有 materializing 执行最多一个。多房间同时交接
100 MiB 的容量/峰值未验证，不能把顺序样本外推为并发容量承诺。

### 阶段

`persist` 包含 chmod、文件和目录 fsync；`projection` 含 journal 读取和公开历史投影。
表中不含接近零的两次授权；原始 JSON 均有。耗时是测量证据，不是 API SLA。

| MiB | 阶段       | main 基线 ms | worker 实现 ms | 实现线程 |
| --- | ---------- | ------------ | -------------- | -------- |
| 1   | projection | 1/1/1        | 1/1/1          | main     |
| 1   | prepare    | 1/0/0        | 1/1/1          | worker   |
| 1   | attach     | 0/0/0        | 1/0/0          | main     |
| 1   | append     | 6/6/8        | 9/17/7         | worker   |
| 1   | persist    | 5/8/5        | 10/9/6         | worker   |
| 1   | readback   | 2/2/1        | 2/2/2          | worker   |
| 1   | compare    | 2/2/2        | 2/2/2          | worker   |
| 1   | finish     | 4/4/8        | 5/7/8          | main     |
| 10  | projection | 9/9/9        | 9/9/9          | main     |
| 10  | prepare    | 1/0/0        | 1/1/1          | worker   |
| 10  | attach     | 0/0/0        | 0/0/0          | main     |
| 10  | append     | 18/19/24     | 22/21/21       | worker   |
| 10  | persist    | 6/10/8       | 6/9/10         | worker   |
| 10  | readback   | 15/14/14     | 17/16/20       | worker   |
| 10  | compare    | 24/19/18     | 21/20/19       | worker   |
| 10  | finish     | 48/51/54     | 46/45/43       | main     |
| 100 | projection | 78/79/78     | 77/80/81       | main     |
| 100 | prepare    | 1/0/0        | 1/1/1          | worker   |
| 100 | attach     | 0/0/0        | 0/0/0          | main     |
| 100 | append     | 143/141/134  | 139/137/135    | worker   |
| 100 | persist    | 10/13/5      | 8/8/6          | worker   |
| 100 | readback   | 153/151/133  | 161/138/137    | worker   |
| 100 | compare    | 220/183/173  | 230/215/197    | worker   |
| 100 | finish     | 441/499/526  | 391/455/462    | main     |

### 实际 worker 复制与退出

`head-transfer.{log,json}` 是相同产品代码的补充诊断，不替换上面的无 preload 主比较。
独立测量提交中的 `handoff-worker-probe.mjs` 仅用于 benchmark：包装真实 Worker/parentPort，
不改产品消息协议、ACK 或 retry 分支。highLoad=false，2.29→2.86/8 核，36.8 s。

- worker-ready：构造至收到 attach 请求，含启动、pin/data 模块加载、prepare 和消息调度。
- clone-to/from-worker：两端 `postMessage` 的同步发送耗时；**不是全部传输/接收反序列化耗时**。
- worker-lifetime：构造至 exit 回调；result-to-exit：父层收到完整结果至 exit 回调。
- 这些区间相互重叠，不能直接求和；接收端反序列化、调度和 GC 没有独立归因。没有修改或补造旧版
  不存在的 worker 指标；它们在旧版为不适用，而不是“免费”。

| MiB | worker-ready ms   | main 发送 clone ms | worker 返回 clone ms | worker-lifetime ms | result-to-exit ms |
| --- | ----------------- | ------------------ | -------------------- | ------------------ | ----------------- |
| 1   | 241.1/214.4/215.9 | 0.1/0.1/0.1        | 0.1/0.1/0.1          | 257.0/234.0/233.9  | 1.0/0.8/0.8       |
| 10  | 241.0/269.7/271.6 | 1.2/1.8/1.7        | 1.0/1.9/1.7          | 317.3/346.0/345.7  | 0.6/0.1/0.1       |
| 100 | 262.3/264.1/227.2 | 9.6/17.0/17.5      | 8.4/7.1/11.7         | 915.9/806.1/785.2  | 10.4/0.6/0.1      |

### native open / warm / 合成首轮

open/warm 在 handoff 计时与 RSS after 采样之外。首轮是最后一次 warm 后的一轮本地合成响应，
不是付费模型时延，也没有统计显著性。

| MiB | native open ms（前→后） | native warm ms（前→后）       | 最后一次 warm 后合成首轮 ms（前→后） |
| --- | ----------------------- | ----------------------------- | ------------------------------------ |
| 1   | 1/1/1→2/1/1             | 2303/2084/2122→2366/2158/2126 | 93→86                                |
| 10  | 12/14/9→13/9/11         | 2346/2227/2338→2364/2150/2182 | 267→266                              |
| 100 | 117/119/99→99/98/98     | 2642/2456/2381→2632/2428/2337 | 1987→2002                            |

### 连续交接的存储增长

九组 `storage.before/after/delta` 和 `seedBytes` 前后逐字节数量相等（不是仅比较总和）。
下表正文是 `kernel_entries.body` 的 BLOB 字节数，不是整个数据库大小。WAL 的文件大小受
checkpoint/复用影响，delta=0 不等于零写入；没有测 fsync 实际物理 I/O 字节或磁盘耐久性故障。

| MiB | 每次 seed B（前=后） | 每次 DB 正文新增 B（前=后） | 三次后的 DB / WAL / 正文 B（前=后） |
| --- | -------------------- | --------------------------- | ----------------------------------- |
| 1   | 1068290              | 1067888                     | 4497408 / 4919312 / 4271116         |
| 10  | 10505474             | 10505072                    | 42270720 / 10843872 / 42019852      |
| 100 | 104877314            | 104876912                   | 420499456 / 105855192 / 419507212   |

100 MiB 连续三次仍留下三份各 104877314 B 的 seed，journal 正文每次新增 104876912 B。
这不是新增的 worker 存储放大，也没有解决既有重复物化。不同 payer 的 seed 不做跨人复用。

## 验证

| 项目                 | 结果                                                                        | 证据                                                       |
| -------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 同步提取阶段         | check + lifecycle/history 20/20；1 MiB 控制运行通过                         | move-check.log、move-tests.log、move-control.log           |
| loader 提取          | check + lifecycle/history 20/20                                             | data-loader-check.log、data-loader-tests.log               |
| 新专项测试           | 15/15、0 skip                                                               | seed-tests.log                                             |
| 同步包装负控         | 替换为同样文件步骤的 async/Promise 包装，worker-thread 断言预期失败；1 fail | seed-negative-loader.mjs、seed-negative.log；未改产品文件  |
| 默认全量（实现阶段） | **637/637**、0 fail/skip，无串行例外                                        | npm test；test.log                                         |
| 中间一次默认全量     | **636/637**、0 skip；settings recovery 用例失败，记录保留                   | final-test.log；见下节                                     |
| owner 授权的默认重跑 | **637/637**、0 fail/skip，237830 ms；未改测试或门槛                         | test-owner-retry.log                                       |
| 静态检查             | format/check/lint/format:check 全部通过                                     | format.log、check.log、lint.log、format-check.log          |
| perf 对 main         | exit 0、ledger guard 通过；58 worse / 30 slower                             | perf.log、ci/{base,head}.json、ci-comparison.json          |
| perf 对 D7 基线      | exit 0、ledger guard 通过；6 worse / 26 slower                              | d7-perf.log、d7-ci/{base,head}.json、d7-ci-comparison.json |

新测试覆盖真实 worker 执行和父循环让出、attach 先于 append、private/public 边界、不重复计费/镜像、
最终授权时持有 lease/旧 head、Stop 在 prepare/attach/readback/最终授权各点、attach ACK 丢失、
worker 文件写失败、非私有目录、完整 readback 不符、unknown 跨 journal 重开 fence、
相同请求幂等、新请求被 pending fence 拒绝、空历史和共享 fork/import 路径。
不以 Node 工具返回成功替代 receipt/head/usage 的业务断言。

### 中间一次全量失败与 owner 授权重跑

实现阶段 `test.log` 为 637/637。交接文档及 SDK 依赖注释更新后重新执行默认全量，
`final-test.log` 为 **636/637**、0 skip：`test/settings-ui.test.ts:312` 的 recovery 用例在
`:401` 恢复 owner 身份时，动态 import 报 `Failed to resolve module specifier "preact/hooks"`。
最终 check/lint/format:check 均通过（`final-*.log`），未自动重复全量。

独立 `node --test test/settings-ui.test.ts` 为 7/7（`settings-alone.log`）。
`7671c97` 的未修改基线加入 150 ms POST 响应延迟的诊断仍为 1/1，**没有重现同一错误**；
该诊断也产生关闭时的 aborted 日志，只是合成延迟实验，不能作为既有产品失败的证明。
证据为 `settings-base-delay.log`、`settings-navigation-delay.mjs`；临时 checkout 已清理。

测试、BrowserPage、index 和 UI 对 `7671c97` 无改动；fixture 明确走 legacy runtime，
不调用 D7 materializer。恢复表单点击后立即 import store 的导航/文档就绪时序是代码阅读推断，
原失败没有保留当时页面上下文，不能将推断升级为根因已证实。未修改测试、跳过用例或降低门槛。
owner 随后明确选择“默认全量重跑一次”，已执行且通过：`test-owner-retry.log` 为 **637/637**、
0 fail/skip、237830 ms。没有修改该测试、使用串行例外、跳过用例或降低门槛，也未再重复全量。
这解除本次交付门槛，不证明恢复登录失败的根因已修复；完整失败和诊断证据仍保留。

## 每项 worse

使用 `test/perf/ratchet.ts: compare` 和未更改的 ledger tolerance 对保存报告计算，不使用
“candidate 对 ledger 历史 baseline”表冒充本次 before/after。两组均单轮，L1/L2 不替代生产 L3。
main 是 `e649d9d`；D7 隔离基线为 `9e6412d`。
head 的负载分别为 3.66→6.58/8 核、6.14→4.21/8 核。星号标该比较实际判为 worse。

62 项并集的解释代码：

- **S**：D7 隔离中一次延迟 sessions 广播，额外 1 SQL、13 rows、3485 stringify chars、
  1 event、4076 wire B。独立内容/SQL trace 在**旧版反而多、实现反而少**时精确复现同一组差值：
  base 48/109/88107/10/86312，head 47/96/84622/9/82236；两边 worker 数都是 0。
  差异 SQL 唯一为 `RotomJournal.modelNames` 查询，多返回一次 13 行；多的 event 正是 4076 B sessions。
  `PocketApp.#scheduleSessions` 的现行 400 ms timer 可落入不同测量窗口。旧/新都能出现两种采样，
  不是 D7 新增一条 SQL/广播。main 栏还含历史差异，不能把该栏所有 SQL 增量都归到这一次广播。
- **U**：history stringify +34 字符。补充两版内容 trace 都是 243098 字符，没有重现；
  原 CI 没有保存逐次字符串正文，不能追溯那 34 字符的具体字段，保持 **unknown**，不说“已证明无回归”。
- **A**：D6 `native.css` 独立 link 已核验的请求成本；D7 两边相同，没有再次加 CSS/HTTP 请求。
- **P**：已核验的 D5 初连 ACK 和 room generation 包装；同项 D6 记录已有，D7 隔离没有该 worse。
- **N**：main 含 A4 modulepreload 节点、D6 link/空白，以及 CDP 的节点分配/回收采样；
  D7 不改 DOM/CSS，此项隔离未判 worse。CDP Nodes 不是持久 DOM 计数或泄漏证明。
- **V**：对 main 的 stream 样本多两次 view（24→26）和 push（30→32），相关投影、SQL、JSON、
  样式/浏览器计数随窗口变化。**同一实现代码**的两组 head 也分别是 26/24 views、32/30 pushes、
  405/386 SQL、79944/78187 view B、114/109 RecalcStyleCount、31525/30445 parse chars。
  不把所有字节/样式增量精确归因到那两次 view；旧正文/调度 trace 缺失的部分仍 unknown。
- **Q**：main 累计 A–D6 的既有查询/窗口差异，参见 [D6 完整记录](d6-validation.md) 同项；
  D7 隔离未判该项 worse，也未修改这些 SQL 实现。未保存旧版 query trace 的历史细项不新造因果解释。

诊断文件为 `trace-{base,head}/{session.open,session.history.earlier}.json` 和
`trace-counters.mjs`；使用等长临时 checkout、当前同一 fixture、无真实账号。
它们用于解释计数器，不用其时间代替主比较；临时 checkout 已移除。

| 计数器                                         | 对 main：base→head | D7 隔离：base→head | 解释 |
| ---------------------------------------------- | ------------------ | ------------------ | ---- |
| assets.first/http.requests                     | 53→54 *            | 54→54              | A    |
| assets.validated/http.requests                 | 53→54 *            | 54→54              | A    |
| commands.discover.cold/sql.rows                | 78→81 *            | 81→81              | Q    |
| commands.discover.warm/sql.rows                | 64→66 *            | 66→66              | Q    |
| native.warm/sql.rows                           | 10→11 *            | 11→11              | Q    |
| projection.large.open/sql.statements           | 98→99 *            | 99→99              | Q    |
| projection.large.paced/sql.statements          | 572→574 *          | 574→574            | Q    |
| session.history.earlier/json.stringify.chars   | 243132→243132      | 243098→243132 *    | U    |
| session.open.long/sql.rows                     | 47→49 *            | 49→49              | Q    |
| session.open.long/sql.statements               | 16→17 *            | 17→17              | Q    |
| session.open/json.stringify.chars              | 88107→88107        | 84622→88107 *      | S    |
| session.open/push.bytes                        | 86312→86312        | 82236→86312 *      | S    |
| session.open/push.events                       | 10→10              | 9→10 *             | S    |
| session.open/sql.rows                          | 107→109 *          | 96→109 *           | S    |
| session.open/sql.statements                    | 46→48 *            | 47→48 *            | S    |
| startup.restart/sql.statements                 | 848→851 *          | 851→851            | Q    |
| turn.cold/sql.rows                             | 141→153 *          | 148→148            | Q    |
| turn.cold/sql.statements                       | 209→226 *          | 216→216            | Q    |
| turn.paced/sql.statements                      | 286→288 *          | 288→288            | Q    |
| turn.warm/sql.statements                       | 157→158 *          | 158→158            | Q    |
| web.open.long/cdp.Nodes                        | 1585→1703 *        | 1703→1703          | N    |
| web.open.long/http.requests                    | 80→81 *            | 81→81              | A    |
| web.open.long/push.view.bytes                  | 165859→165883 *    | 165883→165883      | P    |
| web.open.long/web.event.parse.calls            | 8→9 *              | 9→9                | P    |
| web.open.long/web.event.parse.chars            | 173290→173492 *    | 173492→173492      | P    |
| web.open/cdp.Nodes                             | 996→1114 *         | 1138→1138          | N    |
| web.open/http.requests                         | 81→82 *            | 82→82              | A    |
| web.open/push.bytes                            | 83736→83964 *      | 83964→83964        | P    |
| web.open/push.events                           | 10→11 *            | 11→11              | P    |
| web.open/push.view.bytes                       | 76309→76333 *      | 76333→76333        | P    |
| web.open/sql.statements                        | 31→32 *            | 32→32              | Q    |
| web.open/web.event.parse.calls                 | 9→10 *             | 10→10              | P    |
| web.open/web.event.parse.chars                 | 82941→83141 *      | 83141→83141        | P    |
| web.paced/cdp.Nodes                            | 1295→1412 *        | 1417→1413          | N    |
| web.paced/sql.statements                       | 306→308 *          | 322→308            | Q    |
| web.reopen/cdp.Nodes                           | 1090→1208 *        | 1232→1232          | N    |
| web.reopen/push.bytes                          | 10313→10541 *      | 10541→10541        | P    |
| web.reopen/push.events                         | 9→10 *             | 10→10              | P    |
| web.reopen/push.view.bytes                     | 2001→2025 *        | 2025→2025          | P    |
| web.reopen/web.event.parse.calls               | 8→9 *              | 9→9                | P    |
| web.reopen/web.event.parse.chars               | 9527→9727 *        | 9727→9727          | P    |
| web.send.poll/cdp.Nodes                        | 1477→1617 *        | 1619→1620          | N    |
| web.send.stream/cdp.Nodes                      | 1491→1635 *        | 1634→1629          | N    |
| web.send.stream/cdp.RecalcStyleCount           | 104→114 *          | 108→109            | V    |
| web.send.stream/push.bytes                     | 91291→93762 *      | 94170→92005        | V    |
| web.send.stream/push.events                    | 30→32 *            | 32→30              | V    |
| web.send.stream/push.view.bytes                | 77497→79944 *      | 80352→78187        | V    |
| web.send.stream/push.view.count                | 24→26 *            | 26→24              | V    |
| web.send.stream/sql.statements                 | 384→405 *          | 405→386            | V    |
| web.send.stream/view.inbox.project.calls       | 24→26 *            | 26→24              | V    |
| web.send.stream/view.kernel.json.parse.calls   | 70→76 *            | 76→70              | V    |
| web.send.stream/view.kernel.json.parse.chars   | 37870→41116 *      | 41116→37870        | V    |
| web.send.stream/view.kernel.project.calls      | 24→26 *            | 26→24              | V    |
| web.send.stream/view.kernel.sql.attempts       | 48→52 *            | 52→48              | V    |
| web.send.stream/view.kernel.sql.command_inputs | 46→50 *            | 50→46              | V    |
| web.send.stream/view.kernel.sql.heads          | 24→26 *            | 26→24              | V    |
| web.send.stream/view.kernel.sql.rows           | 70→76 *            | 76→70              | V    |
| web.send.stream/view.kernel.sql.statements     | 118→128 *          | 128→118            | V    |
| web.send.stream/view.live.project.calls        | 24→26 *            | 26→24              | V    |
| web.send.stream/web.event.parse.calls          | 15→16 *            | 16→15              | V    |
| web.send.stream/web.event.parse.chars          | 30133→31525 *      | 31729→30445        | V    |
| web.send.stream/web.view.apply.calls           | 12→13 *            | 13→12              | V    |

## 全部 slower（48 项并集）

星号表示对应比较判为 slower。两组都只有一轮，低绝对时间的百分比尤其不稳定；不据此宣称生产回归
或“都是噪声”。通用 perf 护栏不能替代 handoff 专项；已知 D7 启动/复制/总耗时成本见上表。
未调整任何门槛，未把不可测量算为零。

| L2 指标                                       | 对 main：base→head ms | D7 隔离：base→head ms |
| --------------------------------------------- | --------------------- | --------------------- |
| commands.discover.cold/nativeStartHelperMs    | 0.3→0.7 *             | 1.2→0.6               |
| commands.discover.cold/nativeStartResourcesMs | 57.2→63.2             | 33.9→48.3 *           |
| commands.discover.cold/nativeStartVerifyMs    | 2.6→2.5               | 1.2→2 *               |
| commands.list/ms                              | 67.7→52.3             | 51.3→65.3 *           |
| image.concurrent/imageClientMs                | 299.9→289.4           | 297.4→369 *           |
| image.concurrent/imageSendFinishMs            | 32→71.6 *             | 50.4→73.8 *           |
| image.concurrent/imageServerMs                | 184.5→178.6           | 190.9→234.5 *         |
| image.original.validated/ms                   | 16.3→21.8 *           | 13.8→19 *             |
| image.single/imageClientMs                    | 56.6→48.5             | 46.2→60.5 *           |
| image.single/imageLookupMs                    | 10.9→8.5              | 7.4→10.1 *            |
| image.single/imageSendFinishMs                | 9.1→8.4               | 9→13.3 *              |
| image.single/imageServerMs                    | 42.6→33.1             | 33.5→44.6 *           |
| image.single/ms                               | 59→50.1               | 47.3→63 *             |
| image.thumbs.again/ms                         | 10.3→13.1 *           | 13→14.5               |
| native.warm/nativeStartHelperMs               | 0.2→0.7 *             | 0.2→0.5 *             |
| native.warm/nativeStartRpcSpawnMs             | 0.4→0.9 *             | 0.5→0.5               |
| projection.large.open/ms                      | 43.4→62.2 *           | 75.6→66.8             |
| session.history.earlier/ms                    | 23.1→28.9 *           | 23→25.1               |
| session.open/ms                               | 31.1→56.7 *           | 59.3→51.7             |
| session.open/roomKernelProjectMs              | 0.5→1.2 *             | 1.7→1.9               |
| session.reclaim/ms                            | 21.3→17.1             | 17.2→26 *             |
| session.reclaim/roomKernelProjectMs           | 0.9→0.6               | 0.7→11.9 *            |
| sessions.list/ms                              | 7→8.6 *               | 9→7                   |
| turn.cold/nativeStartHelperMs                 | 0.3→0.2               | 0.6→0.8 *             |
| turn.cold/nativeStartResourcesMs              | 83.7→79.5             | 40.9→67.5 *           |
| turn.cold/nativeStartValidateMs               | 0.2→0.4 *             | 0.3→0.3               |
| turn.cold/roomKernelProjectMs                 | 0.7→0.3               | 0.3→0.5 *             |
| turn.cold/roomLiveProjectMs                   | 0.3→0.2               | 0.2→0.4 *             |
| turn.prewarmed/roomKernelProjectMs            | 0.4→0.4               | 0.3→0.4 *             |
| turn.warm/ms                                  | 87.3→91.9             | 69.7→90.4 *           |
| web.open.long/eventParseMs                    | 0.1→0.2 *             | 0.1→0.1               |
| web.open.long/viewApplyMs                     | 0.2→0.3 *             | 0.2→0.3 *             |
| web.open/eventParseMs                         | 0.1→1.7 *             | 0.6→0.2               |
| web.open/viewApplyMs                          | 0.1→0.3 *             | 0.2→0.5 *             |
| web.paced/eventParseMs                        | 0.7→0.9 *             | 0.9→0.8               |
| web.paced/viewApplyMs                         | 1→1.4 *               | 1.9→1.9               |
| web.reopen/viewApplyMs                        | 0.1→0.3 *             | 0.2→0.2               |
| web.send.poll/clockUncertaintyMs              | 0.7→1 *               | 1→1.1                 |
| web.send.poll/promptDispatchedMs              | 54.8→70.1 *           | 55.2→46.1             |
| web.send.poll/submitAnsweredMs                | 15.9→21.3 *           | 15.5→30.3 *           |
| web.send.poll/taskMs                          | 130.7→159.6 *         | 153.4→146.1           |
| web.send.poll/userEchoedMs                    | 8.9→11.4 *            | 8.7→14.2 *            |
| web.send.stream/clockUncertaintyMs            | 0.5→0.7 *             | 0.7→0.6               |
| web.send.stream/promptDispatchedMs            | 36.9→54.5 *           | 43.8→51.2             |
| web.send.stream/runAdmittedMs                 | 10→14.1 *             | 7.3→8.6               |
| web.send.stream/submitAnsweredMs              | 14.5→22.4 *           | 24.4→20.3             |
| web.send.stream/taskMs                        | 138.1→170.6 *         | 161.1→146.6           |
| web.send.stream/userEchoedMs                  | 8→11.4 *              | 7.2→18.7 *            |

## 交付边界与下一步

用户 `opportunities.md` 和未跟踪 `2026-10-21-proposals.md` 保持原内容，未暂存。
未使用 D5 的串行例外；owner 单独批准的一次默认重跑不构成后续任务例外。开发初期 fixture 的 private data/HOME/payer
设置错误已按既有合同修正，没有降低产品权限或读取校验。

这是开发机、合成历史、顺序交接的验证。未验证真实账号、生产高并发、磁盘故障/断电、跨平台峰值或
多房间大历史容量；物理接收反序列化/GC 分摊和旧样本 +34 字符来源仍 unknown。
没有新增配置、常驻池、自动重试或更宽松 ledger 来隐藏这些限制。

**审查方下一步核验 D7；owner 批准的单次默认全量重跑已通过。**
恢复登录失败仍需独立调查；由 owner 另案授权采集失败页面上下文，不能把本次重跑当作修复。
审查需明确评估小历史启动延迟及大历史 RSS 取舍；D7 核验通过前不开始 D8。
若需要并发容量/平台数据，由 owner 指定负载与预算后另行测量；不能依据顺序测试承诺容量。
