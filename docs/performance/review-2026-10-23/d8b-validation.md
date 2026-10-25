# D8b — 默认关闭的单 storage worker

基线为已通过第 13 轮核验的 `230ec01`。本轮只实施 D8b，不进入 D9，不部署、不重启服务、不使用真实模型账号。

## 实现边界

- `--storage-worker` / `--no-storage-worker`，默认 false；仅 native kernel 模式允许启用。省略和 false 均不创建 worker，仍调用 D8a 本地 Storage 与异步 journal adapter。
- 单 worker 持有 `RotomJournal` 和公开 Pi Durable `Storage`。Harness、事务 callback、mutation queue、镜像协调、权限、账号及 native/gate 所有权留在父线程。
- FIFO 传递完整操作；256 MiB 编码值/普通队列字节上限、128 普通请求上限、1 MiB 单页在途。三种去重 close 有保留容量。整个值仍会物化，不能将传输上限当作总内存上限。
- 准入前取消可移除排队请求；dispatch 后取消仍等 durable ACK。unknown 不自动重发、重启或切回父 writer。
- ACK 错误保留真实 `StorageRejected` 与普通 Error 的区分；公开后端的普通事务验证错误不能被无差别改成 worker 崩溃，否则会破坏公开 conformance。Session 保留其 poison 规则。
- journal endpoint close 不释放租约。成功关闭先 drain native/gate/子进程及恢复协调，再关闭两套数据库；父执行环境 cleanup 确认后，等最终 owner ACK 和 worker exit，最后释放两把锁。失败清理继续尝试父线程资源，但不解锁。
- worker 使用空环境，只传数据库路径及固定标记；不复制 caller Context 或凭据。仍是同一 OS 用户下的可信代码，不是沙箱。

## 故障与回归覆盖

| 范围                | 证据                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 公开 Storage 合同   | `storage-worker.test.ts` 原样运行公开 conformance kit，真实代理和两套数据库                                                     |
| 事务、传输          | 原子 head/binding 冲突；多 MiB history；commit 后退出；晚 ACK 不能复活 owner                                                    |
| 单 writer / unknown | 重复 writer 拒绝；已提交但未 ACK 的数据可在受控 fixture 重开后读到；intent 变 unknown，不重复 launch                            |
| 背压 / 取消         | 满队列仍能 drain/close；排队取消不 dispatch；dispatch 后取消保留 durable ACK                                                    |
| 生命周期            | app 开关三种值；worker ready 失败；Harness.open 失败；恢复协调 drain；关闭失败留锁                                              |
| 镜像                | off/on 均真实子进程重启；Durable 已提交但本地 completion 丢失不重复 append；同一持久数据切换开关后完整 mirror/room payload 相等 |
| 权限                | outstanding worker read 后撤权不准入；真实 pinned app/command proof 保留个人路由、固定 payer、generation、unknown、权限检查     |
| 真实 native 关闭    | active prompt 中杀实际 storage thread；app.close 拒绝，但 native PID 已退出，两把锁保留                                         |
| 计数                | worker SQL/JSON 与本地相同；room/table 归因及 projection 调用数不能重复；historical-entry observer 在 worker 内仍可触发         |

## 负控

`d8b-negative.mjs` 只在加载时改测试进程源码，不改工作区；只用于合成临时数据。

```sh
node --import './docs/performance/review-2026-10-23/d8b-negative.mjs?mode=report-loss' --test test/perf-storage-report.test.ts
node --import './docs/performance/review-2026-10-23/d8b-negative.mjs?mode=env-close-order' --test --test-name-pattern='parent environment cleanup' test/storage-worker-app.test.ts
node --import './docs/performance/review-2026-10-23/d8b-negative.mjs?mode=queue-close' --test --test-name-pattern='saturated ordinary' test/storage-worker.test.ts
node --import './docs/performance/review-2026-10-23/d8b-negative.mjs?mode=resume-drain' --test --test-name-pattern='joins the startup' test/storage-worker-app.test.ts
node --import './docs/performance/review-2026-10-23/d8b-negative.mjs?mode=environment' --import ./test/fixtures/storage-env-guard.ts --test --test-name-pattern='switch.*true' test/storage-worker-app.test.ts
node --import './docs/performance/review-2026-10-23/d8b-negative.mjs?mode=false-rejection' --test --test-name-pattern='acknowledged plain Storage' test/storage-worker.test.ts
node --import './docs/performance/review-2026-10-23/d8b-negative.mjs?mode=projection-double-count' --test test/storage-worker-counters.test.ts
ROTOM_TEST_NO_WORKER_COUNTERS=1 node --test test/storage-worker-counters.test.ts
```

以上八类负控均已观察到对应断言失败。移除负控后专项通过；最终全量结果见下。

## 保留的失败与修复

原始日志在 `/tmp/rotom-review-D8b/`，不删除失败、不挑最好数字。

