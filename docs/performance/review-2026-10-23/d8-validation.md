# D8 — Storage 边界、测量与验证

## 当前状态

**第12轮追加修复**：已拉取 `ba8892e`，完成原子准入/历史捕获修复、逐条审计及确定性负控；最终677/677、
三组pinned proof与perf gating/guard通过，待推送核验。见[本轮验证](d8a-round12-validation.md)及[逐项性能记录](d8a-round12-performance.md)。
D8b仍等待owner核验，不因本轮修复自动开工。下面保留第11轮及更早的交付证据，不代替第12轮结果。

### 第11轮历史交付

已拉取 `c6947a8` 并阅读 HANDOFF 第 11 轮；五个未推送提交已 rebase 到它之上，产品/test 改动逐字节恢复。
D8a 按澄清口径提交供核验：测试与 perf gating/guard 通过，候选差异逐条保留来源和未知边界，不要求零差异。
**D8a 已推送待核验**：测量证据 `02837de`、实现 `bf04234` 已在远端审查分支，`git ls-remote` 已确认。
未声称审查通过。D8b 等 owner 核验 D8a 后再开始；D9 未开始。
用户原有 opportunities.md 与未跟踪 proposals 文档备份在 `/tmp/rotom-review-D8/user/`，不纳入提交。

## Owner 本轮明确修订 C3

执行前核对发现：pi-durable 1.0.2 已有公开异步 Storage API；完整迁移 Harness 则需要搬迁事务回调、
registry、观察订阅和旧后端任务调度，并为父线程个人凭据/模型/工具建立桥接。
Owner 在本轮选择 **“调整为 Storage 边界”**，替代旧 C3 的 Harness+queue 线程归属：

```text
父线程：HTTP / 权限 / native transport / payer gate
        Durable Harness + mutation queue + 业务事务回调 / 镜像协调
           │ 完整存储操作、有界数据消息、关联 ID、durable ACK
           ▼
单 storage worker：RotomJournal + 公开 Pi Durable Storage
```

- D8a 先把跨边界的 journal 调用链改成显式异步，暂留主线程。Durable Storage 已是异步接口；
  复用其公共合同，不发明缺失的 upstream API，不改数据库 schema/document kinds 或 runtime patch。
- D8b 单 worker 同时承担两套存储操作，开关默认关闭；不能用第二个父线程数据库 writer 或私有表读取绕开它。
  Harness 的 Session 全局队列仍在父线程；不声称它或全部文档/投影 CPU 已 offload。
- 父线程继续拥有个人凭据与旧后端执行。D9 未授权提前执行，不能借此次 worker 删除旧执行能力。
- 原 ACK/unknown、不自动重放、完整事务、镜像顺序、权限隔离、shutdown 和故障注入要求保留。
  StorageRejected 只代表已证明无副作用的拒绝；丢 ACK 不等于事务回滚。
- 异步接口本身不是响应性收益；D8a 不宣称 CPU 已离开主线程。

公开合同依据：`pi-durable/dist/types.d.ts` 的 Storage/Session；`dist/session/session.js` 的
queue、adoption/publication 与 poisoned 状态。现有 mirror 在一个 Durable commit 内更新正文、
Authors/Sessions/NativeMirrorDoc；只在该提交成功后推进内存 cursor，顺序必须保留。

## 改动前基线

只运行现有测量器，未改 workload、计数器或 ledger：

```sh
node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs D8-baseline -- \
  npm run perf:measure -- --runs 1 --out /tmp/rotom-review-D8/base.json
```

源码 `2e92cbd`；darwin-arm64 / Node v24.18.0 / Apple M1 8 核。
exit=0，highLoad=false，load 2.38→3.38/8 核，wall 121971 ms。
`/tmp/rotom-review-D8/base.log` 和 `base.json` 保存原始数据。单轮 L2，不作为生产 L3 结论。
现有 D7 1/10/100 MiB 阶段证据保留在原记录；本轮尚未重跑或宣称新性能收益。

后续分别对 D8a 和启用/关闭 worker 的当前产物验证；worker 工作必须计入测量，不能把跨线程不可见
计数器当作零。消息复制、序列化、排队和关闭成本需要单独记录。

## D8a 检查点：按第 11 轮提交供核验

