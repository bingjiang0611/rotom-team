# rotom 执行内核迁移

## 当前合同与证据入口

当前实现及 R1–R8 验收以 [NATIVE-DELIVERY.md](NATIVE-DELIVERY.md) 为准；恢复操作以 [NATIVE-RECOVERY.md](NATIVE-RECOVERY.md) 为准。现已加入 Qoder access-only bridge、不可变 segment/public history、handoff/fork/原生 compact、配置激活与 Credit 投影。独立真实账号的指定 ChatGPT↔Qoder 路径已有证据；最终 `e31e9ca` 产物已在备用机完成冷安装、312/312、原生 smoke、UI、重启/恢复与受限回滚验证，具体范围及证据见验收矩阵。Native 仍显式 opt-in，旧会话不改后端；附件、任意旧 mutation、子 Agent/Goal 和完整财务账本不在本次核心范围。USD 预算无法证明时拒绝，不以零费用放行。

**以下为第三阶段及更早的历史记录，不是当前功能缺口清单。** 保留当时的验证与限制，不能用它覆盖上述当前合同。

## 历史状态：第三阶段，可选新会话后端

已接入 PocketApp 的真实授权状态、HTTP API 和网页。**仅显式 `--rotom-kernel` 启动并选择 rotom 的新会话使用新后端；默认、现有会话与备用机部署仍使用原 Pi Durable 后端。** 这不是把 rotom 包装为一个模型 Provider；不会让两个 Agent 循环同时执行同一会话。没有复制刷新凭据，没有修改 dev-agent 源码或当前用户的 rotom 安装。新路径目前只用 synthetic accounts / loopback scripted endpoint 验证，不继承旧后端的真实账号证据。

长期边界：team 拥有成员/项目权限、协作、不可变付费人、配置快照、请求准入和共享视图；rotom 拥有模型接入、Agent 循环、工具、扩展和原生会话。rotom 不引入团队业务概念，也不依赖 team。team 固定已验证的产品版本，通过版本化适配边界升级，不能追随全局 CLI 或开发 checkout 自动变化。

## 已实现

- `runtime/rotom/package.json` / lock：单独安装公开 `@bingjiang0611/rotom@0.1.14`，npm lock 绑定 registry tarball SRI。不是复用本机全局安装，不是 `file:` 引用 dev-agent。
- `runtime/rotom/pin.json`：产品 bootstrap 的 SHA-256。`verifyRotomKernel()` 检查 canonical 路径、版本、名称、公开入口、摘要及可执行性；真正启动仍由产品 launcher 完成它原有的 bundled Pi/resource gate。这不是整个安装树的逐字节审计，也不是 OS 沙箱。
- `src/server/rotom-kernel.ts`：调用真正的公开 `bin/rotom --mode rpc`。使用显式私有 HOME、agent directory、workspace、provider/model；不合并维护进程环境、不传 API key、不查 PATH/global rotom。启动模型与请求不一致则拒绝，不 fallback。
- 产品扩展正常加载；当前验证工具面明确限定 `read,write,edit,bash`。没有宣称完整工具/Goal/Subagent/Browser 能力迁移。受门禁包装的原生调用显式使用 `maxRetries:0`、`transport:sse`；当前 OpenAI-compatible scripted endpoint 的 429/503 各只派发一次，不据此宣称所有第三方 Provider 都支持这些选项。
- `src/server/rotom-rpc.ts`：只按 LF 分帧，正确处理分块 UTF-8、CRLF、U+2028/U+2029；响应按 id+command 关联。持续排空但不保留 stderr，不打印 prompt/工具正文或认证信息。
- prompt response 只证明准入；`agent_end` 不证明执行结束。等待 `agent_settled`，区分 `handled`、明确 `rejected` 和 `unknown`。同一个进程忙时不自动排队、不换账号；断连/超时/坏协议后 fence 后续写入，绝不自动重新启动/重发。
- 未接入的交互式 dialog 一律取消，不默认批准；未实现的模型切换、fork、compact、steer、bash RPC 等命令明确拒绝。控制请求不能绕过 prompt 的 busy 检查。
- stdin 至多 16 个 pending records，单请求 1 MiB、单 stdout record 8 MiB；超界保持 unknown，不截断后伪装成功。需要大附件或超大 transcript 时，应先增加有界分页/附件合同并补测试，不能简单去掉上限。
- `close()` 等待直属 child 退出；不是 detached descendants 已关闭、工具已回滚或外部副作用未发生的证明。

