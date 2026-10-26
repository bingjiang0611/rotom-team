# 2026-10-23 审查交接：性能 / 设计 / 架构

分支：`review/2026-10-23-perf-design-arch`，基于 `main` 的 `e5df4bc`。

## 合作方式

1. **审查方**（写这份文档的 agent）把问题、证据和验收标准写在这里，推到本分支。
2. **执行方**（另一个 agent）在本分支上实现，每完成一项就推送，并更新下面的「状态表」和「执行记录」。
3. 审查方拉取本分支后逐项核验，把结论写进「核验记录」。不通过的项会写明原因，由执行方在同一分支上继续修。
4. 双方都只追加提交，**不 force-push、不 rebase 已推送的提交、不合并到 `main`**。合并由 owner 决定。

## 硬性规则（来自 AGENTS.md / PERFORMANCE.md，违反即核验不通过）

- 不改变：个人凭据路由、unknown 结果不重放、可信原生边界。`vendor/qoder/` 不动。
- `docs.ts` 里的文档 kind、scope、history、fork 设置不改。
- journal schema：**不提升 `PRAGMA user_version`**。新索引用 `CREATE INDEX IF NOT EXISTS`，放在 `kernel_segment_models` 那段之后，和它一样不带版本号，保证旧版本回滚后仍能打开同一个 journal。
- 服务端只用可擦除的 TypeScript 语法，import 带 `.ts` 后缀。改完跑 `npm run format`。
- **测量代码和优化代码分开提交**：新增 perf scenario、计数器或 ledger 条目是一个提交，优化是另一个提交。ledger 的阈值只能往下调，不能放宽。
- 每个提交只做一项，提交信息以条目编号开头，例如 `A1: index kernel_entries by attempt and segment`。
- 每项完成后必须通过：`npm run check`、`npm run lint`、`npm run format:check`、`npm test`。改到等待路径的项还要跑 `npm run perf:ci -- origin/main`，并在「执行记录」里逐条解释每个变差的计数器。在 Linux 上跑时，注明平台是 `linux-x64`，不要和 `darwin-arm64` 的基线直接比。
- 不重启线上服务，不碰真实账号，不部署。
- 审查方的环境装不了 prettier，本目录的两个文件没有格式化过。执行方的第一个提交请对 `docs/performance/review-2026-10-23/` 跑一次 `npm run format`，只改格式，提交信息写 `review: format handoff files`。

## 状态表（执行方维护）

| 编号  | 批次 | 标题                                        | 状态                          | 提交                                   |
| ----- | ---- | ------------------------------------------- | ----------------------------- | -------------------------------------- |
| A1    | A    | journal 索引 + 镜像游标                     | 核验通过                      | `2a2ac90`、`b44ca33`、`7c880fc`        |
| A2    | A    | thinking level / native goal 跨推送缓存     | 核验通过                      | `b8d63f4`、`c13245d`                   |
| A3    | A    | 启动时不再全量解析历史                      | 核验通过                      | `0f39ea3`                              |
| A4    | A    | 静态资源 ETag / gzip / modulepreload        | 核验通过                      | `c8d7cbd`（测量见记录）                |
| B1    | B    | `teamResourceRevision` 不在请求路径读大文件 | 核验通过                      | `9ccc0aa`                              |
| B2    | B    | `finishedSeen` 写入与清理                   | 核验通过                      | `cc652cc`                              |
| B3    | B    | 房间级字段每次推送只算一次                  | 核验通过                      | `8d42e63`                              |
| B4    | B    | journal 预编译语句缓存                      | 核验通过                      | `37cb733`                              |
| B5    | B    | 长轮询队列字节上限                          | 核验通过                      | `5fb4bbe`                              |
| C1–C6 | C    | 需要 owner 决策，只写方案                   | C1 暂缓;C2–C6 已批准,见批次 D | `14caa83`（方案，未实现）              |
| D1    | D    | 文档纠偏(C6)                                | 核验通过                      | `0705511`（测量）；实现见执行记录      |
| D2    | D    | notify 控制消息集中解码(C6)                 | 核验通过                      | `1b1228a`（测量）；实现见执行记录      |
| D3    | D    | 流式 Markdown 解析(C6)                      | 核验通过                      | `b6d3842`（测量）；实现见执行记录      |
| D4    | D    | App 根渲染局部订阅(C6)                      | 核验通过                      | `58ddb47`（测量）；实现见执行记录      |
| D5    | D    | 切换会话不重连(C6)                          | 核验通过                      | `229bda2`（测量）；`5acca07`（实现）   |
| D6    | D    | 大文件纯移动拆分(C5)                        | 核验通过                      | `3768653`（测量）；实现见执行记录      |
| D7    | D    | handoff 测量与异步化(C2)                    | 核验通过                      | `2af9690`（测量）；`859c283`（阈值）   |
| D8    | D    | storage worker(C3)                          | D8a、D8b 核验通过             | `1b0da14`（实现）；测量/限制见执行记录 |
| D9    | D    | 下线旧后端(C4,只读归档)                     | 已推送待核验(D9a 修复)        | `6c21763`（盘点）；`f162467`（实现）   |

状态取值：`待做` / `进行中` / `已推送待核验` / `核验通过` / `核验未通过` / `放弃（写明原因）`。

---

## 批次 A：必做

### A1. kernel journal 缺索引，热路径全表扫描

**证据**

- `src/server/rotom-journal.ts:173-176`：`kernel_entries` 只有 `(kernel_session_id, entry_id)` 主键；`session_id`、`attempt_id` 没有索引。`kernel_usage.attempt_id`、`kernel_child_usage.attempt_id` 也没有索引。
- 下列查询的执行计划都是 `SCAN kernel_entries`（扫描所有会话的记录）：
    - `entries(sessionId, skip)`（`:1316`），用 `LIMIT -1 OFFSET ?` 跳过前缀，仍然全表扫描。调用方是 `TeamKernel.#mirrorNow`（`team-kernel.ts:2459`），每次 `message_end` 都会通过 `onProgress`（`team-kernel.ts:1497`）触发。
    - `segmentEntries`（`:1345`）、`#terminal`（`:1195`）、`usage()`（`:1365`）。
    - `credits()`（`:1397`）：对每个 attempt 的 `LEFT JOIN … json_extract(e.body …)` 都要扫一遍全表，并逐条解析 JSON。
- 复现：`node docs/performance/review-2026-10-23/journal-query-bench.mjs`。审查时在 60 会话 × 600 条（共 3.6 万行，每行约 2 KB）的数据上测到：镜像后缀查询约 50–65 ms/次；`credits` 无 ANALYZE 时约 900 ms/次，有 ANALYZE 时 SQLite 每次临时建自动索引，约 44 ms/次。加索引并改用 rowid 游标后，镜像查询约 0.07 ms/次，`credits` 约 0.7 ms/次。

**要求**

1. 测量提交：在 `test/perf/` 里加一个大 journal 的 scenario，比如 `journal.large`：多会话、多条记录，测镜像后缀查询、`segmentEntries` 和 `credits`。计数器至少包括 `sql.rows` 或每次调用的毫秒数；按 PERFORMANCE.md 的做法注册为 candidate。
2. 优化提交：
    - 加 `kernel_entries(attempt_id)`、`kernel_entries(session_id)`、`kernel_usage(attempt_id)`、`kernel_child_usage(attempt_id)` 索引（遵守上面的 schema 规则）。
    - 镜像不再用 `OFFSET`：`NativeMirrorDoc` 现在存的是条数 `count`，不能改成 rowid（它是已存储的数据）。可以在内存里记下每个会话最后一次镜像到的 `kernel_entries.rowid`，用 `e.rowid > ?` 增量读取；进程启动后的第一次镜像，用 `count` 找到对应的 rowid。必须保证镜像顺序、跳过 handoff、`count` 的语义都和现在完全一致。
    - 检查 `entries` 的计划确实变成从 `kernel_attempts` 的 `conversation_id` 索引出发。

**验收（审查方会做）**

- 重新跑 bench（用 `--schema` 指向测试里由新代码创建的 journal），所有查询的计划里不再出现 `SCAN kernel_entries`。
- 新 scenario 有前后两份报告，计数器下降。
- 已有的镜像、恢复、fork、handoff 测试全部通过；再加一个测试：中途有 handoff、跨进程重启后，镜像出的条目序列和改动前完全一致。

### A2. 打开或切换会话时全量解析 segment 历史

**证据**

- `Room.pushAll` → `TeamKernel.roomInfo`（`team-kernel.ts:2315`）→
    - `agentInfo` → `RotomExecutions.thinkingLevel` → 段内没有存活进程时调用 `RotomJournal.thinkingLevel`（`rotom-journal.ts:954`），它会对 `segmentEntries` 逐条 `JSON.parse`，只为找最近一条 `thinking_level_change`。
    - `nativeGoal`（`team-kernel.ts:2295-2312`）：`#nativeGoal` 没有命中时也要读整段历史，而且算出的结果不写回缓存。
- 同一次 `pushAll` 内部有复用，跨推送没有。每次打开、切换、重连，以及空闲会话里任何文档变化，都会重算一遍。

**要求**

- 测量提交：在现有的 `session.open.long`，或一个新的「重启后打开长会话」scenario 里，统计 `segmentEntries` 的调用次数和解析的字符数（`perf-channels.ts` 已经有 `journal-segments` 这个来源）。
- 优化提交：thinking level 和 goal state 按 `(segmentId, 该 segment 最大的 kernel_entries rowid)` 缓存；`progress`、`finish`、`handoff`、`fork`、`upgradeKernel` 之后失效。也可以在入库时直接增量维护。缓存键必须包含所有会影响结果的输入。

**验收**

- 第二次及之后打开同一个空闲会话时，`segmentEntries` 调用次数为 0。
- 改 thinking level、改模型、handoff、fork 之后，房间显示的 thinking level 和 goal 立刻正确（要有测试覆盖）。

### A3. 启动时为了一个标记全量解析所有历史

**证据**：`#mirrorNow`（`team-kernel.ts:2456-2464`）在进程内第一次运行时用 `skip = 0`，把整个会话历史读出来并逐条解析，目的只是判断有没有 `customType === "team-kernel-branch"`。`reconcile`（`:507-529`）会对每个原生会话依次这样做。审查时测到 60 会话 × 600 条约 3.9 s，全部同步执行。

**要求**：测量提交可以复用 `startup.restart`；如果数据太少看不出差别，就加一个大数据量的变体。优化提交：「有没有分叉历史」改用一条 SQL 判断（只查该会话，并走 A1 的索引，例如 `EXISTS … json_extract(e.body,'$.customType')='team-kernel-branch'`）；然后从 `count` 对应的位置开始做增量镜像。

**验收**：启动时解析的字符数与历史总量无关；重启后分叉历史提示（`hasBranchedHistory`）的行为不变，要有测试覆盖。

### A4. Web 静态资源完全不缓存、不压缩

**证据**

- `src/server/http/assets.ts:147-168`：`serveFile` 每次请求都 `readFileSync`，响应头只有 `cache-control: no-cache`，没有 ETag，也不压缩。`serveApp`（`:130`）也一样。
- `web/` 下的 JS/CSS 约 1.07 MB，加上 vendor 模块，每次打开都完整下载一遍。从 `web/app.js` 出发的静态 import 链大约 12 层，`index.html` 里没有 `modulepreload`，经过隧道时要串行等十几个往返。

**要求**

- 保留「编辑后刷新即生效」：仍然用 `no-cache`，但加上强 ETag（按内容哈希，或按 `mtime+size`；用哪种请写明理由），支持 `If-None-Match` 返回 304。
- 支持 `Accept-Encoding: gzip`（有余力可加 br）。压缩结果按文件的 ETag 缓存在内存里并设上限；压缩不能在每次请求时同步执行。
- `index.html` 在服务端注入 `<link rel="modulepreload">` 清单，内容由 `web/` 的 import 图生成，按 mtime 失效。注意不能破坏 CSP（`appPolicy`），也不能改变模块的加载顺序（architecture.md「Loading order matters」）。
- 测量提交：在 `web.open` 或新的 scenario 里加「首次打开 / 再次打开」的传输字节数和请求数；如果条件允许，用现成的 CDP 限速（`image.thumbs.network` 那套）测一下时间。

**验收**：再次打开时 JS/CSS 全部返回 304；首次打开的传输字节明显下降；`mobile-ui`、`peeks-ui` 等真实 Chromium 测试通过；修改 `web/` 文件后刷新能拿到新内容（要有测试）。

---

## 批次 B：小项（A 全部完成后再做）

- **B1** `teamResourceRevision`（`rotom-resources.ts:113-172`）每次都同步读取并哈希 `npm/package-lock.json` 等文件。调用方：`TeamKernel.nativeCommands`（`team-kernel.ts:2278-2285`，GET 命令列表和每条 slash 命令都会走到）和 `onCommands`（`:1451`）。改成先 `stat` 比较 `mtime/size/ino`，没变就复用上次的哈希。新鲜度语义不能变：配置一改，状态就要显示 `configuration-changed`。
- **B2** `markFinishedSeen`（`config.ts:257-272`）每次都同步重写整个 `config.json`，`finishedSeen` 从不清理，`save()`（`:423`）不做 fsync。要求：会话被删除或用户被移除时，清理对应的条目；`save()` 在 rename 前 fsync 临时文件、rename 后 fsync 目录；高频的已读标记合并写入（比如 1 s 内合并一次），但进程正常退出前必须落盘。
- **B3** `Room.#push`（`room.ts:600-662`）对每个客户端都重新构造并序列化 `fields`，还各自调用一次 `#readHead()`。这些内容在房间内是一样的：改成在 `pushAll` 里算一次 JSON，每个客户端只比较字符串。`roomState`（按客户端不同）保持原样。
- **B4** `RotomJournal` 的每个方法每次都重新 `prepare()`。改成按 SQL 文本缓存语句，`close()` 时清掉。
- **B5** 长轮询（`http/events.ts:254-256`）的队列没有字节上限，每次应答都把所有未确认的事件重新序列化。参照流式传输的 `STREAM_BUFFER_BYTES`：超过上限就关闭这个 poller，让标签页重新拿完整视图；入队时只序列化一次，存字符串。

每项都要有测试；涉及等待路径的要附 `perf:ci` 结果。

---

## 批次 C：需要 owner 决策，**不要实现**，只把方案写进本文件末尾的「C 方案」

- **C1** 已用过的原生进程没有空闲回收和总量上限（`rotom-executions.ts` 的 `#kernels`；`docs/CONFIGURATION.md:90-96` 写明了 "No idle eviction"）。每个进程约 327 MiB。请给出 LRU 上限和空闲超时的建议值、与预热机制的配合方式、对 unknown 结果和 MCP 连接的影响，以及需要修改哪些产品合同文字。
- **C2** handoff 每次复制整段公开历史（`rotom-executions.ts:663-665, 834-897`）：同步写文件、fsync、读回，再对整段历史做 `JSON.stringify` 比较，最后全部写入 journal。请量化成本（存储、时间、冷启动），并给出可选的方向，比如异步写入、复用已有的 seed 文件。
- **C3** 单进程、单线程：两个 `DatabaseSync` 库加上 Durable 的全局队列都在主事件循环上。在 2026-10-19 proposals 的 Program 3 worker 方案基础上，补充 kernel journal 的部分。
- **C4** 双后端（Durable agent 循环和 rotom）并存：11 个文件里有 65 处分支，`src/server/extensions/` 有 2156 行在团队模式下不加载。请给出下线旧后端的步骤和风险。
- **C5** 大文件拆分：`team-kernel.ts` 3286 行（其中 `#submit` 约 385 行，用 if 链分发命令，与 `queue()` 有重复）、`rotom-executions.ts` 的 `run` 约 450 行、`conversation-routes.ts` 有 62 个 `third ===` 分支、`style.css` 8823 行。请给出拆分方案和顺序，每一步都必须是可验证的纯移动（architecture.md「A change that moves code between modules is a move only when…」）。
- **C6** 其他：控制消息靠前缀塞在 `notify` 文本里（`team-kernel.ts:1602-1627`）；切换会话仍然会重连 EventSource（Program 2 第 3 项）；流式回答每次推送都重新做 marked + DOMPurify（`web/transcript.js:650`，`web/ui.js:427`）；每次 `store.set` 都重渲染整个 App（`web/app.js:579`）；`architecture.md` 和 `map.md` 的主体仍然在描述上游 Pi Pocket。

---

## 批次 D:owner 已批准实现 C2–C6(2026-10-24)

owner 已批准把 C2–C6 从「只写方案」改为「实现」。C1(进程回收)**仍然不做**。各项按下面的编号和顺序进行,一项核验通过后再开始下一项。上面「硬性规则」全部继续适用,另外补充:

- 每项先写测量提交(没有可测量的计数器时,写明理由),再写实现提交;纯移动和行为变更不能放在同一个提交里。
- 不改变个人凭据路由、unknown 不重放、可信原生边界、Durable 文档合同和 journal `user_version`。
- 改到产品行为或合同文字的项,要同步更新 `PRODUCT.md` / `CONFIGURATION.md` / `architecture.md` 中对应的文字。
- 状态表新增 D1–D9 行,取值同上。D9 的处置方式 owner 已选「只读归档」,按 D1→D9 的顺序做到它时直接开始。

| 编号 | 来源 | 内容                                                                                                                                                                            | 关键验收                                                                                                                                                                                                                                             |
| ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | C6   | `architecture.md`、`map.md` 纠偏:以 Team(rotom)为主体,上游 Pi Pocket 机制标为 legacy;画清个人凭据、原生 journal、Durable 镜像、关闭/恢复次序                                    | 每条描述都能对应到当前代码的文件和函数;只改文档                                                                                                                                                                                                      |
| D2   | C6   | notify 前缀控制消息:把现有 envelope 的解码和校验集中到一个模块,不改变线上格式,不改 vendor/pin                                                                                   | 普通通知不会被误吞;畸形或未知 kind 会被拒绝并有测试                                                                                                                                                                                                  |
| D3   | C6   | 流式 Markdown:先量化增长块的重复解析;再按帧合并解析,结束时立即 flush                                                                                                            | 最终 HTML 和改动前逐字一致;未闭合 fence、跨块结构和 XSS 用例都有测试;不省略 DOMPurify                                                                                                                                                                |
| D4   | C6   | App 根渲染:先量化组件提交次数;只把已证实的高频 live state 改成局部订阅,不引入新状态库                                                                                           | 订阅顺序不变;真实 Chromium UI 测试全过;计数器下降                                                                                                                                                                                                    |
| D5   | C6   | 切换会话不重连:按 Program 2 第 3 项,用订阅 POST 加 generation/ACK,SSE 和长轮询都支持                                                                                            | 快速来回切换、撤权、断线重连、旧 tab 兼容都有测试;不重发用户的 send;`session.switch` 类计数器下降                                                                                                                                                    |
| D6   | C5   | 大文件拆分,按「C 方案 C5」表格的 1→4 顺序,每步一个连续职责块的纯移动                                                                                                            | 每步附移动等价证据(代码块逐字一致、条件顺序一致);CSS 拆分若多出请求,要单列网络成本                                                                                                                                                                   |
| D7   | C2   | handoff:先补 1/10/100 MiB、多次交接的阶段计时、事件循环延迟、RSS 和 DB/WAL 增量;再把 materialization 移到受控的异步执行边界                                                     | 保留 attach→持久化→readback→二次授权→finish 的顺序;materialization 开始后的失败仍是 unknown;**不做** seed 复用或跨付费人去重                                                                                                                         |
| D8   | C3   | storage worker:按「C 方案 C3」的设计,分两步。D8a:journal 和 Durable 写入的调用链改为显式异步接口,仍在主线程运行,行为不变。D8b:新增单个 storage worker,用开关启用,**默认关闭**   | D8a 全部测试通过,`perf:ci` 的 gating 和 ledger guard 通过,每个变差的计数器都逐条解释(审查方澄清:不要求零变差,和 A–D7 的标准相同);D8b 有 worker crash、晚到 ACK、双写拒绝、unknown 不重放、镜像顺序、权限隔离的故障注入测试;关闭开关时和 D8a 完全相同 |
| D9   | C4   | 下线旧后端。**owner 已选「只读归档」(2026-10-24)**:旧后端会话可以打开、阅读、导出,但禁止新的执行和恢复;未完成的任务明确标为中止并提示,不静默丢弃。只用合成 fixture,不读线上数据 | 按「C 方案 C4」的 4 个步骤,每步单独提交、可回滚;不删除用户历史                                                                                                                                                                                       |

---

## 执行记录（执行方追加）

### D2 — 测量基线

- 基线 `8686fdd`。现有五种 Team notify envelope 为 children、policy、barrier、tree、context；发送端在 rotom-policy.mjs，接收端分散在 rotom-rpc.ts、rotom-kernel.ts、team-kernel.ts。字段/nonce 校验和 UI 过滤各自实现，children 同一事件会由 transport、等待器和 live view 重复解码。
- 独立测量脚本 `node docs/performance/review-2026-10-23/notify-decode-bench.mjs` 使用现有 nativeReadback 计数器，不新增 ledger key、不改生产代码。100 个原格式 children 通知 × 3 个读者：JSON.parse **300 次 / 13,800 字符**。这是定向读者扇出检查，不冒充完整 RPC 或端到端耗时。
- 后续实现集中解码/字段校验，按事件生命周期复用结果；独立测试覆盖正常通知、已知 envelope、未知/畸形保留消息及 RPC unknown 不重放。发送格式、原生 pin/vendor 均不修改。完成后跑全套检查和 perf:ci；D2 核验前不开始 D3。

### D1 — 测量提交：文档基线与适用范围

- 基线 `8606886`。D1 只改文档，不改任何执行路径；不存在能衡量本项语义纠偏的运行时工作计数器。**性能增益 unavailable / 不适用（docs-only）**，不登记伪零值或新增 ledger 条目。此提交先记录源码对照，后续独立提交修改 architecture/map。
- 当前文档的六处关键偏差及已读源码证据：

| 偏差                                                         | 当前代码证据                                                                                                 | 修订方向                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 以 Pi Pocket launcher/默认目录为主入口                       | `bin/rotom-team.js`、`main.ts` 的 options/启动段                                                             | Team 直接启动服务器，隔离资源，开发/测试始终显式 --data；旧 launcher 单列 legacy |
| 把全部执行真相放在 pocket.sqlite                             | `RotomJournal.reserve/finish`、`TeamKernel.#mirrorNow`                                                       | 区分原生 journal/JSONL、共享 Durable 镜像与暂态 live                             |
| 用最新消息作者解释所有付费路由                               | `TeamKernel.#check`、`RotomExecutions.#launch`、`TeamAccounts.kernelAuth`、`TeamExecution.authorize`         | 原生绑定固定 payer，每次推理过 gate；legacy 也受个人路由授权                     |
| 启动步骤缺少 native 对账，关闭顺序未写清                     | `PocketApp.#open/close`、`TeamKernel.reconcile/resumeInterrupted/close`、`RotomExecutions.close`             | 明示恢复顺序、unknown 栅栏、先关闭 native 再释放存储锁                           |
| 让服务端 drop-in、PocketHost 看起来是 Team 扩展机制          | `PocketApp.#open` 的 !kernel 分支、`main.ts` watcher、`startRotomKernel`                                     | service extensions/旧 browser 工具标 legacy；Team 用 native extensions           |
| “Browsers only see committed state”及“其余 web 无测试”已过时 | `TeamKernel.#observe/clientLive`、`web/store.js actions.submit`、`test/native-*.test.ts`、`test/*ui.test.ts` | 区分 optimistic/live 与持久化确认，列出现有合成 native/Chromium 验证入口         |

- 验收不以测试通过代替文档准确性：逐段对照文件/函数，检查相对链接和引用路径；实现提交后跑 format/check/lint/format:check/npm test 及用户要求的 perf:ci origin/main。perf 只是分支护栏，不作为文档收益证明。
- 本轮遵守逐项核验门槛：D1 推送后等待审查方确认再开始 D2；不提前写 D2–D8、不做 C1，本次不扩展到 D9。

### D1 — 实现与验证：Team 主体、数据归属和恢复顺序

- 测量提交 `0705511`；实现提交题名 `D1: document Team ownership and separate legacy execution`。只修改 architecture.md、map.md 和本交接记录，未实现 C1/D2–D9。
- architecture 以 Team/native 调用链为主体，新增执行/个人授权图、journal→Durable 公共镜像→暂态 live 图，逐步说明启动、正常关闭和允许续跑的条件；明确 unknown 不重放、原生权限不是 OS 沙箱、单 worker/已用进程回收尚未实现。
- map 修正直接启动入口和 data 所有权，新增 Team 核心文件/函数导航；保留共享 UI/工具导航，把 service extensions、PocketHost、Durable Agent 执行和 service browser 标为 legacy。纠正“浏览器只看已提交状态”和“其余 web 无测试”。native auth gate、Chrome relay preload、Qoder request provider 分别注明真实职责。
- 对照当前 PRODUCT/CONFIGURATION 纠偏，不改变其中的产品合同，故不改这两份权威合同。保留 legacy 现行执行路径的说明；D9 的只读归档还没有实施。

| 检查               | 结果与范围                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文档引用与源码声明 | 临时检查 `/tmp/rotom-review-D1/check-docs.mjs` 通过：20 个相对链接/锚点，23 个源码文件中的 86 个函数/方法声明；这是引用检查，核心权限/启动/镜像/关闭语义另已逐段读源码核对 |
| 静态验证           | format、check、lint、format:check 全通过                                                                                                                                   |
| 完整测试           | npm test **577/577**，无失败/跳过；没有新增产品逻辑或测试替身来制造“文档收益”                                                                                              |
| 性能护栏           | `perf:ci -- origin/main --runs 1` passed，gating/ledger guard passed；darwin-arm64、Node 24.18.0；highLoad=false（4.48→4.22/8 核）；报告 `/tmp/rotom-review-D1/ci/`        |
| 变更边界           | 相对 D1 基线 `8606886`，src/web/test/vendor/runtime/package 文件无 diff；ledger 未改；原有两份用户文档与开工备份逐字节一致，未暂存                                         |

- perf 基线是 `origin/main=e649d9d`，包含此前 A/B 分支差异。D1 没有修改等待路径，不把整条分支的更好/更差计数归因于文档，也不宣称性能加速。完整验证日志保留在 `/tmp/rotom-review-D1/`。
- 下一步 owner/审查方：核验 D1 并在本分支写回结论。按批次 D 的门槛，核验通过前执行方不开始 D2；D2–D8 仍待做。未部署、未重启服务，未使用真实模型账号。

<!-- 每项一节：做了什么、提交号、测试结果、perf:ci 摘要（平台、highLoad、每个变差计数器的解释）、遗留问题。 -->

### A1 — 测量层

