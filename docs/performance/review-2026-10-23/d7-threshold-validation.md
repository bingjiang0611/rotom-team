# D7 第 9 轮补充 — 8 MiB 分流

## 版本与结论

在审查提交 `0573ad1` 上追加：测量 `2af9690`，实现及测试 `859c283`。
`select` 计时先独立提交；基准/工作量、ledger、pin、vendor、journal schema 和 Durable 合同未改。
原全量 worker 的证据仍在 [D7 原记录](d7-validation.md)，本页描述当前分流实现。
D8 未开始，没有部署或重启服务。

原始证据：`/tmp/rotom-review-D7-threshold/`。基准报告中的 `2af9690-dirty` 是随后提交
`859c283` 的产品/测试差分；`implementation.patch` 保存该差分。之后仅修改交接文档。

## 阈值与语义

- 精确计算 `Buffer.byteLength(JSON.stringify(publicNativeHistory结果), "utf8")`，不是原始历史、
  seed 文件大小、消息条数或 JS 字符长度。**小于 8388608 B 在父线程执行；等于或大于该值走 worker。**
- 复用 `prepareSeed/persistSeed`；调用方已加载的 pinned SessionManager 传入共同的 `#seed`。
  小路径不再启动 worker，也不重复加载 SDK。空历史仍不创建文件/worker。
- 两条路径保持 prepare → 父线程 durable attach → append → 文件/目录 fsync → readback →
  完整比较 → 最终授权/Stop 检查 → finish。large 路径另外等 worker exit，绝不凭收到结果提前释放 lease。
- `materializing = true` 在字节计算/准备前设置。此后的大小计算、prepare、attach、写入或 readback 失败、
  Stop、最终撤权仍是 unknown。共用 attach 前 Stop 检查；small 在 attach 后再次检查，避免已观测 Stop 后 append。
  同一请求不重放，pending/unknown 仍阻止新请求，接力历史不重复计费/镜像。
- 小路径是明确授权的同步路径：**不能在同步 I/O 中间处理排队的 HTTP Stop**。已观测的 Stop 阻止后续
  append/commit；这不等于它和 worker 具有同样的可抢占性。大路径仍 terminate/join worker。
- 未加配置项、pool、后台队列、跨付费人复用或全局内存 admission cap。

### 为什么选 8 MiB

第 9 轮采用的原始同步样本中，1 MiB 停顿约 22 ms，而 10 MiB 约 118 ms；
全量 worker 对 1 MiB 额外增加约 240 ms。现有样本约束了“1 MiB 应直接做、10 MiB 应 offload”，
**没有证明一个精确的总耗时交叉点**（worker 在这些档位总耗时仍更长）。

因此选择审查允许的 4–8 MiB 区间上端 8 MiB：减少中小历史的固定启动税，同时保留 10 MiB 以上的
off-main 行为。8 MiB ±1 B 的测试验证的是边界正确性，不是该值的性能最优性。
若实际 4–8 MiB 的停顿成为主要等待来源，应沿用同一协议补 4/8 MiB 配对样本再评估下调；不据此抬高 ledger。

## 1/10/100 MiB 重测

沿用未改的 `handoff-bench.mjs` 及 benchmark-only worker preload。同一机器、每档新进程、
64 条合成公开历史、同一 payer 连续三次 handoff，再 native open/warm，最后一次 warm 后一轮
loopback 合成推理。不是三个独立重复实验，也不代表生产模型上下文容量或多成员并发容量。

Node v24.18.0，darwin-arm64，Apple M1 / 8 核，rotom 0.1.26。
正式对照 `measured-base.{log,json}` / `head.{log,json}`：
前者 highLoad=false，2.91→2.75/8 核，37.3 s；后者 highLoad=false，3.27→2.67/8 核，36.1 s。
`base.log` 是加 select 探针之前的预采样，不替代正式同仪器对照。

三值对应顺序交接 1/2/3，四舍五入，不叫 p95。RSS 是整个父进程截至该次返回的累计 peak，
包括 worker 线程但不含 native 推理子进程；后两次受此前 open/warm 的历史 peak 影响，非单次独立峰值。

| MiB | 路径（前→后） | 总耗时 ms（前→后）            | 最大 lag ms（前→后）    | select ms（后） | 进程累计 peak RSS MiB（前→后） |
| --- | ------------- | ----------------------------- | ----------------------- | --------------- | ------------------------------ |
| 1   | worker→main   | 300/284/347→42/60/78          | 5/6/8→23/23/43          | 1/1/1           | 268/303/303→218/256/258        |
| 10  | worker→worker | 412/451/445→425/456/464       | 47/47/50→45/48/51       | 12/11/11        | 386/439/443→382/450/452        |
| 100 | worker→worker | 1440/1429/1420→1497/1520/1519 | 423/471/488→421/452/497 | 119/136/125     | 1429/1507/1611→1494/1494/1494  |

