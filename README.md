# douyin-gpt

在 Mac 上运行的独立 GPT 抖音助手：登录自己的抖音账号，主动浏览推荐视频、发表评论、回复新评论，并自动回复指定联系人的新私信。

这是 0.2.0 命令行版本。Node.js 22 及以上，机器已有 Chrome 或 Edge 即可；没有 npm 运行依赖，不需要 DSH、Python、Windows OCR 或下载 Chromium。GPT 使用 OpenAI Responses API，模型可配置，默认 `gpt-6.1-terra`。

## 当前实现

- 独立浏览器 profile 保存登录态；扫码后绑定账号，每轮核对稳定账号 ID。
- 从抖音推荐流取得候选；接口返回空数据时，读取正常推荐页面里的当前视频。真实打开视频、静音播放一段时间、截取画面，交给 GPT 分析；保存观看记录和 Markdown 日报。
- 只读取配置名单里的个人会话，使用稳定 `sec_uid`，昵称只用于显示。
- 自动回复新到的文字私信；对方分享视频卡片时，尝试读取该视频及其画面，再生成回复。
- 每个联系人用自己的会话历史作为上下文，可以参考助手最近浏览的视频记录。
- 首次运行记录已有消息作为基线；之后以消息 ID 去重，同一句话发两次且 ID 不同，会分别处理。
- 回复生成后再次读取会话。期间有新消息或主人已手动回复，就取消旧回复。
- 发送前落盘，发送后核对本人消息回显。超时、进程中断或结果不明确时暂停该联系人，不自动重发。
- 个人/全局每日回复额度、每日视频数量、轮询间隔都可配置。预览模式不发消息。
- 可选自动评论：只对实际浏览过、能写出具体内容的视频评论，同一视频只发一次。
- 可选自动回复评论：只处理别人回复你的评论、评论区 @ 你、或在你的作品下新留言；先建立通知基线，不补回历史互动。
- 评论通过页面正常操作发送，用稳定评论 ID 核对对象和楼根；新评论不在热榜中时，从通知入口打开对应楼层。评论区与私信的发送记录分开。

## 开始使用

先在终端进入本项目目录。下面命令都在本目录执行。

```bash
node --version
npm run init
```

编辑生成的 `.env`，只在本机填密钥：

```dotenv
OPENAI_API_KEY=你的API密钥
OPENAI_MODEL=gpt-6.1-terra
OPENAI_REASONING_EFFORT=low
OPENAI_BASE_URL=https://api.openai.com/v1
```

这是 API 调用方式，需要你可用的 API 密钥与额度。程序不会读取或复用 Codex 的登录凭证。也可以配置提供 Responses API 的兼容接口；把消息和截图发给哪个服务，由 `OPENAI_BASE_URL` 决定。

也支持把凭证放在数据目录的 `openai.json`（权限应为 `0600`），字段为 `apiKey`、`model`、`reasoningEffort`、`baseUrl`。存在这份本机专用配置时，其非空字段优先于 `.env`。本机部署使用此方式保存密钥，源码压缩包不包含它。

如果当前 Mac Chrome 已登录抖音，可以直接复用（此可选命令需要 Node.js 22.13 及以上）：

```bash
node src/cli.mjs import-chrome --account 你的抖音号
```

只读取当前 Chrome profile 中 `.douyin.com`、`douyin.com`、`www.douyin.com` 的 Cookie，把加密字段复制到本程序的独立 Chrome profile，让 Chrome 自己处理登录态；不读取其他网站 Cookie，不读取 Keychain，也不输出 token。随后联网核对账号。若 Chrome 的加密或平台策略不允许复用，使用下面的扫码方式。

扫码登录并核对你要使用的抖音号：

```bash
node src/cli.mjs login --account 你的抖音号
```

程序会打开独立 Chrome 窗口。在浏览器里完成扫码，回终端按回车；核对成功后才能绑定。也可以不传 `--account`，扫码后读取并绑定当前账号。仅有一个抖音号不能取得登录权限，仍需账号主人扫码。