本节更新上方“改动前基线”的历史状态。产品实现与测量分开提交；没有同步兼容入口、第二个数据库
连接或新的全量缓存。journal 使用普通方法对象和 FIFO 异步入口；事务核仍同步留在主线程。
调用者、HTTP、proof/test 已迁移；seed attach、进度与已准入子任务用量均等待 ACK，关闭先 drain。
Room / 会话列表按连接合并，准备完成后重查成员、权限、generation 和 connection，才更新发送缓存。

### 独立提交与验证

| 项目                                | 结果                                                    | 证据（均在 `/tmp/rotom-review-D8/`）                                                   |
| ----------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| workload 等待 async API             | `a785208`，不改变工作负载                               | 原有 workload 断言保留                                                                 |
| 跨 await 投影计数隔离               | `7fcd6e9`，原生 AsyncLocalStorage / diagnostics_channel | counter-negative.log：旧实现错误计入 6 条而非自身 2 条 SQL                             |
| thinkingSnapshot 分类               | `0785f51`，保留原 thinking 类别和总解析量               | thinking-attribution.log；thinking-negative.log 去掉映射后 1≠2                         |
| 设置页导航同步修复                  | owner 另行批准；`93dbc7c`，只改测试                     | settings-navigation-fixed.log 7/7；negative 去掉前置条件后稳定复现 preact/hooks 错误   |
| 当前 format/check/lint/format:check | 通过                                                    | navigation-{format,check,lint,format-check}.log                                        |
| 当前默认全量                        | **670/670，0 skip，242965 ms**，原 concurrency=2        | navigation-full-test.log                                                               |
| pinned native ACK / 用量顺序        | passed，realProvider=false                              | d8a-verified-kernel.log；usage-negative-2.log 提前结算时准确失败                       |
| pinned native app                   | passed，realProvider=false                              | snapshot-app-proof.log；随后只合并 agentInfo/nativeGoal 的等价 head 查询及修复测试同步 |
| command / privacy / unknown         | passed，realAccounts=false                              | d8a-commands-proof.log；含 >64 MiB 历史和重启 fence                                    |
| 当前投影 / journal 专项             | 34/34                                                   | projection-read-focused.log                                                            |

新增验证覆盖 main/seed-worker 各三种延迟 attach ACK、六种 native 投影竞态/共享、异步计数隔离、
单次 roomSnapshot 的 pending/latest 等价性及 unresolved-command fence。这里的 seed worker 不是 D8b。

保留失败记录：早期机械迁移、Proxy 故障注入、缓存懒读取、初始事件顺序、关闭后读库与遗漏 await
均先失败后修复。默认全量先后出现同一设置页错误：d8a-verified-test-final.log 667/668、
final-projection-test.log 669/670；没有跳过。Owner 授权的一次原样重跑见 d8a-authorized-rerun.log，
668/668。再次发生后停下，另获授权修复根因：表单 click 只启动导航；确认页没有 import map。
现在 signedIn 在新应用文档就绪前返回“尚未登录”，仍使用原 until / 超时；没有 sleep、吞错或重放 POST。
新增“确认页尚非应用”的断言让负控确定失败，不再靠偶发时序证明修复。

### 性能调查与修正

- 最初把异步准备移到旧同步 span 外，view.kernel 子计数错误为零；该报告不能作为收益。
  已把 span 包住实际 roomState 准备，并隔离并发计数；不修改 workload、quiet 规则或 ledger。
- 两次 DOM 诊断比较创建节点、活动树、移除节点、解析器赋值和事件序列，均一致。
  未加诊断的五对交错样本中，reopen 的基线及 head 都有 1208/1232，poll 也落在已有容差内。
  不把最初 +24/+27 节点当作已证实的产品增量；诊断插桩时延不作为 L2。
- history 的额外 34 字符在基线和 head 都出现。实际 Room 3 秒 timer 的两次 stringify 共 34 字符，
  堆栈见 head-timer-probe.log。HTTP 历史正文始终 243098；没有删除或移出计数窗口。
- repeat5 的五对交错样本发现稳定变慢：大投影 kernel span 中位数 12.1→15.2 ms，区间不重叠。
  因此没有直接接受“护栏通过”：新增一次 FIFO roomSnapshot，复用 ID 确实相同的 pending/latest
  receipt，少一次 command-input 查询/解析；公共 agentInfo/nativeGoal 复用已有 sessionIfPresent，
  避免“存在检查→head→segment”重复查询。没有改 schema、权限或 unknown 语义。