L1：1 MiB 三次 worker-ready/worker-lifetime 事件从各 **3→0**，prepare/append/persist/readback/compare
均在 main；10/100 MiB 仍各有三次 worker 生命周期，文件阶段仍在 worker。

1 MiB 回到原同步基线同一量级：旧同步证据 40/56/60 ms，本轮 42/60/78 ms；第三次仍比旧样本高，
不宣称逐次等价。它不再承担约 300 ms 的 worker 路径成本。10/100 MiB 的最大 lag 保持约 50/500 ms。
父线程 projection 和同步 journal.finish 仍是剩余阻塞，D7 不替代 D8。

字节计算不是免费的：`select` 在 10 MiB 为 11–12 ms，100 MiB 为 119–136 ms，
包含一次完整 JSON stringify 和 UTF-8 byteLength；有临时字符串分配。100 MiB 总耗时因而有所增加。
没有把这段工作移出 handoff 计时窗口，也没有只按文本长度猜大小。

### 存储、native open/warm 和首轮

九次对照的 storage.before/after/delta、seedBytes 均相等，不仅是合计相等。
WAL delta=0 不等于零物理写入；不声称磁盘断电验证。native open/warm 在 handoff 计时之外，
合成首轮不是付费模型时延。

| MiB | 每次 seed B（前=后） | 每次 journal 正文新增 B（前=后） | native open ms（前→后） | native warm ms（前→后）       | warm 后合成首轮 ms（前→后） |
| --- | -------------------- | -------------------------------- | ----------------------- | ----------------------------- | --------------------------- |
| 1   | 1068290              | 1067888                          | 2/1/1→1/1/1             | 2355/2162/2132→2348/2020/2158 | 86→94                       |
| 10  | 10505474             | 10505072                         | 12/9/9→12/9/9           | 2419/2227/2208→2383/2142/2194 | 268→262                     |
| 100 | 104877314            | 104876912                        | 102/99/98→98/97/98      | 2753/2418/2354→2591/2277/2380 | 2018→1979                   |

## 验证

| 检查                                | 结果                                                   | 证据                                              |
| ----------------------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| check / lint / format:check，format | 通过                                                   | check.log、lint.log、format-check.log、format.log |
| 两路径专项                          | 31/31，0 skip                                          | seed-tests.log                                    |
| 总是 worker 负控                    | 小于阈值的断言失败；1 fail / 2 pass                    | negative-always-worker.log                        |
| JS 字符数负控                       | 等于及大于阈值的 Unicode 样本失败；2 fail / 1 pass     | negative-character-count.log                      |
| 默认全量首次                        | 652/653，dropins reload 超时                           | test.log                                          |
| 同一 dropins 文件独立运行           | 4/4；不是全量替代品                                    | dropins-alone.log                                 |
| owner 明确授权的一次默认重跑        | **653/653**，0 fail/skip，237897 ms                    | test-owner-retry.log                              |
| kernel app API proof                | status=passed、realProvider=false；83 次 loopback 请求 | kernel-app.log                                    |
| perf 对 origin/main                 | exit 0，ledger guard passed；42 worse / 23 slower      | perf.log、ci/{base,head}.json                     |
| perf 对阈值前 2af9690               | exit 0，ledger guard passed；25 worse / 15 slower      | threshold-perf.log、threshold-ci/{base,head}.json |

31 项覆盖两路径的 attach-before-append、材料化失败 unknown、Stop 在 prepare/attach/readback/
最终授权各点、最终授权时的 lease/旧 head、幂等、新请求 fence、private/public、usage、
fork/import 和重开 journal。另保留空历史与共享 helper 的完整 readback mismatch 检查。
边界样本为公开 JSON UTF-8 **8 MiB−1 B、8 MiB、8 MiB+1 B**，同时包含 Unicode 和 JSON 转义。
小于阈值的原始输入还包含足以超过阈值的 private reasoning，证明按过滤后的结果选择。
两条负控由临时 Node loader 替换判定表达式，没有修改产品源码或测试断言。

kernel app proof 的 apiHandoffAndCompaction、handoffHistoricalUsagePreserved、
apiForkIdempotencyConfigurationAndPayer、forkGapAndUnknownSourceNotReplayed、
crashedKernelRemainsUnknownWithoutContinuation 均 true；不把该 proof 当作 web UI 验收。
日志中的 “Fixture: stop after configuration staging, before journal intent” 是该脚本的故意故障注入；
最终 status=passed。完整报告路径保留在 kernel-app.log 中。

