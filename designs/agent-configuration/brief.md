# Agent 配置的页面入口 / 2026-10-14

任务：Owner 现在只能在部署机器上用文件和 CLI 配置 Skill / MCP / Agent Extension / `AGENTS.md`（全局 `<data>/team-agent`，项目 `<project>/.pi`）。给这两层配置一个网页入口。成功标准：在网页上能看清**每层各有什么、当前是否生效、冲突与错误在哪里**，并在授权与不冲撞运行的前提下改它们。

本文件是设计稿（结构方案对照），不是实现方案；`index.html` 是独立原型，不连后端。

## 现状（已核对源码）

| 资源                | 全局位置                                       | 项目位置                      | 现有网页入口                                                         |
| ------------------- | ---------------------------------------------- | ----------------------------- | -------------------------------------------------------------------- |
| 通用指令 AGENTS.md  | `<data>/team-agent/AGENTS.md`                  | `<project>/AGENTS.md`         | 无                                                                   |
| Skill               | `<data>/team-agent/skills/<name>/SKILL.md`     | `<project>/.pi/skills/…`      | 无（会话冻结快照只在 `profile` sheet 里只读展示）                    |
| Agent Extension     | `<data>/team-agent/extensions/*.ts`            | `<project>/.pi/extensions/`   | 无。`web/sheets/extensions.js` 管的是旧版服务模块，kernel 模式下隐藏 |
| MCP                 | `<data>/team-agent/mcp.json`                   | `<project>/.pi/mcp.json`      | 只有 `web/sheets/mcp.js`：**个人 OAuth 登录**，不含定义              |
| settings / packages | `<data>/team-agent/settings.json`、`team.json` | `<project>/.pi/settings.json` | 无                                                                   |

服务端也还没有对应 HTTP：`src/server/http/api.ts` 里 `settings` 只接受 `approvalRule`；`extensions` 路由指向旧 loader；`rotom-resources.ts` 只有启动期派生与校验，没有读写 API。

## 约束（改动会碰到的硬合同）

- H1 `docs/CONFIGURATION.md` 现在写明“There is no new package-management web UI”，且 `/settings` 与 model scope 编辑是 **owner-only** 且 **运行中拒绝**。本设计只做资源/配置编辑，不做 npm/git 安装；文档需同步修订，不是默认已允许。
- H2 全局层写入 = 改所有成员下次启动派生的配置，仅 owner。项目层 `.pi` 是受信任可执行代码（Extension 以服务 OS 用户权限运行，无沙箱），写入前必须有明确的信任确认。
- H3 运行中不改：有活跃 Team run 时编辑锁定；文件系统直接写不受 Team 锁保护，所以网页侧必须自己先 gate。
- H4 不碰凭据：`mcp.json` 不写 token；成员 OAuth 仍走现有 **MCP sign-ins**。`kernel-homes/<member>/.pi/agent` 的派生副本只读展示，不可编辑。
- H5 生效语义要显式：保存 ≠ 生效。需要 `/reload` + 下次原生启动；历史冻结会话保留旧快照。
- H6 合并语义按原生规则显示：MCP 按 server 名覆盖（项目带 `command`/`url` 则替换，否则只能覆盖 `enabled`/`exposure`/`toolExposure`）；`AGENTS.md` 全局→祖先→cwd 叠加；同名 Skill 保留先发现者并告警。
- H7 失败要闭合：`settings.json` 解析失败、同名大小写歧义、成员侧未托管文件冲突（`TeamResourcePolicyError`）都要在页面上显示为阻断，不自动修。
- S1 沿用现有 Tokyo Night token、等宽字体、直角控件（`web/style.css` `:root`），不另造视觉。
- S2 复用既有 settings 窗口外壳（`web/sheets/settings.js` 的 `SETTINGS_PAGES` + `settings-nav/settings-pane`），不新造一套导航组件。

## 调研

