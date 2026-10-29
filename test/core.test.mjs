import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, validateConfig, dayKey } from '../src/config.mjs';
import { Store, takeLock } from '../src/store.mjs';
import { Engine, unanswered } from '../src/engine.mjs';
import { StopRequired, normalizeVideo } from '../src/douyin.mjs';

const contact = { secUid: 'MS4wLjABAAAA_TEST_CONTACT', label: '测试联系人', enabled: true };
const old = { id: 'old', from: 'them', text: '旧消息' };
function harness(t, { baseline = true, live = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dy-gpt-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cfg = defaultConfig();
  cfg.reply.contacts = [structuredClone(contact)];
  cfg.browse.enabled = false;
  cfg.account.secUid = 'MS4wLjABAAAA_TEST_OWNER';
  const store = new Store(home);
  if (baseline) store.baseline(contact.secUid, [old]);
  const state = { messages: [old, { id: 'new', from: 'them', text: '在吗' }], sends: [], calls: 0, reads: 0 };
  const messenger = {
    read: async () => { state.reads++; return structuredClone(state.messages); },
    send: async (c, text) => { state.sends.push({ id: c.secUid, text }); state.messages.push({ id: 'mine-' + state.sends.length, from: 'me', text }); },
  };
  const gpt = {
    reply: async () => { state.calls++; return { shouldReply: true, text: '在的，怎么啦？', reason: '回应新消息' }; },
    analyze: async () => ({ summary: '视频记录', evidence: '画面文字', recommend: true, confidence: 0.8 }),
  };
  const dy = { checkAccount: async () => ({}), feed: async () => [], watch: async () => [] };
  const engine = new Engine({ home, cfg, store, gpt, dy, messenger, live, log: () => {} });
  return { home, cfg, store, state, messenger, gpt, dy, engine };
}

test('默认配置有效；拒绝昵称代替稳定 ID、零轮询和小数配额', () => {
  validateConfig(defaultConfig());
  const c = defaultConfig();
  c.reply.contacts = [{ secUid: '朋友', label: '朋友', enabled: true }];
  assert.throws(() => validateConfig(c), /secUid/);
  const c2 = defaultConfig(); c2.reply.pollSeconds = 0;
  assert.throws(() => validateConfig(c2));
  c2.reply.pollSeconds = 15; c2.browse.framesPerVideo = 1.5;
  assert.throws(() => validateConfig(c2));
});
test('配额日期按北京时间跨天', () => {
  assert.equal(dayKey(new Date('2026-10-29T16:01:00Z')), '2026-10-30');
});
test('首次运行只建立消息基线，不回复已有消息', async t => {
  const h = harness(t, { baseline: false });
  await h.engine.pollReplies();
  assert.equal(h.state.sends.length, 0);
  assert.equal(h.state.calls, 0);
  assert.deepEqual(h.store.contact(contact.secUid).seen, ['old', 'new']);
});
test('新消息发送一次；重启且页面没有本人回显也不会再发', async t => {
  const h = harness(t);
  await h.engine.pollReplies();
  assert.equal(h.state.sends.length, 1);
  assert.equal(h.store.data.outbox[0].status, 'sent');
  h.state.messages = [old, { id: 'new', from: 'them', text: '在吗' }];
  h.engine.store = new Store(h.home);
  await h.engine.pollReplies();
  assert.equal(h.state.sends.length, 1);
});
test('不同消息 ID 的相同文字会分别回复', async t => {
  const h = harness(t);
  await h.engine.pollReplies();
  h.state.messages.push({ id: 'new-2', from: 'them', text: '在吗' });
  await h.engine.pollReplies();
  assert.equal(h.state.sends.length, 2);
});
test('未知发送方、没有消息 ID 和已被主人回复的消息不自动回复', () => {
  assert.deepEqual(unanswered([{ id: 'x', from: 'them', text: '你好' }, { id: 'y', from: 'unknown', text: '未知' }]), []);
  assert.deepEqual(unanswered([{ from: 'them', text: '没有 ID' }]), []);
  assert.deepEqual(unanswered([{ id: 'x', from: 'them', text: '你好' }, { id: 'y', from: 'me', text: '已回' }]), []);
});
test('不读取或回复名单外联系人', async t => {
  const h = harness(t);
  await h.engine.replyTo({ ...contact, secUid: 'MS4wLjABAAAA_STRANGER' });
  assert.equal(h.state.reads, 0);
  assert.equal(h.state.sends.length, 0);
});
test('禁用联系人不会读取会话', async t => {
  const h = harness(t);
  h.cfg.reply.contacts[0].enabled = false;
  await h.engine.pollReplies();
  assert.equal(h.state.reads, 0);
});
test('每日配额为零时不调用 GPT 或发消息', async t => {
  const h = harness(t);
  h.cfg.reply.perContactPerDay = 0;
  await h.engine.pollReplies();
  assert.equal(h.state.calls, 0);
  assert.equal(h.state.sends.length, 0);
});
test('发送前进程退出：恢复为 uncertain，阻止该联系人新回复并占用配额', async t => {
  const h = harness(t);
  const item = h.store.draft(contact, [h.state.messages[1]], '回复', '原因');
  h.store.transition(item, 'sending');
  h.engine.store = new Store(h.home);
  h.engine.store.recover();
  assert.equal(h.engine.store.data.outbox[0].status, 'uncertain');
  assert.equal(h.engine.store.quota(contact.secUid, h.cfg.reply), h.cfg.reply.perContactPerDay - 1);
  h.state.messages.push({ id: 'new-2', from: 'them', text: '还在吗' });
  await h.engine.pollReplies();
  assert.equal(h.state.sends.length, 0);
});
test('发送超时/失败后不自动重试', async t => {
  const h = harness(t);
  let attempts = 0;
  h.messenger.send = async () => { attempts++; throw new Error('回读超时'); };
  await h.engine.pollReplies();
  await h.engine.pollReplies();
  assert.equal(attempts, 1);
  assert.equal(h.store.data.outbox[0].status, 'uncertain');
});
test('生成回复时有新消息到达：旧回复作废，下轮处理新消息', async t => {
  const h = harness(t);
  const original = h.gpt.reply;
  h.gpt.reply = async () => {
    const result = await original();
    if (h.state.calls === 1) h.state.messages.push({ id: 'newer', from: 'them', text: '补充一下' });
    return result;
  };
  await h.engine.pollReplies();
  assert.equal(h.state.sends.length, 0);
  assert.equal(h.store.data.outbox[0].status, 'superseded');
  await h.engine.pollReplies();
  assert.equal(h.state.sends.length, 1);
});
test('主人在生成期间手动回复：取消 GPT 的旧回复', async t => {
  const h = harness(t);
  h.gpt.reply = async () => {
    h.state.messages.push({ id: 'manual', from: 'me', text: '我来回' });
    return { shouldReply: true, text: '过期回复', reason: '' };
  };
  await h.engine.pollReplies();
  assert.equal(h.state.sends.length, 0);
  assert.equal(h.store.data.outbox[0].status, 'superseded');
});
test('账号不一致时中止，不读取联系人', async t => {
  const h = harness(t);
  h.dy.checkAccount = async () => { throw new StopRequired('账号不一致'); };
  await assert.rejects(h.engine.pollReplies(), /账号不一致/);
  assert.equal(h.state.reads, 0);
});
test('停止信号到达后不再发送刚生成的回复', async t => {
  const h = harness(t);
  const controller = new AbortController();
  h.engine.signal = controller.signal;
  h.gpt.reply = async () => { controller.abort(); return { shouldReply: true, text: '不该发', reason: '' }; };
  await h.engine.pollReplies();
  assert.equal(h.state.sends.length, 0);
});
test('GPT 失败不消耗消息，恢复后可以正常回复', async t => {
  const h = harness(t);
  const original = h.gpt.reply;
  h.gpt.reply = async () => { throw new Error('HTTP 429'); };
  await h.engine.pollReplies();
  assert.equal(h.store.contact(contact.secUid).seen.includes('new'), false);
  h.gpt.reply = original;
  await h.engine.pollReplies();
  assert.equal(h.state.sends.length, 1);
});
test('GPT 判断不需要回复，只处理一次', async t => {
  const h = harness(t);
  h.gpt.reply = async () => { h.state.calls++; return { shouldReply: false, text: '', reason: '无需回复' }; };
  await h.engine.pollReplies(); await h.engine.pollReplies();
  assert.equal(h.state.calls, 1);
  assert.equal(h.state.sends.length, 0);
});
test('预览模式不发消息，也不消耗真实待回复输入', async t => {
  const h = harness(t, { live: false });
  await h.engine.pollReplies();
  assert.equal(h.state.sends.length, 0);
  assert.equal(h.engine.previews.length, 1);
  assert.equal(h.store.contact(contact.secUid).seen.includes('new'), false);
});
test('同一轮浏览中的多次轮询不会重复生成同一条预览', async t => {
  const h = harness(t, { live: false });
  await h.engine.pollReplies(); await h.engine.pollReplies();
  assert.equal(h.state.calls, 1);
});
test('落盘失败时不进入发送器', async t => {
  const h = harness(t);
  h.store.save = () => { throw new Error('磁盘写失败'); };
  await assert.rejects(h.engine.replyTo(contact), /磁盘写失败/);
  assert.equal(h.state.sends.length, 0);
});
test('同一数据目录不能同时运行两个进程', t => {
  const h = harness(t);
  const release = takeLock(h.home);
  assert.throws(() => takeLock(h.home), /已有程序/);
  release();
  const release2 = takeLock(h.home); release2();
});
test('损坏的消息状态不静默重置', t => {
  const h = harness(t);
  writeFileSync(join(h.home, 'state.json'), '{bad');
  assert.throws(() => new Store(h.home));
});
test('视频达到每日额度后不继续采集，报告包含真实本轮记录', async t => {
  const h = harness(t);
  h.cfg.browse.enabled = true; h.cfg.browse.videosPerDay = 1;
  let feeds = 0;
  h.dy.feed = async () => { feeds++; return [{ id: '7400000000000000001', desc: '测试视频', author: '测试作者', url: 'https://www.douyin.com/video/7400000000000000001' }]; };
  await h.engine.browseRound();
  await h.engine.browseRound();
  assert.equal(feeds, 1);
  assert.equal(h.store.videoCount(), 1);
  assert.match(readFileSync(join(h.home, 'reports', `${dayKey()}.md`), 'utf8'), /视频记录/);
});
test('视频 ID 保留为字符串，排除不合法链接', () => {
  const video = normalizeVideo({ aweme_id: '7400000000000000001', desc: '内容' });
  assert.equal(video.id, '7400000000000000001');
  assert.equal(normalizeVideo({ aweme_id: '../../file' }), null);
});
