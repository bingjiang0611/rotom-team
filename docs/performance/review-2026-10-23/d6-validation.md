# D6 — 纯移动拆分验证记录

## 范围与版本

- 产品源码基线：`5551a50`（D5 已核验）。独立测量提交：`3768653`。
- 最终产品源码：`8506d3d`。四个移动提交仅含移动与直接 import/export/调用/link 胶水；无算法优化、barrel、注册表或新状态 owner。
- 环境：Node v24.18.0、darwin-arm64、Apple M1 / 8 核；最终 Chromium 探针 UA 为 Chrome/156.0.0.0。移动端为真实 Chromium 的 390×844 touch/coarse 仿真，不是真机。
- 未修改 schema/user_version、Durable 存储合同、vendor/pin、凭据路由、unknown 不重放或 ledger。未部署、未重启线上、未用真实模型账号；未开始 D7。

| 步骤 | 提交    | 原 owner 行数                  | 迁移目标与边界                                                                                                                                                  |
| ---- | ------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | d9f7afd | conversation-routes.ts 797→731 | conversation-routes/upload.ts：upload if 分支及紧随的 404，原名 MAX_UPLOAD/safeName 随唯一使用方移动。method/third 在原位置计算后传入，鉴权和 fallback 顺序不变 |
| 2    | 27c3f7e | team-kernel.ts 3298→3196       | team-kernel/projection.ts：连续 publicEntry/applyUpdate，正文/注释不变，只有 type imports；不移动 #submit 或实例状态                                            |
| 3    | 54387bd | rotom-executions.ts 2231→1990  | rotom-executions/native-tail.ts：连续 snapshot/entries/NativeTail 及两项不变的限制常量。实例仍由 execution 创建/持有；#track、receipt、gate、close 全部留原处   |
| 4    | 8506d3d | style.css 8823→8227            | native.css：原末尾连续 595 行；两个 HTML 入口都在 style.css 后相邻 link，规则、media query、相对 URL 基准不变                                                   |

## 验证

每步运行 `npm run format`、`check`、`lint`、`format:check`、默认 `npm test` 和 `npm run perf:ci -- origin/main --runs 1`。静态检查、等价证明和性能护栏均 exit 0。用户两处文档从备份逐字节恢复/核对，没有暂存。

| 检查                         | 结果                                                                                           | 证据（/tmp/rotom-review-D6/ 下）                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 步骤 1 默认全量              | 622/622，0 skip，235858 ms                                                                     | step1/test.log                                                                                                                       |
| 步骤 2 默认全量              | 首次 621/622；owner 批准仅重跑一次后 622/622，0 skip，232227 ms                                | step2/test.log、step2/test-owner-retry.log                                                                                           |
| 步骤 3 默认全量              | 622/622，0 skip，237805 ms                                                                     | step3/test.log                                                                                                                       |
| 步骤 4 默认全量              | 622/622，0 skip，234246 ms                                                                     | step4/test.log                                                                                                                       |
| 最终专项                     | native snapshot/notify + 真实 app mobile/peek，59/59，0 skip                                   | final-targeted.log；node --test test/mobile-ui.test.ts test/peeks-ui.test.ts test/native-snapshot.test.ts test/native-notify.test.ts |
| 移动等价                     | 四步完整 owner 反向重组、移动正文及常量哈希全部一致                                            | move-step1/2/3/4.json、step1/2/3/4/equivalence.log                                                                                   |
| 真实 Chromium computed style | desktop/mobile × dark/light data-mode，4×28 个受控节点的全部属性哈希一致；独立实际 UI 回归见上 | style-base.json、style-head.json、style-final.json；冻结 style-baseline.json                                                         |
| 负控：漏载 CSS               | 临时探针移除 native.css link，computed-style 断言失败                                          | style-negative.log；不是语法错误                                                                                                     |
| 负控：限制被改               | 临时探针将读取到的 64 MiB 常量改成 63 MiB，owner/nativeLimits 哈希断言失败                     | move-negative.log；未改生产文件                                                                                                      |
| 测量适配                     | 迁移前旧布局 probe 1/1；迁移后全量包含新布局 probe；原 parse/GC/readback 断言不变              | memory-probe.log、step3/test.log                                                                                                     |

