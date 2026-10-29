import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, validateConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { DailyJournal, journalDay, validateDailySummary } from '../src/journal.mjs';
import { Gpt } from '../src/openai.mjs';

const V = '7400000000000000001', V2 = '7400000000000000002', V3 = '7400000000000000003';
const analysis = { summary: '展示钩织的小动物挂件', evidence: '抽样画面可见毛线造型', recommend: false, confidence: 0.8 };
const video = (id, provider = 'openai', day = '2026-10-29') => ({ id, desc: '毛线小动物', author: '测试作者', provider, model: provider === 'openai' ? 'gpt-6.1-terra' : 'deepseek-flash', day, watchedAt: `${day}T10:00:00Z`, analysis });
const summary = videos => ({ overview: `今天记录了 ${videos.length} 条视频，主要展示手工造型。\n\n只依据抽样画面整理。`, themes: [{ title: '手工造型', summary: '画面可见钩织挂件。', videoIds: videos.map(v => v.id) }], highlights: [{ videoId: videos[0].id, reason: '有具体造型可回看' }], reflections: ['可继续观察制作细节。'], limitations: ['没有音频转写，也未完整看完。'] });
function harness(t) {
  const home = mkdtempSync(join(tmpdir(), 'dy-journal-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const cfg = defaultConfig(); cfg.deepseek.enabled = true; cfg.journal.outputDir = join(home, 'export');
  const store = new Store(home); store.data.videos = [video(V), video(V2, 'deepseek')];
  store.data.outbox = [{ text: 'SECRET_PRIVATE_MESSAGE' }]; store.data.contacts = { SECRET_CONTACT: {} };
  const state = { now: new Date('2026-10-29T10:00:00Z'), calls: [], logs: [] };
  const models = Object.fromEntries(['openai', 'deepseek'].map(provider => [provider, {
    config: { model: provider === 'openai' ? 'gpt-6.1-terra' : 'deepseek-flash' },
    dailySummary: async input => { state.calls.push({ provider, ...input }); return summary(input.videos); },
  }]));
  const ledger = { data: { actions: [{ id: 'comment', day: '2026-10-29', kind: 'comment', provider: 'deepseek', status: 'sent', text: 'SECRET_COMMENT_BODY_NOT_NEEDED' }] } };
  const journal = new DailyJournal({ home, cfg, store, models, ledger, now: () => state.now, log: line => state.logs.push(line) });
  return { home, cfg, store, state, models, ledger, journal, file: day => join(home, 'reports', `${day}.md`) };
}

test('日志配置兼容旧配置，拒绝相对输出路径和无效刷新间隔', () => {
  const cfg = defaultConfig(); delete cfg.journal; validateConfig(cfg); assert.equal(cfg.journal.enabled, true);
  cfg.journal.outputDir = '../escape'; assert.throws(() => validateConfig(cfg), /绝对路径/);
  cfg.journal.outputDir = ''; cfg.journal.refreshMinutes = 0; assert.throws(() => validateConfig(cfg), /refreshMinutes/);
});
test('日志日期不能穿越路径，也不接受不存在的日期', () => {
  assert.equal(journalDay('2026-10-29'), '2026-10-29');
  for (const value of ['../config', '2026-02-30', '2026-13-01', '2026-1-1']) assert.throws(() => journalDay(value));
});
test('每个模型只总结自己的视频；原始日志完整，公开互动只记计数，镜像字节一致', async t => {
  const h = harness(t); await h.journal.refresh();
  assert.deepEqual(h.state.calls.map(c => [c.provider, c.videos.map(v => v.id)]), [['openai', [V]], ['deepseek', [V2]]]);
  const text = readFileSync(h.file('2026-10-29'), 'utf8');
  assert.match(text, /GPT 当日总结/); assert.match(text, /DeepSeek 当日总结/);
  assert.equal((text.match(/^### \d+\./gm) || []).length, 2);
  assert.match(text, /https:\/\/www.douyin.com\/video\/7400000000000000001/);
  assert.match(text, /\| DeepSeek \| 1 \| 5 \| 1 \| 0 \|/);
  assert.doesNotMatch(text + JSON.stringify(h.state.calls), /SECRET_PRIVATE_MESSAGE|SECRET_CONTACT|SECRET_COMMENT_BODY_NOT_NEEDED/);
  assert.equal(text, readFileSync(join(h.cfg.journal.outputDir, '2026-10-29.md'), 'utf8'));
  assert.equal(statSync(h.file('2026-10-29')).mode & 0o777, 0o600);
});
test('已总结的内容重启后复用缓存，不重复调用模型', async t => {
  const h = harness(t); await h.journal.refresh();
  const restarted = new DailyJournal({ home: h.home, cfg: h.cfg, store: h.store, models: h.models, ledger: h.ledger, now: () => h.state.now });
  await restarted.refresh(); assert.equal(h.state.calls.length, 2);
});
test('新增视频立即入逐条日志；综合总结在刷新间隔后更新，另一模型不重算', async t => {
  const h = harness(t); await h.journal.refresh();
  h.store.data.videos.push(video(V3)); await h.journal.refresh();
  assert.equal(h.state.calls.length, 2);
  assert.match(readFileSync(h.file('2026-10-29'), 'utf8'), /覆盖 1\/2 条/);
  assert.equal((readFileSync(h.file('2026-10-29'), 'utf8').match(/^### \d+\./gm) || []).length, 3);
  h.state.now = new Date('2026-10-29T10:31:00Z'); await h.journal.refresh();
  assert.equal(h.state.calls.length, 3); assert.equal(h.state.calls.at(-1).provider, 'openai');
  assert.doesNotMatch(readFileSync(h.file('2026-10-29'), 'utf8'), /覆盖 1\/2 条/);
});
test('北京时间跨天会新建文件，并保留前一天完整记录及缓存', async t => {
  const h = harness(t); h.state.now = new Date('2026-10-29T15:59:00Z'); await h.journal.tick();
  const previous = readFileSync(h.file('2026-10-29'), 'utf8');
  h.state.now = new Date('2026-10-29T16:01:00Z'); h.store.data.videos.push(video(V3, 'deepseek', '2026-10-30'));
  await h.journal.tick();
  assert.equal(readFileSync(h.file('2026-10-29'), 'utf8'), previous);
  const next = readFileSync(h.file('2026-10-30'), 'utf8');
  assert.match(next, /全部 1 条/); assert.match(next, new RegExp(V3)); assert.doesNotMatch(next, new RegExp(V2));
});
test('一个模型总结失败不妨碍另一模型和原始日志；失败不在每次轮询时重试', async t => {
  const h = harness(t); h.models.openai.dailySummary = async () => { h.state.calls.push({ provider: 'openai' }); throw new Error('HTTP 429'); };
  await h.journal.refresh(); await h.journal.refresh();
  assert.equal(h.state.calls.length, 2); assert.equal(h.state.logs.filter(s => s.includes('429')).length, 1);
  const text = readFileSync(h.file('2026-10-29'), 'utf8');
  assert.match(text, /综合总结待生成/); assert.match(text, /今天记录了 1 条视频/);
  assert.equal((text.match(/^### \d+\./gm) || []).length, 2);
});
test('损坏的总结缓存能重建，原始观看记录不变', async t => {
  const h = harness(t), before = JSON.stringify(h.store.data);
  writeFileSync(join(h.home, 'reports', '2026-10-29.summary.json'), '{broken');
  await h.journal.refresh(); assert.equal(h.state.calls.length, 2); assert.equal(JSON.stringify(h.store.data), before);
});
test('运行状态裁剪后，每日源记录仍可完整回看和重新生成，且不重算已有总结', async t => {
  const h = harness(t); await h.journal.refresh(); h.store.data.videos = [];
  const archived = new DailyJournal({home:h.home,cfg:h.cfg,store:h.store,models:h.models,now:()=>h.state.now});
  await archived.refresh();
  assert.equal(h.state.calls.length, 2);
  assert.equal((readFileSync(h.file('2026-10-29'),'utf8').match(/^### \d+\./gm)||[]).length,2);
  const source = readFileSync(join(h.home,'reports','2026-10-29.videos.json'),'utf8');
  assert.doesNotMatch(source,/SECRET_PRIVATE_MESSAGE|SECRET_CONTACT/);
});
test('源记录损坏时保留已生成的日志，不用空数据覆盖归档', async t => {
  const h=harness(t);await h.journal.refresh();const before=readFileSync(h.file('2026-10-29'),'utf8');
  writeFileSync(join(h.home,'reports','2026-10-29.videos.json'),'{broken');
  assert.throws(()=>h.journal.writeSnapshot(),/源记录损坏/);
  assert.equal(readFileSync(h.file('2026-10-29'),'utf8'),before);
});
test('不能遗漏、重复归类或编造视频 ID；无效总结不会成为有效缓存', () => {
  const videos = [video(V), video(V2)], valid = summary(videos);
  validateDailySummary(valid, videos);
  for (const ids of [[V], [V, V], [V, 'made-up']]) {
    assert.throws(() => validateDailySummary({ ...valid, themes: [{ ...valid.themes[0], videoIds: ids }] }, videos));
  }
  assert.throws(() => validateDailySummary({ ...valid, highlights: [{ videoId: 'missing', reason: '无依据' }] }, videos));
});
test('停止信号或关闭日志时不调用模型；零视频日期也有明确记录', async t => {
  const h = harness(t), controller = new AbortController(); controller.abort();
  await h.journal.refresh({ signal: controller.signal }); assert.equal(h.state.calls.length, 0);
  h.store.data.videos = []; await h.journal.refresh({ day: '2026-10-30' });
  assert.match(readFileSync(h.file('2026-10-30'), 'utf8'), /今天尚无观看记录/);
  h.cfg.journal.enabled = false;
  const disabled = new DailyJournal({ home: h.home, cfg: h.cfg, store: h.store, models: h.models });
  assert.equal(await disabled.refresh({ day: '2026-11-01' }), null); assert.equal(existsSync(h.file('2026-11-01')), false);
});
test('每日总结的真实请求结构只含公开视频资料，不含私信人设或多余字段', async () => {
  let received;
  const model = new Gpt({ apiKey: 'FAKE_KEY', model: 'deepseek-flash', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' }, { fetchImpl: async (_url, options) => {
    received = JSON.parse(options.body);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(summary([video(V)])) }] }] }));
  } });
  model.persona = 'PRIVATE_PERSONA';
  await model.dailySummary({ day: '2026-10-29', videos: [{ ...video(V), privateToken: 'DO_NOT_SEND' }] });
  assert.equal(received.text.format.name, 'daily_video_journal'); assert.equal(received.text.format.strict, true);
  assert.equal(received.max_output_tokens, 6000); assert.equal(received.tools, undefined);
  assert.match(received.instructions, /DeepSeek/); assert.doesNotMatch(JSON.stringify(received), /PRIVATE_PERSONA|DO_NOT_SEND/);
  assert.deepEqual(JSON.parse(received.input[0].content[0].text).videos.map(v => v.id), [V]);
  model.fetch = async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ...summary([video(V)]), themes: ['not-an-object'] }) }] }] }));
  await assert.rejects(model.dailySummary({ day: '2026-10-29', videos: [video(V)] }), /类型无效/);
});