登录命令会把本程序之前的无头浏览器切换成可见窗口。也可用 `node src/cli.mjs browser-close` 关闭专用浏览器。

列出最近会话并加入自动回复名单：

```bash
npm run contacts
node src/cli.mjs allow --id '从上一步复制的secUid' --label '朋友昵称'
```

此命令会在实际会话列表里核对 ID。没有列出的人，先在抖音里建立会话；列表较长时，在专用浏览器会话列表滚动到那个人再执行。群聊和无法核对稳定 ID 的会话不会加入。

先检查和预览：

```bash
npm run doctor
npm run preview
```

`preview` 会尝试生成当前未回复消息的草稿，并浏览一轮，不发送私信、不把预览草稿计入已处理消息。如果当前没有待回复消息，只执行视频浏览。

开始持续运行：

```bash
npm start
```

`npm start` 等价于 `node src/cli.mjs start --live`，会自动发送名单里联系人的新消息回复。第一次正式运行只记录已有消息；等终端提示“已记录消息基线”后，让联系人发一条新消息测试。终端保持运行，Mac 保持唤醒；Ctrl+C 停止。配置修改后需重启。

在 Mac 上也可以脱离终端后台运行：

```bash
npm run start:background
npm run status:background
npm run stop
```

运行日志在数据目录的 `assistant.log`。停止命令只向经过命令路径和独有运行 ID 核对的本程序发送停止信号。后台模式仍需要 Mac 保持唤醒，没有注册开机启动任务。

## 配置与人设

设置在 `.data/config.json`。示例见 `config.example.json`。`persona.md` 决定聊天口吻，每次启动读取。默认不是模仿主人本人，被问到身份时会如实说明。

默认轮询间隔 15 秒（读取和生成回复的耗时另计）；每 5 分钟浏览最多 3 条视频；每条实际播放约 8 秒并抽 2 帧；每日最多 30 条视频。每个联系人每日最多 40 条回复，全局每日最多 80 条。日期按北京时间计算。`browse.interests` 影响 GPT 的判断口径，采集来源仍是该账号的推荐流，并非关键词搜索。

暂停某个联系人：

```bash
node src/cli.mjs deny --id 'secUid'
```

重新 `allow` 后会重新建立消息基线。更换抖音账号时请使用新的专用 `DOUYIN_GPT_HOME`，重新 `init` 和扫码，避免沿用其他账号的聊天记录。

## 自动评论与评论回复

发布包默认关闭公开评论；当前用户已明确授权的本机配置已开启。开关和配额位于 `config.json` 的 `engagement`：

```json
{
  "enabled": true,
  "commentOnVideos": true,
  "replyToComments": true,
  "commentsPerDay": 3,
  "repliesPerDay": 10,
  "perRound": 1,
  "pollSeconds": 60,
  "commentCooldownMinutes": 30,
  "maxChars": 100,
  "minConfidence": 0.7
}
```

主动评论默认每天最多 3 条，每轮最多 1 条，两条主动评论至少间隔 30 分钟。评论回复默认每天最多 10 条，每 60 秒检查互动通知，处理时间另计。不同开关可分别关闭。修改后重启后台助手。

GPT 只生成公开语境下的简短文字，不使用私信历史或私人人设作为评论输入。证据不足、纯广告、争吵或需要使用者本人公开表态的内容跳过。评论不附带外部链接或主动 @。同一条收到的评论只回复一次；结果不确定时暂停公开评论，不自动重发，私信继续运行。

新通知先按稳定评论 ID、作者和楼根定位原留言；原留言被删、正文变更或定位失败时保留待处理，不猜对象。抖音要求验证时需要回专用浏览器完成正常验证，程序不代过验证。

公开评论使用专用 Chrome 页面，交互时会激活对应标签。

