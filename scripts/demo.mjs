// 演示只使用虚构联系人、视频和 GPT 替身，不开浏览器、不联网、不发私信。
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';

const home = mkdtempSync(join(tmpdir(), 'douyin-gpt-demo-'));
const cfg = defaultConfig();
const contact = { secUid: 'MS4wLjABAAAA_DEMO_CONTACT', label: '演示好友', enabled: true };
cfg.account.secUid = 'MS4wLjABAAAA_DEMO_OWNER';
cfg.reply.contacts = [contact];
let messages = [{ id: 'old-1', from: 'them', text: '这是启动前的旧消息' }];
let sends = 0;
const engine = new Engine({
  home, cfg, store: new Store(home), live: true,
  dy: { checkAccount: async () => ({}), feed: async () => [{ id: '7400000000000000001', desc: '用几行代码整理桌面文件', author: '演示作者', url: 'https://www.douyin.com/video/7400000000000000001' }], watch: async () => [] },
  gpt: {
    analyze: async () => ({ summary: '演示：一个文件整理脚本。', evidence: '演示替身，没有读取真实视频。', recommend: true, confidence: 0.8 }),
    reply: async () => ({ shouldReply: true, text: '刚看了一个文件整理脚本的思路，感觉挺适合你。', reason: '演示：结合浏览记录回复' }),
  },
  messenger: {
    read: async () => structuredClone(messages),
    send: async (_contact, text) => { sends++; console.log('【模拟发送】' + text); messages.push({ id: `mine-${sends}`, from: 'me', text }); },
  },
});
try {
  console.log('1. 启动：建立旧消息基线，不回复旧消息');
  await engine.pollReplies();
  console.log('2. 主动浏览：生成视频记录与日报');
  await engine.browseRound();
  console.log('3. 收到新消息：调用 GPT 替身，模拟回复');
  messages.push({ id: 'new-1', from: 'them', text: '今天刷到什么有意思的？' });
  await engine.pollReplies();
  console.log('4. 再次轮询：相同消息不重复回复');
  await engine.pollReplies();
  console.log(`完成：模拟发送 ${sends} 次；所有数据都是虚构的。`);
  if (sends !== 1) throw new Error('去重演示失败');
} finally { rmSync(home, { recursive: true, force: true }); }
