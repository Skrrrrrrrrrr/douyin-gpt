# douyin-gpt

在 Mac 上运行的 GPT / DeepSeek 抖音助手：登录自己的抖音账号，主动浏览推荐视频、发表评论、回复新评论，分别生成每日日志，并按关键词选择 GPT 或 DeepSeek 回复指定联系人的新私信。

这是 0.7.0 命令行版本。Node.js 22 及以上，机器已有 Chrome 或 Edge 即可；使用一个轻量 Node.js 依赖 `ws`；基础浏览和聊天不需要 DSH、Windows OCR 或下载 Chromium。视频功能另需 Python、Pillow 和 FFmpeg。两个服务均使用各自的 Responses API；默认模型为 `gpt-6.1-terra` 和支持图像输入的 `deepseek-flash`。

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
- GPT 与 DeepSeek 使用同一后台进程、账号和浏览器，按顺序操作；观看、评论和评论回复按模型独立计数。
- 公开评论记录跨模型去重。用户回复模型发出的评论时，按被回复评论 ID 和楼根交给原模型；模型停用、额度用完或接口失败时保留待处理，不切换到另一模型回答。

## 开始使用

先在终端进入本项目目录。下面命令都在本目录执行。

```bash
node --version
npm install
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

默认私信轮询间隔 15 秒（读取和生成回复的耗时另计）；GPT 每 5 分钟浏览最多 3 条视频；每条实际播放约 8 秒并抽 2 帧；GPT 每日最多 15 条视频。DeepSeek 开启后每 35 分钟浏览最多 1 条，每日最多 5 条，播放时长、抽帧数和兴趣配置沿用 `browse`。每个联系人每日最多 40 条私信回复，全局每日最多 80 条，两个模型共用这份私信额度。默认由 GPT 处理，开启下方关键词路由后可按新消息选择模型。日期按北京时间计算。`browse.interests` 影响模型的判断口径，采集来源仍是该账号的推荐流，并非关键词搜索。

## 私信关键词路由

当前本机已按用户要求启用：本轮尚未处理的新来信中，只要任意一条文字包含连续的“大肥鱼”，就由 `deepseek-flash` 回复；否则由 `gpt-6.1-terra` 回复。只有指定名单中的联系人会进入处理。

`config.json` 中的设置：

```json
{
  "reply": {
    "routing": { "enabled": true, "deepseekKeyword": "大肥鱼" }
  }
}
```

匹配不检查联系人昵称、账号名、本人发言或已经处理的历史消息。一次收到多条待回复消息时作为一批判断，关键词在其中任意一条就命中；下一批重新判断。发布包默认关闭路由，旧配置也保持 GPT。

被选模型读取这个联系人的最近会话、待回复新消息和该模型自己的近期视频记录；消息带视频卡片时，画面分析也交给同一个模型。两个模型共用 `persona.md` 的聊天口吻，`{{MODEL_NAME}}` 自动替换为实际模型名称，身份回答如实区分 GPT 与 DeepSeek。

DeepSeek 需要已启用并配置自己的 API 密钥。命中后接口失败或模型停用时，消息保留待处理，不切换模型；每次发送继续执行账号、联系人、最新消息快照、去重和共享私信额度核对。发送记录保存 `provider` 和实际 `model`，可用 `node src/cli.mjs outbox` 查看。设置修改后重启后台助手。

## 接入 DeepSeek

在 `.env` 填入独立的 DeepSeek API 配置：

```dotenv
DEEPSEEK_API_KEY=你的DeepSeek密钥
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_REASONING_EFFORT=low
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

也可在数据目录保存权限为 `0600` 的 `deepseek.json`，字段为 `apiKey`、`model`、`reasoningEffort`、`baseUrl`，非空字段优先于 `.env`。它与 `openai.json` 完全分开，不借用对方凭证。当前本机已经配置，压缩包不含密钥。

`config.json` 中增加：

```json
{
  "deepseek": {
    "enabled": true,
    "browse": { "videosPerDay": 5, "videosPerRound": 1, "everyMinutes": 35 },
    "engagement": { "enabled": true, "commentsPerDay": 5, "repliesPerDay": 10 }
  }
}
```