- room-snapshot-negative.log 强制重复 decode 后，最小检查按 2≠1 失败。前后测试保留所有 receipt 字段，
  验证 missing、未执行、pending、handled、unknown 和未决命令标志，不只断言计数。

### 最终测量：仍有待归因的候选变化

| 对照                       | 结果                                     | 范围与负载                                             |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| repeat5/base → final-head5 | check 通过；25 worse / **0 slower**      | 每侧 5 轮；head highLoad=false，2.27→3.94/8，539391 ms |
| origin/main → 当前         | check / guard 通过；52 worse / 33 slower | 每侧 1 轮；highLoad=false，3.94→3.78/8，238887 ms      |

报告为 final-head5.json、final-ci-main/{base,head}.json；逐项比较为 final-comparison.json。
主干对照包含此前 D1–D7，不用其单轮时延替代紧邻基线的重复对照。所有结果只有 L1/L2，没有 L3。
最终大投影 kernel span 为 11.6/12.4/14.1/15.4/13.8 ms，中位数 13.8，区间已重叠，未被 compare 判慢；
不宣称它快于 12.1 ms 的基线。

当前 25 项 worse 分组列于此；[逐项性能记录](d8-performance-review.md)和[机器可读证据](d8-performance-evidence.json)
保留隔离比较全部 25 项、main 比较全部 52 项以及原始采样值和来源限定：

1. **21 项 turn.warm**：第 5 轮 244.8 ms、4 次 view；其余四轮 85–95.8 ms、2 次 view。
   基线五轮为 65.5–98.9 ms、2 次 view。额外投影关联 SQL、解析、entry/stats 扫描、字段序列化、
   live/inbox/kernel 投影、push 次数/字节。尚未确定慢样本来自 native dispatch、模型首输出还是父线程；
   不能仅称为噪声，更不能为了减少帧而延迟真实状态。
2. **3 项 turn.prewarmed**：fs.read.calls +1，durableStorage 解析 +2 / +302 字符。
   与此前 native-mirror 元数据重复读取的特征相符，但本轮尚未逐项确认来源；不放宽容差。
3. **1 项 web.send.poll/cdp.LayoutCount**：18→19，浏览器布局时序尚未归因。

此前执行方把“perf 不变差”误读为不允许任何计数器变差。第 11 轮已明确：测试、gating/guard 通过，
逐条说明差异；不能稳定复现的采样差异标为“采样差异，未归因”，不阻塞提交。以下诊断保留事实和未知，
不是追溯证明原慢样本的具体原因。三项预算已全部使用，owner 不批准额外对照，不再重跑以追求零差异。
D8b 的公开 Storage conformance、Context 取消、worker 故障/晚 ACK、单 writer、有界传输、镜像/权限及
shutdown 均尚未实现验证。用户两份文档保持逐字节不变；不部署、不重启服务。

## 三项有界诊断：已完成，按第 11 轮保留未归因采样差异

比较端保持 `0785f51` 与 `93dbc7c` 加当前 dirty 产品实现。插桩只在 `/tmp/rotom-review-D8/` 的
Node loader 中，临时 checkout 用后清理。没有改变仓库 workload、ledger、quiet 或产品推送节奏。
三项共 22 个 fixture 进程，全部 exit 0、highLoad=false；截短场景和插桩数字不能替代正式 L2/L3。

| 实验                 | 范围与结果                                                                                                                         | 原始证据（上述 `/tmp` 目录下）                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1. warm 自然时间线   | 五对交错；10/10 均为 2 views。base 74.0–101.3 ms，head 71.5–89.9 ms；未复现原慢样本。父线程最大 loop delay 13.5–21.0 ms            | `warm-pairs.log`、`warm-timeline/{base,head}-{1..5}.jsonl`、`warm-timeline-summary.json`；wall 150294 ms                         |
| 2. warm 状态屏障     | 三对交错；模型诊断响应等待已观察到 busy/live view 后继续，不改产品 timer。6/6 完成，安全期限均未触发。两侧均出现额外 view 和长等待 | `warm-controlled-pairs.log`、`warm-controlled/{base,head}-{1..3}.jsonl`；wall 101779 ms                                          |
| 3. prewarmed 与 poll | 三对交错；记录 fs read 栈/字节、durableStorage 解析形状、mirror 行数，以及 Chromium Layout 时间线。四项原差异都未复现              | `remaining-timeline-pairs.log`、`remaining-timeline/{base,head}-{1..3}.jsonl`、`remaining-timeline-summary.json`；wall 636001 ms |