- 首个纯格式提交：`329df5b`，已推送；未混入实现。
- 测量提交：`A1: measure large journal queries`（本节所在提交）。新增独立 `journal.large`，60 会话 × 50 attempts × 12 entries；测最后一个会话的镜像后缀、整段历史和真实 Qoder credit 汇总。所有返回值有断言，数据构造不计入查询窗口。
- `check`、`lint`、`format:check`、`npm test` 均通过；560/560，无跳过。两次独立 `perf:measure --runs 1` 通过，darwin-arm64 / Node 24.18.0，highLoad=false；scenario 总耗时 153.0 / 120.3 ms。
- 仅注册 `journal.large/sql.statements`、`journal.large/sql.rows` 两个 candidate，没有提高既有阈值。`sql.rows` 是返回行数，不是 SQLite 扫描行数；索引效果将用实际查询计划和每次查询耗时验证，不能声称返回相同数据的查询减少了返回行数。
- 本地证据：`/tmp/rotom-review-A1/before-{1,2}.json` 及同目录检查日志。尚无生产优化；完整 perf:ci 和重启回归在优化阶段执行。未使用真实账号、未重启/部署服务。

### A1 — 优化及验收

- 测量提交 `2a2ac90`；新增 cursor 方法的 parse 来源补充单独提交 `b44ca33`；优化/回归提交 `7c880fc`。四个索引在 schema 6 的非版本化初始化中创建；旧版仍可打开。镜像按 conversation 的 attempts → entries 索引查 rowid 后缀，内存游标仅在 Durable 提交后推进；已存 `count`、handoff 排除和 metadata 保持不变。
- `npm run format`、`check`、`lint`、`format:check`、`npm test` 全通过（563/563，无跳过）。新增 3 项回归覆盖索引/版本、跨会话及 handoff/fork 游标等价、真实子进程重启和提交失败重试。另跑 `npm run test:kernel:app`、`node test/native-commands-proof.ts`，均 passed，包含既有 handoff/fork/recovery/branch/unknown 检查，仅合成 loopback 账号。
- 独立 bench `--schema /tmp/rotom-review-A1/schema/kernel.sqlite`：所有查询均使用索引，无 `SCAN kernel_entries` 或 `SCAN e`；cursor 从 `one_conversation_request` 出发，命中 `kernel_entries_attempt (attempt_id=? AND rowid>?)`。cursor 0.04 ms/call、credits 0.65 ms/call（该 bench 条件下，非生产延迟）。
- `perf:ci -- origin/main` 三轮通过；修正新方法 parse 来源归属后，再以 `--runs 1` 完整复验通过。平台 darwin-arm64、Node 24.18.0，两次 highLoad=false，gating 和 ledger guard 均通过。最终报告在 `/tmp/rotom-review-A1/final-ci/{base,head}.json`。最终 journal.large：总耗时 152.9→13.9 ms，后缀 64.4→1.0 ms，segment 30.0→8.1 ms，credits 57.9→4.1 ms；前三轮方向相同。返回行数仍为 662、查询数仍为 3，不能将索引优化描述为返回行数下降。
- 最终相对 origin/main 的变差计数器逐项解释：

| 计数器                              | base→head     | 原因与证据                                                                                                                                                                                              |
| ----------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| startup.restart/sql.statements      | 848→851       | 必要启动工作：索引初始化 exec、新进程从持久化 count 定位 rowid，以及保留的分叉历史读取；不在每次 warm mirror 重复定位。A3 将移除全历史解析。                                                            |
| turn.prewarmed/json.stringify.chars | 120707→122634 | 同一采样中 view 推送 2→3，push.view.bytes 8567→9804；额外中间视图由原有 90 ms 合并窗口与原生完成时序决定。未改变 payload 格式或增加常驻序列化路径；前三轮比较该计数器未变差。保留原始结果，不放宽阈值。 |

- 初次三轮中的 journal 来源归属变化来自新增方法未被测量代理标为 history，不是额外解析；已用独立测量提交修正，最终结果以上述复验为准。当前证据是受控查询加速/索引计划，不是线上 L3。原要求“计数器下降”对 sql.rows（返回行数）不适用于保持输出等价的索引优化；本项明确保留这一验收差异，交审查方核验，不伪造下降。
- 服务未重启、未部署；用户原有两处文档改动逐字保留。日志位于 `/tmp/rotom-review-A1/`，不含真实账号数据。

### A2 — 测量层

- 独立测量提交 `A2: measure repeated idle native room projections`：真实 app 创建会话，直接种入 600 条原生 journal 历史；预读一次，窗口内再读三次 roomInfo，断言 Goal 和 thinking 一致。新 scenario 放在所有既有场景之后，不改变它们的会话列表/ID。
- 两次独立 `perf:measure --runs 1` 通过，darwin-arm64 / Node 24.18.0、highLoad=false；新增三个 candidate（segmentEntries 查询次数及 journalSegments 解析调用/字符数），无阈值放宽。原始报告 `/tmp/rotom-review-A2/before-{1,2}.json`。TypeScript 和 scoped lint/format 已通过；全套验收在优化阶段执行。

### A2 — 优化及验收

- 实现 `c13245d`，测量 `b8d63f4`。thinking/Goal 按 segment + 最大 rowid 缓存；thinking 另含 fallback level，二者包含 kernelVersion。只缓存派生值，每种最多 128 段，不保留完整历史；当前 live 状态优先。新行、切换 head、model fallback 和 kernel upgrade 均不会命中旧值。
- format/check/lint/format:check 全通过；npm test 564/564，无跳过；native-commands-proof passed（真实 pinned kernel、合成 loopback 模型）。新增 real TeamKernel 测试覆盖空 Goal、重复 idle 读取、progress/finish、fallback 变化、handoff、fork、upgrade。负控：仅禁用 Goal cache hit，测试在第二次 idle 读取以 2≠1 失败；恢复后全通过。
- `perf:ci -- origin/main --runs 1` 通过，darwin-arm64 / Node 24.18.0，highLoad=false，gating/guard 均通过。session.open.native-long 的三次投影：segmentEntries 3→0，解析调用 1800→0，解析字符 2,370,165→0，L1 达成；结果值逐次相等。单轮不用于稳定毫秒速度承诺。证据 `/tmp/rotom-review-A2/ci/`。
- 下表列出相对 origin/main 的全部 worse（该比较包含 A1）。R：必要的 indexed MAX(rowid) revision 查询/单行结果，以小标量查询换掉历史解析；S：A1 启动索引/游标定位。D：未改变对应序列化或 payload schema，动态运行元数据/合并推送时点的采样差异；正确性用真实状态等价及 native proof 检查，未据此提高任何阈值，也不承诺逐字节下降。

| 计数器                                      | base→head     | 解释                                               |
| ------------------------------------------- | ------------- | -------------------------------------------------- |
| startup.restart/sql.statements              | 848→851       | S                                                  |
| session.open/sql.statements                 | 45→47         | R                                                  |
| session.open/sql.rows                       | 94→96         | R                                                  |
| turn.warm/sql.statements                    | 157→158       | R                                                  |
| turn.paced/sql.statements                   | 286→288       | R                                                  |
| web.open/sql.statements                     | 31→32         | R                                                  |
| session.open.long/sql.statements            | 16→17         | R                                                  |
| session.open.long/sql.rows                  | 47→49         | R，空历史也缓存 absent 值                          |
| native.warm/sql.rows                        | 10→11         | R，thinking 授权前读取 revision                    |
| web.paced/sql.statements                    | 306→308       | R                                                  |
| web.send.stream/sql.statements              | 384→386       | R                                                  |
| web.send.stream/push.bytes                  | 91291→91693   | D，+402 B                                          |
| web.send.stream/push.view.bytes             | 77497→77899   | D，同一 view payload 的 +402 B，不是第二份额外工作 |
| commands.discover.cold/sql.rows             | 78→81         | R                                                  |
| commands.discover.cold/json.stringify.chars | 33812→33846   | D，+34 字符                                        |
| commands.discover.warm/sql.rows             | 64→66         | R                                                  |
| projection.large.open/sql.statements        | 98→99         | R                                                  |
| projection.large.open/json.stringify.chars  | 199672→199706 | D，+34 字符                                        |
| projection.large.paced/sql.statements       | 572→574       | R                                                  |
| changes.poll.images/json.stringify.chars    | 20328→20362   | D，+34 字符；该 Git/image 路径无 A2 实现改动       |

- D 的具体字符来源未逐字追踪，仅能确认路径未变、采样输出不完全同字节；审查时可要求补充 payload 追踪，不能把这项限制隐藏为已经证明没有字节回归。未部署、未碰真实账号。

### A3 — 启动增量镜像

- 实现 `0f39ea3`。复用既有 `startup.restart` 测量，不修改仪表或 workload。已镜像前缀的分叉标记改为 indexed SQL EXISTS，只返回布尔值；首次镜像 count=0 时直接检查正在读取的后缀，不多做 SQL。SQLite 仍需在该会话范围内检查 JSON，未宣称消除了所有 SQLite 内部工作。
- format/check/lint/format:check 和 npm test 通过（564/564，无跳过）。真实新进程重启测试把 branch 标记移到已镜像前缀，同时禁止启动调用全量 entries API；handoff seed 的标记不计入、其他会话不串入、fork 标记仍可见。负控恢复全量历史调用后，该测试报“Startup mirror must not parse the historical prefix”；恢复 SQL 路径后通过。
- 最终 `perf:ci -- origin/main --runs 1` passed，darwin-arm64 / Node 24.18.0、highLoad=false、gating/guard passed。startup.restart 的 journalHistory 解析 56→0 次、135,546→0 字符（L1）。日志/前后报告 `/tmp/rotom-review-A3/final-ci/`；首次实验发现空会话多余 EXISTS，已经修正并重新跑完整四项检查及 perf。
- 最终相对 origin/main 的 worse 全部如下。R/S/D 含义同 A2；V 表示本次实际多推了一个中间视图（session.open push.events 9→10），其 SQL/序列化相应增加。只解释已观察到的工作，不放宽 ledger。

| 计数器                                      | base→head     | 解释                                                      |
| ------------------------------------------- | ------------- | --------------------------------------------------------- |
| startup.restart/sql.statements              | 848→851       | S，索引初始化/游标定位/布尔恢复，不再传回历史正文         |
| session.open/sql.statements                 | 45→48         | R + V                                                     |
| session.open/sql.rows                       | 94→109        | R + V                                                     |
| session.open/json.stringify.chars           | 84622→88107   | V                                                         |
| session.open/push.events                    | 9→10          | V，原有合并窗口中的额外中间状态                           |
| session.open/push.bytes                     | 82236→86312   | V                                                         |
| turn.warm/sql.statements                    | 157→158       | R                                                         |
| turn.warm/json.stringify.chars              | 85248→85250   | D，+2 字符                                                |
| turn.paced/sql.statements                   | 286→288       | R                                                         |
| web.open/sql.statements                     | 31→32         | R                                                         |
| session.open.long/sql.statements            | 16→17         | R                                                         |
| session.open.long/sql.rows                  | 47→49         | R                                                         |
| native.warm/sql.rows                        | 10→11         | R                                                         |
| web.paced/sql.statements                    | 320→322       | R                                                         |
| web.send.stream/cdp.Nodes                   | 1479→1492     | D，CDP 采样时存活/分配节点差异；本项没有 Web DOM 代码改动 |
| commands.discover.cold/sql.rows             | 78→81         | R                                                         |
| commands.discover.cold/json.stringify.chars | 33812→33846   | D，+34 字符                                               |
| commands.discover.warm/sql.rows             | 64→66         | R                                                         |
| projection.large.open/sql.statements        | 98→99         | R                                                         |
| projection.large.open/json.stringify.chars  | 199672→199706 | D，+34 字符                                               |
| projection.large.paced/sql.statements       | 572→574       | R                                                         |
| changes.poll.images/http.body.bytes         | 20296→20328   | D，+32 B；该 handler 无 A3 改动，未承诺固定同字节输出     |

- 单轮 Web/动态字段计数不能证明长期回归或改善；D 的逐字/逐节点来源未单独追踪，保留给审查方，不以不存在的零差异代替观测。未部署或重启线上。

### A4 — 静态资源

- 测量提交 `f9c946b`、`ec1a3d3`、`306cf01`；优化 `c8d7cbd`。node:http 直接记录 53 个 bundle 资源的实际传输字节，解压后与磁盘原始文件逐字比较；不将 bundle 视为整个浏览器导航。
- 内容 SHA-256 强 ETag，identity/gzip 分别哈希实际响应字节；保留 no-cache、Vary 和 If-None-Match/304。异步读取/压缩按 ino/size/mtimeNs/ctimeNs 复用，合并同版并发读取，缓存最多 128 文件/16 MiB（另有一个页面缓存）；不在每次请求同步压缩。
- index 在 importmap 后注入静态 import 图预加载，按源文件版本重新生成；不改 script 内容、CSP hash 或执行顺序。扫描器仅支持当前 literal static ESM 语法；如采用新语法，先换 parser 并扩展独立 AST 等价测试。动态 import 仍 lazy。
- format/check/lint/format:check 全通过；npm test 567/567、无跳过，包含实际 Chromium mobile-ui/peeks-ui。新测试验证 same-size 文件编辑、删除、gzip 字节/validator、304、并发复用和缓存淘汰；独立 TypeScript AST 核对完整静态 import 图、脚本顺序及 CSP。
- 最终 `perf:ci -- origin/main --runs 1` passed、gating/guard passed；darwin-arm64 / Node 24.18.0，**highLoad=true**（5.26→19.58/8 核），不采纳毫秒速度结论。首次 bundle 1,142,870→405,839 B（约 -64.5%）；再次 1,142,870→0 B，53 次条件请求保留，所有资源 304。报告 `/tmp/rotom-review-A4/ci/`。此前子任务未使用 timing lock 的基线报告只用于计数器注册，不作为时间证据。
- 全部 worse（包含 A1/A2；D 的逐字/调度来源限制继续保留）：

| 计数器                                      | base→head   | 解释                                                               |
| ------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| startup.restart/sql.statements              | 848→851     | A1 索引初始化及游标/分叉恢复                                       |
| session.open/sql.statements                 | 46→48       | A2 indexed revision 标量查询/结果（R）                             |
| session.open/sql.rows                       | 107→109     | A2 indexed revision 标量查询/结果（R）                             |
| turn.warm/sql.statements                    | 157→158     | A2 indexed revision 标量查询/结果（R）                             |
| turn.paced/sql.statements                   | 286→288     | A2 indexed revision 标量查询/结果（R）                             |
| web.open/sql.statements                     | 31→32       | A2 indexed revision 标量查询/结果（R）                             |
| web.open/cdp.Nodes                          | 996→1136    | 新增 modulepreload link/分隔文本节点；实际分配节点增加是预加载代价 |
| session.open.long/sql.statements            | 16→17       | A2 indexed revision 标量查询/结果（R）                             |
| session.open.long/sql.rows                  | 47→49       | A2 indexed revision 标量查询/结果（R）                             |
| web.open.long/cdp.Nodes                     | 1585→1725   | 新增 modulepreload link/分隔文本节点；实际分配节点增加是预加载代价 |
| native.warm/sql.rows                        | 10→11       | A2 indexed revision 标量查询/结果（R）                             |
| web.reopen/cdp.Nodes                        | 1090→1230   | 新增 modulepreload link/分隔文本节点；实际分配节点增加是预加载代价 |
| web.paced/sql.statements                    | 306→308     | A2 indexed revision 标量查询/结果（R）                             |
| web.paced/cdp.Nodes                         | 1295→1435   | 新增 modulepreload link/分隔文本节点；实际分配节点增加是预加载代价 |
| web.send.poll/sql.statements                | 392→413     | 高负载采样多推中间视图；SQL 和该 view 字节相应增加                 |
| web.send.poll/push.bytes                    | 61166→67916 | 高负载采样多推中间视图；SQL 和该 view 字节相应增加                 |
| web.send.poll/push.view.bytes               | 48707→55457 | 高负载采样多推中间视图；SQL 和该 view 字节相应增加                 |
| web.send.poll/cdp.Nodes                     | 1476→1577   | 新增 modulepreload link/分隔文本节点；实际分配节点增加是预加载代价 |
| web.send.stream/cdp.Nodes                   | 1495→1632   | 新增 modulepreload link/分隔文本节点；实际分配节点增加是预加载代价 |
| commands.discover.cold/sql.rows             | 78→81       | A2 indexed revision 标量查询/结果（R）                             |
| commands.discover.warm/sql.rows             | 64→66       | A2 indexed revision 标量查询/结果（R）                             |
| commands.discover.warm/json.stringify.chars | 27229→27263 | 动态元数据采样 +34 字符；同 A2 的 D 限制                           |
| projection.large.open/sql.statements        | 98→99       | A2 indexed revision 标量查询/结果（R）                             |
| projection.large.paced/sql.statements       | 572→574     | A2 indexed revision 标量查询/结果（R）                             |

- 未做隧道限速时间承诺；真实 Chromium 功能测试通过，不等同线上或物理手机验收。没有部署/重启。

### B1 — 配置指纹

- 实现 `9ccc0aa`。每个文件先 stat 对比 dev/ino/size/mtimeNs/ctimeNs，再复用 SHA-256；缓存最多 256 个 digest，不缓存大文件正文。shared 路径仍逐次经过原 policy 校验；project 链接仍按原读取语义跟随目标 stat。配置新增、同大小编辑、原子替换、删除均立即改变 freshness。
- 指纹现在组合文件 digest 而非正文，属于不透明 freshness hint 的格式变化；已有命令快照首次比较会显示 configuration-changed，显式刷新后稳定。未改变凭据/执行 configurationDigest 或 unknown 语义。
- format/check/lint/format:check 全通过，npm test 568/568，无跳过。新测试真实 2 MiB lock 文件：连续两次 revision 只读一次；同大小修改、rename 和删除准确失效。已有配置/链接 policy 测试全部保留。
- perf:ci origin/main --runs 1 passed；darwin-arm64、Node 24.18.0、highLoad=false，gating/guard passed；报告 `/tmp/rotom-review-B1/ci/`。全部 worse 如下，包含前序 A 项，未放宽阈值：

| 计数器                                   | base→head   | 解释                                                      |
| ---------------------------------------- | ----------- | --------------------------------------------------------- |
| startup.restart/sql.statements           | 848→851     | A1 启动索引/游标工作                                      |
| session.open/sql.statements              | 45→47       | A2 revision 查询及标量结果（R）                           |
| session.open/sql.rows                    | 94→96       | A2 revision 查询及标量结果（R）                           |
| turn.warm/sql.statements                 | 157→158     | A2 revision 查询及标量结果（R）                           |
| turn.paced/sql.statements                | 286→288     | A2 revision 查询及标量结果（R）                           |
| web.open/sql.statements                  | 31→32       | A2 revision 查询及标量结果（R）                           |
| web.open/http.requests                   | 81→83       | A4 提前发起 preload 请求；完成采样窗口内请求数增加        |
| web.open/cdp.Nodes                       | 996→1136    | A4 preload 元素/分隔文本增加 DOM 节点                     |
| session.open.long/sql.statements         | 16→17       | A2 revision 查询及标量结果（R）                           |
| session.open.long/sql.rows               | 47→49       | A2 revision 查询及标量结果（R）                           |
| web.open.long/cdp.Nodes                  | 1585→1725   | A4 preload 元素/分隔文本增加 DOM 节点                     |
| native.warm/sql.rows                     | 10→11       | A2 revision 查询及标量结果（R）                           |
| web.reopen/cdp.Nodes                     | 1090→1230   | A4 preload 元素/分隔文本增加 DOM 节点                     |
| web.paced/sql.statements                 | 306→308     | A2 revision 查询及标量结果（R）                           |
| web.paced/cdp.Nodes                      | 1284→1425   | A4 preload 元素/分隔文本增加 DOM 节点                     |
| web.send.poll/cdp.Nodes                  | 1450→1595   | A4 preload 元素/分隔文本增加 DOM 节点                     |
| web.send.stream/sql.statements           | 384→386     | A2 revision 查询及标量结果（R）                           |
| web.send.stream/cdp.Nodes                | 1490→1629   | A4 preload 元素/分隔文本增加 DOM 节点                     |
| commands.discover.cold/sql.rows          | 78→81       | A2 revision 查询及标量结果（R）                           |
| commands.discover.warm/sql.rows          | 64→66       | A2 revision 查询及标量结果（R）                           |
| projection.large.open/sql.statements     | 98→99       | A2 revision 查询及标量结果（R）                           |
| projection.large.paced/sql.statements    | 572→574     | A2 revision 查询及标量结果（R）                           |
| changes.poll.images/json.stringify.chars | 20306→20338 | 动态元数据输出差异（D，未逐字归因）；此路径无 B1 代码改动 |
| changes.poll.images/http.body.bytes      | 20272→20304 | 动态元数据输出差异（D，未逐字归因）；此路径无 B1 代码改动 |

- 这是减少重复文件读取/哈希，不是完整文件监控保证；继承“深层资源修改需 reload”的合同。未部署/重启。

### B2 — 已读标记与持久化

- 实现 `cc652cc`。已读标记立即更新内存，最多每秒合并写盘；其他配置写入同时消化 pending batch。正常 app.close 显式 flush；写入失败发 warning、保留 dirty，关闭 flush 失败会拒绝而不是假装保存成功。异常断电仍可能丢失最后一秒已读状态，不影响任务/计费事实。
- 所有 config save 在 rename 前 fsync 文件、rename 后 fsync 目录。启动时和 SessionsDoc 确认移除会话后清理标记；删除用户随其整条记录清理。当前无新增“删除会话”HTTP API，只响应权威目录变化，归档不删除标记。
- format/check/lint/format:check 通过。初次 npm test 出现既有 drop-in reload 等待及 HTTPS Chromium Runtime.evaluate 超时；检查失败日志后，无代码改动单独重跑 6/6，再完整 npm test **570/570**、无跳过。未加重试逻辑、未加超时、未弱化断言。两次原始日志均留在 `/tmp/rotom-review-B2/`。
- 新测试用实际文件+虚拟 timer 验证十次 mark 只有一次写入，以及 file fsync→rename→directory fsync 顺序；真实 app close 验证 pending 保存，真实 SessionsDoc 删除验证清理。
- perf:ci origin/main --runs 1 passed，darwin-arm64 / Node 24.18.0、highLoad=false，gating/guard passed。同步 fsync 是明确的持久化成本；合并减少频繁 marker 写入，不宣称消除所有配置写入阻塞。全部 worse（含前序 A）如下；中间 view 差异按实测计数解释，不将单轮时序差异伪装成稳定零回归：

| 计数器                                      | base→head     | 解释                                                                    |
| ------------------------------------------- | ------------- | ----------------------------------------------------------------------- |
| startup.restart/sql.statements              | 848→851       | A1 初始化/游标工作                                                      |
| session.open/sql.statements                 | 45→47         | A2 revision 查询/单行结果（R）                                          |
| session.open/sql.rows                       | 94→96         | A2 revision 查询/单行结果（R）                                          |
| turn.warm/sql.statements                    | 157→174       | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.warm/sql.rows                          | 116→145       | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.warm/json.parse.calls                  | 147→154       | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.warm/json.parse.chars                  | 338695→342144 | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.warm/json.stringify.chars              | 85248→91641   | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.warm/view.entry.visits                 | 8→15          | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.warm/view.stats.entry.scans            | 8→15          | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.warm/view.fields.stringify.calls       | 24→36         | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.warm/view.fields.stringify.chars       | 279→441       | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.warm/view.live.project.calls           | 2→3           | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.warm/view.inbox.project.calls          | 2→3           | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.warm/view.kernel.project.calls         | 2→3           | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.warm/view.kernel.sql.heads             | 2→3           | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.warm/view.kernel.sql.attempts          | 4→6           | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.warm/view.kernel.sql.command_inputs    | 3→5           | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.warm/push.events                       | 3→5           | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.warm/push.bytes                        | 13102→18817   | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.warm/push.view.count                   | 2→3           | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.warm/push.view.bytes                   | 8656→9926     | 本轮额外中间 view（2→3）及 session 推送；相关投影/SQL/JSON/字节随之增加 |
| turn.paced/sql.statements                   | 286→288       | A2 revision 查询/单行结果（R）                                          |
| web.open/sql.statements                     | 31→32         | A2 revision 查询/单行结果（R）                                          |
| web.open/cdp.Nodes                          | 996→1112      | A4 preload DOM 节点；其他小差异为浏览器采样                             |
| session.open.long/sql.statements            | 16→17         | A2 revision 查询/单行结果（R）                                          |
| session.open.long/sql.rows                  | 47→49         | A2 revision 查询/单行结果（R）                                          |
| web.open.long/cdp.Nodes                     | 1561→1725     | A4 preload DOM 节点；其他小差异为浏览器采样                             |
| native.warm/sql.rows                        | 10→11         | A2 revision 查询/单行结果（R）                                          |
| web.reopen/cdp.Nodes                        | 1090→1230     | A4 preload DOM 节点；其他小差异为浏览器采样                             |
| web.paced/sql.statements                    | 306→308       | A2 revision 查询/单行结果（R）                                          |
| web.paced/cdp.Nodes                         | 1283→1434     | A4 preload DOM 节点；其他小差异为浏览器采样                             |
| web.send.poll/sql.statements                | 392→413       | R 加上额外中间状态的查询                                                |
| web.send.poll/cdp.Nodes                     | 1454→1595     | A4 preload DOM 节点；其他小差异为浏览器采样                             |
| web.send.stream/sql.statements              | 384→386       | A2 revision 查询/单行结果（R）                                          |
| web.send.stream/cdp.Nodes                   | 1492→1630     | A4 preload DOM 节点；其他小差异为浏览器采样                             |
| commands.discover.cold/sql.rows             | 78→81         | A2 revision 查询/单行结果（R）                                          |
| commands.discover.warm/sql.rows             | 64→66         | A2 revision 查询/单行结果（R）                                          |
| commands.discover.warm/json.stringify.chars | 27229→27263   | 动态元数据（D）；未逐字归因                                             |
| projection.large.open/sql.statements        | 98→99         | A2 revision 查询/单行结果（R）                                          |
| projection.large.paced/sql.statements       | 572→574       | A2 revision 查询/单行结果（R）                                          |
| projection.large.paced/json.stringify.chars | 520461→525295 | paced 合并时点不同，增量视图 payload 字节增加                           |
| projection.large.paced/push.bytes           | 247428→252228 | paced 合并时点不同，增量视图 payload 字节增加                           |
| projection.large.paced/push.view.bytes      | 206056→210856 | paced 合并时点不同，增量视图 payload 字节增加                           |

- 报告 `/tmp/rotom-review-B2/ci/`。未部署/重启。

### B3 — 房间级投影复用

