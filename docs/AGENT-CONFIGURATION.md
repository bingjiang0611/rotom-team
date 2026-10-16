# 配置 Agent Extension、Skill 和 MCP

Team 只支持原生 Agent Extension。`src/server/extensions/` 和 `<data>/extensions/` 是非 Team 旧路径的服务模块；Team 不加载、不监听、不提供其管理 API。已有文件和开关记录保留，但不会生效。旧模块不能直接搬进 Agent Extension 目录，必须改成原生 `default (pi) => { … }` API。

## 1. 选择全局或项目范围

这里的“全局”指 **Team 共享基础配置**，不是服务用户或成员个人的 `~/.pi/agent`。

| 配置           | 全局：Owner 管理                           | 项目：可信工作区                       |
| -------------- | ------------------------------------------ | -------------------------------------- |
| Extension      | `<data>/team-agent/extensions/`            | `<project>/.pi/extensions/`            |
| Skill          | `<data>/team-agent/skills/<name>/SKILL.md` | `<project>/.pi/skills/<name>/SKILL.md` |
| MCP            | `<data>/team-agent/mcp.json`               | `<project>/.pi/mcp.json`               |
| 设置与 package | `<data>/team-agent/settings.json`          | `<project>/.pi/settings.json`          |
| 通用指令       | `<data>/team-agent/AGENTS.md`              | `<project>/AGENTS.md`                  |

项目还支持 `.agents/skills/`，按原生规则从 cwd 向祖先发现，遇到仓库根目录停止。建议一个 Skill 只选一个位置，避免同名重复。

全局作用于使用该 Team 数据目录的成员和项目；项目配置只作用于以该工作区为 cwd 的原生会话。`.pi` 配置按 cwd 加载，不是任意父目录的 `.pi` 都会继承；`AGENTS.md` 则从全局到祖先目录、再到 cwd 依次加载。

改配置前先完成或停止 Team 运行，并核清 unknown 操作。不要编辑 `kernel-homes/<member>/.pi/agent` 中的派生资源配置；那里保留各成员的私有凭据、会话和运行状态。

## 2. 直接放置 Extension 和 Skill

简单资源不需要 package，也不必先新增 `settings.json`。把文件放进对应的自动发现目录即可。

**Extension 示例**：保存为全局或项目目录中的 `extensions/session-note.ts`：

```ts
/** Report that the native Agent Extension loaded. */
export default function (pi) {
    pi.on("session_start", async (_event, ctx) => {
        ctx.ui.notify("Agent Extension loaded", "info");
    });
}
```

这是原生生命周期钩子，不是服务模块。Extension 以服务 OS 用户权限运行。项目扩展也受信任，不是沙箱；必须先审查代码。自定义工具/钩子按原生规则加载，但任意新 slash 命令不会因此变成 Team 支持的命令。命令限制见 [CONFIGURATION.md](CONFIGURATION.md)。

**Skill 示例**：保存为 `skills/release-check/SKILL.md`：

```md
---
name: release-check
description: 检查发布准备情况。用户要求发布前检查时使用。
---

# 发布检查

先读取项目发布文档和 package.json。
只运行项目实际存在的检查命令。
报告检查结果、未验证项和发布风险，不自动部署。
```

启动时只展示名称、描述、路径；任务匹配后才读取完整 Skill。也可以明确调用 `/skill:release-check`。配套脚本和参考文件使用相对 Skill 目录的路径。

## 3. 用 settings 选择外部资源或安装 package

目录外的资源可写进相应范围的 `settings.json`。下面只是字段示例，应合并进已有文件，不要覆盖其他设置：

```json
{
    "extensions": ["./custom/session-note.ts"],
    "skills": ["./custom-skills"]
}
```

全局相对路径以 `team-agent` 为基准；项目相对路径以项目 `.pi` 为基准。资源列表按原生规则组合，不是项目列表整体覆盖全局。禁止机械复制同名 Extension/Skill；同名 Skill 保留先发现的项并报告警告，不应靠覆盖顺序定制。

安装 npm/git package 时，Owner 在部署机器上使用该发布目录内的 **固定版本原生 CLI**，并使用独立的安装 HOME。变量必须换成当前实际绝对路径：

```sh
RELEASE=/absolute/path/to/current-release
DATA=/absolute/path/to/team-data
PROJECT=/absolute/path/to/project
ROTOM="$RELEASE/runtime/rotom/node_modules/@bingjiang0611/rotom/bin/rotom"
INSTALL_HOME=$(mktemp -d)
chmod 700 "$INSTALL_HOME"
export HOME="$INSTALL_HOME"
export PI_CODING_AGENT_DIR="$DATA/team-agent"

# 全局安装。替换成已审查的真实 package 名和固定版本。
"$ROTOM" install npm:@example/pi-tools@1.0.0

# 项目安装：声明写入 PROJECT/.pi/settings.json。
cd "$PROJECT"
"$ROTOM" install --local npm:@example/pi-tools@1.0.0
```

