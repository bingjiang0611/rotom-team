# OpenAI 远程登录：把回调地址粘贴回来

适用于**浏览器与 rotom team 服务不在同一台电脑**的情况。成员只需要网页访问权限，不需要服务器 SSH 权限。

## 为什么要粘贴

OpenAI（ChatGPT 订阅与 Codex）登录完成后，会跳转到 `localhost:1455/auth/callback`（ChatGPT 订阅是 `127.0.0.1:1455`）。浏览器访问的是**浏览器所在电脑**的 1455，而登录接收器运行在服务器上。

- 浏览器就在服务器上：跳转直接到达接收器，自动完成。
- 浏览器在别的电脑上：跳转后的页面打不开（"This site can't be reached"）。这是预期的。地址栏里的地址带着这次登录的一次性授权码，粘贴回登录弹窗即可完成。

授权请求由服务器发起，PKCE verifier、state 与 ChatGPT 的 host ID 都留在服务器上；浏览器只是把回调地址带回来。服务器校验 state 后自己交换令牌，凭据直接写入该成员的私有存储。

## 登录步骤

1. 在 **Settings → My model accounts** 选择 OpenAI 或 OpenAI Codex，点 Sign in。Codex 先问登录方式，选 **Browser login**。
2. 点 **Open the sign-in page**，用**自己的** OpenAI 账号授权。保持登录弹窗打开。
3. 授权后浏览器停在打不开的 `localhost:1455/...` 页面。复制地址栏里的**完整地址**。
4. 粘贴到登录弹窗的输入框，点 **Continue**。成功后弹窗关闭并提示已登录。

Codex 也可以选 **Device code login (headless)**：弹窗显示一个代码，在 OpenAI 的设备页输入即可，不需要粘贴。它是否可用取决于 OpenAI 是否为该账号开启了设备码登录；不可用时会直接报错，改用 Browser login。

## 失败与边界

- 回调地址只能用一次，只属于这一次登录。粘贴到其他登录、过期后重用或 state 不符都会被 SDK 拒绝（"State mismatch"）；重新开始一次登录即可。
- 不要把回调地址、授权码或凭据发到聊天里。服务使用明文 http 时，粘贴的地址经过网络传输；授权码没有服务器上的 PKCE verifier 无法单独换取令牌，但仍应只在可信网络中使用。
- 服务器上的 1455 端口同一时间只给一个 OpenAI/Codex 登录使用；其他成员会收到 409，不抢占正在进行的登录。API key 与其他服务商不受这个限制。
- 登录最多等待 10 分钟。超时或取消会中止 SDK 的等待并释放端口；不复用旧的回调地址。
- 按成员保存凭据、SDK 的 state/PKCE 校验和服务器作为唯一刷新者的规则不变。

依据：粘贴入口由 `@earendil-works/pi-ai` 的 OpenAI/Codex 登录提供（`manual_code` 提示），本服务只负责转交与说明。OpenAI 的 [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) 描述的是另一条路径：在本机完成授权后，经安全通道转交凭据文件。那份文档没有专门说明粘贴回调地址这种方式。

## 验证范围

- `test/provider-login.test.ts`：OpenAI/Codex 登录直接进入 SDK，不再有前置问题；粘贴值原样送达 SDK；成员边界、1455 串行、取消与超时。
- `test/provider-login-ui.test.ts`：隔离 Chromium、模拟 SDK，在 390/320 像素下显示粘贴说明、粘贴后完成、取消释放登录、失败保留错误。
- 用真实 SDK（不发网络请求）粘贴 state 不符的地址，两个服务商都返回 state mismatch，证明粘贴的地址进入了 SDK 的校验。
- 未用真实账号验证粘贴后的完整令牌交换。此前一次真实 Codex 登录是通过临时 SSH 转发完成的，不是粘贴。
