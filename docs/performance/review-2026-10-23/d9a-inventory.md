# D9a — 只读归档：实现前盘点

基线 `7478123`，D8b 已通过第 14 轮核验。本提交只记录源码/测试盘点，不改变产品行为，不读取线上数据。只实施 D9a；D9b/D9c 等后续核验，不提前删除历史、旧开关记录或扩展目录。

## 边界与入口

| 范围     | 现状与需要封锁的路径                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 后端识别 | `app.rootOf(id)` + `sessionMeta(root)?.backend ?? "durable"`；不能以 kernel 是否加载判定历史所属后端，子会话跟随根会话                                             |
| 启动恢复 | `app.ts` 的 `#recover`、`execution.recover` 后无条件 `harness.resume()`；只阻止 HTTP submit 不够。Native journal 的 `resumeInterrupted` 是不同恢复路径，保持原合同 |
| 直接执行 | `commands.ts` 创建/提交/steer/follow-up、计划批准、schedule、goal、fork/resend/compact；`shell.ts` 和 browser routes 可直接执行                                    |
| 间接执行 | `ResendTask`、schedule task、subagent reporter/background anchor、goal check、待审批工具、queued submission；普通 conversation abort 不能保证覆盖 background 任务  |
| 写入旁路 | note、chat/reaction、配置/指令、上传、workspace 变更等；在副作用之前拒绝。授权/可见性和读取记账不得被一并禁止                                                      |
| 阅读     | `conversation()`、`room()`、历史分页、导出保留；不能在取得阅读 handle 时一概抛错                                                                                   |
| 模块执行 | `--no-rotom-kernel` 目前加载/监听旧 built-in/drop-in。只读模式不能加载它们；保留代码与用户 enabled 记录，后续步骤再删除实现                                        |

## 拟实施方式

- **保留 `--no-rotom-kernel`，定义为只读归档模式**。理由：没有原生 runtime/账号也可以查阅、授权和导出历史；拒绝新会话执行及所有恢复入口，并给出明确错误。原有 native lease/pending-state 启动保护不绕过。
- 在单 writer 租约内、Harness 接管 Storage 之前，使用**公开 Storage API**分页读取并持久化旧任务的中止结果、未回答输入和计划状态。不得访问私有 SQLite 表，不改 journal `user_version`。
- 不调用旧任务的 run/abort 回调来迁移；它们可能触发 shell、submit 或其它待恢复工作。保留原 checkpoint/恢复信息，记录明确的中止原因和用户可见持久提示；中止后续恢复不代表旧外部效果已撤销。
- 终止标记与提示采用同一原子提交，重启后只处理尚未中止的记录；不重复追加提示。Native 记录、payer/凭据路由与 unknown 保持不变。
- 新旧入口都走真实当前代码的拒绝检查；不引入允许旧执行的生产开关或测试旁路。

## 测试盘点与迁移

机械检索范围是默认 `test/*.test.ts`，共 **123 个文件**：`openApp(` 46 文件/70 个调用，`newSession(` 37/155，`say(` 20/92，三者并集 **47 文件**。这些是词法调用数，不是预估失败用例数；`team.test.ts` 等还独立创建旧 runtime。

- 读/投影/分页/权限/备份测试：把“先执行来造历史”改为明确命名的历史持久化 fixture；不把 `say` 偷换成伪造回答，不把旧创建悄悄重定向到 native。
- 旧执行成功断言：显式改为当前归档拒绝/不分发/不恢复断言，保留权限和历史完整性检查。Native 仍需的行为用 native proof 保留，不假装旧执行仍成立。
- parser、projection、policy、storage 等独立单元测试继续运行。D9a 不删除文件、不改默认测试命令、不加 skip、不放宽等待或断言；D9c 才处理确认已无用途的旧测试代码。
- 核心迁移夹具必须是旧定义/API 写出的**真实非空持久化数据**：已有对话与导出内容，以及 pending/running/waiting/background task、queued/placed input、schedule/goal/resend 等恢复状态；读取/导出保持，所有执行被拒，原子中止且二次重启不重复。
- 使用合成模型/凭据和私有临时目录。不得读取线上数据或使用真实账号。

## 本步验收与交付

`check`、`lint`、`format:check`、默认 `npm test`；`test:kernel:app` 与 `native-commands-proof` 各 off/on；机器锁内 `perf:ci` gating/ledger guard，逐项保留并解释 worse，采样不复现可记“采样差异，未归因”。不改 workload、quiet、ledger 或容差来抹掉成本。

先盘点提交，再实现提交，均以 `D9` 开头。D9a 推送后更新 HANDOFF 为“已推送待核验（D9a）”，停下等 owner 核验。后续删除的无引用证据属于 D9b/D9c，不在本提交冒充已完成。
