# Provider policy findings — not an approval

以下是已检索的官方资料和相关段落，不是完整法律审阅、服务商批准或分发许可。真实请求成功只证明具体授权当时可调用。

## OpenAI / ChatGPT

- [Account sharing policy](https://help.openai.com/en/articles/10471989-openai-account-sharing-policy)：账号属于个人；他人须使用自己的账号。同一个人可用多设备。服务成员 ID 不等于真人身份；本轮 Alice/Bob 是同一维护者的逻辑模拟。
- [SIWC sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[profiles/sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)：独立 client 注册、个人 credential/session 所有权。不能把旧 Codex OAuth 重命名为 SIWC。
- [Models/inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)：账号目录、公开 `/v1/responses`、`store:false`/stream、函数 namespace 与 preview 限制。已在当前独立 grant 验证工具读取，不走 ChatGPT backend endpoint。
- [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)：远端 host ID、同工具/用户/workspace 的新登录与安全转移，以及单一 refresh owner；本产品尚无完整远端转移流程。远端浏览器的 localhost 回调不是部署机器。
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)：资格、共享限额、能力可能变化；目录出现不保证推理许可，也不保证每客户端独立 quota。

当前复用 Pi `1.0.2` 原生客户端注册，显示名沿用 Pi。rotom team 仍为 private/UNLICENSED；不能从“原生 SDK 开源”推断新组合产品符合所有 open-source-client 或分发条件。正式注册品牌、资格与远端会话流程仍须收口。Terms of Use 的直接请求为 403，未据此声称已读完整条款。

## Qoder

官方 [Product/service agreement](https://qoder.com/product-service)（不是返回 404 的 `/terms`）、[Privacy](https://qoder.com/privacy-policy)、[CLI quick start](https://docs.qoder.com/cli/quick-start) 可获取。相关条款限制凭据分享/第三方账号访问，并涉及逆向、反编译/拆解限制；组织方案不等于可把个人客户端凭据交给任意托管工具。

本实现是从 rotom 内化的非官方代码快照，不是 Qoder 官方 SDK 或已批准团队集成。已授权的本人账号研究/验证不构成服务商许可；成功推理、动态目录和余额读数也不能证明许可或未来协议稳定。正式推广/分发须取得适用接入与代码许可；当前不得宣称官方支持。

## 产品行为

不共享他人的凭据、不竞争刷新导入副本、不从余额差值猜单次费用、不失败切到别人的账号。活动授权的刷新前持久记录尝试，unknown 不重放；离线恢复不恢复 auth。模型 usage、credits 和美元账单不混为一谈。