交接文档增补后再次运行 check/lint/format:check，全部 exit 0；文档链接与示例检查 4/4（final-docs-tests.log）。最终 git diff --exit-code 8506d3d -- src web test 为 0，确认产品/测试源码与第四步已验证提交一致；两份用户文档 cmp 一致。

步骤 2 首次失败仍是 `test/dropins.test.ts:114` 在 `:139` 等待已编辑文件 reload 超时（约 10 秒），与 D5 基线签名相同。独立 `node --test test/dropins.test.ts` 为 4/4。用户选择的是**只重跑一次默认全量**，不是批准例外；重跑通过后才提交和进入步骤 3。保留原失败，不声称已修复 watcher，也没有改 npm 脚本、跳过或放宽断言。D5 例外没有延用于 D6。

`move-equivalence.mjs` 排除声明级 import/本地 export 胶水，并在原位置重组；函数、分支、类内正文和注释逐字比较。上传新增 wrapper 只容许参数绑定、原 if、原 404。所有新 runtime imports 受已知依赖白名单约束，不允许反向 owner 循环或 re-export barrel。CSS 用 `style.css + "\n" + native.css` 恢复原文件，完整 SHA-256 一致；HTML 去掉新增 link 后也与基线一致。JS 模块加载、theme→prefs、store 订阅顺序完全未动。

CSS 样本在真实页面中插入受控 markup，包含 native 控件及 peek-seen 按钮，不冒充完整业务交互；实际 mobile/peek 操作由既有 UI 测试覆盖。CSS 探针使用 reduced-motion，排序属性名，等待字体和相关动画完成/取消；只规范化临时 origin。最初未冻结的探针有不稳定采样，**在任何产品移动之前**纠正并重新采集，连续两轮一致后才提交 `3768653`；旧结果留在 `style-base-invalid-*.json` 等文件。实现期间没有更新 golden。该 golden 是本机环境证据，不是跨平台永久门槛。

## 性能与 CSS 网络成本

纯移动的验收目标是职责位置与行为保持，不是降低算法工作量，因此不为移动另造性能计数器。现有 CI 的工作计数/护栏与独立内容证明并用；没有把文件行数下降当作性能提升。

| 项目                       | 基线 → 最终                                    | 结论                                                                                                                                        |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 静态 bundle 首次请求       | 53→54                                          | 新增 native.css，必要 +1                                                                                                                    |
| 静态 bundle 首次 gzip 正文 | 407732→408346 B                                | 必要 +614 B，不能称为网络等价                                                                                                               |
| 条件请求                   | 53→54                                          | 必要 +1；响应正文仍为 0                                                                                                                     |
| CSS gzip                   | 原 style.css 35024 B → 33056 + 2582 B          | 精确解释 bundle 的 +614 B；压缩/缓存策略不变                                                                                                |
| CSS 原始字节               | 178548 → 167178 + 11369                        | 文件边界空行由重组分隔符保留；CSS 规则无删改                                                                                                |
| 浏览器加载                 | 两个相邻 HTML link，均由 link 发起，无 @import | 首次 head 探针同时在 6.1 ms 发起；最终复核为 6.1/6.3 ms，响应结束 10.2/11.1 ms。只说明本地已缓存样本无串行 import 链，不证明高 RTT 首屏等价 |

网络 bundle 探针不含 HTML 本身；HTML 多一个 link 的文本/DOM 成本另记，不能把 +614 B 宣称为全部页面新增流量。浏览器探针的 stylesheet 正文 0 B 是条件响应/已缓存场景，不是冷加载字节；冷 bundle 数字来自实际 HTTP gzip 计数和解码后的源文件比对。新增 stylesheet 也增加一个缓存项；未声称缓存或模块冷加载成本为零。

