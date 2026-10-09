# rotom 执行内核迁移

## 当前状态：第一阶段，不是已切换

已实现并验证独立固定版本 rotom 的进程/RPC 边界。**网页、备用机与现有会话仍使用原 Pi Durable 后端。** 这不是把 rotom 包装为一个模型 Provider；不会让两个 Agent 循环同时执行同一会话。没有复制模型凭据，没有修改 dev-agent 源码或当前用户的 rotom 安装。

长期边界：team 拥有成员/项目权限、协作、不可变付费人、配置快照、请求准入和共享视图；rotom 拥有模型接入、Agent 循环、工具、扩展和原生会话。rotom 不引入团队业务概念，也不依赖 team。team 固定已验证的产品版本，通过版本化适配边界升级，不能追随全局 CLI 或开发 checkout 自动变化。

## 已实现

- `runtime/rotom/package.json` / lock：单独安装公开 `@bingjiang0611/rotom@0.1.14`，npm lock 绑定 registry tarball SRI。不是复用本机全局安装，不是 `file:` 引用 dev-agent。
- `runtime/rotom/pin.json`：产品 bootstrap 的 SHA-256。`verifyRotomKernel()` 检查 canonical 路径、版本、名称、公开入口、摘要及可执行性；真正启动仍由产品 launcher 完成它原有的 bundled Pi/resource gate。这不是整个安装树的逐字节审计，也不是 OS 沙箱。
- `src/server/rotom-kernel.ts`：调用真正的公开 `bin/rotom --mode rpc`。使用显式私有 HOME、agent directory、workspace、provider/model；不合并维护进程环境、不传 API key、不查 PATH/global rotom。启动模型与请求不一致则拒绝，不 fallback。
- 产品扩展正常加载；当前验证工具面明确限定 `read,write,edit,bash`。没有宣称完整工具/Goal/Subagent/Browser 能力迁移。关闭 Agent 自动重试/压缩不等于所有 Provider SDK 都无网络重试。
- `src/server/rotom-rpc.ts`：只按 LF 分帧，正确处理分块 UTF-8、CRLF、U+2028/U+2029；响应按 id+command 关联。持续排空但不保留 stderr，不打印 prompt/工具正文或认证信息。
- prompt response 只证明准入；`agent_end` 不证明执行结束。等待 `agent_settled`，区分 `handled`、明确 `rejected` 和 `unknown`。同一个进程忙时不自动排队、不换账号；断连/超时/坏协议后 fence 后续写入，绝不自动重新启动/重发。
- 未接入的交互式 dialog 一律取消，不默认批准；未实现的模型切换、fork、compact、steer、bash RPC 等命令明确拒绝。控制请求不能绕过 prompt 的 busy 检查。
- stdin 至多 16 个 pending records，单请求 1 MiB、单 stdout record 8 MiB；超界保持 unknown，不截断后伪装成功。需要大附件或超大 transcript 时，应先增加有界分页/附件合同并补测试，不能简单去掉上限。
- `close()` 等待直属 child 退出；不是 detached descendants 已关闭、工具已回滚或外部副作用未发生的证明。

## 安装与检查

仅维护验证入口，**不要对正在执行会话的安装运行 npm ci**：

```sh
npm run install:kernel
npm run test:kernel
```

第一条命令在 `runtime/rotom/` 内按锁安装产品并检查 bootstrap，不更新全局 rotom。发行产品本身携带运行时，不执行依赖安装脚本。正式 server backend 启用前仍需后面的迁移门禁；当前根 launcher 不自动启动它。

`test:kernel` 是显式的真实产品/本地 scripted endpoint 验证，不是 Faux 代替 rotom，也不是付费模型测试。创建私有临时 HOME/workspace，仅 loopback endpoint，验证产品 `qoder-credits` command 存在、真正的原生 write/read、工具回传、最终回答、settled 与原生 JSONL 文件读取。产物留在工具输出所示私有临时目录，不进入 Git。JSONL readback 证明受测正常退出场景的文件内容，不宣称断电持久性。

## 迁移之前必须完成

1. **持久 backend/session/attempt 绑定与准入。** 现有 `harness.resume()` 只能恢复原 Durable 后端；新后端不能进入旧 input/resend/compaction tasks。相同 client request 返回同一持久 receipt。RPC id 仅关联响应，不是服务端幂等键。
2. **unknown 防重放必须跨重启。** 在 send 前持久提交 immutable member/account-generation/model/configuration/session 与 dispatch-intent。传输断线可能已经执行；不得因新进程 idle 就自动重发。当前 RPC transport 的 fence 仅覆盖本进程，尚不是持久调度器。
3. **每次真正付费 dispatch 的授权。** 单独 HOME 不等于权限门禁；仍需核验成员/项目/账号代际/快照，包括 compaction 和子任务。独立登录且唯一 refresh writer；不复制或竞争刷新旧 team/rotom grants。此门禁完成前不把本模块接到真实团队账号。
4. **持久结果投影。** rotom 的 stdout message event 可早于 JSONL append。流式内容仅是 provisional；用 kernel session + entry ID 去重，从原生持久 entry 读取后，在 team 同一事务写 transcript、实际 payer usage 与 ingestion cursor。不能把最新评论者当付费人，不把 unknown credits 当零。
5. **配置与历史。** 原生 SessionManager 才是模型上下文权威，不能仅替换内存 messages。新账号接力需要显式只导入公开的配对文本/工具历史，移除 private thinking/signature/response ID；保留同账号原始记录。fork、comment-to-context、withdraw、快照与压缩须逐项映射，不能用 set_model 冒充接力。
6. **备份与取消。** 新 kernel 的 JSONL、资源目录与子进程要进入 writer/quiescence 合同；现有单进程 SQLite backup 不能冒充新后端安全备份。未知工具写入必须 readback，不重放。
7. 先 scripted 账号/权限/崩溃窗口测试，再用已授权的真实独立账号验证，最后才可迁移或部署；旧会话不静默转换。

## 本阶段证据

- 独立空 HOME/cache/npmrc 安装固定产品成功；`check-kernel`、typecheck、format/lint 通过。
- Wire 回归 12/12：fast settlement、Unicode 分帧、handled/rejected、断连、坏 JSON、错 id、超限、deadline、busy、命令旁路拒绝和 settled 后同批坏协议不能升级为成功。
- `test:kernel`：本地 endpoint 共 3 次模型请求，由真正 rotom 执行 write/read，最终 stop 和 JSONL readback 通过；没有真实账号授权/推理。
- 当前完整自动套件 **275/276**；`test/browser.test.ts:420` 的 1265/1280 screencast 宽度断言失败，与已记录冷环境失败一致。未为此次迁移顺带修改浏览器。
- 本阶段没有更新备用机或启用网页新后端，不声明完整迁移完成。
