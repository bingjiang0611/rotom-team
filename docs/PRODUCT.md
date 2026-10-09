# rotom team 产品合同

共享会话历史，不共享模型账号。谁提交执行，使用谁的个人模型与额度；查看、评论不发起模型推理。当前仍是 `0.1.0-alpha.1` 私有候选，不宣称正式版完成。

## 信任与部署

原生 macOS、专用系统用户、完全可信成员。模型路由、私有文件及应用权限不是 OS 沙箱：执行代码的人具有服务系统用户的文件权限。默认只监听 loopback；未选择 Tailscale、隧道或公网方案。远程网络、TLS 和目标备用 MacBook 尚未实测。

## 已实现

- `team-accounts.ts`：每人成员/账号修订号/Provider 路由，独立凭据与模型缓存，无环境凭据回退。个人模型失效时要求重新选择，不自动借用其他已连接模型。
- `openai-chatgpt.ts`：SIWC OAuth 使用官方账号 `/v1/models` 与 `/v1/responses`；缓存绑定 client ID **和授权 refresh 摘要**，不是仅绑定工具注册。保留 API-key 静态目录。拒绝将 Codex 凭据重命名为 SIWC。
- `credential-store.ts`：串行、原子 `0600` 存储、取消检查。复制的验证凭据不能刷新；原生 OpenAI 与 Qoder 刷新在请求前记录一次性尝试，unknown 不重放。
- `team-execution.ts`：持久执行归属、Provider session 索引和实际分派检查；busy 付费人不变。Durable observer 会吞异常，不能承担授权门禁。
- `team-profiles.ts`：个人配置档、项目规则和完整技能树快照（含 references/scripts），显式激活版本，重启/接力/fork 保留；8 MiB 上限，拒绝碰撞、服务数据导入、非普通文件及 symlink；读取/分派验证 SHA-256。哈希是检查点检测，不防同一 OS 用户并发修改。
- `team-projects.ts`：项目 view/continue/fork 独立授权，fork 不扩张范围；撤权关闭订阅并中止未授权执行。原生代码执行仍不是项目目录沙箱。
- `team-usage.ts` 与 Durable usage patch：响应和实际账号用量原子归属，重启补记不根据最新评论者认领；补记有独立持久去重。
- 分别可撤销的浏览器登录：同一成员至多 32 个额外 bearer 登录，存储 hash；撤销关闭既有流。这不是远程执行节点。
- `scripts/data.mjs`：离线私有备份、逐文件摘要、拒绝活跃 writer；只恢复到原 canonical 路径且不覆盖。备份包含秘密，恢复故意不恢复 `people/*/auth.json`，避免复活旧刷新凭据。项目工作区另备份。

## 协作与上下文

同一会话准入串行。忙时其他成员只能评论、等待、停止后接力或 fork；不跨账号排队。失败执行仍有未处理输入时，不能交给新账号自动执行。幂等重试返回原 receipt，不改付费人。

同账号历史保留原始字段；跨账号只发送公开文本与配对工具历史，移除 thinking/signature/response ID 等私有状态，原记录不变。这不是对协作者隐藏原始 thinking 的访问控制。

已替换 alpha 的跨账号压缩拒绝：hash-bound Durable patch 在转成 user 文本前排除 thinking，当前发起者使用自己的账号压缩。已有持久子 Agent 不自动获得新付费人权限；需要新建子 Agent。

## 用量与限额

Token、API 成本估计、订阅额度和财务账单不同。美元零占位不代表免费；ChatGPT 全账号额度与 Qoder credits 不构成完整账本，缺失保持 unknown。美元预算不硬限制订阅 credits，最终额度由 Provider 执行。

SIWC 的 4096 `maxTokens` 是本地预算提示，不是服务端输出硬上限；该计划路由不接受 `max_output_tokens`。目录最多 256 条；模型目录/推理档位超出可解析合同需更新 adapter，不猜测映射。只映射 Pi 原生支持的 reasoning levels，未支持的 ultra 不伪装支持。

个人账号定时任务、自动 Goal 和付费标题生成保持关闭。个人执行节点、SSO、多租户隔离、跨机器 live SQLite、自动账号降级不是已交付能力。

## 运行时与服务商

Pi npm `1.0.2`，通过 `scripts/prepare-runtime.mjs` 和 `vendor/pi-durable/patches.json` 校验 stock/patched 摘要与包身份：公共压缩、原子归属及 OpenAI SDK `maxRetries:0`。不修改存活 rotom 的安装。保留上游许可/归属。

Qoder 是非官方代码快照，动态目录只开放实测白名单交集；凭据和额度成功不证明上游许可。SIWC 使用 Pi 的原生客户端注册/登录，当前注册显示名沿用 Pi；remote-host session transfer 与客户端品牌审查尚未交付，远端 localhost 回调不能假装到达部署主机。

验收证据见 [VERIFICATION.md](VERIFICATION.md)，部署和恢复见 [DEPLOYMENT.md](DEPLOYMENT.md)，未完成项见 [DELIVERY-CHECKLIST.md](DELIVERY-CHECKLIST.md)。独立 Qoder 登录及隔离本地到期后的刷新已实测；正式版仍须补齐自然到期/撤销/限额、真实跨账号压缩/中断恢复、目标设备部署及服务商支持边界，并收口本次冷环境浏览器回归失败。不得把局部通过写成全目标完成。