- 初版分页发送在 transfer 后读取已 detach 的数组长度；发送前保存 offset 后修复。
- history fixture 缺少 attach/terminal assistant，修正 fixture 后通过；未弱化断言。
- 一度将所有普通 commit 错误都终止 worker，导致六项公开 conformance 失败；恢复公开错误语义，并新增已提交后普通错误不能伪装成 `StorageRejected` 的检查。
- 审计指出存储失败跳过 native drain、满队列无法准入 close，均修复。另补 worker ready 失败的父资源清理、恢复协调关闭顺序和空环境边界。最终自审又发现 owner.close 早于父环境 cleanup，可能在 cleanup 失败时解锁；改为先确认环境清理，再发最终 owner close。正反两种 cleanup 及顺序负控覆盖该问题。
- 首次 worker 性能报告错误地将转发 room scope 记成新 projection，出现 2 倍 project.calls。改为仅传播 AsyncLocalStorage scope；真实等价检查及重复计数负控验证修复。原报告留为 `worker-on-invalid-projection.json`，不用于最终结论。
- 首次全量为 721 pass / 1 fail / 0 skip；唯一失败是本记录尚未创建导致文档链接断开。没有测试失败被跳过。
- 早期性能命令未使用机器级 timing lock：保留工作计数，但不把其毫秒数当作验收证据。最终计时另在锁内完成，使用相同 workload、quiet、ledger 与容差。
- 负控日志的嵌套 AggregateError 曾使外层 grep 未命中；检查原始失败后保留日志。counter fixture 一度显式继承不被 Worker 接受的进程 flags，现只继承测试 preload。

## 验收记录

环境：darwin-arm64、Node 24.18.0，pinned rotom 0.1.26、Pi Durable 1.0.2。最终产品源码 SHA-256 为 `c00a3abf5a1a40fe253b2ec698beddcbdd84129b02f9e0ed75317a1f6df7328f`，文件清单/计数见 [性能证据](d8b-performance.json)，逐项成本见 [性能说明](d8b-performance.md)。

| 检查                                  | 结果                                                                               | 证据（`/tmp/rotom-review-D8b/`）                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| check / lint / format:check           | 通过；最终文档另作格式和链接检查                                                   | `check-release.log`、`lint-release.log`、`format-check-release.log`；文档/报告专项 `docs-report-release.log` 6/6 |
| 最终产品默认完整 npm test             | 724/724，0 skip；250395 ms                                                         | `full-delivery-confirmation.log`                                                                                 |
| 新增报告导出测试后的默认完整 npm test | 725/726，0 skip；253364 ms。唯一失败是旧 drop-in 文件热重载等待超时                | `full-export-acceptance.log`                                                                                     |
| 报告/counter 专项                     | 7/7，包括丢失样本不能补零                                                          | `report-coverage.log`                                                                                            |
| 空环境 guard 下的 app 生命周期        | 10/10                                                                              | `isolation-delivery.log`                                                                                         |
| 真实 pinned app，默认 off / on        | 83 / 84 次 loopback 请求通过；on 实际杀 worker 后 native PID 退出且两锁保留        | `app-off-delivery.log`、`app-on-delivery.log`                                                                    |
| 真实 pinned commands，on              | 19 次合成推理通过，含大历史/unknown 等原证明                                       | `commands-on-delivery.log`                                                                                       |
| 最终同源码锁内 D8a→off→on             | 359856 ms，load 1.26→4.55/8，highLoad=false；off/on gating 与 CI ledger guard 通过 | `timing-acceptance.log`、`acceptance-ci/`、`worker-on-acceptance.json`                                           |

**保留的非全绿结果**：旧 drop-in 热重载测试在 `full-delivery.log` 与最终 `full-export-acceptance.log` 各超时一次；单独 `node --test test/dropins.test.ts` 为 4/4，期间一次默认完整套件为 724/724。该测试与 `src/server/reload.ts` 相对 `230ec01` 未改，走非 worker 的 legacy 模式，失败发生在关闭前；performance skill 已将其列为负载下的既有 flaky test。未锁定这两次丢失通知的具体原因，不改等待时间、并行度或断言，不称最终 726 项全绿。

**计量修复**：底层 worker 采样原已包含 V8/传输字节，但旧 `buildReport` 只导出 REPORTED 的键，丢失了这部分观测。新增报告级正负控，并在最终同源码报告中保留 186 个 worker/V8 观测。历史缺失部分为 unavailable，不推算补零。`workload.ts` 只修正两处 fs counter 的 source 描述；WORKLOAD、SCENARIOS、REPORTED、quiet、ledger、容差均未改变。

**限制**：只有单轮锁内计量，不宣称稳定 L2/生产收益；没有真实模型账号或生产并发/容量验收。传输上限不等于总内存上限。worker 不是沙箱；没有自动重启、回放或父 writer 降级。D9 未开始。产品源码完成并提交供 owner 核验，不因此视为 owner 已通过。