- 实现 `8d42e63`。一次 pushAll 只构造/序列化一套公共 fields、读一次 Git head；每个 client 仍有独立 sentFields 比较、full/delta、live 和 roomState。没有跨 push 缓存公共值。
- format/check/lint/format:check 和 npm test 全通过：571/571，无跳过。新测试同时包含旧 tab、新 tab、完整重发、AuthorsDoc 更新：两 tab 序列化成本等于一个 tab，旧 tab 不重复字段，新 tab 不丢字段。
- perf:ci origin/main --runs 1 passed，darwin-arm64 / Node 24.18.0、highLoad=false，gating/guard passed；四 tab paced 场景 fields.stringify.calls **528→132**，chars **131688→32922**（-75%，L1）。报告 `/tmp/rotom-review-B3/ci/`。
- 全部 worse（包含前序项目，单轮调度差异保留）：

| 计数器                                         | base→head     | 解释                                                                |
| ---------------------------------------------- | ------------- | ------------------------------------------------------------------- |
| startup.restart/sql.statements                 | 848→851       | A1 初始化/游标                                                      |
| session.open/sql.statements                    | 46→47         | A2 revision 查询/标量结果（R）                                      |
| turn.warm/sql.statements                       | 157→158       | A2 revision 查询/标量结果（R）                                      |
| turn.paced/sql.statements                      | 286→288       | A2 revision 查询/标量结果（R）                                      |
| web.open/sql.statements                        | 31→32         | A2 revision 查询/标量结果（R）                                      |
| web.open/cdp.Nodes                             | 996→1112      | A4 preload DOM 节点及浏览器采样                                     |
| session.open.long/sql.statements               | 16→17         | A2 revision 查询/标量结果（R）                                      |
| session.open.long/sql.rows                     | 47→49         | A2 revision 查询/标量结果（R）                                      |
| web.open.long/cdp.Nodes                        | 1561→1701     | A4 preload DOM 节点及浏览器采样                                     |
| native.warm/sql.rows                           | 10→11         | A2 revision 查询/标量结果（R）                                      |
| turn.prewarmed/fs.read.calls                   | 25→26         | 本轮额外中间持久化/投影读取，cold/warm 时序差异；未新增 B3 读取路径 |
| turn.prewarmed/sql.statements                  | 203→219       | 本轮额外中间持久化/投影读取，cold/warm 时序差异；未新增 B3 读取路径 |
| turn.prewarmed/json.parse.durableStorage.calls | 18→20         | 本轮额外中间持久化/投影读取，cold/warm 时序差异；未新增 B3 读取路径 |
| turn.prewarmed/json.parse.durableStorage.chars | 1122→1424     | 本轮额外中间持久化/投影读取，cold/warm 时序差异；未新增 B3 读取路径 |
| web.reopen/cdp.Nodes                           | 1090→1206     | A4 preload DOM 节点及浏览器采样                                     |
| web.paced/sql.statements                       | 306→308       | A2 revision 查询/标量结果（R）                                      |
| web.paced/cdp.Nodes                            | 1294→1433     | A4 preload DOM 节点及浏览器采样                                     |
| web.send.poll/cdp.Nodes                        | 1450→1590     | A4 preload DOM 节点及浏览器采样                                     |
| web.send.stream/sql.statements                 | 384→386       | A2 revision 查询/标量结果（R）                                      |
| web.send.stream/cdp.Nodes                      | 1488→1656     | A4 preload DOM 节点及浏览器采样                                     |
| commands.discover.cold/sql.rows                | 78→81         | A2 revision 查询/标量结果（R）                                      |
| commands.discover.warm/sql.rows                | 64→66         | A2 revision 查询/标量结果（R）                                      |
| projection.large.open/sql.statements           | 98→99         | A2 revision 查询/标量结果（R）                                      |
| projection.large.paced/sql.statements          | 572→574       | A2 revision 查询/标量结果（R）                                      |
| projection.large.paced/push.bytes              | 248228→256228 | 流式合并时点导致 view 字节增加；field 本身仍按客户端基线过滤        |
| projection.large.paced/push.view.bytes         | 206856→214856 | 流式合并时点导致 view 字节增加；field 本身仍按客户端基线过滤        |

- 未改变 viewer 权限计算或个人凭据路由。未部署/重启。

### B4 — 预编译语句

- 实现 `37cb733`。按 SQL 文本缓存连接所属 StatementSync；close 清空缓存再关连接。不缓存查询结果，不改变事务、绑定参数或 schema。SQL 只有有限 literal 和两个 usage 表名，没有用户输入增长的缓存键。
- 接手时保留已有实现和正在运行的验证，没有重放。独立 TypeScript AST 比较确认前后 **66 个 literal/template SQL 调用文本完全一致**。新测试检查三个查询只 prepare 一次、后续写入立即可见、关闭后拒绝查询、重开不复用旧 statement。负控仅绕过 cache hit 后以 3≠1 失败；恢复后通过。
- format/check/lint/format:check passed；npm test **572/572**、无跳过。perf:ci origin/main --runs 1 passed，darwin-arm64 / Node 24.18.0，highLoad=false，gating/guard passed，报告 `/tmp/rotom-review-B4/ci/`。现有 sql.statements 数的是执行次数，不数 prepare，故不把它不变伪称为编译工作未减少，也不凭单轮时间宣称加速。
- 全部 worse（origin/main 比较包含 A1–B3；既有 D 的逐字归因限制保留）：

| 计数器                                          | base→head     | 解释                                                                                     |
| ----------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| startup.restart/sql.statements                  | 848→851       | A1/A3 启动索引、游标及分叉恢复                                                           |
| startup.restart/json.parse.durableStorage.calls | 458→459       | 启动采样多读一个 19 字符 Durable 值；非 journal statement/result 缓存                    |
| startup.restart/json.parse.durableStorage.chars | 51416→51435   | 启动采样多读一个 19 字符 Durable 值；非 journal statement/result 缓存                    |
| session.open/sql.statements                     | 45→47         | A2 indexed revision 标量查询及结果                                                       |
| session.open/sql.rows                           | 94→96         | A2 indexed revision 标量查询及结果                                                       |
| turn.warm/sql.statements                        | 157→158       | A2 indexed revision 标量查询及结果                                                       |
| turn.paced/sql.statements                       | 286→288       | A2 indexed revision 标量查询及结果                                                       |
| web.open/sql.statements                         | 31→32         | A2 indexed revision 标量查询及结果                                                       |
| web.open/cdp.Nodes                              | 996→1112      | A4 preload 元素/文本节点成本，加上采样时节点生命周期差异                                 |
| session.open.long/sql.statements                | 16→17         | A2 indexed revision 标量查询及结果                                                       |
| session.open.long/sql.rows                      | 47→49         | A2 indexed revision 标量查询及结果                                                       |
| web.open.long/cdp.Nodes                         | 1585→1701     | A4 preload 元素/文本节点成本，加上采样时节点生命周期差异                                 |
| native.warm/sql.rows                            | 10→11         | A2 indexed revision 标量查询及结果                                                       |
| native.validate/json.stringify.chars            | 617→685       | 动态元数据输出差异；B4 未修改此路径，具体字符来源未追踪（D 限制）                        |
| web.reopen/cdp.Nodes                            | 1090→1230     | A4 preload 元素/文本节点成本，加上采样时节点生命周期差异                                 |
| web.paced/sql.statements                        | 306→322       | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/view.fields.stringify.calls           | 132→144       | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/view.fields.stringify.chars           | 7050→7695     | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/view.live.project.calls               | 11→12         | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/view.inbox.project.calls              | 11→12         | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/view.kernel.project.calls             | 11→12         | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/view.kernel.sql.statements            | 54→59         | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/view.kernel.sql.heads                 | 11→12         | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/view.kernel.sql.attempts              | 22→24         | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/view.kernel.sql.command_inputs        | 21→23         | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/view.kernel.sql.rows                  | 32→35         | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/view.kernel.json.parse.calls          | 32→35         | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/view.kernel.json.parse.chars          | 17312→18935   | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/push.events                           | 15→16         | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/push.bytes                            | 29633→31430   | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/push.view.count                       | 11→12         | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/push.view.bytes                       | 27295→29092   | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/cdp.Nodes                             | 1284→1410     | A4 preload 元素/文本节点成本，加上采样时节点生命周期差异                                 |
| web.paced/web.event.parse.calls                 | 13→14         | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/web.event.parse.chars                 | 28184→29961   | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.paced/web.view.apply.calls                  | 11→12         | 本次 paced view 推送 11→12；相应投影、SQL、解析/序列化和传输增加（SQL 另含 A2 revision） |
| web.send.poll/cdp.Nodes                         | 1456→1615     | A4 preload 元素/文本节点成本，加上采样时节点生命周期差异                                 |
| web.send.stream/sql.statements                  | 403→405       | A2 indexed revision 标量查询及结果                                                       |
| web.send.stream/cdp.Nodes                       | 1472→1639     | A4 preload 元素/文本节点成本，加上采样时节点生命周期差异                                 |
| commands.discover.cold/sql.rows                 | 78→81         | A2 indexed revision 标量查询及结果                                                       |
| commands.discover.warm/sql.rows                 | 64→66         | A2 indexed revision 标量查询及结果                                                       |
| projection.large.open/sql.statements            | 98→99         | A2 indexed revision 标量查询及结果                                                       |
| projection.large.paced/push.bytes               | 248456→249828 | 原有合并窗口中发送的 live 文本长度不同；本次 +1372 B，未改变 payload schema              |
| projection.large.paced/push.view.bytes          | 207084→208456 | 原有合并窗口中发送的 live 文本长度不同；本次 +1372 B，未改变 payload schema              |
| changes.poll.images/json.stringify.chars        | 20296→20330   | 动态元数据输出差异；B4 未修改此路径，具体字符来源未追踪（D 限制）                        |

- 没有修改 vendor、凭据或 unknown 结果处理；未部署/重启。

### B5 — 长轮询队列

- 实现 `5fb4bbe`。每个 poller 的 UTF-8 event JSON+分隔符最多 8 MiB（另加固定 UUID envelope）；入队只序列化一次，重发拼接已存字符串。ACK 释放对应字节，关闭清空队列；溢出销毁等待响应并 detach，旧 session 再请求获得新 session/full view。attach 阶段超限也不会把部分初始视图当成功返回。没有改 journal push 采集 schema、权限或用户 send 重放语义。
- 四个新 HTTP 回归覆盖：toJSON 仅入队一次且原对象后续变化不改重发内容；UTF-8 多字节计数和 ACK 释放；多个单独能容纳的未确认事件累计超限；等待请求/初始大 view 超限断开后完整重连。已有 gzip/SSE 测试保留。负控禁用上限后，“oversized initial poll”因没有拒绝而失败；恢复后通过。
- format/check/lint/format:check passed；最终 npm test **576/576**、无跳过。第一次 perf 在未改的 origin/main 基线阶段因缺少 send.shown 报告失败，未运行 head；当时 highLoad=true（17.74→21.20/8 核），日志 `/tmp/rotom-review-B5/perf.log`。没有改断言、加超时或提高 ledger。
- 原标准复验 `perf:ci -- origin/main --runs 1` passed，gating/guard passed；darwin-arm64 / Node 24.18.0，**highLoad=true**（9.74→6.45/8 核），只接受计数/正确性，不作毫秒加速承诺。最终报告 `/tmp/rotom-review-B5/final-ci/`；全部 worse 如下（包含前序 A/B）。

| 计数器                                         | base→head     | 解释                                                                                |
| ---------------------------------------------- | ------------- | ----------------------------------------------------------------------------------- |
| startup.restart/sql.statements                 | 848→851       | A1/A3 启动索引、游标及分叉恢复                                                      |
| session.open/sql.statements                    | 46→48         | A2 indexed revision 标量查询及结果                                                  |
| session.open/sql.rows                          | 107→109       | A2 indexed revision 标量查询及结果                                                  |
| turn.paced/sql.statements                      | 286→288       | A2 indexed revision 标量查询及结果                                                  |
| web.open/sql.statements                        | 31→32         | A2 indexed revision 标量查询及结果                                                  |
| web.open/cdp.Nodes                             | 996→1112      | A4 preload 元素/分隔文本成本，叠加采样节点生命周期差异                              |
| session.open.long/sql.statements               | 16→17         | A2 indexed revision 标量查询及结果                                                  |
| session.open.long/sql.rows                     | 47→49         | A2 indexed revision 标量查询及结果                                                  |
| session.history.earlier/json.stringify.chars   | 243098→243132 | 动态元数据输出差异；对应非 poll 路径未改，逐字来源未追踪（D 限制）                  |
| web.open.long/cdp.Nodes                        | 1561→1701     | A4 preload 元素/分隔文本成本，叠加采样节点生命周期差异                              |
| native.warm/sql.rows                           | 10→11         | A2 indexed revision 标量查询及结果                                                  |
| turn.prewarmed/fs.read.calls                   | 25→26         | 预热首轮收尾采样多了文件/Durable 读取；另含 A2 revision（不是 poll 队列路径）       |
| turn.prewarmed/sql.statements                  | 189→205       | 预热首轮收尾采样多了文件/Durable 读取；另含 A2 revision（不是 poll 队列路径）       |
| turn.prewarmed/json.parse.durableStorage.calls | 18→20         | 预热首轮收尾采样多了文件/Durable 读取；另含 A2 revision（不是 poll 队列路径）       |
| turn.prewarmed/json.parse.durableStorage.chars | 1122→1424     | 预热首轮收尾采样多了文件/Durable 读取；另含 A2 revision（不是 poll 队列路径）       |
| web.reopen/cdp.Nodes                           | 1090→1230     | A4 preload 元素/分隔文本成本，叠加采样节点生命周期差异                              |
| web.paced/sql.statements                       | 306→308       | A2 indexed revision 标量查询及结果                                                  |
| web.paced/cdp.LayoutCount                      | 13→15         | 高负载下浏览器帧/布局采样差异；B5 无 DOM 实现改动，不据此声称时间改善               |
| web.paced/cdp.Nodes                            | 1294→1424     | A4 preload 元素/分隔文本成本，叠加采样节点生命周期差异                              |
| web.send.poll/cdp.Nodes                        | 1474→1596     | A4 preload 元素/分隔文本成本，叠加采样节点生命周期差异                              |
| web.send.stream/sql.statements                 | 384→386       | A2 indexed revision 标量查询及结果                                                  |
| web.send.stream/push.bytes                     | 91291→91894   | 原有 stream/paced 合并窗口中的 live 文本/元数据采样差异；B5 未改变 stream 帧 schema |
| web.send.stream/push.view.bytes                | 77497→78100   | 原有 stream/paced 合并窗口中的 live 文本/元数据采样差异；B5 未改变 stream 帧 schema |
| web.send.stream/cdp.Nodes                      | 1509→1651     | A4 preload 元素/分隔文本成本，叠加采样节点生命周期差异                              |
| commands.discover.cold/sql.rows                | 78→81         | A2 indexed revision 标量查询及结果                                                  |
| commands.discover.warm/sql.rows                | 64→66         | A2 indexed revision 标量查询及结果                                                  |
| projection.large.open/sql.statements           | 98→99         | A2 indexed revision 标量查询及结果                                                  |
| projection.large.paced/sql.statements          | 572→574       | A2 indexed revision 标量查询及结果                                                  |
| projection.large.paced/push.bytes              | 253028→257828 | 原有 stream/paced 合并窗口中的 live 文本/元数据采样差异；B5 未改变 stream 帧 schema |
| projection.large.paced/push.view.bytes         | 211656→216456 | 原有 stream/paced 合并窗口中的 live 文本/元数据采样差异；B5 未改变 stream 帧 schema |
| image.single/json.stringify.chars              | 349→417       | 动态元数据输出差异；对应非 poll 路径未改，逐字来源未追踪（D 限制）                  |
| changes.poll.images/json.stringify.chars       | 20272→20388   | 动态元数据输出差异；对应非 poll 路径未改，逐字来源未追踪（D 限制）                  |
| changes.poll.images/http.body.bytes            | 20272→20320   | 动态元数据输出差异；对应非 poll 路径未改，逐字来源未追踪（D 限制）                  |

- 限制已写入 CONFIGURATION：超过上限的单个 initial event 无法通过该连接交付，必须使用现有 tail/pages；若仍超限，需要另设计有界事件协议，而不是静默截断或提高阈值。D 项仍没有逐字归因证据；本次未据其宣称没有任何字节/调度差异。未部署/重启。

### C1–C6 与最终交付检查

- 方案提交 `14caa83`，内容见末节；只有 HANDOFF 文档变更，C 产品能力没有实现。C2 额外执行了真实代码的合成成本观测，局限和临时证据路径已列明；不涉及真实账号或部署。
- 最终 format/check/lint/format:check passed，npm test **576/576**、无跳过，日志 `/tmp/rotom-review-C/`。服务端实现与 B5 perf 通过的版本相同；文档更新不重复跑耗时基准。
- B4 AST 等价核对实际是 **66** 个 SQL literal/template（不是先前记录的 64）；`6b654f5` 只修正记录，证据 `/tmp/rotom-review-B4/sql-equivalence.json`。
- 最终范围核对：vendor/qoder、docs.ts 无 diff；journal user_version 写入未变。ledger 的 **1749 个既有条目全部原样保留，仅新增 9 个测量条目**，未放宽阈值/基线。
- 用户原有 opportunities.md 与未跟踪的 2026-10-21-proposals.md 均与开工备份逐字节相同，未暂存/提交。只追加本分支提交，不合并 main、不强推。A/B 与 C 方案均标为「已推送待核验」，不代审查方填写「核验通过」。

### A4 — 第 1 轮核验修复：preload 尽力而为

- 单独提交：`A4: keep preload failures from breaking the app page`。仅修复 assets.ts、补静态资源回归测试并更新本记录；其余核验状态不变。
- 缓存图校验和重新扫描都在可放弃的 preload 边界内。缺失目标、未知 vendor 目标、已缓存模块消失时，丢弃整份 preload 清单，原始 index 仍返回 200，脚本内容/顺序和 CSP 不变。失败不缓存为永久降级，后续请求恢复正常图时重新生成 preload。首页自身缺失按原文件路由语义返回 404，而不是 500；其他非 not-found 的首页读取错误仍上报。
- 回归使用进程内文件读取重定向到临时 web 副本，未编辑运行中的 web/。覆盖模板字符串中的假 import（普通路径和未知 vendor）、已缓存文件删除、随后恢复 preload、原始 HTML/CSP、降级响应的 ETag/304，以及 index 删除/恢复。修复前模板假 import 的测试为 500≠200；404 子修复前为 500≠404；修复后均通过。
- format/check/lint/format:check passed；静态资源定向测试 **4/4**；最终 npm test **577/577**、无跳过。证据：`/tmp/rotom-review-A4-round1/{negative,negative-index,test}.log`。
- `perf:ci -- origin/main --runs 1` passed，gating/ledger guard passed。基线 `origin/main=e649d9d`，darwin-arm64 / Node 24.18.0，highLoad=false（3.65→3.56/8 核），报告 `/tmp/rotom-review-A4-round1/ci/`。健康路径的首次资源字节 1,142,870→405,839、条件请求→0，与前轮优化结果一致。本轮是正确性修复，不作单轮耗时加速承诺；未改 ledger。
- 相对 origin/main 的所有 worse 如下；比较包含整条审查分支的前序优化，不是本轮修复独有的增量：

| 计数器                                 | base→head     | 解释                                                                                                                             |
| -------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| startup.restart/sql.statements         | 848→851       | 前序 A1/A3 的启动索引、游标及恢复查询；本轮未改存储路径                                                                          |
| session.open/sql.statements            | 46→47         | 前序 A2 的 indexed revision 查询及其返回标量；本轮未改该路径                                                                     |
| turn.warm/sql.statements               | 157→158       | 前序 A2 的 indexed revision 查询及其返回标量；本轮未改该路径                                                                     |
| turn.paced/sql.statements              | 286→288       | 前序 A2 的 indexed revision 查询及其返回标量；本轮未改该路径                                                                     |
| web.open/sql.statements                | 31→32         | 前序 A2 的 indexed revision 查询及其返回标量；本轮未改该路径                                                                     |
| web.open/cdp.Nodes                     | 996→1112      | 前序 A4 的 modulepreload link/文本节点成本，另有浏览器采样生命周期差异；本轮成功路径不增删节点                                   |
| session.open.long/sql.statements       | 16→17         | 前序 A2 的 indexed revision 查询及其返回标量；本轮未改该路径                                                                     |
| session.open.long/sql.rows             | 47→49         | 前序 A2 的 indexed revision 查询及其返回标量；本轮未改该路径                                                                     |
| web.open.long/cdp.Nodes                | 1561→1701     | 前序 A4 的 modulepreload link/文本节点成本，另有浏览器采样生命周期差异；本轮成功路径不增删节点                                   |
| native.warm/sql.rows                   | 10→11         | 前序 A2 的 indexed revision 查询及其返回标量；本轮未改该路径                                                                     |
| web.reopen/cdp.Nodes                   | 1090→1230     | 前序 A4 的 modulepreload link/文本节点成本，另有浏览器采样生命周期差异；本轮成功路径不增删节点                                   |
| web.paced/cdp.Nodes                    | 1269→1433     | 前序 A4 的 modulepreload link/文本节点成本，另有浏览器采样生命周期差异；本轮成功路径不增删节点                                   |
| web.send.poll/cdp.Nodes                | 1452→1618     | 前序 A4 的 modulepreload link/文本节点成本，另有浏览器采样生命周期差异；本轮成功路径不增删节点                                   |
| web.send.stream/sql.statements         | 384→386       | 前序 A2 的 indexed revision 查询及其返回标量；本轮未改该路径                                                                     |
| web.send.stream/push.bytes             | 91492→91693   | 既有 stream/paced live 推送字节差异；合并时序是可能来源，未采集原始 payload，无法逐字归因（延续 D 限制），不作为本轮性能收益证据 |
| web.send.stream/push.view.bytes        | 77698→77899   | 既有 stream/paced live 推送字节差异；合并时序是可能来源，未采集原始 payload，无法逐字归因（延续 D 限制），不作为本轮性能收益证据 |
| web.send.stream/cdp.Nodes              | 1515→1634     | 前序 A4 的 modulepreload link/文本节点成本，另有浏览器采样生命周期差异；本轮成功路径不增删节点                                   |
| commands.discover.cold/sql.rows        | 78→81         | 前序 A2 的 indexed revision 查询及其返回标量；本轮未改该路径                                                                     |
| commands.discover.warm/sql.rows        | 64→66         | 前序 A2 的 indexed revision 查询及其返回标量；本轮未改该路径                                                                     |
| projection.large.open/sql.statements   | 98→99         | 前序 A2 的 indexed revision 查询及其返回标量；本轮未改该路径                                                                     |
| projection.large.paced/sql.statements  | 572→574       | 前序 A2 的 indexed revision 查询及其返回标量；本轮未改该路径                                                                     |
| projection.large.paced/push.bytes      | 241828→246628 | 既有 stream/paced live 推送字节差异；合并时序是可能来源，未采集原始 payload，无法逐字归因（延续 D 限制），不作为本轮性能收益证据 |
| projection.large.paced/push.view.bytes | 200456→205256 | 既有 stream/paced live 推送字节差异；合并时序是可能来源，未采集原始 payload，无法逐字归因（延续 D 限制），不作为本轮性能收益证据 |

- 状态改回「已推送待核验」，保留审查方第 1 轮原文；待审查方复核。不部署、不重启线上、不使用真实模型账号。

### D2 — 集中解码、保留通知与拒绝畸形控制

- 测量提交 `1b1228a`；实现提交题名 `D2: centralize native notify control decoding and validation`。这是集中解码/校验的行为修复，不是纯移动。新增 rotom-control.ts，五种 envelope 的 JSON 解码和字段校验只在此处定义；RPC、启动 policy probe、context/tree/barrier adapter、Team UI 共用结果。nonce 仍由发起操作的 adapter 对照，不把“形状正确”当作响应相关性或业务成功。
- 同一只读 RPC event 用 WeakMap 共享结果，不保留历史事件或跨事件/成员内容缓存。合法发送格式、rotom-policy.mjs、pin/vendor、个人凭据路由、journal user_version、Durable 合同及 ledger 均不变。CONFIGURATION/architecture 已同步接收端行为。
- 普通文本、普通 JSON、非保留的不完整 JSON 保留为通知；合法 Team controls 不显示成 notice。保留 kind 的未知版本、字段畸形、保留前缀的 JSON 语法错误，在任何订阅者消费前使 RPC 进入 unknown fence；不吞掉错误、泄漏 payload 或重放。这里保留的语法前缀是发送方现有的 `{"kind":"team-kernel-`（容许空白）；合法 JSON 可以调整字段顺序，任意普通文本不因包含这段文字而被当成控制消息。

| 验证             | 结果                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 定向测量         | 原脚本/工作量未变：100 event × 3 readers，parse **300→100 次**、**13,800→4,600 字符**，均减少 2/3；只证明重复解码减少，不宣称端到端加速 |
| 解码测试         | 普通通知、全部五种 envelope、空白/字段顺序、>16 KB context、事件级缓存、无事件修改、畸形/未知 kind/字段、错误不含正文                   |
| RPC wire fixture | context/tree/barrier 成功及错误 nonce；畸形 JSON、未知 kind、负 children 计数均拒绝，后续写仍 unknown，不重派发                         |
| 真实 native 集成 | 临时共享扩展通过 pinned rotom 发通知，Team tab 收到原始文本/JSON及 warning 级别；private controls 不进入 notice，无模型推理             |
| 负控             | 仅移除 RPC 首次校验后，unknown-kind 用例因 Missing expected rejection 失败；恢复后通过                                                  |
| 静态与完整测试   | format/check/lint/format:check passed；npm test **585/585**，无失败/跳过                                                                |
| 性能             | `perf:ci -- origin/main --runs 1` passed；gating/ledger guard passed；darwin-arm64 / Node 24.18.0；highLoad=false（4.66→6.25/8 核）     |

- 证据目录 `/tmp/rotom-review-D2/`：base.json/head.json、negative.log、test.log、ci/。相对 origin/main=e649d9d 的全部 worse（包含前序 A/B）：

