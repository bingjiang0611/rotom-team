# D8a — 第 12 轮原子性修复与逐项审计

基于审查提交 `ba8892e` 追加，不修改第 12 轮核验原文或原始复现脚本，不开始 D8b。
下面是本轮结果；此前 670/670 不能代替本轮验证。推送状态及提交号在 HANDOFF 同步。

## 1. 线性化边界

`createAsyncRotomJournal` 仍只调度一次同步 core 调用。没有增加跨 await 的数据库事务、同步兼容入口、第二 writer、
外层全局锁、跨线程 callback 或延迟重试。事务核仍在主线程；本轮不宣称 CPU 已移到 worker。

- `reserve(..., expectedHead, expectedBinding)` 在同步事务内重读 head、比对预期 head 和绑定、检查 running/unknown，
  再写 intent。绑定比较使用标准库 `isDeepStrictEqual`；也拒绝 head ID 不变的原地模型/版本变更。
  已有 request 的幂等返回不分配新 intent。`#rebind` 在自己的既有事务里执行相同绑定检查。
- `forkSeed` 将 existing、源 head/未决状态检查、revision/entries 快照、用户消息选择校验与目标 reserve 合为一次 core 调用。
  源只读部分与目标事务之间没有 await；journal 单 writer 的同步调用期间没有其他 core 操作能插入。
  返回的 entries 是本次解析得到的独立数组，调用方只读使用，不再在父线程重新读取增长中的源历史。
- 同付费人 native clone 仍使用公开 `SessionManager`。先把源文件加载到 manager，再用 `forkSource` 验证
  head/无未决操作/revision。之后原生分支方法只使用已加载的树和标签，不重新读取源文件。
  这样不仅避免取到较新的 leaf，也避免旧分支混入后来修改的 label。验证失败不开始物化，结果为 rejected。
- `handoffSeed` 将幂等判断、历史捕获和 handoff intent 合在一次 core 调用；不存在“读旧历史后，旧 prompt 刚好结束，
  再成功 reserve”的空隙。预留之后 pending fence 阻止新 prompt；原生 public projection 在父线程消费该快照。
  预留后的纯投影失败明确记 rejected；开始物化之后仍按既有 unknown 规则处理，不推断回滚、不自动重放。

## 2. journal 读 → 判断 → 写审计

审计对照：D8a 前 `2e92cbd` 与第 12 轮前 `ba8892e`；范围为 journal 的生产调用者及相邻生命周期路径。
`#track` 只是活动集合，`#operation` 只去重同一 request；**没有**把它们当作不同请求之间的互斥锁。