## 第二阶段：持久执行器

- `rotom-journal.ts`：私有 `kernel.sqlite`，独立 schema `user_version=1`；同步 FULL SQLite commit 在 child 启动/send 之前写入 dispatch-intent。绑定 team session、成员、账号代际、kernel 版本、模型、配置摘要、HOME 和 cwd；同 session 不允许静默更换付费人/配置。
- 相同 request key + 内容返回同一 receipt；改内容拒绝。未完成 intent 在重开时变为 unknown；unknown 对整个成员 HOME 保持派发隔离，不能换 request/session ID 继续。此状态没有自动重试/自动清除路径。
- `kernel.lock` 不因记录的父 PID 已消失而自动删除，因为原 kernel/tool descendants 可能仍活着。只有观察到本次 child 关闭后，执行器才释放当前运行占用；journal 存活期间拒绝备份。未知外部副作用仍需单独核对，不能根据进程退出断言回滚。
- `rotom-executions.ts`：每次准入/分派通过宿主提供的 authorizer，携带固定 binding、operation 和**精确 team session ID**。独立 proof 使用 scripted authorizer；应用入口由 `team-kernel.ts` 查询实际成员、项目、账号代际和冻结快照，不依赖测试 bool。
- `rotom-policy.mjs` 是 team 随调用加载的 extension，不改 rotom 产品。它包装 registry 中的原生 `stream/streamSimple`（而不是会吞异常的 observer hook），通过一次性 loopback capability 请求宿主授权，失败时不调用 native stream。OAuth refresh 也包门禁；启动早期认证/目录初始化和真实 refresh 生命周期尚未实测，不能宣称这些都已通过授权/持久化验证。
- 门禁安装必须用带 nonce 的无推理 RPC probe 回读成功后，才能送业务 prompt；UI dialog 默认取消。receipt 不因 probe success 升级为业务成功。Provider 请求仅开放当前研究的 OpenAI-compatible API 形状；image/deferred 原生方法去掉，不能保留未包装的付费旁路。Goal/Subagent 等仍未启用。
- 同账号下一次请求使用原生 `--session` 文件恢复，不是每轮丢掉历史的无状态 CLI。跨账号换绑拒绝，公共历史导入尚未实现。
- 只有 child 关闭后才读取其原生 JSONL，核验 version 3、session/cwd、完整尾行和 parent/id 树。单文件上限 32 MiB；超过后保持 unknown，升级条件为实现受检的流式/分页导入，不能跳过检查。
- 按 kernel session + entry ID 去重；改写旧 entry 拒绝。新 transcript entry、固定 payer 的原始 usage 和 terminal receipt 在一个 SQLite transaction 提交。`agent_settled` 没有新落盘 terminal response 时拒绝完成；`settled` **不是业务成功**，错误/abort 响应保留原值。原始 usage 不是完整账单，cost/credits 默认 unknown，不按零占位推断免费。
- backup 与 kernel writer 互相排除；restore 还排除 `kernel-homes/<member>/.pi/agent/auth.json` 及临时 gate capabilities。模型 grants 不从备份复活；新 HOME 只能位于该部署的成员目录，不借用个人 rotom HOME。

## 第三阶段：应用与网页

