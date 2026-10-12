# rotom team

共享 Agent 会话，使用自己的模型账号。基于 Pi Pocket 和 Pi Durable 的自托管团队工作台。

**当前版本：`0.1.1`。原生 macOS / 完全可信团队预览，不是企业级安全沙箱。** 包版本以 [package.json](package.json) 为准，执行内核另由 [pin.json](runtime/rotom/pin.json) 固定。

新会话默认由 rotom 执行。团队层提供共享 Transcript、权限、个人账号和恢复，不另运行一个 Agent 循环。当前能力与限制见 [产品合同](docs/PRODUCT.md)；项目 instructions、skills、MCP、扩展及成员 MCP 登录见 [配置指南](docs/CONFIGURATION.md)。旧阶段计划不作为当前合同。

## 启动

使用 Node.js 24，从仓库目录执行：

```sh
npm ci
npm run install:kernel
npm start -- --cwd /absolute/path/to/project
```

默认监听 `127.0.0.1:8787`，数据在 `~/.rotom-team`。终端打印的一次登录入口等同于管理员钥匙，不要发送给同事；登录后使用应用的邀请功能。

```sh
# 指定独立数据目录和端口
npm start -- --data /absolute/path/to/team-data --port 8787 --cwd /absolute/path/to/project

# synthetic accounts / loopback model，无真实模型请求
npm run demo:kernel

# 仅使用旧 Durable 后端
npm start -- --no-rotom-kernel --cwd /absolute/path/to/project
```

演示使用独立临时数据，不证明真实 Provider 的 OAuth、计费或恢复。既有 Durable 会话保持原后端，不自动迁移。远程入口需另行配置 HTTPS 或可信 SSH 转发；不要直接将服务暴露给不信任的人。

## 使用

1. 管理员启动服务并邀请完全可信的成员。
2. 每位成员连接自己的模型账号，选择自己的可用模型。
3. 在项目中创建会话并提交任务。命令、浏览器和桌面操作在服务主机执行。
4. 其他成员可以查看、评论；空闲后发送新任务即接力，使用发送者自己的账号。运行中不能更换付费人。
5. 需要独立探索时 fork；项目权限不会因 fork 扩大。worktree 隔离代码分支，不隔离 OS 权限，也不保证代码回到旧消息时点。

项目配置每次运行重新加载。OAuth 型 MCP 由每位成员在 **MCP sign-ins** 独立登录。旧冻结配置会话保留原摘要，不自动切换为项目配置。

## 安全与限制

- **完全可信团队，而非成员间隔离。** 工具以服务 OS 用户运行，可能读取该用户可访问的所有文件，包括其他成员凭据；Chrome Relay 和桌面也由成员共享。使用专用系统账号。
- 模型授权由父进程 gate 按付费人、Provider 和模型检查；失效账号不借用管理员或其他成员的账号。子 Agent 沿用父运行的付费人和模型，旧 gate 关闭后不能继续授权。
- 跨账号共享公开文本和配对工具历史，不转发 thinking、签名和 response ID。公共镜像不是逐字无损，也不是 OS 文件访问控制。
- 未知执行、工具关闭状态和刷新结果不自动重放。连续自动续跑有上限；恢复步骤见 [NATIVE-RECOVERY.md](docs/NATIVE-RECOVERY.md)。
- rotom 会话暂不支持附件和可证明的 USD 预算。Token、美元估算、订阅额度与 Qoder credits 不是同一账本；缺失保持 unknown。
- 没有 SSO、多租户沙箱、个人执行节点或跨机器活跃 SQLite 迁移。原生会话也不继承 Durable 的全部扩展能力。
- Qoder 非官方；登录或额度读取成功不代表服务商许可或托管批准。授权和分发限制见 [PROVIDER-POLICY.md](docs/PROVIDER-POLICY.md)。

## 数据与维护

Durable 状态和原生 journal 保存在数据目录。模型凭据按成员保存；原生运行使用成员的 `kernel-homes/`，MCP OAuth 授权不与模型授权混用。项目配置和工作区不属于模型凭据存储。

使用 [DEPLOYMENT.md](docs/DEPLOYMENT.md) 的离线备份工具，不复制运行中的 SQLite 主文件。备份含秘密，恢复排除模型和 MCP refresh grants，需独立重新登录；项目工作区另行备份。拒绝覆盖或跨路径恢复，不在存活任务中替换依赖或数据库。

## 验证

```sh
npm run check
npm run format:check
npm run lint
npm test
```

[VERIFICATION.md](docs/VERIFICATION.md) 区分自动测试与真实账号、目标设备验收；[DELIVERY-CHECKLIST.md](docs/DELIVERY-CHECKLIST.md) 列出正式交付要求。通过本地检查不能代替完整产品验收。

## 来源和授权

Pi Pocket 基线：`edafa0b39f96af38c85830c7cda996c839b32012`；保留其 MIT `LICENSE`、源码归属和旧后端开发文档。进程内 Pi/Durable 运行时固定为 npm `1.0.2`，与 rotom 内核的 fork runtime 不同。

Qoder 实现来自 rotom，源文件摘要见 `vendor/qoder/SOURCE.json`，不包含账号或凭据。**组合项目为 UNLICENSED、private 包，不进行 npm 发布。** 仓库应保持私有；开源和对外分发前，需单独确认新增代码、Qoder 和服务商的授权。原 Pocket 的 MIT 权利不受影响。
