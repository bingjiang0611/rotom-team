# rotom team

共享 Agent 会话，使用自己的模型账号。基于 Pi Pocket 和 Pi Durable 的自托管团队工作台。

**状态：`0.1.0-alpha.1`，原生 macOS / 可信团队预览。不是已完成的企业级产品，也不是安全沙箱。**

## 启动

需要 Node.js 24+。从仓库目录执行：

```sh
npm ci --ignore-scripts
npm start -- --cwd /absolute/path/to/project
```

默认监听 `127.0.0.1:8787`，数据在 `~/.rotom-team`。终端打印的一次登录入口等同于管理员钥匙，不要发送给同事；登录后使用应用的邀请功能。

```sh
# 指定独立数据目录和端口
npm start -- --data /absolute/path/to/team-data --port 8787 --cwd /absolute/path/to/project

# 无账号、无真实模型请求、无推理费用的双人演示
npm run demo
```

演示默认在 `127.0.0.1:8790`，打印两位演示成员的登录入口；用两个独立浏览器 profile 测试。退出会删除演示数据。演示不能证明真实 Provider 端的 OAuth、计费或恢复。

当前不配置隧道、Tailscale 或公网代理。需要其他设备访问时再明确部署入口；不要直接把可信原生模式暴露给不信任的人。`--host` 由部署者显式配置，远程部署应另行配置 HTTPS 和访问控制。

## 使用

1. 管理员启动服务并邀请成员。
2. 每个成员打开 **My model accounts**，自行连接 ChatGPT 或 Qoder。
3. 创建会话、选择自己的模型、提交任务。项目文件和命令在服务器执行。
4. 其他成员可以查看和评论；会话空闲后直接发送任务即接力，使用接力者自己的模型账号。
5. 需要并行探索时 fork，推荐勾选独立 Git worktree。

### 当前实现

- 每位成员独立的凭据文件、模型目录、账号修订号及默认模型。
- ChatGPT OAuth、Qoder 浏览器登录接入；不会读取原来的 `~/.pi/agent/auth.json`，也不会借用服务端 `OPENAI_API_KEY`。
- Durable 共享历史、断线重连、个人执行归属、原生文件/命令工具。
- 只展示本人可用模型；拒绝在 API 中指定其他成员的模型路由。
- 运行中不能换付费人；其他成员应评论、等待、停止后接力或 fork。当前不支持跨账号排队。
- 接力时保留可见文本及工具历史；跨账号不传递 Provider 私有推理签名、response ID。原始历史不改写。此投影有意非逐字无损。
- fork 使用发起人的模型账号；重启恢复不回退管理员账号；重复提交按请求 ID 去重。
- 提供原生项目规则、项目 skills 和会话共享 Instructions。配置不会因为另一个人查看会话而自动切换。

### 明确限制

- **可信团队而非隔离：** 原生工具以服务系统用户运行，可能读取该用户可访问的所有文件，包括凭据。文件分开和 `0700/0600` 权限不是成员之间的 OS 隔离。只能部署在专用账号下，邀请完全可信的人。
- **个人 skills / AGENTS.md 配置档及不可变配置快照尚未完成。** 不导入成员私人 HOME；目前用仓库规则、项目 skills、显式会话 Instructions。详见 [产品方案](docs/PRODUCT.md)。
- 当前没有项目级 RBAC、SSO、个人电脑执行节点或生产级备份/升级迁移工具。
- 含跨账号历史的压缩会明确拒绝；长会话须先写公共交接说明并重置上下文。接力后旧子 Agent 不能继续消耗旧成员账号，需要新建子 Agent。
- Pocket 的原生“仅某个会话”邀请仍不能 fork；允许接力的普通成员可以 fork。细粒度 fork 授权待实现。
- 个人账号的定时派发、自动 Goal 续跑暂不启用；不额外调用模型生成标题。保留上游实现用于回归，不把它们宣称为本产品能力。
- Qoder 当前使用已验证基础目录 `lite` / `performance`；动态账号目录、credits 面板和 rotom 的完整 Goal/Browser/Computer Use 合同尚未迁移。
- ChatGPT 订阅和 Qoder credits 不是美元账单。缺失额度保持 unknown；上游 Spend 页仅是已报告模型成本的估计，不用于结算或订阅额度硬限制。
- ChatGPT 账号资格、OAuth 远端回调以及 Qoder 真实登录/推理需要真实环境验证。Qoder 是非官方接入，不代表获得上游支持、许可或团队托管批准。
- worktree 从当前代码状态创建；从旧消息 fork 不代表代码也回到那一刻。
- 原 Pocket 数据不做自动迁移。请使用新的独立数据目录，不指向在用的 Pocket / rotom 数据。

## 数据与维护

```text
~/.rotom-team/
  config.json                 团队成员、邀请、配置
  pocket.sqlite               Durable 历史、任务与执行归属
  people/<member-id>/
    auth.json                 该成员的凭据（不进入会话）
    profile.json              非敏感模型选择与账号修订号
  agent/                      部署专用的 Pi 资源目录
  worktrees/                  隔离代码分支（不是安全沙箱）
```

备份应在服务停止后复制**整个数据目录及项目工作区**到私有位置；不要只复制一个运行中的 SQLite 主文件。凭据包含在备份中，应按秘密管理。升级前备份，不在存活任务中直接替换依赖或数据库。

## 验证

```sh
npm run check
npm run lint
npm run test:team
npm test
```

验证范围和已知问题见 [VERIFICATION.md](docs/VERIFICATION.md)。完整架构与后续路线见 [PRODUCT.md](docs/PRODUCT.md)。

## 来源和授权

Pi Pocket 基线：`edafa0b39f96af38c85830c7cda996c839b32012`；保留其 MIT `LICENSE`、源码归属和原始文档。Pi 运行时固定为 npm `1.0.2`，不代表 rotom 的 fork runtime 已迁移。

Qoder 实现来自 rotom，源文件摘要见 `vendor/qoder/SOURCE.json`，未复制账号或凭据。**本组合项目为 UNLICENSED，private 包，不进行 npm 发布。** 开源和对外分发前需要单独确定新增代码及 Qoder 部分的授权；原 Pocket MIT 权利不受影响。当前只建立本地仓库，没有公开 origin。