### 本轮全量失败与授权范围

首次失败为 `test/dropins.test.ts:114`、在 `:139` 等待 edited file reload 超时，
与既有记录同签名。文件独立 4/4 不能证明根因已修复。执行方先暂停；owner 随后明确批准
**本轮一次默认全量重跑**，才运行并通过。没有改监听测试、串行化、跳过、扩大超时或沿用此前授权。
失败与本轮重跑记录都保留；不把本次授权延伸到 D8 或后续任务。

## 每项 worse：65 项并集

由 `test/perf/ratchet.ts: compare` 及原 ledger tolerance 计算，不拿 candidate 对 ledger 的历史
baseline 表冒充 before/after。星号表示本次对应比较实际判为 worse。
main=`e649d9d`，阈值前=`2af9690`；两组 head 为随后提交的 `859c283` 差分。
两组各一轮；head 负载分别 3.88→5.00/8 核、4.57→3.44/8 核。

解释代码（每行对应一项，不把 unknown 写成零或“已证明无回归”）：

- **A**：D6 独立 native.css 的已知请求成本；本轮不改 CSS/资源加载，阈值隔离此项未判 worse。
- **P**：D5 初连 ACK 和 generation 包装的既有成本，原 D6/D7 记录已有同项；阈值隔离未判此项 worse。
- **H**：main 累计的既有 SQL/parse/窗口差异，本轮未改这些查询或 Durable storage；
  阈值隔离未判此项 worse。startup 的额外一次 19 字符 durableStorage parse 无旧输入 trace，
  不能编造具体字段归因。其余历史项可对照 [原 D7](d7-validation.md) / [D6](d6-validation.md)。
- **N**：main 含 A4 preload、D6 stylesheet link 与 CDP 节点采样的累计差异。本轮不改 DOM；
  隔离未判此项 worse。Nodes 不等于持久 DOM 或泄漏证明，未保留旧 heap/DOM trace 的细项不精确归因。
- **V**：stream 同组由 24→26 views、30→32 pushes，关联投影/SQL/JSON/apply 计数一起增加。
  两组**同一实现代码的 head**也分别是 24/26 views、30/32 pushes、386/405 SQL、379/394 rows、
  144/156 fields stringify、8798/9535 fields chars、77986/79950 view B。
  因而这些数确实会随同代码的推送窗口变化；不把所有字符/字节增量精确归到某一个字段。
- **B**：large.paced 的两组同代码 head 都是 44 views、52 pushes、574 SQL、719 rows，
  但 view B 为 207656/208456，stringify chars 为 422735/423600。相同次数下正文大小也会变化；
  缺原逐帧正文 trace，隔离样本增加的 7200 B/字符不能精确归因，仍是 unknown。
- **T**：poll 请求/浏览器 layout 的窗口采样差异。web.paced 两个同代码 head 均为 11 views、
  15 pushes、308 SQL、311 rows，LayoutCount 却为 13/15。poll 对 main 多 2 请求在隔离中未判 worse；
  没有原路由/layout trace，不能声称每个请求/布局增量已被解释或都是噪声。