| 来源                                                                                        | 可观察事实                                                                                                                                                                                                          | 借鉴                                                                    | 不借 / 原因                                                                      | 动作       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------- |
| VS Code《Settings》文档（2026-10-14 实抓 `code.visualstudio.com/docs/configure/settings`）  | 一个编辑器里 **User / Workspace 两个 tab**；工作区设置存在项目 `.vscode` 里随 Git 走；明确声明“并非所有用户设置都能被工作区覆盖”；始终保留 “Open Settings (JSON)” 出口                                              | scope 作为页面内 tab，而不是两套页面；永远保留“打开原文件”的出口        | 不照搬 settings 搜索树：我们的配置是文件集合，不是扁平键值                       | A / B / C  |
| VS Code《Add and manage MCP servers》（同日实抓 `/docs/copilot/customization/mcp-servers`） | 存在 “Agent Customizations editor”，把 MCP/自定义项收在一处；表单只编辑受支持字段，**保存只改动过的属性**，不支持的字段使 Save 不可用并解释原因；部分来源只读 JSON；工作区 MCP 继承 Workspace Trust，受限模式不启动 | 表单 + “Other Properties 打开 JSON”双通道；不支持字段显式只读；信任门槛 | 不做 per-server sandbox（我们没有这层能力，写出来就是假承诺）                    | B 的详情区 |
| 本仓库 `designs/sidebar-app-menu`（已落地决定：方向 C 设置窗口）                            | 用户上次在“弹出菜单 / 侧栏平铺 / 设置窗口”中选了设置窗口，并要求应用级功能只有一个入口                                                                                                                              | 新入口优先长在 settings 窗口里，避免第二套应用级导航                    | 不默认再开一个独立窗口（B 仍作为对照，因为资源编辑的内容量比普通设置大一个量级） | A / C 偏向 |

个人组件库检索（`library.py search`，`--kind page` / `--kind component`）：**0 命中，42 条索引全部 stale**（索引指向另一台机器上的旧路径）。无可复用组件记录，本轮按项目既有 CSS 复用，不新建库条目。

## 缺失与假设（需要你确认，原型里按默认值画）

- A1 编辑范围：原型默认“文本可编辑 + 可执行代码只读”——`AGENTS.md`/`mcp.json`/`SKILL.md` 可在网页编辑，`.ts` Extension 只展示与开关，代码仍在机器上改。
- A2 项目层写权限：原型默认 **owner-only**（与 H2 一致）；带 project view 权限的成员只读。
- A3 项目来源：原型默认取 `projects.json` 已登记项目 + 当前会话 cwd，不允许任意路径。
- A4 包管理（npm/git package）仍只读展示，安装留在 CLI。

## 三个结构方案（见 index.html）

- **A 设置窗口内分页**：`Settings` 新增 “Agent” 组四页（Instructions / Skills / Extensions / MCP），每页顶部 `Shared | <项目> | Effective` 切换。入口统一、改动最小；缺点是编辑区窄，跨资源排错要切页。
- **B 独立配置工作台**：三栏（资源类型 / 条目列表 / 详情编辑），顶栏切 scope，右栏带“生效来源”与 JSON 出口。最接近 VS Code Agent Customizations；缺点是多出一个应用级窗口，和 sidebar-app-menu 的“单一入口”决定相悖。
- **C 对象优先**：按配置对象分页——`Shared agent base` 一页，`Projects & access` 里每个项目一页，页内按资源分区，一屏看完一层。最贴合“全局 vs 项目”的心智；缺点是“同一个 MCP 两层怎么合并”要靠页内 Effective 区解释。

## 验收（选定方案后）

1. 原型三方向同数据对照，含 owner/member、idle/running(2 活跃) 四种组合。
2. 落地后在真实 8787 验证：锁定态不可保存、member 只读、保存后出现 `/reload` 提示、冲突/解析错误显示为阻断、`mcp.json` 写入不含凭据。
3. 文档同步：`docs/CONFIGURATION.md` H1 段落与 `docs/AGENT-CONFIGURATION.md` 第 5 节“当前没有通用资源编辑 Web UI”必须一起修订，否则文档与产品相互矛盾。

