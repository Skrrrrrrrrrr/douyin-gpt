import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, validateConfig, providerBrowse, providerEngagement, modelConfig, dayKey } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { CommentStore } from '../src/comment-store.mjs';
import { Engine } from '../src/engine.mjs';
import { CommentAutomation } from '../src/comment-automation.mjs';
import { Gpt } from '../src/openai.mjs';
import { normalizeNotice } from '../src/comments.mjs';

const V = '7400000000000000001', ROOT = '7400000000000000002', CID = '7400000000000000003';
const video = { id: V, desc: '手工毛线挂件', author: '测试作者', url: `https://www.douyin.com/video/${V}` };
const analysis = { summary: '毛线小动物', evidence: '抽样画面', recommend: true, confidence: 0.9 };
const target = { id: CID, rootId: ROOT, authorSecUid: 'MS4wLjABAAAA_TEST_PEER', text: '在吗', createTime: 100 };
const event = { id: `31:${V}:${CID}`, type: 31, video, target, replyToId: ROOT, parentText: '挂件很可爱' };
const decision = { shouldPost: true, text: '这些小动物是怎么固定的？', reason: '具体提问', confidence: 0.9 };
function harness(t) {
  const home = mkdtempSync(join(tmpdir(), 'dy-providers-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cfg = defaultConfig();
  cfg.account.secUid = 'MS4wLjABAAAA_TEST_OWNER';
  cfg.reply.enabled = false;
  cfg.engagement.enabled = true;
  cfg.deepseek.enabled = cfg.deepseek.engagement.enabled = true;
  const state = { calls: { openai: [], deepseek: [] }, sends: [], events: [], context: [target], watches: [], feeds: [] };
  const models = Object.fromEntries(['openai', 'deepseek'].map(provider => [provider, {
    config: { model: provider === 'openai' ? 'gpt-6.1-terra' : 'deepseek-flash' },
    analyze: async (...args) => { state.calls[provider].push(['analyze', ...args]); return analysis; },
    publicComment: async input => { state.calls[provider].push(['comment', input]); return { ...decision, text: `${provider}：${decision.text}` }; },
    reply: async input => { state.calls[provider].push(['private', input]); return { shouldReply: false, text: '', reason: '' }; },
  }]));
  const store = new Store(home);
  const comments = {
    read: async () => state.context,
    notices: async () => state.events,
    send: async input => { state.sends.push(input); return { accepted: true, verified: true, id: String(7400000000000000100n + BigInt(state.sends.length)) }; },
  };
  const dy = {
    checkAccount: async () => ({}), detail: async () => video,
    feed: async input => { state.feeds.push(input); return Array.from({ length: 30 }, (_, i) => ({ ...video, id: String(7400000000000000200n + BigInt(i)) })).filter(v => !input.exclude.includes(v.id)).slice(0, input.limit); },
    watch: async v => { state.watches.push(v.id); return ['public-video-frame.png']; },
  };
  const service = new CommentAutomation({ home, cfg, gpt: models.openai, models, comments, dy, store, live: true, log: () => {} });
  const messenger = { read: async () => [{ id: 'new', from: 'them', text: '你好' }] };
  const engine = new Engine({ home, cfg, store, gpt: models.openai, models, dy, messenger, engagement: service, live: true, log: () => {} });
  return { home, cfg, state, models, store, comments, dy, service, engine };
}
function ownThread(h, provider = 'deepseek', id = ROOT) {
  const a = h.service.ledger.draft('comment', video, null, decision, { provider, model: h.models[provider].config.model });
  h.service.ledger.transition(a, 'sent', '', { accepted: true, verified: true, id });
  return a;
}

test('旧配置补齐关闭的 DeepSeek，不修改 GPT 和账号设置；独立配额必须为整数', () => {
  const cfg = defaultConfig(); delete cfg.deepseek;
  cfg.browse.videosPerDay = 15; cfg.engagement.commentsPerDay = 5; cfg.engagement.repliesPerDay = 20;
  validateConfig(cfg);
  assert.equal(cfg.deepseek.enabled, false);
  assert.deepEqual([cfg.browse.videosPerDay, cfg.engagement.commentsPerDay, cfg.engagement.repliesPerDay], [15, 5, 20]);
  assert.deepEqual([cfg.deepseek.browse.videosPerDay, cfg.deepseek.engagement.commentsPerDay, cfg.deepseek.engagement.repliesPerDay], [5, 5, 10]);
  cfg.deepseek.browse.videosPerDay = 1.5; assert.throws(() => validateConfig(cfg), /deepseek.browse/);
  cfg.deepseek.browse.videosPerDay = 5; cfg.deepseek.engagement.repliesPerDay = -1;
  assert.throws(() => validateConfig(cfg), /deepseek.engagement/);
});
test('DeepSeek 使用自己的密钥和模型，不借用 OpenAI；坏 JSON 错误不泄露原文', t => {
  const home = mkdtempSync(join(tmpdir(), 'dy-key-config-'));
  const keys = ['DOUYIN_GPT_HOME', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } rmSync(home, { recursive: true, force: true }); });
  process.env.DOUYIN_GPT_HOME = home; process.env.OPENAI_API_KEY = 'GPT_ONLY'; delete process.env.DEEPSEEK_API_KEY;
  assert.equal(modelConfig('deepseek').apiKey, '');
  writeFileSync(join(home, 'deepseek.json'), JSON.stringify({ apiKey: 'DS_ONLY', model: 'deepseek-flash' }));
  assert.equal(modelConfig('deepseek').apiKey, 'DS_ONLY'); assert.equal(modelConfig().apiKey, 'GPT_ONLY');
  writeFileSync(join(home, 'deepseek.json'), '{"apiKey":"DO_NOT_LEAK"');
  assert.throws(() => modelConfig('deepseek'), e => e.message.includes('deepseek.json') && !e.message.includes('DO_NOT_LEAK'));
});
test('GPT 旧观看记录仍占 GPT 配额，DeepSeek 可独立浏览 5 条并在重启后保留计数', async t => {
  const h = harness(t); h.cfg.engagement.enabled = h.cfg.deepseek.engagement.enabled = false;
  for (let i = 0; i < 15; i++) h.store.data.videos.push({ ...video, id: `legacy-${i}`, day: dayKey(), analysis });
  h.store.save();
  await h.engine.browseRound(undefined, 'openai'); assert.equal(h.state.feeds.length, 0);
  for (let i = 0; i < 7; i++) await h.engine.browseRound(undefined, 'deepseek');
  assert.equal(h.state.watches.length, 5);
  assert.equal(h.models.deepseek.config.model, h.store.data.videos.at(-1).model);
  const restarted = new Store(h.home);
  assert.equal(restarted.videoCount(dayKey(), 'deepseek'), 5); assert.equal(restarted.videoCount(), 15);
  assert.equal(restarted.videoCount('2026-10-30', 'deepseek'), 0);
  assert.equal(h.state.calls.openai.length, 0); assert.equal(h.state.calls.deepseek.length, 5);
  assert.equal(new Set(h.state.watches).size, 5);
  assert.ok(restarted.lastBrowseAt('deepseek')); assert.equal(restarted.lastBrowseAt(), 0);
  assert.match(readFileSync(join(h.home, 'reports', `${dayKey()}.md`), 'utf8'), /deepseek-flash/);
});
test('DeepSeek 禁用时完全不采集或调用；GPT 的近期视频不包含 DeepSeek 上下文', async t => {
  const h = harness(t); h.cfg.deepseek.enabled = false;
  await h.engine.browseRound(undefined, 'deepseek'); assert.equal(h.state.feeds.length, 0);
  h.store.addVideo(video, analysis, { provider: 'deepseek' });
  assert.equal(h.store.recentVideos().length, 0); assert.equal(h.store.recentVideos('deepseek').length, 1);
});
test('两个模型共用同一视频评论的去重键和冷却，计数则各自独立', async t => {
  const h = harness(t);
  await h.service.onVideo(video, analysis, undefined, 'deepseek');
  await h.service.onVideo(video, analysis, undefined, 'openai');
  await h.service.onVideo({ ...video, id: '7400000000000000008' }, analysis, undefined, 'openai');
  assert.equal(h.state.sends.length, 1); assert.equal(h.state.calls.openai.length, 0);
  const ledger = new CommentStore(h.home);
  assert.equal(ledger.count('comment', dayKey(), 'deepseek'), 1); assert.equal(ledger.count('comment', dayKey(), 'openai'), 0);
  assert.equal(ledger.data.actions[0].model, 'deepseek-flash');
});
test('DeepSeek 每天最多 5 条主动评论、10 条评论回复，不消耗 GPT 的 5/20 配额', async t => {
  const h = harness(t);
  for (let i = 0; i < 7; i++) await h.service.submit('comment', { ...video, id: `v${i}` }, null, decision, 'deepseek');
  for (let i = 0; i < 12; i++) await h.service.submit('reply', video, { ...target, id: `t${i}` }, decision, 'deepseek');
  assert.equal(h.state.sends.length, 15);
  assert.equal(h.service.ledger.quota('comment', providerEngagement(h.cfg, 'deepseek'), 'deepseek'), 0);
  assert.equal(h.service.ledger.quota('reply', providerEngagement(h.cfg, 'deepseek'), 'deepseek'), 0);
  assert.equal(h.service.ledger.quota('comment', h.cfg.engagement), 5);
  assert.equal(h.service.ledger.quota('reply', h.cfg.engagement), 20);
  const restarted = new CommentStore(h.home);
  assert.equal(restarted.count('reply', dayKey(), 'deepseek'), 10);
  assert.equal(restarted.count('reply', '2026-10-30', 'deepseek'), 0);
});
test('用户回复 DeepSeek 的评论由 DeepSeek 回答，跨模型去重在重启后仍有效', async t => {
  const h = harness(t); ownThread(h); h.service.ledger.baseline([]); h.state.events = [event];
  await h.service.poll(undefined, { force: true });
  h.service.ledger = new CommentStore(h.home); await h.service.poll(undefined, { force: true });
  assert.equal(h.state.sends.length, 1); assert.equal(h.state.calls.deepseek.length, 1); assert.equal(h.state.calls.openai.length, 0);
  const a = h.service.ledger.data.actions.at(-1); assert.equal(a.provider, 'deepseek'); assert.equal(a.targetId, CID); assert.equal(a.rootId, ROOT);
});
test('旧的 GPT 评论记录无需重写，仍由 GPT 回复；精确被回复评论优先于楼根', async t => {
  const h = harness(t), a = ownThread(h, 'openai'); delete a.provider; h.service.ledger.save();
  h.service.ledger.baseline([]); h.state.events = [event]; await h.service.poll(undefined, { force: true });
  assert.equal(h.state.calls.openai.length, 1); assert.equal(h.state.calls.deepseek.length, 0);
  const child = h.service.ledger.draft('reply', video, { ...target, id: 'child-input' }, decision, { provider: 'deepseek' });
  h.service.ledger.transition(child, 'sent', '', { id: 'child-receipt' });
  assert.equal(h.service.owner({ ...event, replyToId: 'child-receipt' }), 'deepseek');
});
test('DeepSeek 配额耗尽后保留它的新留言，同时继续处理后面的 GPT 留言', async t => {
  const h = harness(t); ownThread(h); h.cfg.deepseek.engagement.repliesPerDay = 0;
  h.service.ledger.baseline([]);
  const gptEvent = { ...event, id: 'gpt-event', target: { ...target, id: 'gpt-target', rootId: 'gpt-root' }, replyToId: 'gpt-root' };
  h.state.events = [event, gptEvent]; h.state.context = [target, gptEvent.target];
  await h.service.poll(undefined, { force: true });
  assert.equal(h.state.calls.deepseek.length, 0); assert.equal(h.state.calls.openai.length, 1);
  assert.equal(h.service.ledger.data.seen.includes(event.id), false);
});
test('DeepSeek 请求失败时不改由 GPT 回答，且不吞掉待回复通知', async t => {
  const h = harness(t); ownThread(h); h.service.ledger.baseline([]); h.state.events = [event];
  h.models.deepseek.publicComment = async () => { throw new Error('DeepSeek HTTP 429'); };
  await h.service.poll(undefined, { force: true });
  assert.equal(h.state.sends.length, 0); assert.equal(h.state.calls.openai.length, 0); assert.equal(h.service.ledger.data.seen.includes(event.id), false);
});
test('未知楼根的 @ 通知先解析真实页面，再交给原模型；不受 GPT 零配额误拦', async t => {
  const h = harness(t); ownThread(h); h.cfg.engagement.repliesPerDay = 0; h.service.ledger.baseline([]);
  h.state.events = [{ ...event, type: 45, replyToId: '', target: { ...target, rootId: '', text: '' } }];
  await h.service.poll(undefined, { force: true });
  assert.equal(h.state.calls.deepseek.length, 1); assert.equal(h.state.sends.length, 1);
});
test('私信仍只交给 GPT，DeepSeek 不会接收名单、私信内容或人设', async t => {
  const h = harness(t); h.cfg.reply.enabled = true;
  const contact = { secUid: 'MS4wLjABAAAA_TEST_PEER', label: '好友', enabled: true };
  h.cfg.reply.contacts = [contact]; h.store.baseline(contact.secUid, [{ id: 'old', from: 'them', text: '旧消息' }]);
  await h.engine.pollReplies();
  assert.equal(h.state.calls.openai[0][0], 'private'); assert.equal(h.state.calls.deepseek.length, 0);
});
test('DeepSeek 通过独立 Responses 接口收图片和严格 schema，身份与错误标签正确', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dy-ds-api-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const png = join(home, 'frame.png'); writeFileSync(png, Buffer.from([137, 80, 78, 71]));
  let received;
  const model = new Gpt({ apiKey: 'DS_TEST_SECRET', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', label: 'DeepSeek', envPrefix: 'DEEPSEEK' }, { fetchImpl: async (url, options) => {
    received = { url, ...options, body: JSON.parse(options.body) };
    const value = received.body.text.format.name === 'video_review' ? analysis : decision;
    return new Response(JSON.stringify({ status: 'completed', model: 'deepseek-flash', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }));
  } });
  await model.analyze(video, [png]);
  assert.equal(received.url, 'https://api.deepseek.com/responses'); assert.equal(received.headers.authorization, 'Bearer DS_TEST_SECRET');
  assert.equal(received.body.model, 'deepseek-flash'); assert.equal(received.body.reasoning.effort, 'low');
  assert.match(received.body.input[0].content[1].image_url, /^data:image\/png;base64,/);
  model.persona = 'PRIVATE_PERSONA_DO_NOT_SEND'; await model.publicComment({ video, analysis });
  assert.match(received.body.instructions, /DeepSeek 助手/); assert.doesNotMatch(JSON.stringify(received.body), /PRIVATE_PERSONA_DO_NOT_SEND/);
  model.fetch = async () => new Response('DS_TEST_SECRET', { status: 401 });
  await assert.rejects(model.analyze(video, []), e => e.message.includes('DeepSeek') && !e.message.includes('DS_TEST_SECRET'));
});
test('通知归属保留精确被回复 CID，避免楼中楼串模型', () => {
  const notice = normalizeNotice({ type: 31, comment: { aweme_id: V, parent_id: ROOT, comment: { cid: CID, text: target.text, user: { sec_uid: target.authorSecUid } }, reply_comment: { cid: '7400000000000000099', user: { sec_uid: 'owner' } } } }, { secUid: 'owner' });
  assert.equal(notice.replyToId, '7400000000000000099'); assert.equal(notice.target.rootId, ROOT);
});
