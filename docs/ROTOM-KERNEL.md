# rotom 执行内核迁移

## 当前状态：第二阶段，不是已切换

已实现并验证独立固定版本 rotom 的进程/RPC 边界，以及独立的持久执行器、原生 Provider 分派门禁和结果导入。**网页、备用机与现有会话仍使用原 Pi Durable 后端。** 这不是把 rotom 包装为一个模型 Provider；不会让两个 Agent 循环同时执行同一会话。没有复制模型凭据，没有修改 dev-agent 源码或当前用户的 rotom 安装。

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
- `rotom-executions.ts`：每次准入/分派通过宿主提供的 authorizer，携带固定 binding、operation 和**精确 team session ID**。目前 proof 的 authorizer 是 scripted 权限状态，**尚未连接 PocketApp 的真实成员/项目/账号/快照状态**；不能把测试中的 bool 当生产权限实现。
- `rotom-policy.mjs` 是 team 随调用加载的 extension，不改 rotom 产品。它包装 registry 中的原生 `stream/streamSimple`（而不是会吞异常的 observer hook），通过一次性 loopback capability 请求宿主授权，失败时不调用 native stream。OAuth refresh 也包门禁；启动早期认证/目录初始化和真实 refresh 生命周期尚未实测，不能宣称这些都已通过授权/持久化验证。
- 门禁安装必须用带 nonce 的无推理 RPC probe 回读成功后，才能送业务 prompt；UI dialog 默认取消。receipt 不因 probe success 升级为业务成功。Provider 请求仅开放当前研究的 OpenAI-compatible API 形状；image/deferred 原生方法去掉，不能保留未包装的付费旁路。Goal/Subagent 等仍未启用。
- 同账号下一次请求使用原生 `--session` 文件恢复，不是每轮丢掉历史的无状态 CLI。跨账号换绑拒绝，公共历史导入尚未实现。
- 只有 child 关闭后才读取其原生 JSONL，核验 version 3、session/cwd、完整尾行和 parent/id 树。单文件上限 32 MiB；超过后保持 unknown，升级条件为实现受检的流式/分页导入，不能跳过检查。
- 按 kernel session + entry ID 去重；改写旧 entry 拒绝。新 transcript entry、固定 payer 的原始 usage 和 terminal receipt 在一个 SQLite transaction 提交。`agent_settled` 没有新落盘 terminal response 时拒绝完成；`settled` **不是业务成功**，错误/abort 响应保留原值。原始 usage 不是完整账单，cost/credits 默认 unknown，不按零占位推断免费。
- backup 与 kernel writer 互相排除；restore 还排除 `kernel-homes/<member>/.pi/agent/auth.json` 及临时 gate capabilities。模型 grants 不从备份复活；新 HOME 只能位于该部署的成员目录，不借用个人 rotom HOME。

## 安装与检查

仅维护验证入口，**不要对正在执行会话的安装运行 npm ci**：

```sh
npm run install:kernel
npm run test:kernel
```

第一条命令在 `runtime/rotom/` 内按锁安装产品并检查 bootstrap，不更新全局 rotom。发行产品本身携带运行时，不执行依赖安装脚本。正式 server backend 启用前仍需后面的迁移门禁；当前根 launcher 不自动启动它。

`test:kernel` 是显式的真实产品/本地 scripted endpoint 验证，不是 Faux 代替 rotom，也不是付费模型测试。创建私有临时 HOME/workspace，仅 loopback endpoint，验证产品 `qoder-credits` command 存在、真正的原生 write/read、工具回传、最终回答、settled 与原生 JSONL 文件读取。产物留在工具输出所示私有临时目录，不进入 Git。JSONL readback 证明受测正常退出场景的文件内容，不宣称断电持久性。

## 迁移之前必须完成

1. **持久 backend/session/attempt 绑定与准入。** 现有 `harness.resume()` 只能恢复原 Durable 后端；新后端不能进入旧 input/resend/compaction tasks。相同 client request 返回同一持久 receipt。RPC id 仅关联响应，不是服务端幂等键。
2. **接入持久 receipt 与 unknown 管理。** 独立 journal 已覆盖跨重开 intent/unknown 隔离；仍需在网页命令和服务启动路径启用，并验证真实 host crash/工具进程存活窗口。传输断线可能已经执行；不得因新进程 idle 就自动重发。
3. **每次真正付费 dispatch 的授权。** 单独 HOME 不等于权限门禁；仍需核验成员/项目/账号代际/快照，包括 compaction 和子任务。独立登录且唯一 refresh writer；不复制或竞争刷新旧 team/rotom grants。此门禁完成前不把本模块接到真实团队账号。
4. **接入共享 UI/账本投影。** 独立 journal 已原子导入 native entry 与固定 payer usage；还未替换原 PocketApp 的 room/spend 展示与计数路径。stdout event 仅为 provisional，不能把最新评论者当付费人，不把 unknown credits 当零。
5. **配置与历史。** 原生 SessionManager 才是模型上下文权威，不能仅替换内存 messages。新账号接力需要显式只导入公开的配对文本/工具历史，移除 private thinking/signature/response ID；保留同账号原始记录。fork、comment-to-context、withdraw、快照与压缩须逐项映射，不能用 set_model 冒充接力。
6. **服务级备份与取消。** helper 已增加 kernel writer 排除和 native auth 剔除；还需接通服务 stop/revocation 的实时 abort、真实 grant 重新授权以及完整生命周期恢复。未知工具写入必须 readback，不重放。
7. 先 scripted 账号/权限/崩溃窗口测试，再用已授权的真实独立账号验证，最后才可迁移或部署；旧会话不静默转换。

## 本阶段证据

- 独立空 HOME/cache/npmrc 安装固定产品成功；`check-kernel`、typecheck、format/lint 通过。
- Wire 回归 12/12：fast settlement、Unicode 分帧、handled/rejected、断连、坏 JSON、错 id、超限、deadline、busy、命令旁路拒绝和 settled 后同批坏协议不能升级为成功。
- Journal/backup/RPC focused **21/21**。覆盖跨重开 unknown、不同 key/session 不能绕过、原子 transcript/usage 回滚、变更 entry 拒绝、缺失 terminal readback 拒绝、writer 锁与 restore credential 剔除。
- `test:kernel`：初始链路 3 次 loopback 模型请求，由真正 rotom 执行 write/read；扩展 proof 通过同账号恢复、重复 receipt 不派发、不重复记账、写入后撤权阻止第二次推理、429/503 无重试、首次超限拒绝后合法请求可继续、延迟准入复用最新原生历史。没有真实账号授权/推理。日志 `/tmp/rotom-team-kernel-guarded-proof.log`。
- 当前完整自动套件 **284/284，0 fail/skipped**，约 102 秒；日志 `/tmp/rotom-team-kernel-journal-final-suite.log`。此前 `test/browser.test.ts:420` 的 1265/1280 宽度失败保留为历史不稳定项，本次通过不证明该问题已修复；未修改浏览器。typecheck/format/lint 通过。
- 只读复核发现的三个误隔离问题（未落盘首次拒绝、异步准入旧状态、literal path alias）均修复并补回归，随后复核确认三项解决；不把 scoped review 当成整产品认证。
- 本阶段没有更新备用机或启用网页新后端，不声明完整迁移完成。