五次 perf CI 均 exit 0，ledger guard 通过：

| 比较                | head 的当时标签 → 对应纯移动提交 | worse 数 | slower 数（L2，单轮） | 1 分钟 load 前 → 后 |
| ------------------- | -------------------------------- | -------- | --------------------- | ------------------- |
| step1/ci：main 对照 | 3768653-dirty → d9f7afd          | 36       | 26                    | 5.78→3.77           |
| step2/ci：main 对照 | d9f7afd-dirty → 27c3f7e          | 39       | 14                    | 5.69→4.30           |
| step3/ci：main 对照 | 27c3f7e-dirty → 54387bd          | 36       | 20                    | 6.57→3.90           |
| step4/ci：main 对照 | 54387bd-dirty → 8506d3d          | 47       | 21                    | 4.46→6.20           |
| d6-ci：3768653 对照 | 54387bd-dirty → 8506d3d          | 18       | 20                    | 3.96→6.37           |

main 固定为 `e649d9d`。perf 在每步提交前测量该步 dirty 源码；紧随的纯移动提交保存同一产品 diff。最终两轮使用同一份步骤 4 源码；其后只有交接文档变更。保留用户文档 dirty 不等于存在未记录的实现。单轮 L2 与有负载的开发机不能证明生产提速或稳定回归；未提高阈值、候选 baseline 或 journal 版本。

### 每个 worse 计数器

以下是五次 `compare(base, head, ledger)` 的完整并集 **54 项**。星号表示该列确实判 worse；其他列也显示实际值，不拿旧 ledger candidate 表冒充此次差分。数据见 step1/2/3/comparison.json、step4-comparison.json、d6-comparison.json。

