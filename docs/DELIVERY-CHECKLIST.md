# Trusted-team delivery checklist

用户已授权真实账号验证、推理、多人模拟和录屏。不得泄露凭据、刷新导入副本、冒充服务商许可或另一设备实测。仍为私有 alpha 候选，不缩小原验收目标。

## 已交付并受测

- [x] 独立仓库、可信原生执行、个人账号路由、接力/fork/busy payer
- [x] 个人配置/完整技能树快照、编辑 UI、明确版本激活、摘要验证、fork/重启/canonical alias 保留
- [x] 项目 view/continue/fork 权限与撤权（本地回归）
- [x] 持久执行归属、响应原子用量归属、恢复补记去重；不冒充财务账本
- [x] 公共历史压缩 serialization 修复（本地回归）
- [x] 同成员 browser device 登录/撤销（本地回归，不是执行节点）
- [x] 离线摘要备份/原路径恢复，拒绝活跃 writer，恢复排除旧 auth
- [x] 当前主工作区完整测试 264/264，包含 Qoder 账号目录刷新回归
- [x] 独立 HOME/PATH/空 npmrc 冷安装、runtime 门禁、typecheck、focused 22/22（此前冷依赖完整 263/263）
- [ ] 本次冷依赖完整回归 263/264：browser screencast 宽度 1265/1280 不一致，仍需收口
- [x] ChatGPT/Codex + Qoder 导入账号的真实协作/工具/fork 和私有录像，明确逻辑成员/恢复与换行差异
- [x] 独立 SIWC grant、账号目录、官方 API 真实 read、刷新轮换；原 auth 字节前后相同
- [x] 独立 Qoder grant、隔离本地到期后的真实轮换、同一 SIWC 会话真实 read 接力；目录刷新修复和当前账号目录核验
- [x] unknown OAuth 刷新不重放和 OpenAI SDK 无 429/503 自动重试回归
- [x] 指定备用 MacBookPro17,1：固定源码冷安装、完整 264/264、loopback launchd、自动重启及无 Provider auth 的停机备份恢复
- [x] 官方政策资料检索与未获批准边界说明

## rotom 内核迁移（新增目标）

- [x] 固定产品独立安装、bootstrap 校验、严格 RPC、真实 rotom 原生工具 proof（scripted endpoint，无真实账号）
- [x] 独立 journal/attempt/receipt、unknown 跨重开隔离、原生 stream gate、entry/usage 原子导入，同账号恢复和 scripted 撤权 proof
- [ ] 接入真实 team 角色/项目/账号/快照、完整 refresh writer 合同及跨账号上下文
- [ ] 网页 create/submit/stop/接力/fork/压缩以及备份迁移；新内核真实账号验证与备用机部署
- [x] 当前增量完整套件 284/284；此前浏览器宽度不稳定失败仍保留记录，不宣称已修复

以上第二阶段不等于网页已使用 rotom，实施边界见 [ROTOM-KERNEL.md](ROTOM-KERNEL.md)。

## 正式版仍需完成

- [ ] Qoder 自然到期、服务商撤销/限额和 unknown 刷新真实路径（已验证独立授权及隔离本地到期）
- [ ] 实际远端 OAuth host/session、客户端注册品牌与资格
- [ ] 独占专用 OS 用户、真实跨版本升级/断电/有账号的恢复，以及备用机独立模型登录/推理与 UI 验证（已完成用户指定账号的安装、launchd 与停机恢复）
- [ ] 真实跨账号压缩、长任务中断、关键外部副作用恢复与完整权限撤销/设备协作录像
- [ ] 真实 quota/财务账本需求与 Provider 支持/许可收口
- [ ] 最终正式受检版本、发布/分发授权和剩余验收

源码提交不等于正式发布。当前证据与限制见 [VERIFICATION.md](VERIFICATION.md)，网络/设备未选择时不得擅自开放服务。
