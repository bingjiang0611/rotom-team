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

| 编号  | 批次 | 标题                                        | 状态         | 提交                            |
| ----- | ---- | ------------------------------------------- | ------------ | ------------------------------- |
| A1    | A    | journal 索引 + 镜像游标                     | 已推送待核验 | `2a2ac90`、`b44ca33`、`7c880fc` |
| A2    | A    | thinking level / native goal 跨推送缓存     | 进行中       | 测量见执行记录                  |
| A3    | A    | 启动时不再全量解析历史                      | 待做         |                                 |
| A4    | A    | 静态资源 ETag / gzip / modulepreload        | 待做         |                                 |
| B1    | B    | `teamResourceRevision` 不在请求路径读大文件 | 待做         |                                 |
| B2    | B    | `finishedSeen` 写入与清理                   | 待做         |                                 |
| B3    | B    | 房间级字段每次推送只算一次                  | 待做         |                                 |
| B4    | B    | journal 预编译语句缓存                      | 待做         |                                 |
| B5    | B    | 长轮询队列字节上限                          | 待做         |                                 |
| C1–C6 | C    | 需要 owner 决策，只写方案                   | 待做         |                                 |

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

## 执行记录（执行方追加）

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

## 核验记录（审查方追加）

<!-- 每项一节：核验了什么、结论（通过 / 未通过）、未通过的原因。 -->

## C 方案（执行方追加）