| 路径                                                                    | 处理结果与依据                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RotomExecutions.#execute`（run、compact、discover、setModel）          | 合并 authoritative 检查与 reserve。先前父线程的 head 检查仅为提前拒绝；最终 head/绑定/未决状态在 core intent 事务内判定。reserve 后同会话 pending fence 保持到结算，所以随后读取 attached session 不会换到另一付款 segment。                                                                                                                                               |
| `fork` / core `forkSeed`                                                | 合并 existing、源检查、entries/选择快照和目标预留；目标也带 admission head/绑定。新源运行若先入队则冲突，若在捕获后开始则不能改写已返回的 entries。已存在请求不再次物化。                                                                                                                                                                                                  |
| clone 分支                                                              | native manager 加载后再次核对捕获 revision 和源 pending 状态。这个 await 后不再读源文件，只从冻结的 manager 树分支；Stop 在物化前重查。没有拿 journal 最后一条 ID 冒充完整 native 标签快照。                                                                                                                                                                               |
| 外部历史导入 `importHistory`（本仓库没有原名为 forkSeed 的导入方法）    | 给目标 reserve 传入 admission head/绑定。输入 entries 属于调用者提供的数组，不来自并发增长的 source journal；保留原 public-history 转换与独立目标授权。原有 native module 加载 await 不曾构成同步事务。                                                                                                                                                                    |
| `handoff`                                                               | 新 `handoffSeed` 原子捕获 + 预留；core `handoff` 本身保留 expectedHead 和 unblocked 事务。退休与 seed 发生在 pending fence 之后；关闭未知不释放 writer。                                                                                                                                                                                                                   |
| `setThinkingLevel`                                                      | phase/status/unresolved-input 检查移到 `beginCommandInput(..., "execution")` 内与插入连续执行。首次 yield 前发布覆盖 admission + native mutation 的 drain；并保留之前已准入的 thinking drain，不能被后来的拒绝覆盖。未准入失败仍回给调用者，不把它误当 native mutation 失败；若 ACK 丢失，finish 仍检查持久化输入 fence。已准入失败保留给 finalization，不能吞掉 unknown。 |
| `queue` / `hasUnresolvedCommandInput`                                   | 早期读取不是锁。extension command 的 authoritative 排他条件一直在 `beginCommandInput` 中检查并插入；现在复用同一次 receipt 里的 unresolved 字段，少读一次同一 fence。普通 steer/follow-up 的 native snapshot await 在 D8a 前就存在，本轮不宣称它是跨 native RPC 的 journal 事务。                                                                                          |
| 进度、attach、子任务 usage、finish/fail                                 | `attach`、`progress`、`childUsage`、`finish`/`fail` 各自保持完整 core 操作。usage 不再走读 receipt 后再写的路径；close gate → drain admitted usage ACK → finish 顺序保留。finish 内连续核对 unresolved input、receipt、session、terminal result，再提交。                                                                                                                  |
| inference/refresh gate                                                  | 所有 journal await 放在授权之前；授权返回后同步重查 `running.aborted` 和 `gateState.active` 并回复，不再在权限检查之后增加存储等待。该执行 owner 在所有 finish/fail 前清除 active latch，因此仍能拒绝授权期间已结束的 attempt。没有新增凭据缓存或个人路由。                                                                                                                |
| `TeamKernel.close` 的 pending/canResume/planResume                      | 合并为 `planPendingResume`。排队 phase 更新若先发生，直接不建计划并继续关闭。真正的 Storage 错误仍抛出，未用 catch 掩盖关闭失败。                                                                                                                                                                                                                                          |
| startup `resumeInterrupted`                                             | receipt/phase 为已结算记录；本轮不把 latest 查询升级为跨所有后续动作的锁。D8a 前已经在判断后 await accounts/submit，再写 plan 状态；不是本次拆开的同步检查写入区间。现有 derived request ID、submit 的新 admission、unknown 不续跑规则保留。                                                                                                                               |
| mirror：count → cursor → suffix → Durable commit                        | 保留拆开。`#mirrors` 对同 conversation 真正串行执行；journal entries 只追加，cursor 与 suffix 使用相同排序且都排除 handoff seed，追加不会改变已消费前缀。Durable commit 成功才推进内存 cursor，失败保留原 cursor；不丢行、不提前推进 count。branch-history 标记可能领先本次 suffix，不能把读投影称作全数据库一致快照。                                                     |
| ensureBound / reconcile / upgradeKernel                                 | `bind` 在 core 自行验证不可变身份并提交；外层 hasConversation 是提示而非写入授权。启动 reconcile 是完整 core 操作。upgrade 的 expectedHead/unblocked 检查一直在其事务内；原地绑定变更如今还会被后续 reserve 的 admission 比较检出。                                                                                                                                        |
| account-idle / Team 配置操作                                            | account-idle 后的 retireUnusedOf、Harness/账户加载 await 在 D8a 前已存在，不是新拆开的 journal 同步写区间。不能把 idle 查询当作账户全局锁；配置操作保留实际 `execution.exclusive`，新的运行仍由 immutable receipt、账户 generation 和每次 inference gate 约束。                                                                                                            |
| thinking/native-info 缓存、Room/session-list、spend/workspace/HTTP 读取 | revision-keyed 缓存可能因交错多一次失效，但旧 revision 不能成为后续有效缓存；没有把读投影拿来代替 intent 检查。Room/list 在异步准备之后重查 connection、generation、权限与请求版本。只读响应不宣称所有字段同一数据库快照。                                                                                                                                                 |
| snapshot receipts                                                       | 另修一个实际异步转换遗漏：`map(async ...)` 改为 `await Promise.all(...)`，防止 JSON 输出 `{}`；新增真实 TeamKernel snapshot 序列化断言。                                                                                                                                                                                                                                   |

公开 Storage 的 Harness、mutation queue、业务事务 callback、镜像协调仍在父线程。没有修改 schema version、vendor/pin 或 legacy 执行能力。

## 3. 确定性回归与负控

`test/rotom-lifecycle.test.ts` 新增七项，使用实际 `RotomExecutions` / `RotomJournal` / FIFO facade，不用 sleep：

1. 在 run 第二次 `session` 读取后立即把真实 handoff finish 排入 FIFO：检查读到 A，finish 切到 B，reserve 必须抛
   `KernelRequestConflict`。断言新 request 不存在、只保留 handoff receipt、没有到达 `onReserved`。