- `SessionMeta.backend` 缺省仍为 Durable，显式 `rotom` 绑定独立 journal。新会话先冻结配置；旧 API 的 submit/fork/compact/model 等路径拒绝 native 会话，不 fallback。只允许读取 native snapshot/configuration、提交普通文本和停止执行。
- `team-kernel.ts` 在准入和每次推理时检查可见性、项目 continue、driver、固定发起人、个人 provider alias/代际、workspace 和快照摘要；另一个 viewer/driver 不能借用固定 payer 发送。授权 driver 可以停止；角色、项目与预算变化触发撤权检查和 abort。跨后端共享 account-idle 检查。
- 父进程现有 credential store 是唯一 refresh writer。`team-accounts.ts` 在门禁调用时取得当前 `ModelAuth`；子进程只收到单次请求 auth，不复制 OAuth grant，不落入 HOME/prompt/events。broker 模式禁用子进程刷新，拒绝 HOME 内已有 grant；只容许 native AuthStorage 自建的小型空 `{}` 文件。当前只开放三种 OpenAI-compatible API 形状；Qoder 拒绝。SIWC payload 转换复用纯 helper，推理/工具循环仍是原生 rotom；真实 SIWC/Codex 刷新与推理尚未在新路径验证。
- 配置使用显式 frozen context/skills，禁止自动发现 live workspace context、skills 和 prompt templates；启动回读模型与 thinking level。浏览器公共投影剔除私有推理字段，展示固定 payer、原始 usage、最近 100 条 receipt。美元成本仍 unknown；设有成员/会话美元预算时拒绝执行，不绕过预算或用零占位。
- 网页复用 Pocket transcript/composer。request ID 在 POST 前按成员/会话存入 localStorage；重开只 GET 对账，不自动重发。网络/5xx/unknown 保留 pending；明确的准入 4xx 允许修正。结果在 child 关闭并导入后出现，1.5 秒轮询不是实时 token stream。支持文本、工具结果与停止；不支持附件、接力、fork、压缩、子 Agent/Goal 或原会话的完整 mutation 面。
- 未完成/unknown intent 对该成员 HOME 隔离；关闭 feature flag 后也不能绕过：在取得 harness lock 后只读检查 journal，发现 pending/unknown 拒绝启动。没有自动清理 unknown 或 lease 的恢复按钮。
- 创建会话涉及两个独立 SQLite store，不是跨库事务；应用创建中断/回滚可能留下 orphan journal binding。当前不自动协调/删除，尚无跨库 crash/reconciliation 验证；大规模开放前需实现并测试显式对账。

## 安装与检查

**不要对正在执行会话的安装运行 npm ci**：

```sh
npm run install:kernel
npm run test:kernel
npm run test:kernel:app

# 实验部署：使用独立数据目录，默认仍是 loopback
npm start -- --rotom-kernel --data /absolute/experimental-team-data --cwd /absolute/workspace
```

第一条命令在 `runtime/rotom/` 内按锁安装产品并检查 bootstrap，不更新全局 rotom。发行产品本身携带运行时，不执行依赖安装脚本。根 launcher 不自动安装产品；不带 `--rotom-kernel` 不启用新后端。启用后在 New session → Execution engine 显式选择 rotom；先选好自己的受支持模型。不要据此替换现有部署。

`test:kernel` 是显式的真实产品/本地 scripted endpoint 验证，不是 Faux 代替 rotom，也不是付费模型测试。创建私有临时 HOME/workspace，仅 loopback endpoint，验证产品 `qoder-credits` command 存在、真正的原生 write/read、工具回传、最终回答、settled 与原生 JSONL 文件读取。产物留在工具输出所示私有临时目录，不进入 Git。JSONL readback 证明受测正常退出场景的文件内容，不宣称断电持久性。

## 完整迁移之前必须完成

1. **真实 Provider 与生命周期。** 新路径的独立 SIWC/Codex grant、真实刷新/推理、撤销/到期与 Qoder 路由尚未验证；不复制或竞争刷新旧 team/rotom grants，不把脚本验证当服务商批准。
2. **恢复。** 补齐跨库创建对账、真实 host crash/断电、直属 child 之外的工具存活与外部副作用窗口，以及明确的 unknown 人工核对流程。不得因新进程 idle 就自动重发，也不能直接删除 lease。
3. **共享上下文与能力。** 原生 SessionManager 是模型上下文权威。接力须显式投影公开的配对文本/工具历史并移除私有状态；fork、comment-to-context、withdraw、压缩、附件与子任务须逐项映射和授权，不能用 set_model 冒充接力。
4. **账本与网页。** 原始 usage 不等于账单；尚未把 native 用量接入完整 Spend/预算执行路径。补充流式事件、移动端新 pane、Stop 按钮及断线 pending 的真实 UI 验证；当前拒绝预算而不是静默放行。
5. **部署与备份恢复。** 实验应用已接 stop/revocation，但旧备用机未变。真实 grant 重新授权、跨版本恢复与设备实测仍待完成；先验收再部署，旧会话不静默转换。

## 第二阶段历史证据

