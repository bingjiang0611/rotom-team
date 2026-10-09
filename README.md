# rotom team

共享 Agent 会话，使用自己的模型账号。基于 Pi Pocket 和 Pi Durable 的自托管团队工作台。

**状态：`0.1.0-alpha.1`，原生 macOS / 可信团队预览。不是已完成的企业级产品，也不是安全沙箱。**

## 启动

已验证 Node.js 24.18.0 / npm 11.16.0。使用固定 checkout，从仓库目录执行：

```sh
npm ci
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

另有显式 `--rotom-kernel` 的[实验新会话后端](docs/ROTOM-KERNEL.md)：团队层只做协作/权限/凭据编排，由独立固定版本 rotom 执行。已接入 API 和桌面网页，但仅验证 scripted endpoint；不支持 Qoder、接力/fork/压缩或完整财务预算。默认、现有会话与备用机不变，不要把以下旧后端能力全部算给实验后端。安装和独立验证方式见[部署说明](docs/DEPLOYMENT.md)。

## 使用（默认后端）

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
- 个人配置和完整 skills 资产快照、明确版本激活、摘要验证，接力/重启/fork 不静默换配置。
- 项目 view/continue/fork 权限、原子用量归属、分别可撤销的同成员浏览器登录。
- SIWC 账号专属目录、公共历史安全压缩、离线摘要备份/恢复。实际验证范围见下方报告。

### 明确限制

- **可信团队而非隔离：** 原生工具以服务系统用户运行，可能读取该用户可访问的所有文件，包括凭据。文件分开和 `0700/0600` 权限不是成员之间的 OS 隔离。只能部署在专用账号下，邀请完全可信的人。
- 不自动导入私人 HOME；激活到共享会话的个人配置也对协作者可见。技能快照上限 8 MiB；摘要检查不是 OS 沙箱。
- 没有 SSO、个人执行节点或跨机器活跃 SQLite 迁移。项目目录权限不限制可信原生代码的 OS 文件访问。
- 接力后旧子 Agent 不能继续消耗旧成员账号，需要新建子 Agent。
- 个人账号的定时派发、自动 Goal 续跑暂不启用；不额外调用模型生成标题。保留上游实现用于回归，不把它们宣称为本产品能力。
- Qoder 只开放账号动态目录与实测白名单交集；没有完整 credits 财务账本或 rotom 的全套 Goal/Browser/Computer Use 合同。
- ChatGPT 订阅和 Qoder credits 不是美元账单。缺失额度保持 unknown；上游 Spend 页仅是已报告模型成本的估计，不用于结算或订阅额度硬限制。
- 已验证独立 SIWC 登录、刷新轮换和官方 API 工具读取；已有导入账号的 ChatGPT/Qoder 协作录像。Qoder 独立登录/刷新、远端 OAuth 回调/转移、备用 MacBook 与完整故障恢复仍未验证。
- Qoder 非官方，不代表获得上游支持、许可或团队托管批准。当前 SIWC 客户端注册名沿用 Pi，正式品牌/远端 host-session 方案待完成。
- worktree 从当前代码状态创建；从旧消息 fork 不代表代码也回到那一刻。
- 原 Pocket 数据不做自动迁移。请使用新的独立数据目录，不指向在用的 Pocket / rotom 数据。

## 数据与维护

```text
~/.rotom-team/
  config.json                 团队成员、邀请、配置
  pocket.sqlite               Durable 历史、任务与执行归属
  people/<member-id>/
    auth.json                 该成员的凭据（不进入会话）
    profile.json              模型选择与账号修订号
    models-store.json         私有账号目录缓存
    oauth-refresh/            刷新一次性尝试记录
  profiles/<member-id>.json    个人配置草稿
  configuration-snapshots/    不可变规则和完整技能资产
  agent/                      部署专用的 Pi 资源目录
  worktrees/                  隔离代码分支（不是安全沙箱）
```

使用 [部署与恢复说明](docs/DEPLOYMENT.md) 的离线备份工具；不要复制运行中的 SQLite 主文件。备份含秘密，恢复故意排除个人 auth，需独立重新登录；项目工作区另行备份。拒绝覆盖/跨路径恢复，不在存活任务中替换依赖或数据库。

## 验证

```sh
npm run check
npm run lint
npm run test:team
npm test
```

验证范围和已知问题见 [VERIFICATION.md](docs/VERIFICATION.md)。完整架构与后续路线见 [PRODUCT.md](docs/PRODUCT.md)。

## 来源和授权

Pi Pocket 基线：`edafa0b39f96af38c85830c7cda996c839b32012`；保留其 MIT `LICENSE`、源码归属和原始文档。Pi 运行时固定为 npm `1.0.2`，团队 patch 由摘要门禁可重复安装，不代表 rotom 的 fork runtime 已迁移。

Qoder 实现来自 rotom，源文件摘要见 `vendor/qoder/SOURCE.json`，未复制账号或凭据。**本组合项目为 UNLICENSED，private 包，不进行 npm 发布。** 开源和对外分发前需要单独确定新增代码及 Qoder 部分的授权；原 Pocket MIT 权利不受影响。当前只建立本地仓库，没有公开 origin。
