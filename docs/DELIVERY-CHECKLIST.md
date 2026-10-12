# 正式交付检查

本清单是验收要求，不是运行授权或完成记录。当前产品合同见 [PRODUCT.md](PRODUCT.md)，配置合同见 [CONFIGURATION.md](CONFIGURATION.md)。旧实验的授权、PASS、计数或截图不替代当前版本验收。

## 自动检查与产物

- 对明确的源码 revision 运行 `npm run check`、`npm run format:check`、`npm run lint`、`npm test`。
- 使用固定依赖和 rotom pin 验证隔离安装，不拿复用依赖的检查冒充冷安装。
- 对原生执行路径使用相应 `test:kernel*` 证明脚本，记录实际命令、产物和限制。执行前确认脚本的输入、模型和授权范围；本清单不授权真实账号或付费调用。
- 检查变更是否仍满足 [NATIVE-DELIVERY.md](NATIVE-DELIVERY.md) 的 R1–R8、[NATIVE-RECOVERY.md](NATIVE-RECOVERY.md) 的 unknown/lease 边界及 [SECURITY.md](../SECURITY.md) 的可信团队限制。

## 真实账号与服务商

以下验证必须先取得本次明确授权，使用独立测试环境，并将账号、设备、原始日志和费用证据保存在 Git 外：

- 模型授权自然到期、撤销、刷新轮换、限额与失败；unknown 不重试或默认成功。
- ChatGPT/Qoder 接力、fork、压缩及工具执行的当前原生路径，不沿用旧 Durable 的结果。
- 子 Agent 的固定付费人、gate 关闭、用量归属和中断边界。
- 项目 MCP 的成员 OAuth 登录、撤销、隔离存储与失败，不混用模型刷新凭据。
- Provider 支持、SIWC 注册/品牌、团队托管及分发许可；见 [PROVIDER-POLICY.md](PROVIDER-POLICY.md)。
- 明确区分 token、美元估算、订阅额度和 credits；不宣称完整财务或 quota 账本。

## 目标设备与运维

- 在授权设备验证实际安装产物、loopback/访问控制、界面及多人操作，不以维护机结果替代。
- 验证服务停止、子进程关闭、重启及自动续跑上限。无法证明工具关闭时保持 unknown，不重放。
- 验证离线备份、摘要、原路径恢复、独立重登和受限回滚；不复制在线 SQLite，不删除未核清 lease。
- 远程入口需独立验证 TLS 和访问控制。远程 OpenAI 登录靠成员粘贴回调地址（见 REMOTE-OPENAI-LOGIN.md），不是 OpenAI 官方的凭据转交流程。
- 私有部署记录、公司或设备标识、原始会话及账号数据不进入 Git。

## 交付报告

报告应分别列出：源码/产物版本、实现范围、实际验证、未验证项、unknown 结果、费用边界、提交和部署状态。不要把构建成功、局部 fixture 或历史录像写成正式版完成。