保存后 `npm run stop`，再 `npm run start:background`。发布包默认关闭 DeepSeek；用户已授权的本机配置已开启。DeepSeek 的公开评论设置继承 `engagement` 的字数、开关、信心阈值与冷却，可在 `deepseek.engagement` 单独覆盖。

| 模型 | 每日视频 | 每日主动评论 | 每日评论回复 |
|---|---:|---:|---:|
| GPT-6.1 Terra | 15 | 5 | 20 |
| DeepSeek Flash | 5 | 5 | 10 |

以上均为上限；内容不适合评论或没有新互动时不凑数。两个模型共用主动评论的冷却记录，至少间隔 30 分钟。DeepSeek 的浏览间隔为 35 分钟，给每条新视频保留评论机会。

DeepSeek 的视频与公开评论请求只包含相应公开内容；开启关键词私信路由后，命中消息所属联系人的近期会话和聊天人设也会发送给 DeepSeek，完整联系人名单和其他联系人的私信不会进入该请求。回复哪个模型的评论，就由哪个模型回答；无法归属的新作品留言等交给 GPT。旧版本的观看与评论记录视为 GPT，升级不重置当天计数。`npm run status` 的 `providers` 分别显示两个模型的计数与上限。

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
  "commentsPerDay": 5,
  "repliesPerDay": 20,
  "perRound": 1,
  "pollSeconds": 60,
  "commentCooldownMinutes": 30,
  "maxChars": 100,
  "minConfidence": 0.7
}
```

GPT 主动评论默认每天最多 5 条，每轮最多 1 条，两条主动评论至少间隔 30 分钟。GPT 评论回复默认每天最多 20 条；DeepSeek 分别为 5 条和 10 条。每 60 秒检查互动通知，处理时间另计。不同开关可分别关闭。修改后重启后台助手。

两个模型只生成公开语境下的简短文字，不使用私信历史或私人人设作为评论输入。证据不足、纯广告、争吵或需要使用者本人公开表态的内容跳过。评论不附带外部链接或主动 @。同一条收到的评论只回复一次；结果不确定时暂停两个模型的公开评论，不自动重发，私信继续运行。

新通知先按稳定评论 ID、作者和楼根定位原留言；原留言被删、正文变更或定位失败时保留待处理，不猜对象。抖音要求验证时需要回专用浏览器完成正常验证，程序不代过验证。

公开评论使用专用 Chrome 页面，交互时会激活对应标签。

```bash
node src/cli.mjs comments-outbox
node src/cli.mjs comments-resolve --id '记录ID' --as sent
# 或核对后跳过，本命令不会重发：
node src/cli.mjs comments-resolve --id '记录ID' --as skip
```

`sent` 表示已在评论区回读；`accepted` 表示抖音返回了评论 ID，但尚未完成回读；`not_sent` 表示发送前被拦；`uncertain` 表示无法确认结果。评论记录在 `comments.json`，不要通过删除这个文件来解除暂停，这会丢失去重记录。

## 每日日志

默认启用。每条视频记录后，立即更新 `reports/YYYY-MM-DD.md`；GPT 和 DeepSeek 分别根据自己当天的视频记录生成综合总结，最多每 30 分钟重算一次，没有新内容时复用已有总结。主循环在没有新视频的轮次也会检查总结和公开互动计数。

一份日志包含当天概况、两个模型的内容归类、回看线索、当天观察、判断范围，以及全部视频的逐条摘要、画面依据、原链接和北京时间。日志和总结请求均不包含私信、联系人名单或私人人设；综合总结只使用已保存的公开视频分析，不重新刷视频、不发送评论。

```json
{
  "journal": {
    "enabled": true,
    "refreshMinutes": 30,
    "outputDir": "/absolute/path/to/douyin-daily-logs"
  }
}
```

`outputDir` 为空时只保存数据目录内的报告；填写专用绝对目录后，同时把每个日期的 Markdown 日志同步过去。本机已经同步到任务的 `outputs/douyin-daily-logs/`，用户可以直接打开。日期按北京时间划分，跨天创建新的日志，前一天的未完成总结继续补齐。

每个主题必须覆盖属于该模型的全部视频 ID，不能遗漏、重复或杜撰；格式无效或接口失败时保留逐条记录，后续再尝试生成总结。原始每日资料另存 `reports/YYYY-MM-DD.videos.json`，日常状态裁剪到最近 1000 条也不会删除这些归档。`reports/YYYY-MM-DD.summary.json` 保存模型总结及其来源版本，重启不重复消耗 API。

需要手动生成或重新总结时，先停止后台进程，再执行：

```bash
npm run stop
npm run journal
# 指定日期；只读取已存的该日记录：
node src/cli.mjs journal --day 2026-10-29
# 只有明确需要重算时才添加 --refresh：
node src/cli.mjs journal --day 2026-10-29 --refresh
npm run start:background
```

自动日志依赖正在运行的本机助手及 Mac 保持唤醒，没有额外注册系统定时任务。

## 双人配音视频晚报

用户已授权的本机版本每天提前制片，安排当晚 21:00 发布；当前 Codex 自动任务在北京时间 18:30 运行 `node scripts/evening.mjs --live --schedule`。抖音定时发布要求至少提前 2 小时，因此制作时间早于公开发布时间。视频及描述明确标注日志统计截止时间。Mac 和 Codex 需要保持运行。

白发角色为 GPT，蓝发角色为 DeepSeek；用户头像参考、透明角色图和生成提示词均位于 `assets/hosts/`。每条视频约一分钟，1080×1920，双人轮流配音、字幕和发言强调；当前不做逐字嘴型同步。两个模型只写自己当天观看内容的简短回顾，数量由程序填入。支持中文神经音色候选与 OpenAI Realtime。当前本机已按用户选择使用 GPT D、DeepSeek B；旧配置未选择候选时沿用 `gpt-realtime-2.1-mini` 的 coral / shimmer。配音服务返回的文字边界或转写须与台词相符才保存，失败时不自动换成其他音色。

音色候选来自用户指定聊天“生成角色配音视频”的实际配音配置，使用 [edge-tts](https://github.com/rany2/edge-tts) 的中文音色：

| 候选 | 音色 | 音高 | 语速 |
|---|---|---:|---:|
| A | 晓晓，参考白发角色 | +24Hz | +12% |
| B | 晓伊，参考蓝发角色 | -3Hz | +8% |
| C | 晓晓，原声 | +0Hz | +0% |
| D | 晓伊，原声 | +0Hz | +0% |

可以分别混搭，当前 `video.voiceProfiles` 为 `{ "openai": "D", "deepseek": "B" }`。这里的 openai / deepseek 表示画面中的角色，音色候选的 TTS 服务为 Edge，并不改变角色台词的生成模型。试听在本机任务的 `outputs/douyin-videos/voice-samples/`。新增或改变音色、音高、语速都会改变音轨缓存键，避免误用旧音频。

`node scripts/revoice.mjs` 读取当前音色配置，用已生成晚报的同一份台词制作独立换声预览，不改动远端作品或已定时日账。`node scripts/evening.mjs --live --ready-only` 仅提交已经完成的同日成片，并核对成片音色和当前选择一致；用于已获用户授权的单次替换任务，不重新生成日志或台词。

视频只汇总公开日志和已在评论区回读成功的互动，不包含私信、联系人或登录信息。视频、描述和抖音自主声明均标记 AI 角色与合成配音。平台审核状态与提交成功分开记录。

首次部署视频依赖：

```bash
python3 -m venv .data/video-venv
.data/video-venv/bin/python -m pip install -r requirements-video.txt
```

将 `config.json` 的 `video.enabled` 设为 `true`，`video.python` 设为这个虚拟环境 Python 的绝对路径，`video.outputDir` 设为专用视频目录。本机已经配置完成。默认发布包关闭此功能；本机任务已按用户授权启用。

```bash
# 手动只做成片，先停止后台以取得同一运行锁：
npm run stop
node src/cli.mjs video-build
npm run start:background