| 计数器                                          | 对 main：base→head | 阈值隔离：base→head | 解释 |
| ----------------------------------------------- | ------------------ | ------------------- | ---- |
| assets.first/http.requests                      | 53→54 *            | 54→54               | A    |
| assets.validated/http.requests                  | 53→54 *            | 54→54               | A    |
| commands.discover.cold/sql.rows                 | 78→81 *            | 81→81               | H    |
| commands.discover.warm/sql.rows                 | 64→66 *            | 66→66               | H    |
| native.warm/sql.rows                            | 10→11 *            | 11→11               | H    |
| projection.large.open/sql.statements            | 98→99 *            | 99→99               | H    |
| projection.large.paced/json.stringify.chars     | 518034→422735      | 416400→423600 *     | B    |
| projection.large.paced/push.bytes               | 245028→249028 *    | 242628→249828 *     | B    |
| projection.large.paced/push.view.bytes          | 203656→207656 *    | 201256→208456 *     | B    |
| projection.large.paced/sql.statements           | 572→574 *          | 574→574             | H    |
| session.open.long/sql.rows                      | 47→49 *            | 49→49               | H    |
| session.open.long/sql.statements                | 16→17 *            | 17→17               | H    |
| session.open/sql.statements                     | 46→47 *            | 47→47               | H    |
| startup.restart/json.parse.durableStorage.calls | 458→459 *          | 458→458             | H    |
| startup.restart/json.parse.durableStorage.chars | 51416→51435 *      | 51416→51416         | H    |
| startup.restart/sql.statements                  | 848→851 *          | 851→851             | H    |
| turn.paced/sql.statements                       | 286→288 *          | 288→288             | H    |
| turn.warm/sql.statements                        | 157→158 *          | 158→158             | H    |
| web.open.long/cdp.Nodes                         | 1561→1703 *        | 1703→1703           | N    |
| web.open.long/http.requests                     | 80→81 *            | 81→81               | A    |
| web.open.long/push.view.bytes                   | 165859→165883 *    | 165883→165883       | P    |
| web.open.long/web.event.parse.calls             | 8→9 *              | 9→9                 | P    |
| web.open.long/web.event.parse.chars             | 173290→173492 *    | 173492→173492       | P    |
| web.open/cdp.Nodes                              | 996→1114 *         | 1138→1114           | N    |
| web.open/http.requests                          | 81→82 *            | 82→82               | A    |
| web.open/push.bytes                             | 83736→83964 *      | 83964→83964         | P    |
| web.open/push.events                            | 10→11 *            | 11→11               | P    |
| web.open/push.view.bytes                        | 76309→76333 *      | 76333→76333         | P    |
| web.open/sql.statements                         | 31→32 *            | 32→32               | H    |
| web.open/web.event.parse.calls                  | 9→10 *             | 10→10               | P    |
| web.open/web.event.parse.chars                  | 82941→83141 *      | 83141→83141         | P    |
| web.paced/cdp.LayoutCount                       | 13→13              | 13→15 *             | T    |
| web.paced/cdp.Nodes                             | 1295→1422 *        | 1423→1412           | N    |
| web.paced/sql.statements                        | 306→308 *          | 308→308             | H    |
| web.reopen/cdp.Nodes                            | 1090→1232 *        | 1232→1232           | N    |
| web.reopen/push.bytes                           | 10313→10541 *      | 10541→10541         | P    |
| web.reopen/push.events                          | 9→10 *             | 10→10               | P    |
| web.reopen/push.view.bytes                      | 2001→2025 *        | 2025→2025           | P    |
| web.reopen/web.event.parse.calls                | 8→9 *              | 9→9                 | P    |
| web.reopen/web.event.parse.chars                | 9527→9727 *        | 9727→9727           | P    |
| web.send.poll/cdp.LayoutCount                   | 18→19 *            | 18→18               | T    |
| web.send.poll/cdp.Nodes                         | 1400→1593 *        | 1620→1620           | N    |
| web.send.poll/http.requests                     | 20→22 *            | 22→22               | T    |
| web.send.stream/cdp.Nodes                       | 1476→1653 *        | 1626→1631           | N    |
| web.send.stream/push.bytes                      | 100246→91804       | 91804→93768 *       | V    |
| web.send.stream/push.events                     | 32→30              | 30→32 *             | V    |
| web.send.stream/push.view.bytes                 | 86452→77986        | 77986→79950 *       | V    |
| web.send.stream/push.view.count                 | 26→24              | 24→26 *             | V    |
| web.send.stream/sql.rows                        | 754→379            | 379→394 *           | V    |
| web.send.stream/sql.statements                  | 403→386            | 386→405 *           | V    |
| web.send.stream/view.fields.stringify.calls     | 312→144            | 144→156 *           | V    |
| web.send.stream/view.fields.stringify.chars     | 19070→8798         | 8798→9535 *         | V    |
| web.send.stream/view.inbox.project.calls        | 26→24              | 24→26 *             | V    |
| web.send.stream/view.kernel.json.parse.calls    | 76→70              | 70→76 *             | V    |
| web.send.stream/view.kernel.json.parse.chars    | 41116→37870        | 37870→41116 *       | V    |
| web.send.stream/view.kernel.project.calls       | 26→24              | 24→26 *             | V    |
| web.send.stream/view.kernel.sql.attempts        | 52→48              | 48→52 *             | V    |
| web.send.stream/view.kernel.sql.command_inputs  | 50→46              | 46→50 *             | V    |
| web.send.stream/view.kernel.sql.heads           | 26→24              | 24→26 *             | V    |
| web.send.stream/view.kernel.sql.rows            | 76→70              | 70→76 *             | V    |
| web.send.stream/view.kernel.sql.statements      | 128→118            | 118→128 *           | V    |
| web.send.stream/view.live.project.calls         | 26→24              | 24→26 *             | V    |
| web.send.stream/web.event.parse.calls           | 16→15              | 15→16 *             | V    |
| web.send.stream/web.event.parse.chars           | 31914→30445        | 30445→31528 *       | V    |
| web.send.stream/web.view.apply.calls            | 13→12              | 12→13 *             | V    |