| 计数器                                      | S1 / main       | S2 / main       | S3 / main       | S4 / main       | 最终 / D6 基线  | 解释                                                                                                                             |
| ------------------------------------------- | --------------- | --------------- | --------------- | --------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| assets.first/http.body.bytes                | 1142870→407732  | 1142870→407732  | 1142870→407732  | 1142870→408346  | 407732→408346 * | CSS 分文件 gzip 总量 35024→35638 B，必需 +614 B；未改压缩或缓存策略。                                                            |
| assets.first/http.requests                  | 53→53           | 53→53           | 53→53           | 53→54 *         | 53→54 *         | 新增 native.css，首次与条件请求都各 +1；条件响应正文仍为 0。                                                                     |
| assets.validated/http.requests              | 53→53           | 53→53           | 53→53           | 53→54 *         | 53→54 *         | 新增 native.css，首次与条件请求都各 +1；条件响应正文仍为 0。                                                                     |
| changes.poll.images/json.stringify.chars    | 20338→20346     | 20296→20320     | 20354→20280     | 20322→20338     | 20296→20346 *   | 同一最终代码两轮 20338→20346；只有序列化字符数差异；未改相应路径/调用顺序，未留正文，字段级来源 unknown。                        |
| commands.discover.cold/sql.rows             | 78→81 *         | 78→81 *         | 78→81 *         | 78→81 *         | 81→81           | main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。                                  |
| commands.discover.warm/sql.rows             | 64→66 *         | 64→66 *         | 64→66 *         | 64→66 *         | 66→66           | main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。                                  |
| git.changes/json.stringify.chars            | 3105→3106       | 2537→2540       | 3107→3102       | 2536→3105 *     | 3104→3106       | 同一最终代码两轮 3105→3106；只有序列化字符数差异；未改相应路径/调用顺序，未留正文，字段级来源 unknown。                          |
| native.warm/sql.rows                        | 10→11 *         | 10→11 *         | 10→11 *         | 10→11 *         | 11→11           | main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。                                  |
| projection.large.open/sql.statements        | 98→99 *         | 98→99 *         | 98→99 *         | 98→99 *         | 99→99           | main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。                                  |
| projection.large.paced/json.stringify.chars | 556756→420368   | 518861→421135   | 559953→419502   | 516496→420369   | 421201→428369 * | 同一最终代码两轮 420369→428369；RPC/SQL/view 次数相同但字节量不同。无正文 trace，无法精确字段归因；不声称性能等价。              |
| projection.large.paced/push.bytes           | 269548→246628   | 245828→247428 * | 272748→245828   | 243428→246628 * | 247428→254628 * | 同一最终代码两轮 246628→254628；RPC/SQL/view 次数相同但字节量不同。无正文 trace，无法精确字段归因；不声称性能等价。              |
| projection.large.paced/push.view.bytes      | 228176→205256   | 204456→206056 * | 231376→204456   | 202056→205256 * | 206056→213256 * | 同一最终代码两轮 205256→213256；RPC/SQL/view 次数相同但字节量不同。无正文 trace，无法精确字段归因；不声称性能等价。              |
| projection.large.paced/sql.statements       | 601→574         | 572→574 *       | 601→574         | 572→574 *       | 574→574         | main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。                                  |
| session.open.long/sql.rows                  | 47→49 *         | 47→49 *         | 47→49 *         | 47→49 *         | 49→49           | main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。                                  |
| session.open.long/sql.statements            | 16→17 *         | 16→17 *         | 16→17 *         | 16→17 *         | 17→17           | main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。                                  |
| session.open/sql.rows                       | 107→96          | 107→96          | 107→109 *       | 94→96 *         | 109→109         | main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。                                  |
| session.open/sql.statements                 | 46→47 *         | 46→47 *         | 46→48 *         | 45→47 *         | 48→48           | main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。                                  |
| startup.restart/sql.statements              | 848→851 *       | 848→851 *       | 848→851 *       | 848→851 *       | 851→851         | main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。                                  |
| turn.paced/sql.statements                   | 286→288 *       | 286→288 *       | 286→288 *       | 286→288 *       | 288→288         | main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。                                  |
| turn.prepared/json.stringify.chars          | 121586→121586   | 121637→121552   | 119693→119693   | 119693→121586   | 121586→127662 * | 同一最终代码两轮 121586→127662；RPC/SQL/view 次数相同但字节量不同。无正文 trace，无法精确字段归因；不声称性能等价。              |
| turn.prepared/push.bytes                    | 14617→14617     | 14668→14617     | 13379→13379     | 13379→14617     | 14617→20693 *   | 同一最终代码两轮 14617→20693；RPC/SQL/view 次数相同但字节量不同。无正文 trace，无法精确字段归因；不声称性能等价。                |
| turn.prepared/push.view.bytes               | 9820→9820       | 9871→9820       | 8582→8582       | 8582→9820       | 9820→15896 *    | 同一最终代码两轮 9820→15896；RPC/SQL/view 次数相同但字节量不同。无正文 trace，无法精确字段归因；不声称性能等价。                 |
| turn.prewarmed/sql.rows                     | 133→119         | 133→136         | 133→136         | 117→136 *       | 131→119         | main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。                                  |
| turn.prewarmed/sql.statements               | 203→190         | 203→205         | 203→205         | 189→205 *       | 204→190         | main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。                                  |
| turn.warm/json.stringify.chars              | 85248→85248     | 85248→85250 *   | 85248→85248     | 85248→85248     | 85248→85248     | 同一最终代码两轮 85248→85248；只有序列化字符数差异；未改相应路径/调用顺序，未留正文，字段级来源 unknown。                        |
| turn.warm/sql.statements                    | 157→158 *       | 157→158 *       | 157→158 *       | 157→158 *       | 158→158         | main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。                                  |
| web.open.long/cdp.Nodes                     | 1561→1701 *     | 1585→1701 *     | 1585→1701 *     | 1585→1703 *     | 1701→1703       | main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1703→1703；另有节点分配/回收取样，不等于持久 DOM 或泄漏。     |
| web.open.long/http.requests                 | 80→80           | 80→80           | 80→80           | 80→81 *         | 80→81 *         | D6 新增 native.css 一请求；步骤② web.open 在拆 CSS 前也曾 81→83，不能将 main 全部增量归到 CSS。                                  |
| web.open.long/push.view.bytes               | 165859→165883 * | 165859→165883 * | 165859→165883 * | 165859→165883 * | 165883→165883   | main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。                                                      |
| web.open.long/web.event.parse.calls         | 8→9 *           | 8→9 *           | 8→9 *           | 8→9 *           | 9→9             | main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。                                                      |
| web.open.long/web.event.parse.chars         | 173290→173492 * | 173290→173492 * | 173290→173492 * | 173290→173492 * | 173492→173492   | main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。                                                      |
| web.open/cdp.Nodes                          | 996→1112 *      | 996→1112 *      | 996→1112 *      | 972→1114 *      | 1112→1114 *     | main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1114→1114；另有节点分配/回收取样，不等于持久 DOM 或泄漏。     |
| web.open/http.requests                      | 81→81           | 81→83 *         | 81→81           | 81→82 *         | 81→82 *         | D6 新增 native.css 一请求；步骤② web.open 在拆 CSS 前也曾 81→83，不能将 main 全部增量归到 CSS。                                  |
| web.open/push.bytes                         | 83736→83964 *   | 83736→83964 *   | 83736→83964 *   | 83736→83964 *   | 83964→83964     | main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。                                                      |
| web.open/push.events                        | 10→11 *         | 10→11 *         | 10→11 *         | 10→11 *         | 11→11           | main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。                                                      |
| web.open/push.view.bytes                    | 76309→76333 *   | 76309→76333 *   | 76309→76333 *   | 76309→76333 *   | 76333→76333     | main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。                                                      |
| web.open/sql.statements                     | 31→32 *         | 31→32 *         | 31→32 *         | 31→32 *         | 32→32           | main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。                                  |
| web.open/web.event.parse.calls              | 9→10 *          | 9→10 *          | 9→10 *          | 9→10 *          | 10→10           | main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。                                                      |
| web.open/web.event.parse.chars              | 82941→83141 *   | 82941→83141 *   | 82941→83141 *   | 82941→83141 *   | 83141→83141     | main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。                                                      |
| web.paced/cdp.Nodes                         | 1296→1421 *     | 1269→1421 *     | 1294→1420 *     | 1294→1424 *     | 1420→1421       | main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1424→1421；另有节点分配/回收取样，不等于持久 DOM 或泄漏。     |
| web.paced/sql.statements                    | 306→308 *       | 320→308         | 306→308 *       | 306→308 *       | 308→308         | main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。                                  |
| web.reopen/cdp.Nodes                        | 1090→1230 *     | 1090→1230 *     | 1090→1206 *     | 1090→1208 *     | 1230→1232 *     | main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1208→1232；另有节点分配/回收取样，不等于持久 DOM 或泄漏。     |
| web.reopen/push.bytes                       | 10313→10541 *   | 10313→10541 *   | 10313→10541 *   | 10313→10541 *   | 10541→10541     | main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。                                                      |
| web.reopen/push.events                      | 9→10 *          | 9→10 *          | 9→10 *          | 9→10 *          | 10→10           | main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。                                                      |
| web.reopen/push.view.bytes                  | 2001→2025 *     | 2001→2025 *     | 2001→2025 *     | 2001→2025 *     | 2025→2025       | main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。                                                      |
| web.reopen/web.event.parse.calls            | 8→9 *           | 8→9 *           | 8→9 *           | 8→9 *           | 9→9             | main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。                                                      |
| web.reopen/web.event.parse.chars            | 9527→9727 *     | 9527→9727 *     | 9527→9727 *     | 9527→9727 *     | 9727→9727       | main 含 D5 初连 ACK/room generation 包装；D6 协议未变，隔离此项未判 worse。                                                      |
| web.send.poll/cdp.Nodes                     | 1452→1593 *     | 1451→1620 *     | 1455→1615 *     | 1480→1603 *     | 1617→1620       | main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1603→1620；另有节点分配/回收取样，不等于持久 DOM 或泄漏。     |
| web.send.stream/cdp.Nodes                   | 1491→1628 *     | 1488→1626 *     | 1516→1624 *     | 1494→1579 *     | 1614→1654 *     | main 含 A4 preload 节点；D6 加 1 link 及相邻空白。同一最终代码两轮 1579→1654；另有节点分配/回收取样，不等于持久 DOM 或泄漏。     |
| web.send.stream/cdp.RecalcStyleCount        | 105→112 *       | 104→107         | 102→104         | 104→111 *       | 110→109         | 步骤①未改 CSS/JS 即出现；D6 隔离未判 worse。旧 UI/浏览器布局窗口取样，不作稳定回归结论。                                         |
| web.send.stream/push.bytes                  | 91492→91804 *   | 90889→91603 *   | 91492→91603 *   | 91492→91603 *   | 91498→91603 *   | main 含 D5 包装；D6 隔离本次数据长度增量未精确归因，未保存正文。同一最终代码两轮 91603→91603；保留差值，不把源码等价当作零成本。 |
| web.send.stream/push.view.bytes             | 77698→77986 *   | 77095→77785 *   | 77698→77785 *   | 77698→77785 *   | 77680→77785 *   | main 含 D5 包装；D6 隔离本次数据长度增量未精确归因，未保存正文。同一最终代码两轮 77785→77785；保留差值，不把源码等价当作零成本。 |
| web.send.stream/sql.statements              | 384→386 *       | 384→386 *       | 384→386 *       | 384→386 *       | 386→386         | main 含 A1–A3 等既有查询/窗口差异；D6 隔离此项未判 worse。无新增 SQL，完整 owner/状态顺序等价。                                  |
| web.send.stream/web.event.parse.chars       | 30133→30445 *   | 29932→30445 *   | 30133→30445 *   | 30133→30445 *   | 30365→30445 *   | main 含 D5 包装；D6 隔离本次数据长度增量未精确归因，未保存正文。同一最终代码两轮 30445→30445；保留差值，不把源码等价当作零成本。 |