| 计数器                                 | base→head     | 解释                                                                                                                                  |
| -------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| startup.restart/sql.statements         | 848→851       | 前序 A1/A3 索引、游标和恢复查询；D2 未改此路径                                                                                        |
| session.open/sql.statements            | 46→47         | 前序 A2 indexed revision 查询及标量结果；D2 未改存储路径                                                                              |
| turn.warm/sql.statements               | 157→158       | 前序 A2 indexed revision 查询及标量结果；D2 未改存储路径                                                                              |
| turn.paced/sql.statements              | 286→288       | 前序 A2 indexed revision 查询及标量结果；D2 未改存储路径                                                                              |
| web.open/sql.statements                | 31→32         | 前序 A2 indexed revision 查询及标量结果；D2 未改存储路径                                                                              |
| web.open/cdp.Nodes                     | 996→1112      | 前序 A4 preload 的 link/文本节点成本，叠加浏览器取样时序；D2 不修改 DOM/CSS                                                           |
| session.open.long/sql.statements       | 16→17         | 前序 A2 indexed revision 查询及标量结果；D2 未改存储路径                                                                              |
| session.open.long/sql.rows             | 47→49         | 前序 A2 indexed revision 查询及标量结果；D2 未改存储路径                                                                              |
| web.open.long/cdp.Nodes                | 1585→1725     | 前序 A4 preload 的 link/文本节点成本，叠加浏览器取样时序；D2 不修改 DOM/CSS                                                           |
| native.warm/sql.rows                   | 10→11         | 前序 A2 indexed revision 查询及标量结果；D2 未改存储路径                                                                              |
| web.reopen/cdp.Nodes                   | 1090→1230     | 前序 A4 preload 的 link/文本节点成本，叠加浏览器取样时序；D2 不修改 DOM/CSS                                                           |
| web.paced/cdp.Nodes                    | 1269→1434     | 前序 A4 preload 的 link/文本节点成本，叠加浏览器取样时序；D2 不修改 DOM/CSS                                                           |
| web.send.poll/cdp.LayoutCount          | 17→18         | 前序 A4 preload 的 link/文本节点成本，叠加浏览器取样时序；D2 不修改 DOM/CSS                                                           |
| web.send.poll/cdp.Nodes                | 1434→1593     | 前序 A4 preload 的 link/文本节点成本，叠加浏览器取样时序；D2 不修改 DOM/CSS                                                           |
| web.send.stream/http.requests          | 6→8           | 路由追踪复测同一 D2 基线为 8→8：submit/typing、gate/loopback 模型各一次，两轮 favicon 切换；无额外 send/推理，原 6→8 为该窗口采样差异 |
| web.send.stream/cdp.Nodes              | 1448→1633     | 前序 A4 preload 的 link/文本节点成本，叠加浏览器取样时序；D2 不修改 DOM/CSS                                                           |
| commands.discover.cold/sql.rows        | 78→81         | 前序 A2 indexed revision 查询及标量结果；D2 未改存储路径                                                                              |
| commands.discover.warm/sql.rows        | 64→66         | 前序 A2 indexed revision 查询及标量结果；D2 未改存储路径                                                                              |
| projection.large.open/sql.statements   | 98→99         | 前序 A2 indexed revision 查询及标量结果；D2 未改存储路径                                                                              |
| projection.large.paced/sql.statements  | 572→574       | 前序 A2 indexed revision 查询及标量结果；D2 未改存储路径                                                                              |
| projection.large.paced/push.bytes      | 244228→246628 | live 合并窗口或动态元数据字节差异；未采集原始 payload，延续已记录的 D 归因限制，不作为 D2 收益证据                                    |
| projection.large.paced/push.view.bytes | 202856→205256 | live 合并窗口或动态元数据字节差异；未采集原始 payload，延续已记录的 D 归因限制，不作为 D2 收益证据                                    |

- 为区分旧分支差异，另跑 `perf:ci -- 1b1228a --runs 1`，通过且 highLoad=false（3.27→4.30/8 核）。该隔离比较全部 worse：

| 计数器                                          | base→head   | 解释                                                                                                                                  |
| ----------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| startup.restart/json.parse.durableStorage.calls | 458→459     | 启动取样多一个 19 字符 Durable 值；未改恢复/存储逻辑，原始字段未采集，不作逐字来源断言                                                |
| startup.restart/json.parse.durableStorage.chars | 51416→51435 | 启动取样多一个 19 字符 Durable 值；未改恢复/存储逻辑，原始字段未采集，不作逐字来源断言                                                |
| web.paced/sql.statements                        | 308→322     | 本轮 view 11→12、push 15→16，带来对应投影、序列化、SQL/解析与浏览器应用；90 ms 合并窗口的收尾时序不同                                 |
| web.paced/sql.rows                              | 311→323     | 本轮 view 11→12、push 15→16，带来对应投影、序列化、SQL/解析与浏览器应用；90 ms 合并窗口的收尾时序不同                                 |
| web.paced/view.fields.stringify.calls           | 132→144     | 本轮 view 11→12、push 15→16，带来对应投影、序列化、SQL/解析与浏览器应用；90 ms 合并窗口的收尾时序不同                                 |
| web.paced/view.fields.stringify.chars           | 7050→7695   | 本轮 view 11→12、push 15→16，带来对应投影、序列化、SQL/解析与浏览器应用；90 ms 合并窗口的收尾时序不同                                 |
| web.paced/view.live.project.calls               | 11→12       | 本轮 view 11→12、push 15→16，带来对应投影、序列化、SQL/解析与浏览器应用；90 ms 合并窗口的收尾时序不同                                 |
| web.paced/view.inbox.project.calls              | 11→12       | 本轮 view 11→12、push 15→16，带来对应投影、序列化、SQL/解析与浏览器应用；90 ms 合并窗口的收尾时序不同                                 |
| web.paced/view.kernel.project.calls             | 11→12       | 本轮 view 11→12、push 15→16，带来对应投影、序列化、SQL/解析与浏览器应用；90 ms 合并窗口的收尾时序不同                                 |
| web.paced/view.kernel.sql.statements            | 54→59       | 本轮 view 11→12、push 15→16，带来对应投影、序列化、SQL/解析与浏览器应用；90 ms 合并窗口的收尾时序不同                                 |
| web.paced/view.kernel.sql.heads                 | 11→12       | 本轮 view 11→12、push 15→16，带来对应投影、序列化、SQL/解析与浏览器应用；90 ms 合并窗口的收尾时序不同                                 |
| web.paced/view.kernel.sql.attempts              | 22→24       | 本轮 view 11→12、push 15→16，带来对应投影、序列化、SQL/解析与浏览器应用；90 ms 合并窗口的收尾时序不同                                 |
| web.paced/view.kernel.sql.command_inputs        | 21→23       | 本轮 view 11→12、push 15→16，带来对应投影、序列化、SQL/解析与浏览器应用；90 ms 合并窗口的收尾时序不同                                 |
| web.paced/view.kernel.sql.rows                  | 32→35       | 本轮 view 11→12、push 15→16，带来对应投影、序列化、SQL/解析与浏览器应用；90 ms 合并窗口的收尾时序不同                                 |
| web.paced/view.kernel.json.parse.calls          | 32→35       | 本轮 view 11→12、push 15→16，带来对应投影、序列化、SQL/解析与浏览器应用；90 ms 合并窗口的收尾时序不同                                 |
| web.paced/view.kernel.json.parse.chars          | 17312→18935 | 本轮 view 11→12、push 15→16，带来对应投影、序列化、SQL/解析与浏览器应用；90 ms 合并窗口的收尾时序不同                                 |
| web.paced/push.events                           | 15→16       | 本轮 view 11→12、push 15→16，带来对应投影、序列化、SQL/解析与浏览器应用；90 ms 合并窗口的收尾时序不同                                 |
| web.paced/push.view.count                       | 11→12       | 本轮 view 11→12、push 15→16，带来对应投影、序列化、SQL/解析与浏览器应用；90 ms 合并窗口的收尾时序不同                                 |
| web.paced/cdp.LayoutCount                       | 13→15       | 浏览器布局/样式/节点生命周期取样变化；原生通知时序改变，未改 DOM/CSS；不作单轮毫秒结论                                                |
| web.paced/web.event.parse.calls                 | 13→14       | 本轮 view 11→12、push 15→16，带来对应投影、序列化、SQL/解析与浏览器应用；90 ms 合并窗口的收尾时序不同                                 |
| web.paced/web.view.apply.calls                  | 11→12       | 本轮 view 11→12、push 15→16，带来对应投影、序列化、SQL/解析与浏览器应用；90 ms 合并窗口的收尾时序不同                                 |
| web.send.poll/cdp.RecalcStyleCount              | 110→118     | 浏览器布局/样式/节点生命周期取样变化；原生通知时序改变，未改 DOM/CSS；不作单轮毫秒结论                                                |
| web.send.stream/http.requests                   | 6→8         | 路由追踪复测同一 D2 基线为 8→8：submit/typing、gate/loopback 模型各一次，两轮 favicon 切换；无额外 send/推理，原 6→8 为该窗口采样差异 |
| web.send.stream/cdp.Nodes                       | 1587→1652   | 浏览器布局/样式/节点生命周期取样变化；原生通知时序改变，未改 DOM/CSS；不作单轮毫秒结论                                                |
| image.concurrent/json.stringify.chars           | 1396→1464   | live 合并窗口或动态元数据字节差异；未采集原始 payload，延续已记录的 D 归因限制，不作为 D2 收益证据                                    |

- 对重复出现的 stream HTTP 6→8 作了一次外部 diagnostics_channel 路由追踪（不改仓库测量代码、不记录 token/body）。同一对照变成 **8→8**，两侧 submit 后的八条路由完全一致，均只含一次 submit、一次 gate authorize、一次 loopback 模型调用；其余为 typing 和 favicon。报告 route-ci/、routes.log，highLoad=false（2.08→3.42/8 核）。该诊断不用于毫秒收益；不提高阈值、改 workload 或放宽断言。
- 自审边界：唯一 notify JSON 解码入口为 decodeNativeControl；发送端、vendor/pin、存储文档/版本未动。未部署/重启、未使用真实账号。测试扩展只写入临时数据，首次 fixture 使用未被原生自动发现支持的 .mjs 导致命令 rejected；核对原生 loader 后改为它支持的 .js，未放宽产品准入。
- D2 状态为「已推送待核验」；D3 仍待做。下一步由审查方核验 D2，通过后执行方再开始 D3。

### D3 — 测量基线（实现前）

- 新增 markdown-bench.mjs 和共用 Chromium fixture。使用真实 web/ui.js Markdown、Preact、marked、DOMPurify；只替换帧时钟并计数真实 parse/sanitize 调用，无账号、无模型调用。
- 20 个固定帧：burst 每帧 8 次增长、每次再同值渲染一次；paced 每帧增长一次；unchanged 每帧同值渲染一次。均含首次渲染和结束 cache=true，结束后的工作不移出计数窗口。
- a587a23 实现基线：burst **322 次 parse / 2,756,978 字符 / 322 次 sanitize**，最终文本 17,049 字符；paced **22 / 24,643 / 22**；unchanged **22 / 286 / 22**。每组最终都没有待执行帧。结果 /tmp/rotom-review-D3/base.json。
- 同时由未修改的 Markdown 生成 markdown-golden.json：8 组固定输入的最终 DOM HTML（未闭合/闭合 fence、跨块引用/列表/表格、整页 HTML、XSS、长代码折叠、文件路径、rich blocks）。实现后的测试必须逐字对照这份基线，不从新实现重生成期望值。
- 这是增长块与同值父组件提交的定向 L1 测量，不是实际 90 ms 推送频率或毫秒收益。逐帧一次的路径是无收益对照，不能为了数字变小跳过最终解析或 DOMPurify。实现计划：组件内保留最近解析输入，同一帧只解析最新增长值，完成/上下文改变立即刷新，卸载取消 pending frame；不做增量 Markdown 语法解析。

### D3 — 帧合并实现与验证

- 测量提交 `b6d3842`；fixture 独立补丁 `c311666`（支持 Transcript 的嵌套模块）、`d6e57f6`（Browser.close 后等待退出再删 profile）。计数脚本、固定输入和 golden HTML 均未修改。实现提交题名 `D3: coalesce streaming Markdown per frame and flush completion`。
- web/ui.js 的 Markdown 组件内合并增长更新，保留单个 pending frame，不因每次输入替换回调而饿死渲染；useMemo 避免同值重解析。首次、完成、会话/basePath 改变立即渲染，结束/卸载取消 pending。仅保留已渲染及最新输入，没有跨组件流式缓存，原 500 条成品 LRU 不变。marked→DOMPurify→partsOf 全文解析链不变，未尝试破坏跨块语义的增量解析。
- 自审实际调用链发现：延后子提交会绕过 Transcript 父级 layout effect 的滚动跟随。真实 Chromium 测试先复现距底部 **760 px** 的回归，再把 image-load 专用监听替换为内容 ResizeObserver；仍遵循 stick/keepPlace，读者向上滚动不被拉回。观察器随会话/缺失状态清理，卸载断开；未增加 UI 文案或 CSS。
- CONFIGURATION/architecture 已同步帧等待、立即完成和高度跟随的行为。

| 定向工作量（20 帧，包含完成）    | parse 次数 base→head | parse 字符 base→head  | sanitize 次数 base→head |
| -------------------------------- | -------------------- | --------------------- | ----------------------- |
| burst：每帧 8 次增长并同值再提交 | **322→22**           | **2,756,978→195,758** | **322→22**              |
| paced：每帧一次增长              | **22→22**            | **24,643→24,643**     | **22→22**               |
| unchanged：每帧同值提交          | **22→2**             | **286→26**            | **22→2**                |

| 检查           | 结果/证据                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 固定 HTML 基线 | 8 组与实现前 golden 逐字一致；覆盖未闭合/跨块 fence、引用/列表/表格、整页 HTML、长代码最终折叠、路径和 rich blocks                              |
| 生命周期与安全 | 完成前保留未执行帧，完成立即对照最终 HTML；验证最新值、取消/卸载、上下文失效、rich streaming 标志；每次解析都有 sanitize，危险 DOM/脚本执行为 0 |
| 负控           | 强制每次立即解析（绕过合并）使 burst 变为 162 而非 22，计数和 pending 用例失败；未修复跟随时滚动用例因 760≠0 失败。恢复最终实现后通过           |
| 语法与静态检查 | node --check 两个 web 文件；format/check/lint/format:check 全通过                                                                               |
| 完整测试       | **600/600**，无失败/跳过；新增 Markdown 浏览器组 **15/15**                                                                                      |
| 性能护栏       | perf:ci -- origin/main --runs 1 通过，ledger guard 通过；Node 24.18.0 / darwin-arm64 / 8 核，highLoad=false（4.10→3.66）                        |
| D3 隔离比较    | perf:ci -- b6d3842 --runs 1 通过，ledger guard 通过；highLoad=false（2.76→2.98）                                                                |

- 相对 origin/main=e649d9d 的全部 worse 如下；并列 D3 隔离样本以区分既有 A/B 差异和本项成本：

| 计数器                                          | origin/main→head | D3 隔离 base→head | 解释                                                                                                             |
| ----------------------------------------------- | ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| startup.restart/sql.statements                  | 848→851          | 851→851           | 主分支差异含 A1/A2/A3 查询和异步窗口；D3 未改 SQL/服务端，隔离复测不增                                           |
| startup.restart/json.parse.durableStorage.calls | 458→459          | 458→458           | 启动窗口多一个 19 字符 Durable 值；D3 没有存储改动，隔离复测不增；未保存原值，不作字段级归因                     |
| startup.restart/json.parse.durableStorage.chars | 51416→51435      | 51416→51416       | 启动窗口多一个 19 字符 Durable 值；D3 没有存储改动，隔离复测不增；未保存原值，不作字段级归因                     |
| session.open/sql.statements                     | 45→48            | 47→47             | 主分支差异含 A1/A2/A3 查询和异步窗口；D3 未改 SQL/服务端，隔离复测不增                                           |
| session.open/sql.rows                           | 94→109           | 96→96             | 主分支差异含 A1/A2/A3 查询和异步窗口；D3 未改 SQL/服务端，隔离复测不增                                           |
| session.open/json.stringify.chars               | 84622→88107      | 84622→84622       | 收尾/90 ms 合并窗口的事件与动态 payload 字节差异；D3 隔离不增。未保存原始 payload，不作逐字段归因                |
| session.open/push.events                        | 9→10             | 9→9               | 收尾/90 ms 合并窗口的事件与动态 payload 字节差异；D3 隔离不增。未保存原始 payload，不作逐字段归因                |
| session.open/push.bytes                         | 82236→86312      | 82236→82236       | 收尾/90 ms 合并窗口的事件与动态 payload 字节差异；D3 隔离不增。未保存原始 payload，不作逐字段归因                |
| turn.cold/sql.statements                        | 209→226          | 226→211           | 主分支差异含 A1/A2/A3 查询和异步窗口；D3 未改 SQL/服务端，隔离复测不增                                           |
| turn.cold/sql.rows                              | 141→153          | 153→146           | 主分支差异含 A1/A2/A3 查询和异步窗口；D3 未改 SQL/服务端，隔离复测不增                                           |
| turn.warm/sql.statements                        | 157→158          | 158→158           | 主分支差异含 A1/A2/A3 查询和异步窗口；D3 未改 SQL/服务端，隔离复测不增                                           |
| turn.paced/sql.statements                       | 286→288          | 288→288           | 主分支差异含 A1/A2/A3 查询和异步窗口；D3 未改 SQL/服务端，隔离复测不增                                           |
| web.open/sql.statements                         | 31→32            | 32→32             | 主分支差异含 A1/A2/A3 查询和异步窗口；D3 未改 SQL/服务端，隔离复测不增                                           |
| web.open/cdp.Nodes                              | 996→1112         | 1112→1112         | 主分支比较含 A4 preload 节点；D3 隔离仍有节点分配/回收取样差异（见下表），最终 DOM 基线不变                      |
| session.open.long/sql.statements                | 16→17            | 17→17             | 主分支差异含 A1/A2/A3 查询和异步窗口；D3 未改 SQL/服务端，隔离复测不增                                           |
| session.open.long/sql.rows                      | 47→49            | 49→49             | 主分支差异含 A1/A2/A3 查询和异步窗口；D3 未改 SQL/服务端，隔离复测不增                                           |
| web.open.long/cdp.Nodes                         | 1585→1701        | 1725→1701         | 主分支比较含 A4 preload 节点；D3 隔离仍有节点分配/回收取样差异（见下表），最终 DOM 基线不变                      |
| native.warm/sql.rows                            | 10→11            | 11→11             | 主分支差异含 A1/A2/A3 查询和异步窗口；D3 未改 SQL/服务端，隔离复测不增                                           |
| web.reopen/cdp.Nodes                            | 1090→1230        | 1206→1230         | 主分支比较含 A4 preload 节点；D3 隔离仍有节点分配/回收取样差异（见下表），最终 DOM 基线不变                      |
| web.paced/sql.statements                        | 306→308          | 308→308           | 主分支差异含 A1/A2/A3 查询和异步窗口；D3 未改 SQL/服务端，隔离复测不增                                           |
| web.paced/cdp.Nodes                             | 1294→1417        | 1433→1425         | 主分支比较含 A4 preload 节点；D3 隔离仍有节点分配/回收取样差异（见下表），最终 DOM 基线不变                      |
| web.send.poll/cdp.RecalcStyleCount              | 112→123          | 111→115           | 独立帧提交和实际高度跟随的样式重算成本；隔离 stream 为 100→110，view 24→24、Layout 18→18。不把这项开销声称为收益 |
| web.send.poll/cdp.Nodes                         | 1452→1620        | 1594→1615         | 主分支比较含 A4 preload 节点；D3 隔离仍有节点分配/回收取样差异（见下表），最终 DOM 基线不变                      |
| web.send.stream/sql.statements                  | 384→386          | 386→386           | 主分支差异含 A1/A2/A3 查询和异步窗口；D3 未改 SQL/服务端，隔离复测不增                                           |
| web.send.stream/push.bytes                      | 91291→91492      | 91291→91291       | 收尾/90 ms 合并窗口的事件与动态 payload 字节差异；D3 隔离不增。未保存原始 payload，不作逐字段归因                |
| web.send.stream/push.view.bytes                 | 77497→77698      | 77497→77497       | 收尾/90 ms 合并窗口的事件与动态 payload 字节差异；D3 隔离不增。未保存原始 payload，不作逐字段归因                |
| web.send.stream/cdp.RecalcStyleCount            | 102→109          | 100→110           | 独立帧提交和实际高度跟随的样式重算成本；隔离 stream 为 100→110，view 24→24、Layout 18→18。不把这项开销声称为收益 |
| web.send.stream/cdp.Nodes                       | 1516→1629        | 1631→1648         | 主分支比较含 A4 preload 节点；D3 隔离仍有节点分配/回收取样差异（见下表），最终 DOM 基线不变                      |
| commands.discover.cold/sql.rows                 | 78→81            | 81→81             | 主分支差异含 A1/A2/A3 查询和异步窗口；D3 未改 SQL/服务端，隔离复测不增                                           |
| commands.discover.warm/sql.rows                 | 64→66            | 66→66             | 主分支差异含 A1/A2/A3 查询和异步窗口；D3 未改 SQL/服务端，隔离复测不增                                           |
| projection.large.open/sql.statements            | 98→99            | 99→99             | 主分支差异含 A1/A2/A3 查询和异步窗口；D3 未改 SQL/服务端，隔离复测不增                                           |
| projection.large.paced/sql.statements           | 572→574          | 574→574           | 主分支差异含 A1/A2/A3 查询和异步窗口；D3 未改 SQL/服务端，隔离复测不增                                           |
| projection.large.paced/push.bytes               | 245828→251428    | 248228→245828     | 收尾/90 ms 合并窗口的事件与动态 payload 字节差异；D3 隔离不增。未保存原始 payload，不作逐字段归因                |
| projection.large.paced/push.view.bytes          | 204456→210056    | 206856→204456     | 收尾/90 ms 合并窗口的事件与动态 payload 字节差异；D3 隔离不增。未保存原始 payload，不作逐字段归因                |

- D3 隔离比较自身全部 worse（不能用主分支已有收益遮盖本项成本）：

| D3 隔离 worse                                | base→head     | 解释                                                                                                                |
| -------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| session.history.earlier/json.stringify.chars | 243098→243132 | 动态序列化结果 +34 字符；后端/投影代码未动，原始值未记录，不冒充已证明的字段归因                                    |
| web.reopen/cdp.Nodes                         | 1206→1230     | 独立子提交后节点分配/浏览器回收时点的取样成本；未增加最终 DOM，8 组固定结果逐字一致；不宣称节点指标改善             |
| web.send.poll/cdp.Nodes                      | 1594→1615     | 独立子提交后节点分配/浏览器回收时点的取样成本；未增加最终 DOM，8 组固定结果逐字一致；不宣称节点指标改善             |
| web.send.stream/cdp.RecalcStyleCount         | 100→110       | 独立帧提交和实际高度跟随的样式重算成本；隔离 stream 为 100→110，view 24→24、Layout 18→18。不把这项开销声称为收益    |
| web.send.stream/cdp.Nodes                    | 1631→1648     | 独立子提交后节点分配/浏览器回收时点的取样成本；未增加最终 DOM，8 组固定结果逐字一致；不宣称节点指标改善             |
| projection.large.open/json.stringify.chars   | 181858→181892 | 动态序列化结果 +34 字符；后端/投影代码未动，原始值未记录，不冒充已证明的字段归因                                    |
| assets.first/http.body.bytes                 | 405839→406244 | 新增帧合并、上下文失效和高度跟随的实现代码；gzip +405 B（ui.js +382，transcript.js +23），请求仍 53、条件响应体仍 0 |

- 取舍/限制：这里只证实 L1 重复解析减少。逐帧一次没有解析收益；一般推送已合并到 90 ms，不能把 burst 的 322→22 外推为生产提速。帧合并可能把中间文本延后到下一帧，且增加独立提交的样式工作；保留初次/最终立即渲染，并付出高度跟随成本来保持行为。不放宽 ledger，不声称单轮毫秒/所有 Markdown/真实手机均已证明。
- 证据在 /tmp/rotom-review-D3/：base.json、head.json、targeted.log、coalescing-negative.log、scroll-negative.log、test.log、ci/、change-ci/。一次测量正常结束后旧 SIGTERM 清理遇到 profile ENOTEMPTY；已单独修正为 graceful Browser.close，未重试/弱化测试断言，遗留 fixture profile 已删除，完整验证随后通过。
- 最终自审：生产改动只有 web/ui.js、web/transcript.js；发送协议、服务端、vendor/pin、凭据、unknown、journal/Durable 合同和 ledger 都未改。用户两处原有文档改动保留。未部署、未重启、未使用真实账号。
- D3「已推送待核验」；由审查方核验并写回结论，通过后执行方再开始 D4。本轮不做 D4。

### D4 — 根组件提交测量（实现前）

- 新增 app-commits-bench.mjs / app-browser.ts / app-commits.js：真实 Chromium、生产 App/Transcript、临时 Team 服务与禁止推理的合成账号。先装 Preact 探针再加载原 app.js；其它模块/订阅仍按生产入口顺序加载。只计 render→diff→commit 完成的指定组件（单独 diffed 会包含 Preact 11 的 SCU bailout，不能当成真实渲染）。
- 1245967 基线：text、thinking、tool 三组各 **20 个已刷新的 live 更新**，每组 App/Transcript/Topbar/SessionList/Composer/NativeBanner/Notices 均 **20 次提交**。每次对 room.ts 重发的 conversation/inbox/agent/stats/clients/viewers/approvals/kernel 作 JSON round-trip，不能靠引用碰巧没变伪造收益；entries/order/省略字段保留 applyView 的引用语义。结果 /tmp/rotom-review-D4/base.json。
- 调用链检索确认：generation/tools/compactions 仅 Transcript 渲染，busy 还影响 App/favicon、Composer、菜单、NativeBanner 等；kernel 的状态/对话框/权限、费用/账号等并非 live-only，必须继续更新根。计划只跳过其它数据完全不变且 busy 不变的 live 更新，让 Transcript 局部订阅；原 store.set 和所有既有订阅顺序保持，不引入状态库、不移动副作用模块。
- 这是确定性组件提交 L1，不代表整个 DOM 重建、真实 token 到达频率或生产毫秒收益。尚未实现或修改 ledger。

### D4 — live 局部订阅实现与验证

- 测量 `58ddb47`，工具样本修正 `c6b784d`，实现题名 `D4: subscribe Transcript locally to live-only updates`。初稿工具样本错用了 slot.args；按 ClientToolSlot 改为 output 并附真实 toolCall block，在原始 58ddb47 生产源码上重跑基线，再恢复实现重跑 head，三组提交计数均未变。测试另验证最后的工具输出实际显示，不把空工具区当优化。
- store.js 新增只读 liveOnlyChange：必须 live 引用改变、busy 不变、所有非 live 字段不变才局部化。room.ts 每次重发的八个 JSON 字段按值及迭代顺序比较；entries Map、order、其它省略字段只比较既有引用，不遍历/拷贝历史。新字段/字段删除、权限/账号、pending unknown、原生 dialogs/statuses/widgets、费用/entries 等变化都保留根更新。
- app.js 原位置的 listener 和 queueMicrotask 保留，已有根工作时不重复比较，并始终使用最新 store.state；没有过滤、重排原 store 通知。Transcript 追加挂载期 live 订阅，挂载时补读，卸载取消；没有新状态库、传输改动或模块副作用移动。
- 自审确认 native statuses/widgets 按 Object.entries 顺序显示。初稿仅比值会漏掉重排：新增真实 UI 测试先复现 first/second 未变成 second/first，再修正比较器；取消“任意键顺序都可忽略”的错误测试假设，保留同值同序新 JSON 对象的阳性控制。初次通过的 perf 报告不是最终版本证据；以下均来自修正后的 final-ci/final-change-ci。
- CONFIGURATION/architecture 已同步订阅边界。未来新增非 Transcript 的 live 消费者须重新审查此边界；没有为未来消费者创建框架或注册表。