## 原型已渲染核对（2026-10-14，Chrome 1440×603/659）

| 组合                      | 结果                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| A / owner / 空闲          | Settings 左栏新增 “Agent 配置” 组；scope 三段切换；列表 + 下方编辑                         |
| A / owner / 2 运行中      | 黄色锁定条；“新建”禁用、字段虚线只读、保存标注“运行中：保存不可用”                         |
| A / member / 任意         | 蓝色只读条 + “打开 MCP sign-ins”；标题变“查看”；新建/保存/放弃按钮不渲染，只留“打开原文件” |
| A / owner / 项目 scope    | 红色信任条；`docs` 覆盖项的 transport/url 只读并解释原因，另给“改成完整替换 / 删除覆盖”    |
| B / owner / Shared 与项目 | 三栏工作台；资源 rail、条目列表、详情表单 + 合并说明                                       |
| C / owner / Shared        | 单页分区（指令/Skills/Extensions/MCP/Packages）；顶部合并结果摘要；Packages 无“新建”       |

渲染中发现并已修的问题：rail 标签与计数粘连、列表长文本压到状态 chip、项目覆盖项错误地显示为可改 url、成员看到大量禁用死按钮、Packages 出现“新建”。

决定：待定（等方向选择与 A1–A4 确认）。

## v2 收敛稿（2026-10-15，`v2.html` + `compare.html`）

v1 三方向并列，没给推荐，也没按真实窗口尺寸画。v2 收敛成一个推荐结构，直接加载 `web/style.css`，用真实 `settings-window`（880×600）、`list-item`、`segmented`、`switch` 渲染。

### 相对 v1 的修正

| v1 问题                                                     | 依据                                                                                | v2 处理                                                                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定义列表上显示 `connected · 7 tools` / `needs your sign-in` | `web/sheets/mcp.js` 的状态来自 `c/<id>/mcp`，按会话和成员计算；配置页没有这个上下文 | 删掉连接状态；MCP 页脚指向 MCP sign-ins                                                                                                                  |
| 产品内文案用中文                                            | 现有 settings 文案全是英文                                                          | 窗口内英文，原型说明用中文                                                                                                                               |
| 窗口画成全屏宽                                              | `.sheet.settings-window { max-width: 880px }`，高 600                               | 用真实外壳；列表与编辑分两层（点进详情，带返回），不在 600px 内上下堆叠                                                                                  |
| Shared / 项目 / Effective 三段                              | 用户关心“这个项目的 agent 实际拿到什么”                                             | 两段：Shared / Project ▾。Project 视图就是合并结果，每行标 `shared` / `project` / `package` / `built in` 来源；Shared 视图反向标“在项目 X 被关闭 / 同名” |
| 4–5 个 nav 项                                               | 设置导航已有 10 项，手机端是横向滚动条                                              | 只加一项 `Team › Agent resources`，页内用 tab 切 Instructions / Skills / Extensions / MCP                                                                |
| 多条横幅堆叠，手机首屏看不到列表                            | 390px 实渲染                                                                        | 阻断错误一条；逐项问题合成一行 `N problems · 链接`；成员提示缩短                                                                                         |
| 同名 Skill 写成“覆盖”                                       | AGENT-CONFIGURATION.md：同名保留先发现者并告警                                      | 文案改为 “same name”，提示改名，不暗示覆盖顺序                                                                                                           |

### 交互要点

- 指令：项目 scope 显示加载链 Shared AGENTS.md → 祖先目录（只读）→ 项目 AGENTS.md。
- Skill / AGENTS.md：等宽文本编辑；package 来源只读。
- Extension：代码只读 + 开关。开关语义对齐原生 `pi config` / `pi config --local`（推测写 settings 的 `-path` 排除，未实测，见 A5）。
- MCP：只编辑受支持字段 + “Edit as JSON”。项目里看 Shared 服务器时，只能改 enabled / exposure，并提供 “Remove the override”。
- 保存条：写到哪个真实路径；新会话读取，运行中进程需 `/reload`；项目文件提示随 Git 提交。
- 状态：运行中可读可起草，Save 禁用；成员只读、无编辑控件；`settings.json` 解析失败时开关停用；文件在机器上被改过时只给 Compare / Load theirs，不静默覆盖。