### 取样差异与剩余范围

- 两个**同一最终代码**的 head 样本中，turn.prepared 的 view 字节为 9820→15896（+6076），恰与 D6 隔离的增量相同；两轮均 3 个 view、4 个 push、201 个 SQL statement、135 行、1 个 native RPC notify。projection.large.paced 则为 205256→213256（+8000），两轮均 44 个 view、52 个 push、574 个 SQL statement、719 行、1 个 notify。这直接证明这些字节值可在不改代码时变化，但不证明精确字段来源或生产无回归。
- web.send.stream 的隔离 view +105 B、parse +80 字符，以及 changes.poll.images +50 字符，未保存事件/JSON 正文，不能从总量反推字段。保留原始报告和 unknown；不虚构 payload 归因，也不把任何未测指标填成 0。
- 真实设备、高 RTT/生产负载、单独的冷 ESM 加载成本未测。没有新交互能力或性能承诺需要用演示替代；本次证明的是原内容/规则保持，以及列出的真实测试范围。
- **下一步 owner：审查方。** 核验 D6 的四个移动提交、首次 watcher 失败记录、CSS 必需成本与样本限制。若要求旧样本精确字段级归因，缺少的是当时正文 trace；只能另立有界合成 trace 测量，不能补造旧证据。D6 核验通过前不开始 D7。

## 最终状态

所有临时负控脚本已删除；测试/基准使用临时服务，无线上部署或重启。证据和两份用户文档备份保留在 `/tmp/rotom-review-D6/`。工作区应只剩用户原有的 `docs/performance/opportunities.md` 与未跟踪 `docs/performance/2026-10-21-proposals.md`；实现/测量/交接提交推送后等待核验。