| 每组 20 次更新（三组分别 text / thinking / tool）        | base→head                                       |
| -------------------------------------------------------- | ----------------------------------------------- |
| App                                                      | **20→0**                                        |
| Transcript                                               | **20→20**（最后文本/thinking/工具输出实际可见） |
| Topbar / SessionList / Composer / NativeBanner / Notices | 各 **20→0**                                     |

| 验证             | 结果/证据                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 选择边界         | busy、权限、路由、missing、连接、通知、entries/order、费用、账号、原生状态/对话框/widget、unknown、JSON 键顺序等均不被忽略；显式空通知仍触发根刷新 |
| 真实 UI          | busy/Stop 与 favicon 停止、权限降级、原生 status 顺序、标题、最终 entry 正确；同 tick 根更新+多次 live 保留最新值，根和 Transcript 各一次提交      |
| 生命周期/顺序    | 原有 listener 引用相对顺序不变，两个观察者按原序收到每次通知；三轮卸载/重挂载每轮只减/增一个局部订阅，重挂后显示最新值                             |
| 负控             | 禁用 root 跳过分支后，三组无关提交恢复 20 并使测试失败；忽略键顺序时实际 status 重排测试失败。最终恢复/修正后通过                                  |
| 静态/语法        | format/check/lint/format:check passed；node --check 三个 web 文件 passed                                                                           |
| 完整测试         | **608/608**，无失败/跳过；新增 Chromium 组 **8/8**，D3 Markdown/滚动测试也通过                                                                     |
| origin/main 护栏 | perf:ci -- origin/main --runs 1 passed；ledger guard passed；Node 24.18.0 / darwin-arm64 / 8 核，highLoad=false（5.93→5.72）                       |
| D4 隔离护栏      | perf:ci -- 58ddb47 --runs 1 passed；ledger guard passed；highLoad=false（5.72→3.34）                                                               |

- 最终版本相对 origin/main=e649d9d 的全部 worse，并列 D4 隔离样本：

| 计数器                                          | origin/main→head | D4 隔离 base→head | 解释                                                                                                       |
| ----------------------------------------------- | ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| startup.restart/sql.statements                  | 848→851          | 851→851           | 主分支差异含 A1/A2/A3 查询与异步收尾；D4 未改服务端 SQL。原生 HTTP/SSE 场景不执行新 selector               |
| startup.restart/json.parse.durableStorage.calls | 458→459          | 458→458           | 启动取样多一个 19 字符 Durable 值；D4 未改恢复/存储，隔离值未增，未保存原值                                |
| startup.restart/json.parse.durableStorage.chars | 51416→51435      | 51416→51416       | 启动取样多一个 19 字符 Durable 值；D4 未改恢复/存储，隔离值未增，未保存原值                                |
| session.open/sql.statements                     | 45→47            | 47→48             | 原生 SSE watcher 窗口，不执行 App；隔离多一条 view（9→10），随之增加 readback/序列化和推送，服务端代码未改 |
| session.open/sql.rows                           | 94→96            | 96→109            | 原生 SSE watcher 窗口，不执行 App；隔离多一条 view（9→10），随之增加 readback/序列化和推送，服务端代码未改 |
| turn.warm/sql.statements                        | 157→158          | 158→158           | 主分支差异含 A1/A2/A3 查询与异步收尾；D4 未改服务端 SQL。原生 HTTP/SSE 场景不执行新 selector               |
| turn.warm/json.stringify.chars                  | 85248→85250      | 85248→85248       | 异步收尾/90 ms 合并窗口或动态 payload 字节差异；原始正文未采集，不作逐字段来源断言                         |
| turn.paced/sql.statements                       | 286→288          | 288→288           | 主分支差异含 A1/A2/A3 查询与异步收尾；D4 未改服务端 SQL。原生 HTTP/SSE 场景不执行新 selector               |
| web.open/sql.statements                         | 31→32            | 32→32             | 主分支差异含 A1/A2/A3 查询与异步收尾；D4 未改服务端 SQL。原生 HTTP/SSE 场景不执行新 selector               |
| web.open/cdp.Nodes                              | 996→1136         | 1136→1136         | 主分支差异含 A4 preload 节点；D4 隔离的节点取样见本列，组件提交/浏览器回收时点会影响计数，未新增 DOM 模板  |
| session.open.long/sql.statements                | 16→17            | 17→17             | 主分支差异含 A1/A2/A3 查询与异步收尾；D4 未改服务端 SQL。原生 HTTP/SSE 场景不执行新 selector               |
| session.open.long/sql.rows                      | 47→49            | 49→49             | 主分支差异含 A1/A2/A3 查询与异步收尾；D4 未改服务端 SQL。原生 HTTP/SSE 场景不执行新 selector               |
| web.open.long/cdp.Nodes                         | 1561→1725        | 1725→1701         | 主分支差异含 A4 preload 节点；D4 隔离的节点取样见本列，组件提交/浏览器回收时点会影响计数，未新增 DOM 模板  |
| native.warm/sql.rows                            | 10→11            | 11→11             | 主分支差异含 A1/A2/A3 查询与异步收尾；D4 未改服务端 SQL。原生 HTTP/SSE 场景不执行新 selector               |
| turn.prewarmed/sql.statements                   | 204→220          | 205→205           | 主分支差异含 A1/A2/A3 查询与异步收尾；D4 未改服务端 SQL。原生 HTTP/SSE 场景不执行新 selector               |
| turn.prewarmed/sql.rows                         | 124→143          | 136→136           | 主分支差异含 A1/A2/A3 查询与异步收尾；D4 未改服务端 SQL。原生 HTTP/SSE 场景不执行新 selector               |
| turn.prewarmed/json.stringify.chars             | 120992→122919    | 122600→122600     | 异步收尾/90 ms 合并窗口或动态 payload 字节差异；原始正文未采集，不作逐字段来源断言                         |
| web.reopen/cdp.Nodes                            | 1090→1206        | 1206→1206         | 主分支差异含 A4 preload 节点；D4 隔离的节点取样见本列，组件提交/浏览器回收时点会影响计数，未新增 DOM 模板  |
| web.paced/sql.statements                        | 306→308          | 308→308           | 主分支差异含 A1/A2/A3 查询与异步收尾；D4 未改服务端 SQL。原生 HTTP/SSE 场景不执行新 selector               |
| web.paced/cdp.Nodes                             | 1286→1420        | 1415→1419         | 主分支差异含 A4 preload 节点；D4 隔离的节点取样见本列，组件提交/浏览器回收时点会影响计数，未新增 DOM 模板  |
| web.send.poll/http.requests                     | 21→23            | 22→22             | 长轮询/收尾窗口差异；D4 不改网络调用或传输协议，隔离值见本列，未保留逐路由采样                             |
| web.send.poll/cdp.Nodes                         | 1409→1595        | 1592→1612         | 主分支差异含 A4 preload 节点；D4 隔离的节点取样见本列，组件提交/浏览器回收时点会影响计数，未新增 DOM 模板  |
| web.send.stream/sql.statements                  | 384→386          | 386→386           | 主分支差异含 A1/A2/A3 查询与异步收尾；D4 未改服务端 SQL。原生 HTTP/SSE 场景不执行新 selector               |
| web.send.stream/cdp.RecalcStyleCount            | 101→110          | 107→109           | 主分支比较含 D3 帧提交/高度跟随；D4 隔离未变差，不将样式计数当作组件提交次数                               |
| web.send.stream/cdp.Nodes                       | 1491→1648        | 1650→1630         | 主分支差异含 A4 preload 节点；D4 隔离的节点取样见本列，组件提交/浏览器回收时点会影响计数，未新增 DOM 模板  |
| commands.discover.cold/sql.rows                 | 78→81            | 81→81             | 主分支差异含 A1/A2/A3 查询与异步收尾；D4 未改服务端 SQL。原生 HTTP/SSE 场景不执行新 selector               |
| commands.discover.cold/json.stringify.chars     | 33812→33846      | 33846→33846       | 异步收尾/90 ms 合并窗口或动态 payload 字节差异；原始正文未采集，不作逐字段来源断言                         |
| commands.discover.warm/sql.rows                 | 64→66            | 66→66             | 主分支差异含 A1/A2/A3 查询与异步收尾；D4 未改服务端 SQL。原生 HTTP/SSE 场景不执行新 selector               |
| projection.large.open/sql.statements            | 98→99            | 99→99             | 主分支差异含 A1/A2/A3 查询与异步收尾；D4 未改服务端 SQL。原生 HTTP/SSE 场景不执行新 selector               |
| projection.large.paced/sql.statements           | 572→574          | 574→574           | 主分支差异含 A1/A2/A3 查询与异步收尾；D4 未改服务端 SQL。原生 HTTP/SSE 场景不执行新 selector               |

- D4 隔离比较自身全部 worse，不能用此前分支收益遮盖：

| D4 隔离 worse                                | base→head     | 解释                                                                                                           |
| -------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------- |
| session.open/sql.statements                  | 47→48         | 原生 SSE watcher 窗口，不执行 App；隔离多一条 view（9→10），随之增加 readback/序列化和推送，服务端代码未改     |
| session.open/sql.rows                        | 96→109        | 原生 SSE watcher 窗口，不执行 App；隔离多一条 view（9→10），随之增加 readback/序列化和推送，服务端代码未改     |
| session.open/json.stringify.chars            | 84622→88107   | 原生 SSE watcher 窗口，不执行 App；隔离多一条 view（9→10），随之增加 readback/序列化和推送，服务端代码未改     |
| session.open/push.events                     | 9→10          | 原生 SSE watcher 窗口，不执行 App；隔离多一条 view（9→10），随之增加 readback/序列化和推送，服务端代码未改     |
| session.open/push.bytes                      | 82236→86312   | 原生 SSE watcher 窗口，不执行 App；隔离多一条 view（9→10），随之增加 readback/序列化和推送，服务端代码未改     |
| session.history.earlier/json.stringify.chars | 243098→243132 | 异步收尾/90 ms 合并窗口或动态 payload 字节差异；原始正文未采集，不作逐字段来源断言                             |
| web.send.poll/cdp.Nodes                      | 1592→1612     | 主分支差异含 A4 preload 节点；D4 隔离的节点取样见本列，组件提交/浏览器回收时点会影响计数，未新增 DOM 模板      |
| web.send.stream/push.bytes                   | 90889→91291   | 异步收尾/90 ms 合并窗口或动态 payload 字节差异；原始正文未采集，不作逐字段来源断言                             |
| web.send.stream/push.view.bytes              | 77095→77497   | 异步收尾/90 ms 合并窗口或动态 payload 字节差异；原始正文未采集，不作逐字段来源断言                             |
| web.send.stream/web.event.parse.chars        | 29932→30133   | 异步收尾/90 ms 合并窗口或动态 payload 字节差异；原始正文未采集，不作逐字段来源断言                             |
| projection.large.open/json.stringify.chars   | 181858→181892 | 纯原生 SSE 投影场景，不执行 web 组件；90 ms 合并窗口/动态元数据差异，服务端及 workload 未改                    |
| projection.large.paced/json.stringify.chars  | 422004→424401 | 纯原生 SSE 投影场景，不执行 web 组件；90 ms 合并窗口/动态元数据差异，服务端及 workload 未改                    |
| projection.large.paced/push.bytes            | 248228→250628 | 纯原生 SSE 投影场景，不执行 web 组件；90 ms 合并窗口/动态元数据差异，服务端及 workload 未改                    |
| projection.large.paced/push.view.bytes       | 206856→209256 | 纯原生 SSE 投影场景，不执行 web 组件；90 ms 合并窗口/动态元数据差异，服务端及 workload 未改                    |
| assets.first/http.body.bytes                 | 406244→407043 | 必要新增 selector/局部订阅代码，gzip +799 B（app +49、store +606、transcript +144）；请求仍 53，条件响应体仍 0 |

- 限制/成本：这是 L1 提交次数减少，不是“整个 DOM 重建减少”或生产端到端提速承诺。新增八个重发 JSON 字段的逐值比较，成本随其大小变化，没有另行计时（unavailable）；不扫描历史 Map/order，不序列化整份 state，不放宽 ledger。相对时间文案仍在相关组件提交时计算，未新增时钟轮询。真实模型账号/手机未验证、未使用。
- 证据 /tmp/rotom-review-D4/：base.json/head.json、negative.log、order-negative.log、targeted.log、test.log、final-ci/、final-change-ci/；早期 ci/change-ci 是键顺序修正前样本，不作最终完成证据。
- 最终自审：生产改动只在 web/app.js、web/store.js、web/transcript.js；src/server、vendor/pin、凭据、unknown、journal/Durable 合同、package 与 ledger 未改。两处用户原有文档改动逐字节保留。未部署/重启，未做 D5。
- D4「已推送待核验」。下一步由审查方核验并写回，通过后执行方才开始 D5。

### D5 — 切换会话测量（实现前）

- 新增 session-switch-bench.mjs：真实 Chromium、真实认证 Team 服务，两种传输各连续 A/B 切换 6 次，等目标非 checking 视图，不发送用户 prompt，不使用真实账号。HTTP diagnostics 与 pushChannel 计数在初始连接之后开始，未改变 perf ledger/workload。
- de036f7 基线：SSE **6 次新 stream、6 hello、6 完整 sessions**；poll **6 次新 poll session、6 hello、6 完整 sessions**；两者 /api/me 都为 0。结果 /tmp/rotom-review-D5/base.json。poll fixture 用仅解析到回环的 localhost.，避免生产 local 判断强制 SSE；原 D4 fixture 默认行为不变。
- 实现计划：显式协商订阅能力；同一连接上 POST 只读订阅意图，单调 generation 与有序 ACK；取消旧房间、每次及 await 后重查权限；冻结事件所属 generation，丢弃旧代事件（包括 A→B→A）；SSE/poll 共用协议，旧 tab 保持原格式。断线/未知 POST 结果只重建只读连接，不重放用户 send。

### D5 — 单连接订阅切换（已实现；待审查方核验）

- 测量提交：`229bda2`。实现提交：`5acca07`（`D5: reuse event connections with generation-acknowledged subscriptions`）。本轮只做 D5，未开始 D6。
- `POST /api/subscribe` 复用现有认证与 X-Pocket guard；按本人连接标识定位，验证 generation/id/claim 输入。生效的新意图先同步离开旧 room，再在打开前及 await 后检查权限；旧 generation/失效连接/晚到房间结果不能重新挂回。
- 复用同一 Client 需要记录实际已加入的 Room；WeakMap 使 A→B→A 不会被旧异步 leave 删除。加入时 ACK 先于 full view/missing，home 只需 ACK；撤权也确认当前 generation 后发送 missing。
- 仅协商的新 tab 包装七类房间事件为 { generation, data }。SSE 与 poll 入队前冻结代号；poll seq 不因切换重置，非法/超前 seq ACK 不删除队列。旧 tab 格式不变，新 UI 遇旧 server 仍走原重连路径。
- web/store.js 在异步缓存读取前隔离旧代，验证匹配 ACK/generation/room 后才接收房间事件；账号/权限 key 变化不回填旧缓存。全局事件、session-list 版本与 peek 连接标识继续沿用。未知 POST、6s 未完成 ACK/view、SSE 错误和 poll 过期只重建只读连接，不重试原 POST 或用户 send；poll 过期时丢弃旧 URL 创建的临时 poller，再连接最新路由（该异常恢复可能多一次握手）。
- 同步 CONFIGURATION、architecture、VERIFICATION；新增错误文案集中于 src/server/constants/copy.ts。未改个人凭据路由、native unknown fence、vendor/pin、Durable 文档合同、journal schema 或 ledger。

#### 验证与 owner 批准的基线例外