### 新增调研

- 原生 `pi config`（`docs/packages.md`、`docs/cli.md`）：已有“按 scope 启用/禁用已发现资源，Tab 切 scope”的 TUI。Web 开关应复用同一写入语义，不另造格式。
- Claude Code MCP 文档（`code.claude.com/docs/en/mcp.md`）：`local / project / user` 三种 scope，project scope 写进随仓库共享的文件。采用“scope 决定写到哪个文件”的显式说明；不采用第三种个人 scope（Team 的个人部分只有凭据，已在 MCP sign-ins）。

### 待确认（沿用 A1–A4，新增 A5–A6）

- A5 项目 scope 的 `-path` 能否排除 **Shared** 的 Extension/Skill：原生文档只明确 `builtin:*` 项目可覆盖。实现前要用固定版本 rotom 实测；不支持则项目视图里 Shared 扩展不提供开关。
- A6 静态检查范围：原型展示“可执行文件不存在”“同名”“解析失败”。这些服务端可静态得出；运行期加载错误需要从原生会话回读，未设计。

### 已渲染核对（Chrome，1440×603 视口；手机通过 390px iframe）

Project/MCP 列表、Shared/Skills + 运行中、Project/Instructions 链、项目 AGENTS.md 编辑、Shared 扩展在项目中的开关、member + 解析失败（桌面与手机）、保存冲突。渲染中修掉：行内文字被 `.list-item > span:first-child` 居中、tab 被 flex 压扁、开关说明横排、只读的 Type 仍像下拉框、项目 Instructions 计数不含加载链。

## v3 只读稿（2026-10-15，`v3.html`）

用户决定：**只扫描并展示列表，显示具体路径，不支持任何操作**。v2 的编辑、开关、新建、保存条、运行锁定、保存冲突、详情页全部删除。

- 入口与结构沿用 v2：`Settings › Team › Agent resources`，Shared / Project ▾，Instructions / Skills / Extensions / MCP 四个 tab。
- 每行显示绝对路径（可整段选中复制）。MCP 写成 `<mcp.json 绝对路径> → mcpServers.<name>`；package 资源显示解析后的文件路径和 package 来源；内置扩展标“No file”。
- 每个 tab 上方列出本次扫描的位置，不存在的标 `(none)`，例如项目的 `.agents/skills/`。项目 Instructions 改为按加载顺序列出 AGENTS.md 链，不再重复列扫描位置。
- 保留扫描问题：同名 Skill、MCP 可执行文件不存在、`settings.json` 解析失败（提示列表可能不完整）。行不可点击，没有 hover 效果。
- 页脚写明：只读；修改需在部署机器上改文件，再在运行中的会话执行 `/reload`。
- 权限：owner 和 member 看到的内容相同，都是只读；member 的项目下拉框只列有 view 权限的项目。

仍未确认：package 的实际安装路径（原型中的 `team-agent/npm/node_modules/...` 只是示例），以及扫描是复用原生 resolver 还是由服务端自己按目录扫描。前者结果准确，后者可能与原生加载结果不一致。

## 实现（v3 落地）

- 页面：`web/sheets/agent-resources.js`，入口 `Settings › Team › Agent resources`，仅 Team 服务器显示。
- 接口：`GET /api/agent-resources[?project=<id>]`，由 `src/server/agent-resource-list.ts` 用固定版本的原生 resolver（`DefaultPackageManager`、`loadSkills`、`loadMcpConfig`、`loadProjectContextFiles`）按会话方式解析；不安装、不连接、不执行。
- 与 v3 的差异：内置扩展没有文件，不列出（页脚说明）；未做“MCP 可执行文件不存在”检查（命令可能来自 PATH，无法可靠判断）；Skill 按名称排序，同名的未加载项紧跟在生效项之后。