- 独立空 HOME/cache/npmrc 安装固定产品成功；`check-kernel`、typecheck、format/lint 通过。
- Wire 回归 12/12：fast settlement、Unicode 分帧、handled/rejected、断连、坏 JSON、错 id、超限、deadline、busy、命令旁路拒绝和 settled 后同批坏协议不能升级为成功。
- Journal/backup/RPC focused **21/21**。覆盖跨重开 unknown、不同 key/session 不能绕过、原子 transcript/usage 回滚、变更 entry 拒绝、缺失 terminal readback 拒绝、writer 锁与 restore credential 剔除。
- `test:kernel`：初始链路 3 次 loopback 模型请求，由真正 rotom 执行 write/read；扩展 proof 通过同账号恢复、重复 receipt 不派发、不重复记账、写入后撤权阻止第二次推理、429/503 无重试、首次超限拒绝后合法请求可继续、延迟准入复用最新原生历史。没有真实账号授权/推理。日志 `/tmp/rotom-team-kernel-guarded-proof.log`。
- 当前完整自动套件 **284/284，0 fail/skipped**，约 102 秒；日志 `/tmp/rotom-team-kernel-journal-final-suite.log`。此前 `test/browser.test.ts:420` 的 1265/1280 宽度失败保留为历史不稳定项，本次通过不证明该问题已修复；未修改浏览器。typecheck/format/lint 通过。
- 只读复核发现的三个误隔离问题（未落盘首次拒绝、异步准入旧状态、literal path alias）均修复并补回归，随后复核确认三项解决；不把 scoped review 当成整产品认证。
- 第二阶段没有更新备用机或启用网页新后端，不声明完整迁移完成。

## 第三阶段证据

- typecheck、lint、format、修改过的 browser JS / policy syntax 与 diff 检查通过。团队/配置/OAuth/journal/RPC/backup/device focused **46/46**，日志 `/tmp/rotom-team-kernel-app-focused.log`。
- `test:kernel` 兼容 proof 通过（15 次 inference authorization checks），日志 `/tmp/rotom-team-kernel-app-final-native.log`。`test:kernel:app` 经真实 PocketApp+HTTP+固定 rotom 验证创建、提交、读取、撤权 abort、冻结配置、固定 payer、私有请求 auth 不持久化、项目/代际/预算门禁、重启幂等、同历史恢复、slash/过长 request ID 准入前拒绝、非法 backend 类型不创建会话或降级，以及关闭 backend 不可绕过 unknown；4 次 loopback 请求，日志 `/tmp/rotom-team-kernel-app-final-http.log`。不涉及真实账号。
- Chrome Relay 桌面 1512px 实测：原生历史/工具展示、slash 拒绝后正常发送、settled receipt、重新打开后 receipt 数仍为 3、显式新建 native 会话（无推理）与旧后端相邻视图。最后界面使用更新后的右侧 Send / Reasoning 标签。私有证据位于 UI fixture `pi-pocket-test-3tUJP1/kernel-ui-verification.json`，fixture 已停止。移动端、实际 Stop 点击和飞行中断线恢复 UI 尚未验证；API abort 测试不能替代这些。
- **最终完整 `npm test` 为 284/285，1 fail，0 skipped**，约 115 秒，`/tmp/rotom-team-kernel-app-verified-suite.log`；唯一失败为 `browser.test.ts:420` 的 1265/1280。未改 browser/schedules 实现或测试，不宣称全绿。
- 保留较早完整 **283/285**（browser + schedules requestedBy 顺序）和中间 **281/285**（browser + 3 个 RPC ack deadline）日志：`/tmp/rotom-team-kernel-app-suite.log`、`/tmp/rotom-team-kernel-app-final-suite.log`。调度当前/干净 `4212b49` 源码副本（相同安装依赖）单跑均 **7/7**；最终全量通过不证明已修复顺序不稳定。
- RPC 隔离诊断也出现 ack deadline（10/12）。修正测试测量边界：等待 wire fixture 明确 ready 后才发命令，保留原 1 秒 ack / 500ms 异常执行限时，不改变生产超时；异常用例另断言准确失败原因，避免仅凭启动超时假通过。修正后独立 **12/12**，最终全量相关用例也通过，`/tmp/rotom-team-kernel-app-rpc-ready.log`。
- 只读 reviewer 的两项发现（禁用后端绕过 unknown、无 receipt 的准入拒绝卡住浏览器 pending）已修复并补回归，复核确认解决；reviewer 未执行命令，不视为整产品认证。备用机与全局 rotom 未改变，未推送/发布。