| 检查                                            | 结果                                                                                                                                                                                      | 证据                                                                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| format / check / lint / format:check / web 语法 | 通过；用户原有两份文档逐字节保留                                                                                                                                                          | /tmp/rotom-review-D5/{format,check,lint,format-check}.log；node --check web/store.js                                                              |
| D5 HTTP / 客户端状态机 / Chromium               | 4/4、13/13（含原 5 条）、2/2；SSE/poll 均覆盖                                                                                                                                             | session-subscriptions.test.ts、transport-reprobe.test.ts、session-subscriptions-ui.test.ts；server-tests.log、client-tests.log、browser-tests.log |
| 负控                                            | 临时测试副本移除 generation 比较后，SSE/poll 两项均失败，旧 A / stale duplicate 被接收                                                                                                    | negative.log；生产文件未为负控改写；临时测试已删除                                                                                                |
| 缓存旧测试修正                                  | 原探针假设每次导航新建 EventSource，第一次全量因此失败；改为先装探针再复用 home 连接、观察 POST claim 和包装内 full view。原 checking/无输入框/kept/缺失补齐/退出清缓存断言保留，单测通过 | test/view-cache-ui.test.ts；test-initial.log、cache-regression.log                                                                                |
| 默认 npm test（并发 2）                         | 计时器最终修正前两次 620/621，均为 legacy dropins 的文件监听超时；未跳过、未增大超时、未改旧实现                                                                                          | test-watch-timeout.log、test.log                                                                                                                  |
| D5 前基线的同命令                               | 229bda2 临时 checkout：606/608；复现同一 dropins 超时，另有既有 push 随机 key 异常断言失败                                                                                                | baseline-full.log；临时 checkout 已清理                                                                                                           |
| 独立/并发小组核对                               | dropins 单独 4/4；与 docs-examples 并发 8/8。不能据此断言监听根因已修复                                                                                                                   | dropins-isolated.log、dropins-paired.log                                                                                                          |
| 全套串行（断言、文件均不变）                    | **622/622，无跳过**，457235ms                                                                                                                                                             | node --test --test-concurrency=1 test/*.test.ts；final-test-serial.log                                                                            |
| 性能护栏                                        | main 与 D5 基线两组 exit 0，ledger guard 均 passed                                                                                                                                        | final-perf.log、final-change-perf.log；final-ci/、final-change-ci/                                                                                |

自审补充：把 SSE 当前 401 用例推进到订阅的 6s 截止后，修正前出现第二条连接（auth-timer-negative.log）。现已在两种传输关闭时取消其订阅计时器，并补 poll 401 回归；最终 13 条状态机及 622 条串行全套通过。早期 ci/、change-ci/ 和 621 条串行结果不是最终版本的完成证据。

**owner 本轮明确选择「接受基线例外，移交 D5」**：以串行全量、D5 专项及性能护栏为证据，保留默认并行失败记录，提交推送后等待核验。这仅是本次移交例外，不修改 npm 脚本、测试断言或后续条目的验收门槛。旧监听问题没有在本次修复，不把默认 npm test 记成通过。

#### 定向计数与成本

- 真实 Chromium + 临时 Team 服务，两种传输各 6 次 A/B 顺序切换，等待目标非 checking 视图；无真实账号、无 inference/用户 send。最终 base.json/head.json：SSE 新 stream **6→0**，poll 新 session **6→0**；两者 hello **6→0**、完整 sessions **6→0**，订阅 POST **0→6**。/api/me 原本就是 0，不宣称认证请求从 6 变成 0。
- 这里只证明正常切换的 L1 工作下降；初连、断线重连、权限刷新仍可发送 hello/完整列表。新 POST 仍检查 cookie/权限。默认 ledger 没有单独 session.switch 场景，本项用独立 session-switch-bench.mjs 度量，不伪称修改了现有 ledger scenario。
- 首次静态资源 **407043→407732B（+689B）**，全部来自 store.js gzip **19104→19793B**；请求 53 不变，条件响应体 0。这是协议代码成本，没有放宽 ledger。
- 正式对照沿用此前单轮方法：`npm run perf:ci -- origin/main --runs 1 --out /tmp/rotom-review-D5/final-ci`，负载 2.81→4.03；`npm run perf:ci -- 229bda2 --runs 1 --out /tmp/rotom-review-D5/final-change-ci`，4.66→3.74；Node 24.18.0 / darwin-arm64 / 8 cores。两组都不触发 high-load 阈值，但单轮 L2 不证明生产提速；slower 明细保留在 *-comparison.json。
- 最初默认 3 runs 的 CI 在 600s 工具期限前已完成 base×3/head×2，进入最后 head 后被终止，不作为护栏通过证据。已检查无该测量进程，移除两个遗留临时 checkout；完整样本保留于 timed-out-samples/，改用有明确时限的单轮正式对照，未调整任何门槛。

以下为最终两次 `compare(base, head, ledger)` 判 worse 的并集 **82 项**（main 39，D5 对照 58）。另一列也显示实际值，不把 ledger 旧候选基线的表混成此次前后对比。

| 计数器                                         | origin/main → D5 | D5 基线 → D5  | 解释                                                                                                                                                                |
| ---------------------------------------------- | ---------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| assets.first/http.body.bytes                   | 1142870→407732   | 407043→407732 | store.js 协议实现 gzip +689B；53 请求不变，条件响应体 0。                                                                                                           |
| changes.poll.images/json.stringify.chars       | 20304→20346      | 20338→20354   | changes 未改；含 mtime 等动态版本字符串的字符量微差（两组 +42/+16）。未留正文，不把未测调用次数说成零。                                                             |
| commands.discover.cold/sql.rows                | 78→81            | 81→81         | 相对主干既有工作/采样差；D5 对照此 SQL 指标未增，没有新增 journal 查询路径。                                                                                        |
| commands.discover.warm/sql.rows                | 64→66            | 66→66         | 相对主干既有工作/采样差；D5 对照此 SQL 指标未增，没有新增 journal 查询路径。                                                                                        |
| git.changes/json.stringify.chars               | 2538→3106        | 3105→2540     | 响应体仅 +1B，git/SQL 次数不变；同进程计数窗口含其他序列化，未留 callsite trace。D5 对照反而 3105→2540，不把 +568 当成该接口响应增量。                              |
| native.warm/sql.rows                           | 10→11            | 11→11         | 相对主干既有工作/采样差；D5 对照此 SQL 指标未增，没有新增 journal 查询路径。                                                                                        |
| projection.large.open/sql.statements           | 98→99            | 99→99         | 相对主干既有工作/采样差；D5 对照此 SQL 指标未增，没有新增 journal 查询路径。                                                                                        |
| projection.large.paced/json.stringify.chars    | 556757→417966    | 422700→429931 | 未协商的合成 Client；44 view、132 次共同字段 stringify 不变。最终同版本两次 head 自身为 202856/214856B，快照采样量可变；未留正文，不伪造逐字段归因。                |
| projection.large.paced/push.bytes              | 269548→244228    | 249028→256228 | 未协商的合成 Client；44 view、132 次共同字段 stringify 不变。最终同版本两次 head 自身为 202856/214856B，快照采样量可变；未留正文，不伪造逐字段归因。                |
| projection.large.paced/push.view.bytes         | 228176→202856    | 207656→214856 | 未协商的合成 Client；44 view、132 次共同字段 stringify 不变。最终同版本两次 head 自身为 202856/214856B，快照采样量可变；未留正文，不伪造逐字段归因。                |
| session.history.earlier/json.stringify.chars   | 243098→243132    | 243132→243098 | 历史页路径未改；两组 +34/-34，属动态输出长度变化，未留正文，不伪造字段归因。                                                                                        |
| session.open.long/sql.rows                     | 47→49            | 49→49         | 相对主干既有工作/采样差；D5 对照此 SQL 指标未增，没有新增 journal 查询路径。                                                                                        |
| session.open.long/sql.statements               | 16→17            | 17→17         | 相对主干既有工作/采样差；D5 对照此 SQL 指标未增，没有新增 journal 查询路径。                                                                                        |
| session.open/sql.rows                          | 107→109          | 96→96         | 相对主干既有工作/采样差；D5 对照此 SQL 指标未增，没有新增 journal 查询路径。                                                                                        |
| session.open/sql.statements                    | 46→48            | 47→47         | 相对主干既有工作/采样差；D5 对照此 SQL 指标未增，没有新增 journal 查询路径。                                                                                        |
| startup.restart/sql.statements                 | 848→851          | 851→851       | 相对主干既有工作/采样差；D5 对照此 SQL 指标未增，没有新增 journal 查询路径。                                                                                        |
| turn.paced/sql.statements                      | 286→288          | 288→288       | 相对主干既有工作/采样差；D5 对照此 SQL 指标未增，没有新增 journal 查询路径。                                                                                        |
| turn.prepared/json.parse.durableStorage.calls  | 19→21            | 19→19         | 主干增加，D5 同分支对照未增；既有提交/延后工作窗口采样差。本项未改 Durable 解析或 prepared 路径。                                                                   |
| turn.prepared/json.parse.durableStorage.chars  | 1412→1710        | 1412→1412     | 主干增加，D5 同分支对照未增；既有提交/延后工作窗口采样差。本项未改 Durable 解析或 prepared 路径。                                                                   |
| turn.prepared/sql.statements                   | 185→215          | 201→201       | 主干增加，D5 同分支对照未增；既有提交/延后工作窗口采样差。本项未改 Durable 解析或 prepared 路径。                                                                   |
| turn.warm/sql.statements                       | 157→158          | 188→158       | 相对主干既有工作/采样差；D5 对照此 SQL 指标未增，没有新增 journal 查询路径。                                                                                        |
| web.open.long/cdp.Nodes                        | 1585→1701        | 1725→1701     | DOM/布局时间窗计数（含暂存节点），不等于持久节点增长；D5 未改模板。保留实际增量，不声称零成本或已证明泄漏。                                                         |
| web.open.long/push.view.bytes                  | 165859→165883    | 165859→165883 | 所测 view 新增 generation 包装 24B；full-view 次数未增。                                                                                                            |
| web.open.long/web.event.parse.calls            | 8→9              | 8→9           | 首次完整视图前增加 1 个有序 ACK；它不修改 store、不重发 hello/列表。                                                                                                |
| web.open.long/web.event.parse.chars            | 173290→173492    | 173290→173492 | 能力协商、ACK、房间事件 generation 包装的必要网络成本；不对动态值差做虚假逐字段归因。                                                                               |
| web.open/cdp.Nodes                             | 996→1112         | 1112→1112     | DOM/布局时间窗计数（含暂存节点），不等于持久节点增长；D5 未改模板。保留实际增量，不声称零成本或已证明泄漏。                                                         |
| web.open/push.bytes                            | 83736→83964      | 83736→83964   | 能力协商、ACK、房间事件 generation 包装的必要网络成本；不对动态值差做虚假逐字段归因。                                                                               |
| web.open/push.events                           | 10→11            | 10→11         | 首次完整视图前增加 1 个有序 ACK；它不修改 store、不重发 hello/列表。                                                                                                |
| web.open/push.view.bytes                       | 76309→76333      | 76309→76333   | 所测 view 新增 generation 包装 24B；full-view 次数未增。                                                                                                            |
| web.open/sql.statements                        | 31→32            | 32→32         | 相对主干既有工作/采样差；D5 对照此 SQL 指标未增，没有新增 journal 查询路径。                                                                                        |
| web.open/web.event.parse.calls                 | 9→10             | 9→10          | 首次完整视图前增加 1 个有序 ACK；它不修改 store、不重发 hello/列表。                                                                                                |
| web.open/web.event.parse.chars                 | 82941→83141      | 82941→83141   | 能力协商、ACK、房间事件 generation 包装的必要网络成本；不对动态值差做虚假逐字段归因。                                                                               |
| web.paced/cdp.Nodes                            | 1294→1421        | 1420→1415     | DOM/布局时间窗计数（含暂存节点），不等于持久节点增长；D5 未改模板。保留实际增量，不声称零成本或已证明泄漏。                                                         |
| web.paced/push.events                          | 15→15            | 15→16         | 主干 view 11→11；D5 对照 11→12，连带多一轮投影/SQL/解析。同一最终 head 自身也为 11/12，采样窗差已实测，不隐藏额外工作量。                                           |
| web.paced/push.view.count                      | 11→11            | 11→12         | 主干 view 11→11；D5 对照 11→12，连带多一轮投影/SQL/解析。同一最终 head 自身也为 11/12，采样窗差已实测，不隐藏额外工作量。                                           |
| web.paced/sql.rows                             | 560→311          | 311→323       | 主干 view 11→11；D5 对照 11→12，连带多一轮投影/SQL/解析。同一最终 head 自身也为 11/12，采样窗差已实测，不隐藏额外工作量。                                           |
| web.paced/sql.statements                       | 306→308          | 308→322       | 主干 view 11→11；D5 对照 11→12，连带多一轮投影/SQL/解析。同一最终 head 自身也为 11/12，采样窗差已实测，不隐藏额外工作量。                                           |
| web.paced/view.fields.stringify.calls          | 132→132          | 132→144       | 主干 view 11→11；D5 对照 11→12，连带多一轮投影/SQL/解析。同一最终 head 自身也为 11/12，采样窗差已实测，不隐藏额外工作量。                                           |
| web.paced/view.fields.stringify.chars          | 7050→7050        | 7050→7695     | 主干 view 11→11；D5 对照 11→12，连带多一轮投影/SQL/解析。同一最终 head 自身也为 11/12，采样窗差已实测，不隐藏额外工作量。                                           |
| web.paced/view.inbox.project.calls             | 11→11            | 11→12         | 主干 view 11→11；D5 对照 11→12，连带多一轮投影/SQL/解析。同一最终 head 自身也为 11/12，采样窗差已实测，不隐藏额外工作量。                                           |
| web.paced/view.kernel.json.parse.calls         | 32→32            | 32→35         | 主干 view 11→11；D5 对照 11→12，连带多一轮投影/SQL/解析。同一最终 head 自身也为 11/12，采样窗差已实测，不隐藏额外工作量。                                           |
| web.paced/view.kernel.json.parse.chars         | 17312→17312      | 17312→18935   | 主干 view 11→11；D5 对照 11→12，连带多一轮投影/SQL/解析。同一最终 head 自身也为 11/12，采样窗差已实测，不隐藏额外工作量。                                           |
| web.paced/view.kernel.project.calls            | 11→11            | 11→12         | 主干 view 11→11；D5 对照 11→12，连带多一轮投影/SQL/解析。同一最终 head 自身也为 11/12，采样窗差已实测，不隐藏额外工作量。                                           |
| web.paced/view.kernel.sql.attempts             | 22→22            | 22→24         | 主干 view 11→11；D5 对照 11→12，连带多一轮投影/SQL/解析。同一最终 head 自身也为 11/12，采样窗差已实测，不隐藏额外工作量。                                           |
| web.paced/view.kernel.sql.command_inputs       | 21→21            | 21→23         | 主干 view 11→11；D5 对照 11→12，连带多一轮投影/SQL/解析。同一最终 head 自身也为 11/12，采样窗差已实测，不隐藏额外工作量。                                           |
| web.paced/view.kernel.sql.heads                | 11→11            | 11→12         | 主干 view 11→11；D5 对照 11→12，连带多一轮投影/SQL/解析。同一最终 head 自身也为 11/12，采样窗差已实测，不隐藏额外工作量。                                           |
| web.paced/view.kernel.sql.rows                 | 32→32            | 32→35         | 主干 view 11→11；D5 对照 11→12，连带多一轮投影/SQL/解析。同一最终 head 自身也为 11/12，采样窗差已实测，不隐藏额外工作量。                                           |
| web.paced/view.kernel.sql.statements           | 54→54            | 54→59         | 主干 view 11→11；D5 对照 11→12，连带多一轮投影/SQL/解析。同一最终 head 自身也为 11/12，采样窗差已实测，不隐藏额外工作量。                                           |
| web.paced/view.live.project.calls              | 11→11            | 11→12         | 主干 view 11→11；D5 对照 11→12，连带多一轮投影/SQL/解析。同一最终 head 自身也为 11/12，采样窗差已实测，不隐藏额外工作量。                                           |
| web.paced/web.event.parse.calls                | 13→13            | 13→14         | 主干 view 11→11；D5 对照 11→12，连带多一轮投影/SQL/解析。同一最终 head 自身也为 11/12，采样窗差已实测，不隐藏额外工作量。                                           |
| web.paced/web.view.apply.calls                 | 11→11            | 11→12         | 主干 view 11→11；D5 对照 11→12，连带多一轮投影/SQL/解析。同一最终 head 自身也为 11/12，采样窗差已实测，不隐藏额外工作量。                                           |
| web.reopen/cdp.Nodes                           | 1090→1230        | 1230→1206     | DOM/布局时间窗计数（含暂存节点），不等于持久节点增长；D5 未改模板。保留实际增量，不声称零成本或已证明泄漏。                                                         |
| web.reopen/push.bytes                          | 10313→10541      | 10313→10541   | 能力协商、ACK、房间事件 generation 包装的必要网络成本；不对动态值差做虚假逐字段归因。                                                                               |
| web.reopen/push.events                         | 9→10             | 9→10          | 首次完整视图前增加 1 个有序 ACK；它不修改 store、不重发 hello/列表。                                                                                                |
| web.reopen/push.view.bytes                     | 2001→2025        | 2001→2025     | 所测 view 新增 generation 包装 24B；full-view 次数未增。                                                                                                            |
| web.reopen/web.event.parse.calls               | 8→9              | 8→9           | 首次完整视图前增加 1 个有序 ACK；它不修改 store、不重发 hello/列表。                                                                                                |
| web.reopen/web.event.parse.chars               | 9527→9727        | 9527→9727     | 能力协商、ACK、房间事件 generation 包装的必要网络成本；不对动态值差做虚假逐字段归因。                                                                               |
| web.send.poll/cdp.Nodes                        | 1477→1540        | 1541→1616     | DOM/布局时间窗计数（含暂存节点），不等于持久节点增长；D5 未改模板。保留实际增量，不声称零成本或已证明泄漏。                                                         |
| web.send.poll/http.requests                    | 22→20            | 20→22         | 结束窗口多 2 次请求；D5 未加 send/写重试。未留逐路由 trace，不能精确归因具体请求，不抹掉差额。                                                                      |
| web.send.stream/cdp.Nodes                      | 1474→1653        | 1652→1630     | DOM/布局时间窗计数（含暂存节点），不等于持久节点增长；D5 未改模板。保留实际增量，不声称零成本或已证明泄漏。                                                         |
| web.send.stream/cdp.RecalcStyleCount           | 100→112          | 106→107       | DOM/布局时间窗计数（含暂存节点），不等于持久节点增长；D5 未改模板。保留实际增量，不声称零成本或已证明泄漏。                                                         |
| web.send.stream/push.bytes                     | 100246→91804     | 91492→93768   | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/push.events                    | 32→30            | 30→32         | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/push.view.bytes                | 86452→77986      | 77698→79950   | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/push.view.count                | 26→24            | 24→26         | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/sql.rows                       | 754→379          | 379→390       | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/sql.statements                 | 403→386          | 386→401       | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/view.fields.stringify.calls    | 312→144          | 144→156       | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/view.fields.stringify.chars    | 19070→8798       | 8798→9535     | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/view.inbox.project.calls       | 26→24            | 24→26         | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/view.kernel.json.parse.calls   | 76→70            | 70→76         | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/view.kernel.json.parse.chars   | 41116→37870      | 37870→41116   | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/view.kernel.project.calls      | 26→24            | 24→26         | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/view.kernel.sql.attempts       | 52→48            | 48→52         | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/view.kernel.sql.command_inputs | 50→46            | 46→50         | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/view.kernel.sql.heads          | 26→24            | 24→26         | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/view.kernel.sql.rows           | 76→70            | 70→76         | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/view.kernel.sql.statements     | 128→118          | 118→128       | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/view.live.project.calls        | 26→24            | 24→26         | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/web.event.parse.calls          | 16→15            | 15→16         | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/web.event.parse.chars          | 31914→30445      | 30133→31528   | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |
| web.send.stream/web.view.apply.calls           | 13→12            | 12→13         | 主干 view 26→24；D5 对照 24→26（两个接收者各多一次，浏览器 apply 12→13），连带一轮投影/SQL/解析及 generation 包装字节。同版本 head 已见 24/26，非稳定新增推送路径。 |

- 采样限制：同一最终 head 的两个正式报告，web.paced 为 11/12 view、web.send.stream 为 24/26 view；projection.large.paced 均为 44 view / 132 次共同字段 stringify，但字节为 202856/214856。计数可随时间窗和动态快照量变化，保留必要协议成本，不把其余增量伪称固定开销或零回归。正文/逐路由 trace 未保存，无法进一步精确拆分；单轮 L2 不证明生产提速。
- 最终自审覆盖 app 的 attach/leave/evict、HTTP 授权与输入、两种传输/重连、缓存和原生视图调用链；修正了实际复现的注销计时器问题。无新状态库、无协议写命令重放、无同步子进程进入请求路径。保留用户两处文档；未部署、未重启线上。下一步由审查方核验 D5；通过前不做 D6。

### D6 — 移动前测量与边界（基线 5551a50）

- 四步按 C5 顺序：① conversation-routes 的 upload 分支及紧随的 404 尾段 → conversation-routes/upload.ts，连同仅该段使用的 MAX_UPLOAD / safeName；原匹配位置、method/third 值、鉴权和错误分支不变。② team-kernel 尾部 publicEntry/applyUpdate → team-kernel/projection.ts，只带 type imports，不改私有状态。③ rotom-executions 尾部 readNativeSnapshot/readNativeEntries/NativeTail → rotom-executions/native-tail.ts，带走两个不变的边界常量，不动 #track/receipt/gate/close。④ style.css 末尾 native 区段 → 同目录 native.css，在 index 与 sign-in 的 style.css link 后相邻加载，保持 URL 基准/级联顺序；不使用中途无效的 @import。
- move-equivalence.mjs + move-baseline.json 记录完整 owner 的实现/声明 SHA-256，逐步去掉声明级 import/export 胶水、反向重组原位置后比较。函数/分支/类内正文与注释逐字比较，不用 AST token 等价冒充正文一致；路由匹配条件和最终 404 包含在比较中。常量/文件名 helper 随依赖原样迁移，不改变值。模块只允许已知依赖，无 re-export barrel。
- CSS 按 style.css + 一个原文件边界空行 + native.css 重组，校验全文件/后缀 SHA；index/sign-in 去掉新增 link 后必须等于基线。theme→prefs 与所有 JS 模块/订阅顺序不动。
- style-move-bench.mjs 在真实 Chromium/临时 Team 页面比对 desktop/mobile × dark/light 共 4 组、每组 28 个受控样本节点的全部 computed-style 属性哈希（只规范化临时 origin，按属性名排序），包含 native tree/选择器/unknown/peek；另跑现有真实 UI/mobile/peek 回归。使用 reduced-motion、等待字体及相关 Web Animations 完成/取消后采样，不用 sleep 掩盖未完成。
- 初版 computed-style 探针未稳定排序/等待，基线重复不一致；生产代码尚未移动时纠正采样后重建未提交的基线，连续两次一致。旧探针结果保留 /tmp/rotom-review-D6/，不作验收证据；冻结后的 golden 不再更新以迁就移动。
- native-tail-memory 的测量适配提前独立提交：两版都先加载 execution owner，再从已知新布局的实际 helper owner 取 NativeTail，否则取原布局；不改 seed、计数、GC、边界或断言。步骤③只迁移擦除后的 type import，避免旧版比较失效，不保留兼容 barrel。
- 纯移动不宣称 L1/L2 提速。CSS 若新增请求/压缩成本会单列；不改 ledger。每步独立提交、完整检查与 perf，证据在 /tmp/rotom-review-D6/。D5 的并行测试例外不自动延用到 D6；未做 D7。

### D6 — 执行完成，等待核验

- 测量 `3768653`；按顺序四个纯移动提交：upload 尾段 `d9f7afd`、公开投影 helper `27c3f7e`、JSONL/readback `54387bd`、native CSS 连续后缀 `8506d3d`。无私有状态/鉴权/条件重排、barrel、schema/vendor/pin 或 ledger 改动。
- 每步 format/check/lint/format:check、默认全量及 perf 护栏通过，四步最终均 **622/622、0 skip**。步骤②首次是同一 legacy dropins reload 超时；独立 4/4，owner 只授权重跑默认全量一次，重跑 622/622。没有启用 D5 例外或放宽测试，也未声称 watcher 根因修复。
- 完整 owner 反向重组、移动正文/常量和 CSS 重组 SHA 全部一致。真实 Chromium 4×28 computed-style 样本一致；最终真实 mobile/peek + native snapshot/notify 专项 **59/59**。漏载 CSS 与改动 64 MiB 限制的负控都按预期失败，未改生产文件或冻结 golden。
- 五组单轮 perf 均 exit 0/ledger guard 通过。CSS 必需成本为首次/条件请求 **53→54**，静态 bundle gzip **407732→408346 B（+614）**，条件响应正文仍为 0；两个相邻 HTML link 不引入 @import 串行链，不承诺生产首屏/冷加载性能等价。
- [D6 完整验证记录](d6-validation.md) 列出版本、每步测试、失败日志、CSS 成本、全部 **54 个 worse 并集**和同代码对照；事件正文未留存的细分字节来源保留 unknown。证据根目录 `/tmp/rotom-review-D6/`。
- 已同步 map/architecture/VERIFICATION 的实际 owner 与加载顺序。保留用户两处文档，不部署、不重启线上。**下一步由审查方核验 D6；通过前不做 D7。**

### D7 — 测量基线（7671c97 + 独立测量改动）

- 新增仅供 benchmark 订阅、无内容的 seed-phase 信号，区分 main/worker；不写入性能 journal、不改 ledger。handoff-bench.mjs 在独立子进程分别做 1/10/100 MiB、每档连续三次真实 handoff，记录阶段、主线程 timer lag、parent/process RSS、SQLite DB/WAL/正文及 seed 字节。每次验证新 segment 64 条、共享镜像仍 64 条；随后真实 native warm，第三次之后做一个 loopback 合成首轮。不是生产模型时延，没有真实账号。
- 初版 RSS 取样落在额外 readback/warm 之后，实施前改为 handoff 返回立即记录；原日志保留 base-pre-rss-scope-fix.log，正式证据为 /tmp/rotom-review-D7/base.log 与 base.json。计时锁 highLoad=false（4.27→7.06/8 核），整体 34.8 s。
- 100 MiB 三次 handoff 1084/1110/1092 ms，主线程最长延迟 1047/990/971 ms；materialization 的 append/readback/compare 占主要可迁移 CPU，finish 仍需 441/499/526 ms，projection 含 journal 读取约 78/79/78 ms。D7 不把 D8 的同步 DB writer 偷搬进 worker，也不声称可消除这些剩余阻塞。
- 实现边界：仅将 #seed 的文件构建、持久化、读回及完整比较放进本次 operation 拥有的短生命周期 worker；parent 保留唯一 journal writer、attach 与最终授权/finish。worker 必须等 attach 完成的 ACK 才能 append；worker 完整退出后才允许 finish 或释放 #track。停止、worker 失败/丢结果、readback 不符、最终撤权仍 unknown，不重试，不复用 seed，不跨付费人去重。不做 C1、D8 或 D9。
- 每个正在 materialize 的既有执行至多一个 worker，无独立后台队列/常驻池；保留现有执行并发模型。需要同时测量 structured-clone、worker 生命周期的额外时延/RSS，而非把移出的工作记成消失。

### D7 — 初版全量 worker（第 9 轮要求补阈值）

- 测量 `9e6412d`；同步文件阶段提取 `da1068c`；固定 session-data loader 提取 `d71fd8d`；
  benchmark-only worker copy/closure 探针 `fa269fc`；行为实现及 15 项回归 `acb36e5`。
- 每个 materializing 执行持有一个短生命周期 worker。父线程仍是唯一 journal writer，先 attach 才 ACK
  允许 append；worker 保留文件/目录 fsync、readback 与完整比较。成功结果必须等 worker 退出，再最终授权、
  检查 Stop、finish。Stop/失败/丢结果/最终撤权保持 unknown，不重放；空历史仍无 worker/file。
- 实现阶段默认 `npm test` **637/637**、0 skip；format/check/lint/format:check 通过，无串行例外。
  最终文档/源码注释校验后的默认全量为 **636/637**：`settings-ui.test.ts:312` 的 recovery 用例
  在 `:401` 恢复 owner 时报 `Failed to resolve module specifier "preact/hooks"`。未自动重跑全量。
  独立该文件 7/7；未改的 D6 基线加 150 ms POST 延迟诊断没有复现（1/1），不能宣称基线已有相同失败。
  测试/浏览器/UI 路径对 `7671c97` 无 diff，fixture 是 legacy 路径；导航就绪竞态只是代码阅读推断。
  证据：final-test.log、settings-alone.log、settings-base-delay.log；没有用旧通过覆盖失败。
  随后 owner 明确授权仅重跑一次默认全量，`test-owner-retry.log` 为 **637/637**、0 fail/skip，237830 ms。
  未改该测试、未跳过或使用串行例外；失败记录保留，重跑通过不代表其根因已修复。
  同步 Promise 包装负控在 worker-thread 断言失败；15 项专项含 fork/import 与重开 journal 的 unknown fence。
- 100 MiB 最长主线程 lag **1047/990/971→412/476/480 ms**，但 handoff 总耗时
  **1084/1110/1092→1362/1388/1380 ms**，截至三次返回的进程累计 peak RSS **1335→1626 MiB**。
  1 MiB 总耗时 **40/56/60→301/286/276 ms**。明确保留启动/复制成本，不声称交接更快或完全无阻塞。
- 连续三次的 DB/WAL/正文/seed 字节量前后一致；不去重、不压缩、不跨付费人复用。projection 与 journal finish
  仍同步；并发大历史容量、真实模型与生产 L3 未验证。
- 对 main 和 D7 测量基线两组 perf 护栏均通过；worse 为 58/6 项，62 项并集逐项记录。
  D7 中五项增量由一次 400 ms 延迟 sessions 广播解释：额外 1 SQL/13 rows/4076 wire B/3485 stringify chars；
  独立 trace 在旧/新代码中反向重现，且两者都未创建 worker。history stringify +34 字符未重现，保留 unknown。
- 完整阶段、copy/exit、RSS/存储、48 项 slower 并集及限制见 [D7 核验材料](d7-validation.md)；
  原始证据在 `/tmp/rotom-review-D7/`。已同步架构/map/配置/验证文档，未改 ledger/schema/vendor/pin。
- **下一步：审查方核验 D7；owner 批准的一次默认全量重跑已通过。**
  settings 恢复登录失败的根因仍未修复；若要继续调查，由 owner 另案授权采集失败页面上下文。
  审查时需评估“小历史额外启动延迟/大历史 RSS”取舍；核验通过前不做 D8。
  未做 C1/D8/D9，未部署或重启；用户两份文档保持不变。

### D7 — 第 9 轮补充：8 MiB 分流，重新提交核验

- 在 `0573ad1` 上追加，测量提交 `2af9690`，实现及两路径测试 `859c283`。按公开历史 JSON 的
  UTF-8 字节数选择：**<8 MiB 直接调用 prepareSeed/persistSeed；≥8 MiB 走现有 worker**。
  等号、JSON 转义、Unicode 与 private reasoning 不计入公共大小均有测试。没有新增配置或 pool。
- 依据原 1 MiB 约 22 ms 停顿与 10 MiB 约 118 ms 停顿，选审查允许区间上端 8 MiB，避免中小历史
  固定启动税；不声称测得精确交叉点或最优阈值。大小判定的完整序列化成本也计入 handoff。
- 两路径保留 prepare→父线程 attach→append→fsync→readback/完整比较→最终授权/Stop→finish。
  大路径仍等待 exit，父线程仍唯一 journal writer；材料化后失败/Stop 仍 unknown、不重放。
  小路径不能在同步 I/O 中处理排队的 HTTP Stop；已观测的 Stop 在相应边界阻止 append/commit。
- 31 项专项通过；总是 worker 与 JS 字符长度两条负控分别按预期失败 1/2 项。默认全量首次
  652/653（dropins 文件监听 reload 超时），独立 4/4；暂停后 owner 明确授权本轮一次默认重跑，
  **653/653、0 fail/skip，237897 ms**。未修改监听测试、串行化或放宽门槛，根因未修复。
- format/check/lint/format:check 通过；`test:kernel:app` status=passed、realProvider=false，
  handoff/历史计费/fork/unknown 不续跑等检查仍 true。没有使用真实模型账号。
- 同仪器前后 1/10/100 MiB、每档三次 handoff：1 MiB worker 次数 **3→0**，总耗时
  **300/284/347→42/60/78 ms**；10 MiB lag **47/47/50→45/48/51 ms**；100 MiB lag
  **423/471/488→421/452/497 ms**。10/100 MiB 仍走 worker。100 MiB select 新增约 119–136 ms，
  不宣称大历史总耗时下降。九次 DB/WAL/正文/seed 字节对照一致。
- 两组 perf 护栏通过：对 main 42 worse/23 slower；对 `2af9690` 25 worse/15 slower。
  65 项 worse、34 项 slower 并集和同代码窗口变化对照见 [阈值验证记录](d7-threshold-validation.md)。
  保留无法精确归因的字节/布局差异，不改 ledger、不以单轮 L2 承诺生产 L3。
- 原始证据 `/tmp/rotom-review-D7-threshold/`；用户两份文档保持不变，无部署或重启。
  **D7 改回已推送待核验，由审查方检查第 9 轮要求；D8 不开始。**

### D8 — 测量开始；owner 修订为公开 Storage 边界

- 基于 D7 核验提交 `2e92cbd`。核对 installed pi-durable 1.0.2 后确认公开 Storage 已全部异步；
  原 C3 的完整 Harness 迁移另需事务回调、registry、观察订阅和旧后端服务桥接，不是简单换 SQLite。
- Owner 本轮明确选择 **“调整为 Storage 边界”**：单 worker 承担 RotomJournal 与公开 Durable Storage；
  **Harness、mutation queue、镜像协调、权限及个人凭据仍在父线程**。此项覆盖旧 C3 的线程归属图，
  不代表完整 Harness 已移入 worker。D8a 主线程显式异步 → D8b 默认关闭的 worker 两步仍保留。
- 仍要求单 writer、完整操作/事务、durable ACK、unknown 不重放、有界传输、镜像顺序、权限隔离、
  严格关闭与故障注入；不得提前归档旧后端。D9 未开始。
- 首先运行现有 `perf:measure --runs 1`，计时锁 highLoad=false、load 2.38→3.38/8 核，exit=0。
  证据 `/tmp/rotom-review-D8/base.{log,json}`；无 workload/ledger 更改。当前没有性能收益结论。
- 详细边界及后续验证记录：[D8 记录](d8-validation.md)。本条最初仅记录测量/合同修订；后续状态如下。

### D8a — 第11轮交付记录（第12轮追加修复见下）

- 已拉取 `c6947a8` 并将五个未推送提交 rebase 到它之上，产品/test 内容逐字节保留。
  异步 journal / consumers、投影失效检查与关闭 drain、attach/progress/usage ACK 顺序已实现。
  测量提交现为 `e120828`、`9d70ac6`、`4e8571a`；独立测试同步修复 `28dd658`。
- 当前 format/check/lint/format:check、默认全量 **670/670，0 skip** 通过。设置页账户切换测试不再抢在
  POST 导航完成前导入 store.js；owner 单独批准修复，负控能在确认页确定复现原 preact/hooks 错误。
  未增加 sleep、超时或重放请求。之前失败及一次授权重跑均保留在 D8 记录中。
- 五轮对照发现的大投影稳定变慢没有被接受；已合并 room 状态存储读，去除重复 receipt decode，
  并复用 sessionIfPresent。最终重复对照无 slower，但仍有 **25 项候选 worse**，主要来自一轮 warm
  244.8 ms / 4 次 view（其余四轮 2 次）。尚未把该慢样本归因，不将其直接当作噪声。
- 最终 `perf:ci -- origin/main --runs 1` check/guard 通过；原 ledger / workload / quiet 规则不变。
  **第 11 轮澄清：不要求零变差，要求测试、gating/guard 通过，并逐条说明候选差异。**
- 三项有界诊断已全部完成（22 个 fixture 进程，全部 exit 0）。自然 warm 未复现慢样本；
  状态屏障诊断中两侧都出现长等待和额外 view，相同三次 view 下 head 的 SQL 工作量更少。
  原始慢样本无时间线，不能追溯断言同因；prewarmed 的三项差异及 poll 的 19 次 Layout 均未复现，
  按第 11 轮标为“采样差异，未归因”，不阻塞提交。保留确定计数器的实际来源与原始差值，不伪造根因。
- Owner 已否决额外对照；不做 JSONL 分批/帧边界实验，不追加性能重跑。
  测量证据 `02837de`、实现 `bf04234` 已推送到本审查分支；实现首次推送时的远端 head `bf04234` 经 `git ls-remote` 确认。
  本次 check/lint/format:check、文档测试 4/4 通过；670/670 和 perf gating/guard 是相同产品字节的已有验证，未重复运行。
  [逐项性能记录](d8-performance-review.md)覆盖 25 项隔离 worse 和 52 项 main worse；
  [机器可读证据](d8-performance-evidence.json)保留数值和既有诊断，详情与日志索引见 [D8 记录](d8-validation.md)。
  D8b 等 owner 核验 D8a 后再开始；D9 未开始。用户两份文档保留，不部署、不重启、不使用真实账号。

### D8a — 第12轮追加修复，已推送待核验

- 已拉取 `ba8892e`，保留第12轮原文和旧调度复现脚本。`reserve` 在单次核心事务内检查预期head/绑定再写intent；
  fork/handoff的历史捕获与预留合并，clone加载后核对源revision，不从后来增长的源文件取标签/leaf。
- thinking的phase/fence检查与输入准入合并，准入+修改的drain在首次yield前发布；关闭计划合并为单次core判断。
  授权后不再await journal，使用finish/fail前关闭的active latch与Stop状态检查。修复snapshot receipts未等待Promise的问题。
- [逐条审计和验证](d8a-round12-validation.md)覆盖run、fork/forkSeed、import、handoff、thinking/queued input、mirror及相邻生命周期。
  确定性回归把真实handoff finish排在检查与reserve之间：冲突且不生成新receipt；去掉预期条件的负控会到达测试停止器。
- 最终check/lint/format:check、默认全量 **677/677，0 skip**，kernel/app/commands三组proof通过；无真实模型账号。
  commands proof原先拦截旧的sessionIfPresent，已修正为实际roomSnapshot且保留一次读取/精确binding断言。
- 最终`perf:ci -- origin/main --runs 1` gating/guard通过，highLoad=false；main 34 worse /17 slower，旧D8a五轮→最终单轮4 worse /5 slower。
  discovery的+2 SQL是事务成本；单轮采样不当作稳定延迟收益/回归。见[逐项性能记录](d8a-round12-performance.md)及[数据](d8a-round12-performance.json)。
  首版验证后修正了授权后的存储等待，最终版重新验证；没有为采样数字重跑，没有新增被否决的对照实验。
- 已推送：proof观察点`35e0691`、性能记录`017d855`、原子性实现`bac6976`、证据版本/测量边界`de62bbe`。
  本轮提交信息均以`D8a:`开头，无强推。等待owner核验；D8b/D9未开始，用户两份文档未提交，不部署、不重启。

### D8b — 默认关闭的 storage worker，已推送待核验

- 基线 `230ec01`（D8a 第13轮核验通过）；仅实施 D8b，D9 未开始。
- 已推送测量提交 `237e412`、`729eb9b`、`0a3ab1a`、`07f2d3d`；实现与证据 `1b0da14`。没有改已推送历史或强推。
- `--storage-worker` / `--no-storage-worker` 默认 false。单 worker 只持有 journal 与公开 Durable Storage；Harness、callback、队列、镜像、个人凭据/权限、payer gate/native 所有权留父线程。没有私有表、schema/vendor/pin 改动，也没有旧后端下线。
- FIFO 完整操作、durable ACK、排队取消、分页/队列上限；unknown 不重放、不自动重启或降级 writer。满队列仍可关闭；失败继续清理父资源；native、恢复协调及父环境确认后才完成最终 owner close 并解锁。worker 空环境，不是沙箱。
- check/lint/format:check 通过。最终产品默认完整套件 **724/724**；新增两个报告测试后最新默认完整套件 **725/726，0 skip**。唯一失败为既有 drop-in 文件热重载等待超时，原测试/loader 未改，单独 **4/4**；performance skill 已记载此负载下 flake。未改等待、并行度或断言，不声称最终全量全绿。
- 环境 guard 下 app **10/10**；报告/counter 专项 **7/7**。八类负控观察到预期失败。真实 pinned app off/on **83/84** 次 loopback 请求通过；on 实际杀 worker 后 native PID 退出、两锁保留；commands on **19** 次合成推理通过。无真实模型账号。
- 最终同源码锁内计量 **359856 ms**，load **1.26→4.55/8**，highLoad=false；off/on gating 与 CI ledger guard 通过。D8a→off **14 worse /23 slower**，off→on **12 worse /41 slower**；main→off 累积 **39 worse**，其 main 计时未持锁，毫秒结论 unavailable。只有单轮，不宣称稳定提速。
- 修复了 projection 重复计数与报告导出丢失 V8/传输计数的问题；最终导出 **186** 个真实观测。昂贵公开 SDK 根导出仅为异常分类所需，改为首次 Storage 错误才加载；未使用私有导出。没有修改 WORKLOAD/SCENARIOS/REPORTED、quiet、ledger、容差；workload.ts 仅修正两个 counter 的 source 描述。
- [验收、失败与负控](d8b-validation.md)、[逐项性能与限制](d8b-performance.md)、[机器可读证据](d8b-performance.json)。原始日志保留在 `/tmp/rotom-review-D8b/`。最终源码摘要 `c00a3abf5a1a40fe253b2ec698beddcbdd84129b02f9e0ed75317a1f6df7328f`。
- 两份用户文档逐字保留且未提交；不部署、不重启。下一步由 owner 核验 D8b；生产并发/容量与稳定 L2 结论不在本轮已验证范围内。

### D9a — 旧 Durable 后端只读归档，已推送待核验（D9a）

- **推送事实**：盘点 `6c21763` 与独立实现 `f16246752b3bbdbcbe92ce9212a684d4239a2c70` 已推至 `origin/review/2026-10-23-perf-design-arch`，远端分支与实现提交一致。没有 force-push、rebase 或合并 main。
- **范围**：旧会话保留原后端身份、读取、导出和访问授权；执行、恢复、新建/fork 及普通修改（含直接 note 和 session budget）拒绝。`--no-rotom-kernel` 仅为只读归档模式，两种模式均不加载/监听旧扩展；source/enabled/disabled 记录保留。
- **启动迁移**：公开 Storage API 在 Harness 接管前按完整 catalog root ownership closure 原子提交；保留私有 task/Live 原件，终结活动任务/未结输入、清除忙碌状态并追加不含原始快照的提示。40 层、提交前失败整组不变、提交成功但 ACK 丢失后重开幂等及 cleanup fencing 均有测试。
- **覆盖迁移**：明确区分真实旧版本非空 JSON、native metadata-only 与真实 loopback native inference。默认套件不读取 `.git`、不运行旧产品、不启用执行后门；parser、凭据/权限、历史、文件系统和持久化断言独立保留。补齐真实 native 跨成员运行隔离、compact USD-budget admission、worktree fork cwd/文件共享与源历史不变。
- **最终验收**：check/lint/format:check 通过；默认 `npm test` **723/723**，0 fail/cancel/skip；native app worker off/on 通过（85/86 loopback requests），commands off/on 各 19 inferences/25 checks。396 文件源码 manifest 与最终 proofs/performance 一致。两份用户文件 byte-for-byte 保留且未暂存。
- **性能**：最终锁内 `perf:ci -- origin/main` exit 0，gating/guard 通过，load 3.07→3.53、`highLoad:false`。对 main 为 63 worse/5 slower；对先前测得的 `7478123` 为 47 worse/1 slower；233 个历史 ledger candidate warning 逐项列出。启动 +6 SQL/+39 rows、每视图 readOnly 字段和压缩资源 +133 B 是明确必要成本；部分聚合字符差异及耗时原因仍未归因，不宣称无回归或加速。未改 workload、ledger、阈值、容差或 quiet 规则。
- **证据**：[验收总表](d9a-validation.md)、[测试迁移映射](d9a-test-migration.md)、[fixture provenance](d9a-fixture-provenance.md)、[性能逐项说明](d9a-performance.md)、[公开归档/回滚合同](../../LEGACY-ARCHIVE.md)。原 32 层截断的内存负控在当前测试上失败；丢失 readOnly 传播的早期浏览器负控 0/2，修复后 2/2，最终默认套件包含更强断言。
- **边界**：256 MiB 单根 closure 上限和 catalog 范围明确记录；未测生产规模迁移耗时、真实账号/OAuth/计费或部署。回滚代码不会复活任务，恢复旧产品/数据须匹配离线备份并明确接受备份后数据损失；外部 unknown 不重放。vendor、journal user_version 未改，未部署/重启线上。
- **下一步归属**：由审查方拉取并独立核验 D9a，重点复查上述残余性能候选和迁移/回滚边界。执行方在此停止；**没有执行 D9b/D9c，也不继续删除旧源文件、目录或记录**。

### D9a — 第 15 轮测试时序修复

- 从 `e3ce988` 快进开始。本轮仅修 `test/perf-web-ui.test.ts`：native assistant 条目到达后，等待一帧及随后任务完成，让 `reply.first` 先记录，再切换会话；恢复轮询 flush/readback，直到既有期望列表的全部 9 条记录齐全。
- `web/perf.js` 及其他产品代码未改；期望列表、正耗时/顺序断言保持不变，没有 skip、可选 reply.first 或超时放宽。
- `node --test test/perf-web-ui.test.ts` 顺序独立连跑 **10/10 次全过**，每次 1/1、exit 0；之后默认 `npm test` **723/723**，0 fail/cancel/skip；check/lint/format:check 全部通过。逐次结果、源码 hash 和日志位置见 [d9a-validation.md](d9a-validation.md#round-15-test-only-repair)。
- 本轮独立提交以 `D9a:` 开头；两份用户文件原样保留、未暂存。无 force-push/rebase/main 合并，无部署或真实账号调用。状态为 **已推送待核验(D9a 修复)**，请审查方复核；执行方在此停止，不开始 D9b。

## 核验记录（审查方追加）

<!-- 每项一节：核验了什么、结论（通过 / 未通过）、未通过的原因。 -->

### 第 1 轮核验(HEAD `dd41997`,2026-10-23)

**环境**:linux-x64,Node 24.22.1,pinned rotom 0.1.26(`npm run install:kernel`)。本机以 root 运行,Chromium 需要 `--no-sandbox`,所以真实浏览器测试通过 `PI_POCKET_BROWSER` 指向一个加 `--no-sandbox` 的包装脚本来跑。下面凡是和 `main` 对比的,都是同一台机器、同一套设置下跑出来的。

**全局检查**

| 检查                                     | 结果                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `check` / `lint` / `format:check`        | 通过                                                                                                                                                                                                                                                                                                                     |
| `npm test`(本分支)                       | 570 通过 / 2 失败 / 4 跳过。`a snap browser comes last…` 在 `main`(`e5df4bc`)上同样失败,是因为设了 `PI_POCKET_BROWSER`,属于环境问题。`the engine reads, clicks…` 在全量并发时超时一次,单独重跑 `test/browser.test.ts` 3 次都通过,而且这个测试不经过本分支改过的代码,判定为偶发                                           |
| `npm test`(`main`,对照)                  | 555 通过 / 1 失败(同一个 snap 用例)/ 4 跳过                                                                                                                                                                                                                                                                              |
| `perf:ci -- origin/main --runs 1`(linux) | 通过:Ratchet linux-x64 passed,Ledger guard passed,load 1.3→0.8/4 核。`startup.restart` 的 journalHistory 解析 132,281→0 字符;`session.open.native-long` 解析 2,370,165→0 字符;`journal.large` 162→10.6 ms;首次传输 1,142,870→405,839 B,再次 →0 B。`assets.first/ms` 慢了 36%(42→57 ms,单轮;第一次请求要现场 gzip),不阻塞 |

**A1 — 通过**

- 用本分支的 `RotomJournal` 新建 journal,再跑 `journal-query-bench.mjs --schema`(60 会话 × 600 条)。原有 6 条查询和新增的 `entryCursor`、`hasBranchedHistory`、`segmentRevision` 都已经不再出现 `SCAN kernel_entries`:`entriesAfter` 0.05 ms、`segmentEntries` 2.2 ms、`#terminal` 0.05 ms、`credits` 1.0 ms、`hasBranchedHistory` 0.9 ms、`entryCursor` 0.1 ms、`segmentRevision` 0.02 ms(单位都是每次调用)。
- 回滚兼容:`user_version` 仍是 6;用 `e5df4bc` 的 `RotomJournal` 打开新代码建出的 journal,可以正常打开,4 个新索引都在。
- 游标只在 Durable 提交成功后推进;`count` 和缓存不一致时会用 `entryCursor` 重新定位,和 `OFFSET` 的语义一致(同样排除 handoff、同样按 rowid 排序)。
- 接受执行方的说明:`sql.rows` 统计的是返回行数,所以索引优化不会让它下降,这一点不算未达标。

**A2 — 通过**

- thinking level 和 goal 的缓存键是 segment、该 segment 的最大 rowid,以及 kernelVersion,thinking 还额外带上 fallback level。新增记录、切换 head、换模型、升级 kernel 都会改变缓存键。两个缓存各限 128 条,只存派生出来的值。
- 每次投影多一条带索引的 `MAX(rowid)` 查询(实测 0.02 ms),换掉了整段历史的 `JSON.parse`,这个取舍合理。

**A3 — 通过**

- 已镜像的前缀改用 `hasBranchedHistory`(一条 `EXISTS`)判断,过滤条件和原来的 `rows.some(...)` 一致,也排除了 handoff。60 会话的启动成本从约 3.9 s 降到约 60 × 0.9 ms。SQLite 内部仍然要按会话对 body 跑 `json_extract`,但 JS 侧解析的字符数已经和历史长度无关。

**A4 — 未通过(只有一处需要修,其余通过)**

- 已通过的部分:用真实 HTTP 请求实测,首页带 gzip 和强 ETag,注入了 70 条 modulepreload;65 个 web 模块带上 `If-None-Match` 再请求时全部返回 304;首页再次请求也返回 304。
- **需要修**:`appPage()` 扫描 import 图时,只要有一个目标文件读不到(`readAsset` 抛出 ENOENT,或者 `Unknown module preload`),整个 `serveApp` 就会失败,首页直接返回 500。复现方法:在 `web/app.js` 末尾加一个模板字符串,里面有一行 `import x from "./not-a-module.js"`。这是合法的 JS,浏览器也能正常运行,但首页从 200 变成了 500。改动前,首页不依赖任何模块能不能读到。
- 要求:preload 清单改成尽力而为。扫描到读不到的目标就跳过(或者整份清单放弃,首页不带 preload 照常返回),绝不能因为它让首页失败。另外补一个回归测试:import 图里有一个不存在的目标时,首页仍然返回 200,并且 CSP 不变。
- 小问题,顺手修即可:`index.html` 不存在时,原来返回 404,现在会抛异常,变成 500。

**B1 — 通过**:按 `dev/ino/size/mtimeNs/ctimeNs` 的 stat 指纹复用哈希,最多缓存 256 个文件。`revision` 只在内存里和 `persistent.revision` 比较,`team-resource-view.json` 里存的值不会跨重启参与比较,所以哈希输入格式变了也不会让已有会话误报 `configuration-changed`。

**B2 — 通过**:已读标记 1 s 内合并写入;正常退出时 `flush()` 写盘,并且放在释放锁之前。`save()` 先 fsync 临时文件,rename 后再 fsync 目录。会话从 SessionsDoc 消失时,以及启动恢复时,都会清理对应的 `finishedSeen`。

**B3 — 通过**:`pushAll` 内部只算一次字段 JSON,各客户端只比较字符串;`roomState` 和各客户端各自的字段没有变。

**B4 — 通过**:按 SQL 文本缓存语句,`close()` 时清空;代码里没有 `iterate()`,不存在复用同一条语句时互相打断的问题。

**B5 — 通过**:入队时只序列化一次,8 MiB 字节上限,ACK 后释放字节,超限就断开连接,客户端重新拿完整视图。单个初始视图本身超过 8 MiB 时无法交付,这和 SSE 的现有行为一致,也已经写进 CONFIGURATION。

**C1–C6 — 方案已读,未实现,符合要求**。等 owner 决策。

**下一步**:执行方修 A4 的 preload 容错,单独提交,提交信息以 `A4:` 开头,然后在状态表里把 A4 改回「已推送待核验」。其余各项我已经在状态表里标为「核验通过」。

### 第 2 轮核验(HEAD `f740f42`,2026-10-24)

**A4 — 通过**

- 按第 1 轮的方法复现:在 `web/app.js` 的模板字符串里放一行 `import x from "./not-a-module.js"`。修复后首页返回 200,只是不带 preload;再次请求首页返回 304。去掉这行后恢复 70 条 preload,65 个模块再次请求都返回 304。
- `index.html` 缺失时返回 404,和改动前一致。
- `check`、`lint`、`format:check` 通过。`npm test` 577 项:572 通过、4 跳过、1 失败。失败的是 snap 那一项,原因是环境变量,在 `main` 上同样失败。`test/static-assets.test.ts` 3/3 通过。
- 已知的小代价:扫描失败期间,每次请求都会重新扫描一遍 import 图。源文件都走 `readAsset` 缓存,只要不改文件,开销很小,不阻塞。

A/B 批全部核验通过。C 批等 owner 决策。

### 第 3 轮核验:D1(HEAD `16123a5`,2026-10-24)

**D1 — 通过**

- 改动范围:相对 `8606886`,`src/`、`web/`、`test/` 都没有 diff,只改了 `architecture.md`、`map.md` 和本文件。
- 引用检查:我另写了一个脚本,抽出两份文档里所有 `Class.method` 和 `file.ts: fn` 形式的引用,逐个在 `src/server`、`web`、`bin` 里查找,全部能找到。
- 语义抽查,对照源码逐条看过,都和代码一致:
    - `PocketApp.#open` 的顺序:verify pin → lock → 只有非 kernel 模式才建 `ExtensionLoader` → 打开 storage → `#recover` → `kernel.reconcile` → `execution.recover` → `spend.load` → 订阅 → guard → `harness.resume` → `resumeInterrupted`。
    - 原生会话在 kernel 关闭时不会落到 Durable 上执行:`conversation-routes.ts:49` 会拒绝,`TeamExecution.admit/authorize`(`:116`、`:216`)也会拒绝。
    - 原生 OAuth refresh 会被拒绝(`team-kernel.ts:275`)。
    - 关闭时先 flush 配置,再释放 `harness.lock`。
    - 文档明确写了 D5、D8、D9 尚未实现,没有提前宣称。
- 提醒(不阻塞):`origin/main` 在本分支之后又多了一个提交 `e649d9d`(pre-commit 文件大小检查)。本分支还没有合入它,将来合并前需要同步一次。

D1 核验通过,执行方可以开始 D2。

### 第 4 轮核验:D2(HEAD `0d9dadf`,2026-10-24)

**D2 — 通过(附一条行为变化说明)**

- `check`、`lint`、`format:check` 通过。`npm test` 585 项:580 通过、4 跳过、1 失败,失败的是 snap 那一项,属于环境问题,`main` 上同样失败。
- 五种 envelope 都只由仓库自己的 `rotom-policy.mjs` 发出(`:202`、`:298`、`:338`、`:353`、`:525`),线上格式和发送方都没有改。各读取方仍各自校验 nonce。WeakMap 按事件对象缓存,不会保留历史。
- 测试覆盖了三种情况:普通文本或 JSON 的 notify 仍然显示为通知;五种控制消息都只解码一次;畸形或未知的保留 kind 会被拒绝,而且错误信息里不带 payload。
- **行为变化,owner 需要知道**:如果一条 notify 以 `{"kind":"team-kernel-` 开头,但格式不对或 kind 未知,`RotomRpc` 会直接 `#fail`。这会结束原生进程,结果记为 unknown,会话会被锁住,等待人工处理。原来的做法是忽略这条消息。这样做的好处是控制通道严格 fail-closed,不会把格式错误的 barrier 或 tree 结果当成成功;代价是,如果哪个项目自己的原生扩展恰好发出这个前缀的通知,整个运行都会被中止。这五种 kind 都是本仓库的 policy 扩展发的,而且和 pin 一起锁定版本,所以我判断可以接受,`CONFIGURATION.md` 和 `architecture.md` 也已经写明。
- 另一个顺带的变化:`team-kernel-policy-v1` 原来会作为普通通知显示,现在不再显示,和其它控制消息保持一致。

D2 核验通过,执行方可以开始 D3。

### 第 5 轮核验:D3(HEAD `ba4ac50`,2026-10-24)

**D3 — 通过**

- `check`、`lint`、`format:check` 通过。`npm test` 600 项:595 通过、4 跳过、1 失败,失败的仍是 snap 那一项,属于环境问题。
- 最终 HTML 等价:`markdown-golden.json` 只在测量提交 `b6d3842` 里写入,写入时用的是改动前的渲染代码;实现提交 `ba4ac50` 没有改它。8 组样例(含未闭合 fence、HTML 页面、`javascript:` 链接、`onerror`)用新代码渲染,和这份基线逐字一致。DOMPurify 仍然在 `markdownParts` 里,没有被绕过。
- 帧合并的逻辑:以下几种情况都会立即渲染,不等下一帧——首次渲染、流结束(`cache=true`)、换了会话、换了 `basePath`。只有正在增长的文本会合并到下一帧。同一个 rAF 请求不会被反复替换,所以持续的流不会一直饿着不刷新。卸载时会取消。
- 滚动跟随:改成用 ResizeObserver 观察内容高度,所以延后渲染的 Markdown 和后加载的图片都能让视图跟到底部;读者已经往上滚动时(`stick=false`)不会被拉回底部。`missing` 和启动画面不绑定 `scroller`,effect 会直接返回,不会对 null 调用 observe。
- 说明(不阻塞):后台标签页里 rAF 会暂停,正在增长的文本要等标签页切回前台才刷新;流结束时会立即渲染最终文本,不受影响。执行方报告的代价(首次 gzip 多 405 B、样式重算 100→110)可以接受。

D3 核验通过,执行方可以开始 D4。

### 第 6 轮核验:D4(HEAD `b5b98ff`,2026-10-24)

**D4 — 通过**

- `check`、`lint`、`format:check` 通过。`npm test` 608 项:603 通过、4 跳过、1 失败,失败的仍是 snap 那一项,属于环境问题。
- 主要风险是:根组件不再重渲染后,有没有别的组件读的 live 内容会变旧。我在 `web/` 下搜了所有读取 `view.live` 的地方,结果如下:
    - 除 `transcript.js` 外,其余组件只读 `live.busy`(`app.js`、`composer.js`、`commands.js`、`diff.js`、`native.js`、`store.js`)。`busy` 一变,`liveOnlyChange` 就返回 false,根组件照常渲染。
    - `perf.js` 会读 `generation`,但它是 `store.subscribe` 的订阅者,不走渲染,不受影响。
    - `diff.js` 里的 `live` 是函数参数,和 `view.live` 无关。
- 判定条件是保守的:只要 state 的其它字段、view 的其它键,或者 `conversation`、`agent`、`kernel` 这类每次都重新发送的字段的 JSON(包括键的顺序)有任何变化,根组件都会照常渲染。
- Transcript 自己订阅了 store,挂载时会先补读一次,避免错过订阅建立之前的变化。它没挂载的时候,也没有别的组件需要 live 内容。

D4 核验通过,执行方可以开始 D5。

### 第 7 轮核验:D5(HEAD `18654ba`,2026-10-24)

**D5 — 通过**

- `check`、`lint`、`format:check` 通过。**默认并行**的 `npm test`(并发 2)共 622 项:617 通过、4 跳过、1 失败,失败的仍是环境相关的 snap 那一项。执行方在 darwin 上遇到的 legacy dropins 文件监听超时,我在 linux 上没有复现。owner 批准的「基线例外」在这台机器上用不到,不过那个监听问题仍然只是偶发,并没有修复。
- 服务端代码逐项看过:
    - **订阅归属**:`subscribe` 必须同时匹配服务端生成的 `connection` 和当前登录用户,别人拿到 connection id 也无法订阅。generation 只能递增,旧的或重复的请求只会返回当前的 generation。
    - **权限**:打开 room 前后各检查一次 `canSee`,打开过程中被撤权的,不会确认订阅、也不会推送视图。撤权路径(`:1824`)会先发 `subscription` 确认,再发 `missing`。
    - **竞争**:新 generation 到来时,旧的 `#joinRoom` 会因为 `current()` 为假而释放 room。`#leaveRoom` 改成同步实现,并用 `#clientRooms` 记录客户端所在的 room;客户端在 join 完成前断开时,`#clients.has` 检查能兜住。另外,join 出错时现在会把客户端移出 room,改动前不会。
    - **晚到事件**:room 类事件在入队前就打上 generation,客户端只接受当前 generation、并且已经确认过的事件,同时校验会话 id。已经排队等待重发的事件,不会被改写 generation。
    - **ACK 校验**:`ack` 大于 `poller.seq` 时返回 400。这个检查只用在已经存在的 poller 上,新建 poller 不受影响。
- 旧版标签页不带 `subscriptions=1`,会继续走原来的重连路径。订阅请求丢失或超过 6 s 还没确认时,只会换一条只读连接,不会重发用户的 send。

D5 核验通过,执行方可以开始 D6。

### 第 8 轮核验:D6(HEAD `3cbc299`,2026-10-24)

**D6 — 通过**

- 纯移动:我对 4 个移动提交分别统计了「删除的行」和「新增的行」(去掉首尾空白后按多重集合比较),两边对不上的只有以下几类,算法、鉴权、状态归属都没有改动:
    - `d9f7afd`:只多了 import、新函数签名和 `const { app, request, response, url, user } = api;` 这一行解构,以及一行调用 `return conversationUpload(...)`。上传路由原来就在 `conversationRoutes` 的末尾,所以路由的匹配顺序不变。
    - `27c3f7e`:只多了 import 和 re-export,没有删掉的行。
    - `54387bd`:只是 import 拆分了一下,加了 re-export。
    - `8506d3d`:`style.css` + `native.css` 拼起来和原来的 `style.css` 相比,只少了一行空行。`native.css` 是原文件末尾那一段连续的样式,链接放在 `style.css` 后面,所以层叠顺序不变。`index.html` 和 `sign-in.ts` 生成的页面都加上了这个链接;`native.css` 里也没有 `url(`、`@import`、`@layer`。
- `check`、`lint`、`format:check` 通过。默认并行的 `npm test` 共 622 项:616 通过、4 跳过、2 失败。一个是 snap 那一项,属于环境问题;另一个是 `media-ui` 里的「https: transcript thumbnail…」,原因是浏览器 `Runtime.evaluate` 超时。这个测试单独重跑 3 次都是 2/2 通过,判定为负载下的偶发,和上传路由的移动无关。
- 接受执行方记录的代价:CSS 多 1 个请求、首次 gzip 多 614 B。

D6 核验通过,执行方可以开始 D7。

### 第 9 轮核验:D7(HEAD `cc10114`,2026-10-24)

**D7 — 核验未通过:正确性没有问题,需要补一个大小阈值**

**正确性:通过**

- `check`、`lint`、`format:check` 通过。默认并行的 `npm test` 共 637 项:632 通过、4 跳过、1 失败,失败的仍是环境相关的 snap 那一项。`npm run test:kernel:app` 也通过,其中 `apiHandoffAndCompaction`、`handoffHistoricalUsagePreserved`、`forkGapAndUnknownSourceNotReplayed`、`crashedKernelRemainsUnknownWithoutContinuation` 都是 true。
- 执行顺序没有变:先授权,接着 worker 准备文件,然后**父线程同步 `journal.attach`**,之后 worker 才开始 append、fsync 和读回比较,最后父线程再次授权并 `finish`。journal 只有父线程一个写入方。
- unknown 语义没有变:`materializing = true` 在创建 worker 之前就设置好了,所以 worker 出错、attach 失败、被 stop 或退出码不为 0,结果都是 `unknown`,不是 `rejected`。`stop()` 会等 worker 真正退出;`result` 也只在 worker 退出后才 settle。abort 时会先停 seed。

**取舍:不接受当前形态**

执行方的测量(`d7-validation.md:51-55`)显示:

| 历史大小 | handoff 总耗时 | 主线程最大停顿 |
| -------- | -------------- | -------------- |
| 1 MiB    | ~50 → ~290 ms  | ~22 → ~7 ms    |
| 10 MiB   | ~150 → ~435 ms | ~118 → ~46 ms  |
| 100 MiB  | ~1.1 → ~1.38 s | ~1.0 → ~0.45 s |

最常见的是小历史。对小历史来说,每次接力都要多付约 240 ms 的 worker 启动开销,换来的只是把 20 ms 的停顿去掉,不划算。到了 10 MiB 以上,主线程停顿才明显到需要处理,这时 worker 才值得用。

**要求(只在 D7 上追加提交,提交信息以 `D7:` 开头):**

1. 按 `publicNativeHistory` 结果序列化后的字节数设一个阈值。阈值以下,在父线程里直接调用已经抽出来的 `prepareSeed` / `persistSeed`,顺序和 unknown 语义与 worker 路径完全相同;阈值以上走 worker。阈值根据现有 bench 的交叉点来定,例如 4–8 MiB,并在记录里写明依据。
2. 两条路径都要有测试,至少覆盖:attach 先于 append、materialize 中途失败结果是 unknown、abort/stop。阈值的选择本身也要有测试。
3. 用 1、10、100 MiB 重跑 `handoff-bench`。期望 1 MiB 的总耗时回到基线附近,10 和 100 MiB 的停顿保持现在的水平。

D8 暂不开始。

### 第 10 轮核验:D7 阈值(HEAD `98b45ca`,2026-10-25)

**D7 — 通过**

- 分流规则:公开历史序列化后小于 8 MiB 的,在父线程里直接调用 `prepareSeed` / `persistSeed`;达到或超过 8 MiB 的走 worker。两条路径共用同一个 `attach` 回调,都是先检查 `#notStopped`、再同步 `journal.attach`,然后才 append。`materializing = true` 在分流之前就已设置,所以两条路径上的任何失败结果都是 `unknown`。
- `check`、`lint`、`format:check` 通过。默认并行 `npm test` 共 653 项:648 通过、4 跳过、1 失败,失败的仍是环境相关的 snap 那一项。`test:kernel:app` 通过。
- 执行方重测的结果:1 MiB 的总耗时回到 42/60/78 ms(同步基线是 40/56/60 ms),worker 生命周期次数 3→0;10 MiB 和 100 MiB 的最大停顿保持在约 50 ms 和 500 ms。另有 8 MiB −1 B、8 MiB、8 MiB +1 B 三个边界测试,样本里包含 Unicode 和 JSON 转义。
- 建议(不阻塞):为了算字节数而做的整段 `JSON.stringify`,在 100 MiB 时会在主线程上多花 119–136 ms。可以改成逐条消息累加、超过阈值就提前停止,这样大历史只需要算到 8 MiB 为止。以后要是再调 D7,可以顺手改掉。

D7 核验通过,执行方可以开始 D8。

### 第 11 轮:D8a 验收口径澄清(2026-10-25)

执行方把 D8a 的「perf 不变差」理解成了「不允许任何计数器变差」,于是卡在几个无法复现的采样差异上(`turn.warm` 的 view 次数、`turn.prewarmed`、Layout)。这不是本意。D8a 的门槛和 A–D7 一样,具体是:

1. `npm test`、`check`、`lint`、`format:check` 全部通过;
2. `perf:ci -- origin/main` 的 gating 和 ledger guard 通过;
3. 变差的计数器逐条列出并说明原因。确定性的计数器(SQL 次数、解析字符数、请求数)如果变差,必须讲清楚来源;采样性的计数器(view 次数、Layout、毫秒数)如果多轮受控重跑都不能稳定复现,标为「采样差异,未归因」即可,不阻塞。

不需要另做 JSONL 分批追加、浏览器帧边界交付的对照实验。请把 D8a 现有的产品改动按「测量提交 + 实现提交」提交并推送,附上已有的诊断结论,然后把 D8a 状态改为「已推送待核验」。D8b 等 D8a 核验通过后再开始。

### 第 12 轮核验:D8a(HEAD `198ee52`,2026-10-25)

**D8a — 核验未通过:测试全部通过,但「先检查、后操作」的原子性被拆开了**

**通过的部分**

- `check`、`lint`、`format:check` 通过。默认并行 `npm test` 共 670 项:665 通过、4 跳过、1 失败,失败的仍是环境相关的 snap 那一项。`test:kernel:app` 和 `test:kernel` 都通过。
- `createAsyncRotomJournal` 只是把一次完整的同步核心调用放进 FIFO 队列执行,事务内部不会 await,单条 SQL 事务仍然是连续的。

**问题:原来同步、连续的「检查 → 操作」,中间现在多了 await**

改动前,`RotomExecutions.run` 里的这一段在同一个同步片段里执行(不带 rebind 时),中间没有 await:

```ts
if (this.journal.session(sessionId).segmentId !== admitted.segmentId) throw ...; // 检查
const receipt = this.journal.reserve(sessionId, ...);                             // 操作
```

现在检查和 `reserve` 是两次独立的 `await`。如果有一次接力(handoff)的 `finish` 已经排在队列里,它会**插在检查和 reserve 之间执行**。结果是:检查时 head 还是 A,reserve 时 head 已经变成了 B。这正好违反了代码注释里写明要防止的情况:"A concurrent completed handoff must not reserve the new payer while launching this previously admitted binding"——receipt 绑定的是新付费人,而启动进程用的仍是旧的 `binding`。

最小复现:`docs/performance/review-2026-10-23/d8a-check-then-act.mjs`。它用和 `createAsyncRotomJournal` 完全相同的调度方式,运行输出是:

```
check passed on A
handoff finish -> head B
reserve on head B
```

`fork` 也有同类问题:`existing` → 源 head 检查 → `pendingConversation` → `segmentEntries` → `reserve`,原来是连续执行的,现在每一步之间都有 await。源会话可能在「pending 检查」之后开始一次新运行,fork 就会拿到一份正在增长的历史。

**要求(只在 D8a 上追加提交,提交信息以 `D8a:` 开头)**

1. 把「检查 + 操作」合并进**一次**核心调用。例如给 `reserve` 增加 `expectedHead` 参数,在同步事务里检查 head 是否一致,不一致就抛出 `KernelRequestConflict`。fork 那一串也同样合并成一个核心方法。异步 facade 只负责调度这一次调用。
2. 排查所有在 D8a 之前是同步连续执行、现在被 `await` 隔开的 journal 「读 → 判断 → 写」序列(至少包括 `run`、`fork`、`forkSeed`、`handoff`、`setThinkingLevel`/`hasUnresolvedCommandInput`、mirror),在执行记录里逐条列出处理结果:合并了,或者说明为什么拆开是安全的。
3. 为第 1 条补一个确定性的回归测试:用排队的 handoff finish 插进检查和 reserve 之间,断言结果是冲突,而不是在新 head 上完成 reserve。

D8b 暂不开始。

### 第 13 轮核验:D8a 修复(HEAD `13705d8`,2026-10-25)

**D8a — 通过**

- 原子性已经恢复:
    - `reserve` 现在接收 `expectedHead` 和 `expectedBinding` 两个参数,在 `BEGIN IMMEDIATE` 事务里比对 head 和 binding,任何一个不一致就抛出 `KernelRequestConflict`。`run` 和 `forkSeed` 都传入了 `admitted.segmentId` 和 `admitted.binding`;rebind 路径也比对 `expectedHead` 和 binding。
    - fork 改为 `journal.forkSeed`、handoff 改为 `journal.handoffSeed`,源检查、读取历史、reserve 都在**同一次**核心调用里完成,中间没有任何让出点。
    - `beginCommandInput` 会在同一次调用里检查 phase 和未完成的输入;关闭时用 `planPendingResume` 一次完成判断和计划。
- 我做的负控:把 `run` 里传给 `reserve` 的 `admitted.segmentId, admitted.binding` 去掉,新增的回归测试「queued handoff finish between run's check and reserve…」随即失败(0/1);恢复后通过(1/1)。
- `check`、`lint`、`format:check` 通过。默认并行 `npm test` 共 677 项:672 通过、4 跳过、1 失败,失败的仍是环境相关的 snap 那一项。`test:kernel:app` 和 `native-commands-proof` 都通过。

D8a 核验通过,执行方可以开始 D8b(storage worker 默认关闭)。

### 第 14 轮核验:D8b(HEAD `de6766a`,2026-10-26)

**结论:D8b 核验通过。** 默认关闭,开启后单 worker 持有两套数据库,失败时 fail-closed、不重放、不降级为父线程写入、不释放锁。可以进入 D9。

**环境**:linux-x64,Node 24.22.1,pinned rotom 0.1.26,root 运行(浏览器用 `--no-sandbox` 包装)。

| 检查                                      | 结果                                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `check` / `lint` / `format:check`         | 通过                                                                                                                                |
| 默认 `npm test`                           | 726 项:721 通过 / 1 失败 / 4 跳过。唯一失败是 `a snap browser comes last…`,原因是设了 `PI_POCKET_BROWSER`,和前几轮相同,属于本机环境 |
| `test:kernel:app`,worker 关 / 开          | 均 `status: passed`;开启时 `storageWorkerFailureStopsNativeAndRetainsLeases: true`                                                  |
| `native-commands-proof.ts`,worker 关 / 开 | 均通过                                                                                                                              |
| 负控 `queue-close`、`env-close-order`     | 带负控时专项失败(1、2 项),去掉后通过,和执行方记录一致                                                                               |

**代码核对**

- 关闭开关时和 D8a 相同:`app.ts`、`TeamKernel.close()` 在未启用 worker 时仍按 D8a 原样立即抛错;`resumeInterrupted` 未启用时直接走原逻辑;`RotomJournal.close()` 默认仍释放租约;`RotomExecutions` 未传 journal 时仍自建本地 journal 和异步 facade。
- worker 线程:先构造 `RotomJournal`(拿到排他租约)再开 `pocket.sqlite`;journal 方法只允许 `JOURNAL_METHODS`,Storage 只允许公开方法列表;`close` 失败直接抛出让线程崩溃,不回成功;回复编码超过 256 MiB 时同样崩溃,父线程按 unknown 处理。空环境启动,不带凭据。
- 分页协议:单页在途、偏移和长度严格校验,任何异常包都抛错终止,不存在静默截断。
- 已知限制(已写入 CONFIGURATION):启动、单个操作 ACK、最终退出各 120 s 期限;超时即整个 worker 失败、所有在途结果为 unknown。默认关闭时不受影响;将来若要默认开启,需要按 D8b 记录里说的另做容量/延迟验收。

**热重载偶发失败复查**:本次全量里 `test/dropins.test.ts` 通过;单独连跑 5 次均 4/4。`src/server/reload.ts` 和 `test/dropins.test.ts` 与 `main` 相比没有改动。同意执行方的判断:是负载下的既有偶发问题,和 D8b 无关,不阻塞。

**下一步**:D9(只读归档),按「C 方案 C4」第 2–4 步分别提交。

### 第 15 轮核验:D9a(HEAD `ba19852`,2026-10-26)

**结论:D9a 未通过,只差一处测试修复。** 只读归档的产品行为全部核验通过;但 D9a 改写后的 `test/perf-web-ui.test.ts` 变成了偶发失败,需要修好再复核。

**环境**:linux-x64,Node 24.22.1,pinned rotom 0.1.26,root 运行(浏览器用 `--no-sandbox` 包装)。

| 检查                                      | 结果                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `check` / `lint` / `format:check`         | 通过                                                                                             |
| 默认 `npm test`                           | 723 项:717 通过 / 2 失败 / 4 跳过。snap 用例是本机环境问题(同前几轮);另一个是 `perf-web-ui`,见下 |
| `test:kernel:app`,worker 关 / 开          | 均 `status: passed`                                                                              |
| `native-commands-proof.ts`,worker 关 / 开 | 均通过                                                                                           |

**需要修:`perf-web-ui` 偶发失败(D9a 引入)**

- 单独跑 `node --test test/perf-web-ui.test.ts` 5 次,失败 3 次;同一台机器上 `7478123` 的旧版本 5/5 通过。
- 失败时缺 `reply.first`:`actual` 少了这一项,其余 8 项都在。
- 原因判断:改成 native 后,回复是一次性整段到达(没有流式中间态)。`web/perf.js` 里 `reply.arrived` 立即记,`reply.first` 要等到真正画到屏幕上才记;测试一看到 assistant 条目就立刻 `navigate(other)`,`observe()` 发现会话变了就调用 `sendFailed` 把还没画出来的 `reply.first` 删掉。另外 D9a 把原来轮询等待报告写满(`until(... web().length >= 8)`)改成了一次性断言,也去掉了对刷盘时序的容忍。
- 要求:让测试在切换会话前确定性地等到 `reply.first` 已记录(例如等页面里的 waits 不再含 `reply.first`,或等至少一帧绘制),并恢复原来的轮询等待;不要放宽期望列表、不要加 skip、不要把 `reply.first` 改成可选。修好后单独连跑至少 10 次全过,再跑一次默认全量。

**已核验通过的部分**

- **独立探针(不依赖执行方的 JSON fixture)**:在 `7478123` 的 git archive 里用旧代码真实跑出一个数据目录:一轮完成的对话、一个正在运行的扩展工具(执行时往哨兵文件写一行)、一条排队的 follow-up、一个 1 分钟后到期的 schedule,然后正常关闭。
    - 正向对照:用旧代码重新打开(时钟拨后 2 小时),工具被重放,哨兵多了一行。
    - 新代码在 kernel 关、kernel 开、storage worker 开三种模式下各打开两次(时钟同样拨后):哨兵不变;schedule 没有发出;活动 task 0、排队/已放置 submission 0;归档提示两次重启后都只有 1 条;导出 Markdown 包含原历史;`commands.submit` 返回 409 只读;关闭后两把锁都已释放。
    - 脚本存为 `d9a-review-probe-produce.ts.txt`、`d9a-review-probe-reopen.ts.txt`(放进 `7478123` 的导出目录运行)和 `d9a-review-probe-head.ts.txt`(放进 `test/` 运行)。
- **代码核对**:隔离在 Harness 打开前、用公开 Storage API 完成,每个旧根会话一次原子提交;旧任务原样存进私有归档文档,不调用旧的 run/abort 回调。`harness.resume()` 已去掉;我核对了 native 会话不创建 Durable task(`ResendTask` 只在 durable fork 里创建,shell 端点对 native 是 409,native 不经过 `Approvals`),所以去掉它不影响 native 恢复,native 走自己的 `resumeInterrupted`。会话 backend 判定看根会话的 `SessionsDoc`,native 会话创建时都会写 `backend: "rotom"`。`--no-rotom-kernel` 保留为只读归档模式,理由已写清,我同意。
- **测试迁移**:被删掉的断言(审批卡片、旧浏览器工具调用、旧执行成功路径)只覆盖旧后端才有的行为,native 不产生审批卡片,这部分覆盖丢失可以接受;D9b/D9c 会删掉对应代码。
- **性能**:对 D9 前的 47 个变差计数器都有归类说明,gating 和 ledger guard 通过,接受。

**记录但不阻塞**

- 只要库里还有旧根会话,每次启动都会扫一遍全部会话,并对每个旧会话查 task、submission 和几个文档。结果是幂等的,但这个开销每次重启都要付,而且没有在生产规模下测过。建议在 D9b 或之后加一个持久的「已隔离」标记,让已经处理过的根会话跳过扫描。这条不作为 D9a 的验收条件。

**下一步**:执行方只修 `perf-web-ui` 的时序问题,单独提交,提交信息以 `D9a:` 开头;然后把状态表改回「已推送待核验(D9a 修复)」并停下,不要开始 D9b。

## C 方案（执行方追加）

### 边界与建议顺序

本节保留提出 D 批之前的方案快照，不是当前实现状态；当前状态以上方 D 状态表为准。当时 **C1–C6 均未实现**。A/B 没有顺带引入进程淘汰、worker、旧后端下线、新订阅协议或大文件拆分。建议先补当前架构文档与基线，再做可证明的纯移动；C1、C2、C3 分别审批，C4 是独立产品决策。所有方案保留个人凭据路由、unknown 不重放、可信原生边界和既有文档存储合同。

### C1 — 已用原生进程的预算与空闲回收

- 建议起点：全局 **8 个原生进程预算**，包含 active、retained、warming、closing；已用空闲进程 **15 分钟**后回收。这是建议值，不是已启用配置。
- unused warm 保留现有每成员 1 个、全局 3 个、5 分钟，但也计入总预算。满额先关闭 unused warm，再淘汰已证明 settled 且无活动 receipt 的空闲 LRU。全部忙时拒绝新启动并明确提示，不增加跨账号任务排队，不驱逐正在运行的进程。
- 关闭确认前仍占预算；从 Map 删除不等于进程已退出。send/warm/回收需在同一 segment 生命周期协调内互斥。未知关闭或未结算 receipt 保持 fenced，不能把回收当作重放许可。
- 回收会丢失扩展内存并断开 MCP；下次从持久化 JSONL 恢复并重新连接，内存中的扩展状态不恢复。按历史约 327 MiB/进程估算，8 个约 2.55 GiB，**不含**服务、子 Agent、MCP，也不是 RSS 硬上限。
- 归属：`rotom-executions.ts` 管预算/淘汰，`team-kernel.ts` 保留 admission/权限。需更新 `CONFIGURATION.md` 的 “No idle eviction”、预热说明及 `PRODUCT.md` 生命周期承诺。
- 验收：上限竞争、warm 与 send 同时到达、权限撤销、MCP 重连、关闭超时和 unknown 各有回归；先测峰值 RSS 和打开/首轮等待。owner 决定机器预算、8/15 参数、满额拒绝语义及扩展内存寿命变化。

### C2 — handoff 复制成本与选项

**当前事实。** `RotomExecutions.handoff` 先构造公开历史，再 reserve/关闭旧进程，`#seed` attach 新文件、append、文件/目录 fsync、读回、两次 stringify 比较，最后 journal.finish。materialization 已开始后的失败仍是 unknown；异步化不能把它改成 rejected。handoff seed 不重复计入 Durable 镜像或接收者 usage。

**合成观测，不是生产 SLO。** 在本分支 B4 代码上，用真实 `RotomExecutions.handoff` 和 pinned SessionManager，临时 PocketApp、64 条交替 user/assistant 消息、同一合成付费人；模型配置只指向 loopback port 1，没有提交推理。初始化与原始 journal 种入在计时外，原生模块已加载。随后实际 warm 新 segment，关闭应用并删除临时数据。每档只测一次，darwin-arm64 / Node 24.18.0，timing lock，highLoad=false（2.69→2.64/8 核）。证据：`/tmp/rotom-review-C/handoff.log`；重现脚本仅在 `/tmp/rotom-review-C2.mjs`，没有添加 C 产品实现。

| 文本输入         |  handoff | 新 seed 文件 | 新 journal body | Native SessionManager.open | 新进程 warm |
| ---------------- | -------: | -----------: | --------------: | -------------------------: | ----------: |
| 1 MiB / 64 消息  |  45.1 ms |  1,068,094 B |     1,067,824 B |                    1.52 ms |  2,150.8 ms |
| 10 MiB / 64 消息 | 142.1 ms | 10,505,278 B |    10,505,008 B |                   11.74 ms |  1,767.2 ms |

- 新增正文实际约 2.04 / 20.04 MiB；journal 数字是 SQL body 字节之和，不是 SQLite 文件/索引/WAL 总增量。文件数、同步写与复制正文随交接增长。
- warm 包含新原生进程启动，不包含首次推理或真实 MCP 服务。10 MiB 单次 warm 更短只能说明启动采样波动，**不能**推断大历史更快。SessionManager.open 仅量化其中历史重读片段，不是完整冷启动。
- 设一次公开历史正文为 P，复制约增加 `seed + journal body ≈ 2P`，另加 entry/header/页/索引开销。固定 10 MiB 交接 20 次，重复正文约 400 MiB；若每次新增 g、初始 H₀、交接 k 次，近似 `2 × [kH₀ + gk(k+1)/2]`。这是明确假设的算术，不是容量实测。

**方案顺序。** 先补 1/10/100 MiB、多次交接的阶段计时、事件循环延迟、RSS、实际 DB/WAL 增量及后续首轮测量。优先把 materialization 放到受控异步执行边界，保留 attach→持久化→readback→二次授权→finish 顺序；只换异步 fs API 不会消除公开投影/stringify/hash 的 CPU 阻塞。暂不直接复用旧 seed：原生可能已经追加它，且原文件可能带私有状态；不能跨付费人硬链接可变 session。真正去重需另设计不可变公开投影对象、引用/GC、备份与权限合同。owner 决定先仅消除主线程阻塞，还是承担新的存储格式和生命周期；建议先选前者。

### C3 — Program 3 的 kernel journal worker 补充

当前 Durable 队列和 kernel journal 是不同一致性域；不得把多个 `DatabaseSync` 直接分散成互不协调的 writer。

```text
拟议：主线程 HTTP / 权限 / native transport / payer gate
          │ 有界命令、关联 ID、持久化 ACK
          ▼
      单 storage worker
      ├─ Durable Harness + mutation queue
      └─ RotomJournal writer + commit/mirror 协调
```

- 先选择一个 storage worker 同时拥有两套存储写入及其顺序，不先增加两个 worker 间的排序问题。迁移需要把同步 journal 调用链改成明确异步操作，不能伪装成纯移动。
- reserve/attach/progress/finish 以完整操作跨边界，不拆事务；收到 durable ACK 才执行依赖该事实的副作用。保留 usage、文档提交和镜像顺序，NativeMirrorDoc count 仍只在 Durable 提交后推进。
- 命令/结果按字节限额，历史分页；测 structured clone、大对象序列化及队列等待，不宣称“放进 worker 就零阻塞”。worker 丢失 ACK 是 unknown：停止新 admission、只读对账，不自动重发有副作用的操作。
- 关闭先停 admission，等待 native/gate/子进程关闭及持久化收尾，再关 storage worker、释放锁。备份/恢复仍受同一所有权边界约束。
- 只读连接另立后续阶段，须等待 pi-durable 明确的快照/读取 API，不绕开 Durable 私有表和全局队列。涉及 `app.ts`、`rotom-journal.ts`、`rotom-executions.ts`、`team-kernel.ts`；不修改 schema version。
- owner 先批准线程归属、ACK 丢失/关闭失败策略及 upstream API 边界。验收必须有 worker crash、晚到 ACK、双写拒绝、unknown 不重放、镜像顺序和权限隔离的故障注入。

### C4 — 下线旧后端

不能把“不加载旧服务扩展”等同于“不需要 Durable”。原生会话仍依赖 Durable 的共享文档、历史镜像和提交队列；现合同仍包含旧 Durable 会话及 `--no-rotom-kernel`。

1. owner 先选旧会话继续执行、只读归档或显式迁移。授权后做只读存量/未完成任务盘点，本次未读取线上数据。
2. 若选只读，先单独发布行为变更：禁止新的旧后端执行/恢复，保留授权、读取、导出；未完成任务明确阻断，不静默丢弃。
3. 再删除旧 agent 执行分支和仅它使用的 loader/API；保留 native 仍需的 Durable 文档、投影和存储定义。
4. 最后删确认无引用的 `src/server/extensions/` 代码及旧执行测试，更新 CLI、PRODUCT/CONFIGURATION 和迁移/回滚说明；不删除用户历史和旧开关记录。

入口涉及 `main.ts`、`app.ts`、HTTP/commands。原审查的 65 分支/2156 行不是当前删除清单，不能按行数直接裁剪。风险是旧数据可读性、恢复计划、客户端兼容和回滚；验收需真实旧格式的合成持久化 fixture，而不只是新建空库。

### C5 — 大文件拆分，逐步证明纯移动

A/B 后重新定位边界。每次仅移动一个连续职责块，保留原算法、条件顺序、错误/权限边界及状态 owner；先比对移动代码等价，再跑相关测试。使用同名子目录、直接导入 owner，不加 barrel、注册表或通用工厂。

| 顺序 | 候选移动                                                            | 不得混入的变化                                  | 移动证据                                                               |
| ---- | ------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| 1    | conversation-routes 的连续、自包含路由块 → 对应 conversation 子模块 | 重排匹配优先级、移动鉴权、合并分支              | 代码块/条件顺序一致，HTTP 权限/错误/重放 fixture                       |
| 2    | team-kernel 的纯 helper/type，再到独立公开投影 adapter              | 将 #submit/queue 去重冒充移动，改变私有状态归属 | 导入图与代码等价，native command/fork/unknown proofs                   |
| 3    | rotom-executions 的独立 JSONL/readback helper                       | 改 #track、receipt、gate、关闭所有权            | 调用顺序和错误路径不变，大历史/恢复测试                                |
| 4    | style.css 的连续区段 → 保持相同相对 URL 基准的相邻样式文件          | 按组件重新排序 cascade、改选择器或媒体查询      | 按原顺序重组后规则完全一致，真实浏览器 computed style/mobile/peek 回归 |

前端必须保留 theme→prefs、模块初始化及 store 订阅顺序。CSS 拆分的加载胶水若产生新 waterfall，必须测量且单列网络成本；不能宣称性能等价。不能保证原加载/级联顺序时暂停该步，不用“测试通过”代替纯移动证据。需要重新设计私有字段接口的 run/#submit 拆分不是纯移动，留待另案批准。每步独立提交、完整验证，可独立回滚。

### C6 — 其余五项分别立项

| 项目                | 建议方案与边界                                                                                                          | 先做的验证 / owner 决策                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| notify 前缀控制消息 | 先集中现有 envelope 解码/校验，再申请 native 专用结构化事件；不要直接改 pin/vendor 或把任意普通通知当控制指令           | 普通通知不误吞、畸形/未知 kind 拒绝；决定是否推动原生协议支持                      |
| 切会话单连接        | 接续 Program 2 第 3 项，用订阅 POST + generation/ACK；逐次检查权限，取消旧 room，拒绝晚到旧 view；SSE 和 poll 同时支持  | 快速来回切换、撤权、断线/重连、旧 tab 兼容；不重发用户 send                        |
| 流式 Markdown       | 已完成块已有 500 项 LRU，先量化增长块重复解析；可合并到帧并在结束时立即 flush，之后再评估真正增量解析                   | 未闭合 fence/跨块结构、XSS、最终文本等价；不能省略 DOMPurify 或信任局部未清洗 HTML |
| App 根更新          | 现有 microtask 已合并更新；root render 不等于整个 DOM 重建。先量化组件提交，再让高频 live state 用局部订阅              | 只改已证实的热组件，保持订阅顺序，不引入新状态库                                   |
| architecture/map    | 按 PRODUCT/CONFIGURATION 修正 Team 主体；把上游机制标为 legacy，画清个人凭据、原生 journal、Durable 镜像及关闭/恢复次序 | 文档逐条对应当前调用链；本次只提方案，不提前宣称 worker/旧后端下线已实现           |

owner 下一步建议：先批准文档纠偏及 C2 扩展测量；若要产品行为变更，先确认 C1 的预算/回收参数。C4 的旧会话处置必须单独决定，不能随重构默认下线。