2. 相同 head 的 kernel binding 升级也使旧 admission 冲突，没有分配 receipt。
3. pending 读到空后把源 run 排入队列，fork 必须冲突；成功捕获后源追加不能修改已捕获数组，clone revision 检查拒绝变更；幂等调用不返回再次物化的数据。
4. fork 与导入的目标 head 在队列中切换后，都不能在新付款 segment 上预留旧 admission。
5. handoff 捕获包含队列中较早 finish 的最后一条历史，不沿用旧 entries 读取结果。
6. thinking 的 execution 读取与 finalization 写入交错时，command-input admission 必须拒绝；并发输入仍只准入一个。
7. shutdown eligibility 读到 true 后进入 finalization：不建 resume、不报“不可恢复”错误；真正的存储错误仍传播。

负控 `/tmp/rotom-review-D8-round12/negative-reserve.mjs` 只在临时 loader 中移除 run 向 reserve 传递的预期 head/绑定。
同一实际调用链回归稳定失败：预期 `KernelRequestConflict`，却进入 `onReserved` 的测试停止器。
**负控没有实际启动错误的 native 派发**。原复现脚本仍保留旧调度反例；不是本次修复后的验收脚本。

## 4. 本轮验证

环境：darwin-arm64、Node 24.18.0、pinned rotom 0.1.26；不使用真实模型账号。
日志目录：`/tmp/rotom-review-D8-round12/`。

| 检查                                                 | 结果                                                                            | 证据                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| format / check / lint / format:check                 | 最终源码通过                                                                    | `final-format.log`、`delivery-{check,lint,format-check}.log`      |
| journal / lifecycle / room-info / mirror / seed 专项 | 90/90，0 skip；最终默认全量也覆盖这些测试                                       | `focused-final.log`                                               |
| 默认 `npm test`，concurrency=2                       | **最终 677/677，0 skip，248706 ms**                                             | `full-test-final.log`；首次同为677/677，保留 `full-test.log`      |
| 负控                                                 | 预期失败；去掉 admission 条件即错误分配 intent                                  | `negative-reserve.log`                                            |
| `npm run test:kernel`                                | 最终 passed，realProvider=false，async ACK顺序仍通过                            | `final-kernel-proof.log`                                          |
| `npm run test:kernel:app`                            | 最终 passed，realProvider=false；含 clean restart、handoff/fork、权限及 unknown | `final-app-proof.log`；配置staging抛错是fixture故障注入           |
| `node test/native-commands-proof.ts`                 | 最终 passed，realAccounts=false；含 live thinking、clone、隐私和 unknown fence  | `final-commands-proof.log`；旧观察点失败保留 `commands-proof.log` |
| `perf:ci -- origin/main --runs 1`                    | 最终 gating/guard通过；highLoad=false，main 34 worse /17 slower                 | `final-perf-ci.log`、`final-ci-main/{base,head}.json`             |

保留第一次 commands proof 失败：它仍拦截 facade 的 `sessionIfPresent`，但现有 `roomState` 已走 `roomSnapshot`，
因此计数为 0 而非 1。已改为观察实际的单次 `roomSnapshot`，保留“恰一次读取”及“不同完整 binding 不得看到目录”的断言。
没有跳过测试、放宽超时或弱化断言；这是 proof 观察点修正，不是修改生产投影以迎合测试。

## 5. 性能成本与限制

- 首次 main CI 为 253460 ms，load 3.92→10.75 /8 cores，highLoad=true，保留 `perf-ci.log`。
  最后自审发现授权之后仍有新增 journal await，故移除该间隙，并对这个新版本重新执行必需验证；不是为消除高负载或候选差异重跑。
  不新增原先否决的 JSONL 分批/浏览器帧边界诊断。最终版本为243298 ms、load 2.58→5 /8、highLoad=false；
  不采用初版高负载毫秒结论，也不把最终单轮时延认定为稳定回归或速度收益。
- 新 reserve 事务每次实际预留增加 `BEGIN IMMEDIATE` / `COMMIT` 两条语句。这是把条件检查和 intent 放入同一事务的必要成本，
  没有改 ledger、容差或 workload。删除授权后的重复receipt读取减少两次查询；普通有gate的路径可能抵消，
  discovery无inference gate，因此cold/warm各净增2条SQL。fork另外读取indexed revision，clone加载后再验证；没有新native/model请求。
- handoff 的原 projection 阶段现在覆盖合并 core 中的捕获与预留，保留全部工作；不能把该阶段直接与旧边界比较并声称速度收益。
- [本轮逐项性能记录](d8a-round12-performance.md)和[机器可读差异](d8a-round12-performance.json)列出最终main的34项worse，
  以及旧五轮D8a报告到最终单轮的4项worse /5项slower。后一组不是同时间交错实验；未精确定位的采样项仍标未归因。
  最终源码diff的SHA256与 `verified-source.sha` 相同，随后只整理文档；不把前一版验证冒充最终版。
- 没有验证 D8b worker、真实付费模型或部署环境。完成推送后等待 owner 核验 D8a，D8b 不开始。
