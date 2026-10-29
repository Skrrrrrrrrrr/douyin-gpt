# 来源与署名

本项目是独立运行的 GPT 助手，不依赖 DSH。

- `vendor/newjo/im-send.mjs` 源自 [NEWJO123/dsh-douyin-scroll](https://github.com/NEWJO123/dsh-douyin-scroll)，固定来源提交 `7c6e2a2ff3443eee89c4935c1304df5822b40e65`，MIT，版权为 2026 dsh-douyin-scroll contributors。完整许可证在 `vendor/newjo/LICENSE`。
- 该适配器已修改：连接本程序的专用浏览器标签；输出稳定消息 ID；强制以稳定账号 ID 操作；发送前再次核对可见会话账号和消息快照；拒绝拼接已有草稿；校验完整正文；用精确正文回读；允许导出函数做离线测试。保留了上游的会话匹配、头像位置判定和页面点击实现。
- 同源读取、CDP 抽帧的方案参考 [Xia28zhi/dsh-douyin-scroll](https://github.com/Xia28zhi/dsh-douyin-scroll)，来源提交 `eb28978092307ae7df8ff4a5e4af116dac049937`，MIT，Copyright (c) 2026 Xia28zhi。本项目的数据与抽帧模块独立编写。
- 两个参考项目都采用了 DSH 插件的相关工程思路；Xia 项目另在其 NOTICE 中署名 `c1overzz/dsh-bili-scroll`。本项目未引入该项目源码。

Xia28zhi 项目的 MIT 许可原文：

Copyright (c) 2026 Xia28zhi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
