# D8 — Storage 边界、测量与验证

## 当前状态

D7 核验提交 `2e92cbd` 已拉取。D8 进行中，尚未实现或验收 worker；D9 未开始。
用户原有 opportunities.md 与未跟踪 proposals 文档备份在 `/tmp/rotom-review-D8/user/`，不纳入提交。

## Owner 本轮明确修订 C3

执行前核对发现：pi-durable 1.0.2 已有公开异步 Storage API；完整迁移 Harness 则需要搬迁事务回调、
registry、观察订阅和旧后端任务调度，并为父线程个人凭据/模型/工具建立桥接。
Owner 在本轮选择 **“调整为 Storage 边界”**，替代旧 C3 的 Harness+queue 线程归属：

```text
父线程：HTTP / 权限 / native transport / payer gate
        Durable Harness + mutation queue + 业务事务回调 / 镜像协调
           │ 完整存储操作、有界数据消息、关联 ID、durable ACK
           ▼
单 storage worker：RotomJournal + 公开 Pi Durable Storage
```

- D8a 先把跨边界的 journal 调用链改成显式异步，暂留主线程。Durable Storage 已是异步接口；
  复用其公共合同，不发明缺失的 upstream API，不改数据库 schema/document kinds 或 runtime patch。
- D8b 单 worker 同时承担两套存储操作，开关默认关闭；不能用第二个父线程数据库 writer 或私有表读取绕开它。
  Harness 的 Session 全局队列仍在父线程；不声称它或全部文档/投影 CPU 已 offload。
- 父线程继续拥有个人凭据与旧后端执行。D9 未授权提前执行，不能借此次 worker 删除旧执行能力。
- 原 ACK/unknown、不自动重放、完整事务、镜像顺序、权限隔离、shutdown 和故障注入要求保留。
  StorageRejected 只代表已证明无副作用的拒绝；丢 ACK 不等于事务回滚。
- 异步接口本身不是响应性收益；D8a 不宣称 CPU 已离开主线程。

公开合同依据：`pi-durable/dist/types.d.ts` 的 Storage/Session；`dist/session/session.js` 的
queue、adoption/publication 与 poisoned 状态。现有 mirror 在一个 Durable commit 内更新正文、
Authors/Sessions/NativeMirrorDoc；只在该提交成功后推进内存 cursor，顺序必须保留。

## 改动前基线

只运行现有测量器，未改 workload、计数器或 ledger：

```sh
node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs D8-baseline -- \
  npm run perf:measure -- --runs 1 --out /tmp/rotom-review-D8/base.json
```

源码 `2e92cbd`；darwin-arm64 / Node v24.18.0 / Apple M1 8 核。
exit=0，highLoad=false，load 2.38→3.38/8 核，wall 121971 ms。
`/tmp/rotom-review-D8/base.log` 和 `base.json` 保存原始数据。单轮 L2，不作为生产 L3 结论。
现有 D7 1/10/100 MiB 阶段证据保留在原记录；本轮尚未重跑或宣称新性能收益。

后续分别对 D8a 和启用/关闭 worker 的当前产物验证；worker 工作必须计入测量，不能把跨线程不可见
计数器当作零。消息复制、序列化、排队和关闭成本需要单独记录。