```bash
node src/cli.mjs comments-outbox
node src/cli.mjs comments-resolve --id '记录ID' --as sent
# 或核对后跳过，本命令不会重发：
node src/cli.mjs comments-resolve --id '记录ID' --as skip
```

`sent` 表示已在评论区回读；`accepted` 表示抖音返回了评论 ID，但尚未完成回读；`not_sent` 表示发送前被拦；`uncertain` 表示无法确认结果。评论记录在 `comments.json`，不要通过删除这个文件来解除暂停，这会丢失去重记录。

## 记录与结果核对

```bash
npm run status
node src/cli.mjs outbox
```

数据默认保存在项目 `.data/`，可用 `DOUYIN_GPT_HOME` 改成另一个专用绝对路径：

| 路径 | 内容 |
|---|---|
| `config.json` | 账号绑定、联系人和设置，不含 GPT 密钥 |
| `browser/` | 专用浏览器登录态 |
| `state.json` | 消息去重、上下文、发送记录、观看记录 |
| `comments.json` | 公开评论去重、互动通知基线、评论与回复发送记录 |
| `reports/日期.md` | 视频日报 |
| `frames/` | 视频抽帧，启动时清理超过 7 天的文件 |
| `browser.log` | 浏览器启动日志 |

`sent` 表示在本人发出的消息中看到了新增的相同正文，不等于对方已读，也不是服务端送达证明。`uncertain` 表示发送是否成功不确定，该联系人会暂停。到抖音里核对后执行：

```bash
node src/cli.mjs resolve --id 'outbox中的记录ID' --as sent
# 或确认不再处理本条：
node src/cli.mjs resolve --id 'outbox中的记录ID' --as skip
```

这两个命令只记账，均不会重发。`draft` 是已生成但还没进入发送的记录；进程如果在这一步退出，也可用 `resolve --as skip` 归档。程序优先避免重复发信，不对不确定结果自动重试。

## 测试

```bash
npm run check
npm test
npm run demo
```

`demo` 用虚构联系人、视频和 GPT 替身演示“建立基线 → 浏览 → 收到消息 → 回复一次 → 再次轮询不重复”。不打开浏览器、不联网，也不访问真实账号。

自动化测试覆盖私信与评论去重、重启恢复、配额与冷却、通知基线、楼根和回复对象、背景页面与通知弹层、停止信号、发送方识别以及 Responses API 请求结构。API 测试连接本机假服务，不会消耗真实 API 额度。

## 当前边界

- 当前 Mac 已实测账号、私信、视频浏览及 GPT-6.1 Terra 的文本和图像调用；并已实际发出 1 条公开评论、对用户的新留言发出 1 条楼中楼回复，均已回读。抖音可能改变接口或页面，失败时会显示错误。详细测试范围见 `VERIFICATION.md`。
- 主动浏览来源仍是推荐流，不做关键词搜索，不自动点赞、收藏或主动群发。公开评论受 `engagement` 开关和配额控制。
- 判断主要来自文案和抽样画面，没有音频转写，不声称完整理解视频。语音消息、图片私信等非文字内容没有单独识别链路。
- 自动回复需要能提取稳定消息 ID、确认消息发送方和联系人 ID；无法确认时不发送。会话列表虚拟化也可能使较远的联系人暂时无法定位。
- 消息正文和上下文、视频文案与截图、相关公开评论会发送到配置的 GPT 接口用于处理；浏览器登录态不会作为模型输入，公开评论请求不包含私信历史。`.env` 与 `.data/` 不应提交或分享。
- 使用抖音网页版自动化，登录、验证和账号限制由平台决定。遇到验证或账号不一致应回浏览器处理，程序没有绕过验证的实现。

## OpenAI 文档与参考代码

Responses API 的结构化输出与图像输入分别按 [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) 和 [Images and vision](https://developers.openai.com/api/docs/guides/images-vision) 实现。默认模型能力见 [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra)。模型可用性以你的 API 账户为准。

两个抖音参考项目的使用范围、提交和许可证见 `NOTICE.md`。