# 已授权的每日入口，会自动恢复原先运行的后台：
node scripts/evening.mjs --live --schedule
```

入口按北京时间取当天记录，先检查视频日账。同一天已有 `scheduled`、`submitted` 或 `published` 时直接返回，结果为 `publishing` 或 `uncertain` 时禁止自动重发。生成中断时可复用已有台词和音轨；只在实际进入提交前记为 `publishing`。通过创作者中心正常上传、填写标题及描述、选择“内容由AI生成”和定时发布，随后从作品管理回读。遇到验证、稿件冲突或发布限制时保留文件和状态，不覆盖其他稿件，不自动过验证。

本机第一条视频原已安排为 2026-10-29 21:00；用户随后选择 GPT D / DeepSeek B，已生成同台词换声版并移除旧定时作品。因为平台已不允许在该时间前两小时内重新定时，当前已安排今晚 21:00 的一次性本机提交任务。后续每日仍提前制片并定时发布。成片、台词及定时回读图保存在任务 `outputs/douyin-videos/`；后续状态保存在数据目录 `video/YYYY-MM-DD/episode.json`。

## 记录与结果核对

```bash
npm run status
node src/cli.mjs outbox
```

数据默认保存在项目 `.data/`，可用 `DOUYIN_GPT_HOME` 改成另一个专用绝对路径：

| 路径 | 内容 |
|---|---|
| `config.json` | 账号绑定、联系人、两个模型的开关与配额，不含 API 密钥 |
| `openai.json` / `deepseek.json` | 可选本机 API 凭证，独立保存，不随源码发布 |
| `browser/` | 专用浏览器登录态 |
| `state.json` | 消息去重、上下文、发送记录、观看记录 |
| `comments.json` | 公开评论去重、互动通知基线、模型归属、评论与回复发送记录 |
| `reports/日期.md` | 视频日报 |
| `reports/日期.videos.json` | 该日公开视频源记录，独立归档 |
| `reports/日期.summary.json` | 两个模型的综合总结、来源版本及刷新时间 |
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

自动化测试覆盖私信与评论去重、重启恢复、配额与冷却、通知基线、楼根和回复对象、背景页面与通知弹层、停止信号、发送方识别、两个模型的 Responses API 请求结构、独立计数、原模型回复归属和凭证隔离。日志另测完整视频归类、跨天、独立模型输入、重启缓存、失败保留原始记录、刷新间隔、镜像一致与长期归档。自动化 API 测试使用假服务，不会消耗真实 API 额度。

## 当前边界

- 当前 Mac 已实测账号、私信、视频浏览及 GPT-6.1 Terra 的文本和图像调用；并已实际发出 1 条公开评论、对用户的新留言发出 1 条楼中楼回复，均已回读。抖音可能改变接口或页面，失败时会显示错误。详细测试范围见 `VERIFICATION.md`。
- 主动浏览来源仍是推荐流，不做关键词搜索，不自动点赞、收藏或主动群发。公开评论受 `engagement` 开关和配额控制。
- 判断主要来自文案和抽样画面，没有音频转写，不声称完整理解视频。语音消息、图片私信等非文字内容没有单独识别链路。
- 自动回复需要能提取稳定消息 ID、确认消息发送方和联系人 ID；无法确认时不发送。会话列表虚拟化也可能使较远的联系人暂时无法定位。
- 私信正文及该联系人的近期历史发送给本轮规则选中的模型；视频文案与截图、相关公开评论发送给处理这条视频或留言的模型。浏览器登录态不会作为模型输入，公开评论请求不包含私信历史。`.env` 与 `.data/` 不应提交或分享。
- 使用抖音网页版自动化，登录、验证和账号限制由平台决定。遇到验证或账号不一致应回浏览器处理，程序没有绕过验证的实现。

## API 文档与参考代码

Responses API 的结构化输出与图像输入分别按 [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) 和 [Images and vision](https://developers.openai.com/api/docs/guides/images-vision) 实现。默认模型能力见 [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra)。模型可用性以你的 API 账户为准。

DeepSeek 依据官方 [Responses API](https://api-docs.deepseek.com/api/create-response/) 和 [Vision](https://api-docs.deepseek.com/guides/vision/) 接入 `deepseek-flash`，使用其原生图片输入与 JSON schema，不把视频图片转交 GPT 代看。

两个抖音参考项目的使用范围、提交和许可证见 `NOTICE.md`。
