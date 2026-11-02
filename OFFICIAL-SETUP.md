# 官方私信接入准备

截至 2026-10-30，当前部署没有官方应用与用户 OAuth 授权。现有自动回复继续使用独立浏览器。官方事件接收、授权与发送 SDK 已实现，尚未接入生产自动回复调度。

## 申请条件与当前开放状态

官方企业号私信接口要求审核通过的企业号、开发者应用、`enterprise.im` 权限和账号主人授权。当前[官方发送文档](https://open.douyin.com/platform/resource/docs/openapi/enterprise-open-ability/message-management-enterprise/message-to-user/)标注“当前能力内测名额已满，已暂停申请”。请在开放平台控制台核对实际开放状态，不能保证现在可申请通过。

1. 注册开发者并创建移动或网站应用，核对企业认证账号。
2. 在应用能力管理确认 `enterprise.im` 是否可申请；恢复开放并获批后再启用。
3. 登记 HTTPS OAuth 回调地址和独立 HTTPS Webhook 地址。
4. 由绑定抖音账号的主人完成 OAuth，核对授权账号与当前浏览器绑定账号。
5. 官方 `open_id` 与网页 `secUid` 是不同命名空间。逐个核对获准联系人的 OpenID，不按昵称猜测，也不自动扩大联系人名单。

## 本机配置

把 `official.example.json` 复制到 `DOUYIN_GPT_HOME/official.json`，权限设为 `0600`。只在本机填写 `clientKey`、`clientSecret` 和 `redirectUri`，不发到聊天、不加入 Git。

```sh
npm run official:doctor
node scripts/official.mjs authorize
```

授权链接只含 Client Key、scope、回调地址和随机 state。state 十分钟有效且只能使用一次。把授权完成后的完整回调 URL 保存在本机文本文件中，再通过控制台或命令换取凭证：

```sh
node scripts/official.mjs exchange /绝对路径/本机回调.txt
node scripts/official.mjs refresh
```

OAuth 交换使用官方 `/oauth/access_token/`，刷新使用 `/oauth/refresh_token/`；凭证只写入本机私有配置。刷新不会自动标记身份核对完成。配置损坏、权限过宽、授权过期、缺少 scope、账号未核对等情况，诊断会明确列出，发送器不会尝试网络发送。

核对后填写 `boundAccountSecUid`、`accountConfirmed`，以及 `contacts` 中每位获准联系人的 `{ "openId": "已核对的官方ID", "verified": true }`。SDK 仍要求 `config.json` 中 `official.enabled=true` 才允许发送。当前部署保持关闭；SDK 不负责自行突破平台的会话窗口或频率限制，未来调度还需同时应用本机额度与平台规则。

## Webhook

```sh
node scripts/official.mjs webhook
```

接收器仅监听 `127.0.0.1:3147/douyin/webhook`。仅将这个独立入口通过你管理的 HTTPS 服务反向代理，不暴露控制台 3146 端口。

按[官方 Webhook 文档](https://open.douyin.com/platform/resource/docs/develop/webhooks/summarize)，接收器使用 `SHA1(client_secret + 原始请求体字节)` 核对 `X-Douyin-Signature`，校验应用 Client Key；challenge 同样需要验签，`Msg-Id` 持久化去重，保存成功后才确认接收。请求过大、队列满或写盘失败不会返回成功。

当前接收的事件保存在本机 `official-events.json`，没有自动交给 GPT、DeepSeek 或浏览器发送器。没有应用配置时不启动接收器、不对外创建地址。完成真实应用联调后，再实现事件到已有私信账本的映射和平台窗口检查。

## 已实现的发送代码

`OfficialClient.send()` 支持文字、已上传素材 ID 对应的图片：官方 owner OpenID 放在 query，用户授权 token 放在 `access-token` header，`content` 使用 JSON 字符串。只接受明确的服务器消息 ID，`<nil>` 或响应丢失均不能视为发送成功，不自动重试 POST。`client_msg_id` 仅用于追踪，不假定官方提供幂等保证。

图片上传文档当前缺少完整参数表，因此不猜测素材上传参数。官方视频消息要求已审核的公开作品 ID；本机私信语音卡不会因此被上传成公开作品。当前语音卡仍使用已获准会话中的原生私信视频入口。

自动化测试使用本机假服务验证 OAuth、防重放、签名、ID 映射与异常响应；这不等于官方企业号已连接或获批。