在独立 shell 中执行，结束后退出该 shell，避免改变服务或当前终端的 HOME。安装 HOME 是临时目录；只删除自己创建的安装 HOME，不能删除共享 profile。Team 启动时不会自动安装缺失的共享 package，必须先安装成功。

需要限定 package 的资源时，可以使用原生对象形式：

```json
{
    "packages": [
        {
            "source": "npm:@example/pi-tools@1.0.0",
            "extensions": ["extensions/*.ts"],
            "skills": [],
            "prompts": [],
            "themes": []
        }
    ]
}
```

`skills: []` 表示不加载该 package 的 Skill；省略该字段表示加载 package 声明允许的全部 Skill。

插件自己的配置文件若位于全局 profile，要在 `team-agent/team.json` 明确声明，例如：

```json
{
    "configFiles": ["plugin/config.json"]
}
```

此时配置源是 `team-agent/plugin/config.json`，下次授权启动会复制到成员派生 profile。原生 `AGENTS.md`、system 文件、`mcp.json` 和 `extensions/pi-computer-use.json` 已有标准声明。不要在 `configFiles` 中放认证、模型库或会话路径；配置复制拒绝符号链接、硬链接和未管理文件冲突。

## 4. 配置 MCP

在选定范围的 `mcp.json` 中配置服务器，例如：

```json
{
    "mcpServers": {
        "project-tools": {
            "command": "/absolute/path/to/mcp-server",
            "args": ["."],
            "exposure": "direct"
        },
        "docs": {
            "url": "https://example.com/mcp",
            "description": "查询团队文档"
        }
    }
}
```

示例路径和 URL 是占位符，必须替换成真实服务器。`command` 是单个可执行文件，不是 shell 命令字符串。相对参数和 `cwd` 使用实际会话工作区；全局服务器配置同样随项目 cwd 运行。工具暴露方式支持原生 `direct`、`codemode`、`deferred`；不要关闭对应的原生 MCP/codemode/tool-search 支持。

项目与全局按 server 名合并：

- 项目同名项包含 `command` 或 `url`：替换全局定义。
- 项目同名项不包含 `command`、`url` 或 `type`：仅允许覆盖 `enabled`、`exposure`、`toolExposure`。
- 关闭某个全局服务器：在项目文件中写 `"docs": { "enabled": false }`。
- 删除项目的覆盖项会恢复全局定义，不等于全局关闭。

也可以在上述独立安装 shell 中用 CLI 写定义（`add` 不连接服务器）：

```sh
# 全局定义
"$ROTOM" mcp add docs --url https://example.com/mcp

# 项目定义，先 cd 到项目
"$ROTOM" mcp add project-tools --local -- /absolute/path/to/mcp-server .
```

不要把个人 Token 写进共享或项目文件。成员在 Team 网页 **MCP sign-ins** 或 `/mcp login <server>` 独立授权，Token 保存在该成员的 `mcp-auth.json`。不要在安装 profile 里执行 OAuth 登录。服务的环境经过清理，不能假设服务用户的环境变量会传给成员进程；项目 `auth.provider` 也不允许借用模型登录凭据。

## 5. 生效与检查

1. 停止或完成当前运行，保存配置。
2. 对已有原生进程执行 `/reload`，然后刷新 slash 命令目录；下一次原生启动也会读取新配置。
3. 在相应项目检查 Extension 的真实通知/工具行为、Skill 是否出现、MCP 的连接状态和配置错误。
4. 各成员单独检查自己的 MCP 授权。定义加载成功不等于连接成功，更不等于工具业务成功。

不需要用旧的服务 Extensions 面板，也不需要为单纯的 Agent 资源编辑重启 Team 服务。升级本次服务加载链改动则仍需按 [DEPLOYMENT.md](DEPLOYMENT.md) 切换发布并重启。

网页 **Settings → Agent resources** 只读列出将加载的资源及其绝对路径：Shared 显示共享基础配置；Project 显示该项目会话合并后的结果，并标出来源（`shared`/`project`/`ancestor`）、package、disabled、同名 Skill、MCP 覆盖、`settings.json` 解析失败和未安装的 package。列表使用固定版本的原生 resolver，按会话方式解析（项目视为可信），但不安装、不连接 MCP，也不执行 Extension；因此它不证明加载成功或连接成功。Extensions 和 Skills 还单独列出每个会话都会加载、与文件无关的 bundled 资源：固定版本 rotom 产品启动器按 `RESOURCE_DESCRIPTORS_V1` 加入的 Extension 和 Skill、Team 自己的 `rotom-skills.mjs`/`rotom-policy.mjs`，以及 Pi 内置 Extension（无文件，显示为 `builtin:<name>`；rotom 下 Codemode 由产品的 `third-party` 提供，不算 Pi 内置）。成员只能选择自己有 view 权限的项目。

没有资源编辑/包管理 Web UI，Owner 在部署机器编辑；项目配置通常随项目 Git 管理。历史冻结会话仍保留其 context/Skill 快照，不能用 `/reload` 宣称已切换为新项目 Skill。细则见 [CONFIGURATION.md](CONFIGURATION.md)，验证边界见 [VERIFICATION.md](VERIFICATION.md)。