第二项的可核对事实：

- 相同三次语义 view 时，base/head 的 view 字节均为 10202；SQL statements 173→159、rows 131→119、
  JSON parse calls 153→151。说明该受控路径没有增加每组状态的工作，不代表原五轮 worst 值已通过。
- base 第 3 轮为 327.6 ms / 5 views，dispatch 52.4 ms、first output 178.7 ms。gate 到 231.5 ms 才收到请求；
  模型屏障在 237.4 ms 才开始，因此不能用该屏障解释此前长等待。
- head 第 3 轮为 250.5 ms / 4 views，dispatch 49.5 ms、first output 181.9 ms。gate 于 71.3 ms 完成，
  模型请求到 242.1 ms 才到；屏障在 242.4 ms 才开始。head 第 2 轮还出现模型响应结束到后续 view 约 159 ms 的间隔。
- 上述三轮父线程最大 loop delay 14.6–18.6 ms，没有同等量级的事件循环阻塞。长间隔位于 measured
  gate/model handler 之外；尚不能区分 native 内部、传输或未插桩的异步等待。两侧都能出现慢阶段及额外 view，
  但原始 244.8 ms 样本没有这些时间戳，不能追溯断言同因，也不能将 21 项候选直接清零。
- view 记录覆盖 entries 数量、pending 状态/phase、busy/generation。`fields` 取错了 payload 层级而始终为空，
  不能据此声称逐字段等价；相同字节数也不等于逐字段等价。

第三项的可核对事实与边界：

- 六轮 prewarmed 都是 25 次 fs read、242540 bytes、18 次 durableStorage parse /1122 chars。
  NativeTail 增量读取分为 40515、6499 bytes，结束校验另读 47014 bytes；mirror 行数均为
  `0+5 → 5+1 → 6+0 → 6+0`。解析形状包含两份 151 字符的 native-mirror metadata。
- 原正式 head 第 3 轮为 26 reads、20 parses /1424 chars，但读取总字节仍为 242540。
  “读取分批不同、增加一次镜像 metadata 读取”与这些差值相容，**尚不是已证明根因**；不能仅凭 `2×151=302` 关闭问题。
- 六轮目标页面都恰有 18 次 Layout，和 CDP counter 一致；trace 无超时、无截断。全浏览器有 23–25 次 Layout，
  不能把其他 frame 的事件混入目标页面。原 19 次样本没有对应 trace，仍未归因。

本轮未改产品代码。`git diff -- src test | shasum -a 256` 与 `source-after-doc-format.sha` 相同；
此前默认全量 670/670 仍是当前产品改动的测试证据，不宣称本轮重跑了全量。诊断脚本和日志保留在 `/tmp`，
不将它们作为产品或测量规则提交。

## Rebase、交付与下一步

第 11 轮和 owner 本次指令已经否决额外 JSONL 分批/浏览器帧边界实验；不再申请或执行。按现有证据提交推送，
等待 owner 核验 D8a。未复现项保留“采样差异，未归因”；不能把暂缺原始调用栈补写为已证明来源。

| 原本地提交 | rebase 后 | 范围                         |
| ---------- | --------- | ---------------------------- |
| `ae35155`  | `e3826a7` | 基线和 Storage 边界          |
| `a785208`  | `e120828` | 测量 workload 等待 async API |
| `7fcd6e9`  | `9d70ac6` | async 投影计数隔离           |
| `0785f51`  | `4e8571a` | thinking 解析归因            |
| `93dbc7c`  | `28dd658` | 独立设置页测试同步修复       |

历史日志保留原哈希；rebase 仅整合远端 HANDOFF，不改测试或产品字节。已有默认全量 670/670 和
`perf:ci -- origin/main --runs 1` 仍对应当前产品内容；本次不新增性能运行，也未重复默认全量。
本次 `npm run format`、`check`、`lint`、`format:check` 通过，`node --test test/docs-examples.test.ts` 4/4；
日志为 `round11-{format,check,lint,format-check,doc-tests}.log`。逐项证据检查确认 25/52 项最差值与保留的样本一致，
第 11 轮原文逐字保留。用户两份文档未暂存，D8b/D9 等待，不因提交而自动开工。