## 全部 slower：34 项并集

星号表示对应比较判为 slower。单轮通用 perf 不能证明生产时延，也不能替代 1/10/100 MiB 专项。
这些路径没有新的性能承诺；没有调整 ledger 或把不可测量算作零。

| L2 指标                                    | 对 main：base→head ms | 阈值隔离：base→head ms |
| ------------------------------------------ | --------------------- | ---------------------- |
| commands.discover.cold/nativeStartVerifyMs | 1.1→1.9 *             | 1.4→1.3                |
| image.concurrent/imageClientMs             | 196.8→329 *           | 292→308.4              |
| image.concurrent/imageDecodeMs             | 0.9→2.9 *             | 2.2→3.1 *              |
| image.concurrent/imageLookupMs             | 9.4→28.8 *            | 24.6→28.9              |
| image.concurrent/imageServerMs             | 101.1→207 *           | 176.3→192.4            |
| image.concurrent/ms                        | 55.5→96.5 *           | 81.5→89                |
| image.original.validated/ms                | 19.5→25.3 *           | 21.2→16.5              |
| image.single/imageDecodeMs                 | 0.8→1.1 *             | 0.9→1                  |
| image.single/imageLookupMs                 | 7.8→9.7 *             | 10.3→9.7               |
| image.single/imageSendFinishMs             | 15.1→8.8              | 10.7→17.8 *            |
| native.warm/nativeStartVerifyMs            | 1.4→3.1 *             | 2.8→6.3 *              |
| session.open.long/ms                       | 20.3→33.4 *           | 31.4→28.2              |
| session.open.native-long/ms                | 23.9→1.6              | 1.1→1.8 *              |
| session.open/ms                            | 44.2→55.2 *           | 52.4→45.7              |
| session.reclaim/roomKernelProjectMs        | 0.9→0.4               | 0.4→0.5 *              |
| startup.restart/ms                         | 84.6→109.1 *          | 63→98.8 *              |
| turn.cold/nativeStartHelperMs              | 0.3→0.8 *             | 1→0.6                  |
| turn.cold/nativeStartRpcSpawnMs            | 0.6→0.8 *             | 0.8→0.6                |
| turn.cold/nativeStartValidateMs            | 0.2→0.3 *             | 0.2→0.2                |
| turn.cold/nativeStartVerifyMs              | 4.9→3.9               | 2.6→3.3 *              |
| turn.cold/roomLiveProjectMs                | 0.3→0.4 *             | 0.3→0.3                |
| web.open.long/eventParseMs                 | 0.3→0.1               | 0.1→0.2 *              |
| web.open/eventParseMs                      | 0.3→0.5 *             | 0.2→0.8 *              |
| web.open/viewApplyMs                       | 0.2→0.3 *             | 0.3→0.3                |
| web.paced/eventParseMs                     | 0.4→0.6 *             | 1→1                    |
| web.paced/taskMs                           | 60.8→58.5             | 54.4→65.9 *            |
| web.paced/viewApplyMs                      | 1→1.8 *               | 1.7→1.6                |
| web.reopen/eventParseMs                    | 0.1→0.2 *             | 0→0.1                  |
| web.send.poll/clockUncertaintyMs           | 0.6→0.8 *             | 0.9→0.5                |
| web.send.poll/submitAnsweredMs             | 18.8→20.6             | 19.6→23.6 *            |
| web.send.poll/userEchoedMs                 | 16.9→11.9             | 10.5→12.8 *            |
| web.send.stream/promptDispatchedMs         | 63.2→35.2             | 44.7→55.9 *            |
| web.send.stream/runAdmittedMs              | 11→6.9                | 8.7→10.5 *             |
| web.send.stream/submitSentMs               | 3.9→2.5               | 2.6→3.3 *              |

## 交接与限制

用户两份已有文档保持原内容，不暂存；没有部署、重启或真实模型账号调用。
大历史仍有同步 projection/finish 和新增完整序列化的成本；小历史恢复同步 I/O 的不可抢占性。
没有验证 4/8 MiB 的性能最优性、生产 L3、真实账号、磁盘断电或多房间大历史并发容量。
unknown 的细粒度计数器来源与 legacy reload 根因不因本轮重跑通过而变为“已解决”。

D7 改回 **已推送待核验**。下一步由审查方核验第 9 轮要求；通过前不开始 D8。
若要修复 legacy reload，由 owner 另案授权定位文件监听链路，不混入 D7 阈值补丁。
