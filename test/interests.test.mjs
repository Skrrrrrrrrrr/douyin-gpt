import {loginDashboard} from './helpers/dashboard-login.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConfig, validateConfig, providerBrowse, dayKey} from '../src/config.mjs';
import {DEFAULT_INTEREST_PROFILES, validateInterestProfiles, validTopic} from '../src/interest-profiles.mjs';
import {Interests} from '../src/interests.mjs';
import {Engine} from '../src/engine.mjs';
import {Store, atomicJson} from '../src/store.mjs';
import {StopRequired} from '../src/douyin.mjs';
import {Gpt} from '../src/openai.mjs';
import {applyDashboardPatch, createDashboard} from '../src/dashboard.mjs';
import {journalVideoInput} from '../src/journal.mjs';
import {interestProfilesPanel, interestProfilePatch, videoInterestPanel} from '../web/features.js';

const id = number => String(7700000000000000000n + BigInt(number));
const video = (number = 1) => ({id: id(number), desc: '画面里正在烤鱼', author: '公开视频作者', url: `https://www.douyin.com/video/${id(number)}`});
const review = (topics = ['烤鱼'], score = 2) => ({summary: '厨师把烤鱼装盘', evidence: '抽样画面中有烤盘和鱼', recommend: false, confidence: .9,
  interest: {score, topics, reason: '烤鱼的内容符合角色口味。'}});
function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'douyin-interests-'));
  t.after(() => rmSync(home, {recursive: true, force: true}));
  const cfg = defaultConfig();
  cfg.discovery = {enabled: true, topics: ['共同主题'], profiles: structuredClone(DEFAULT_INTEREST_PROFILES), fallbackToFeed: true};
  cfg.reply.enabled = false; cfg.journal.enabled = false; cfg.deepseek.enabled = true;
  validateConfig(cfg);
  const store = new Store(home), interests = new Interests(home, cfg);
  atomicJson(join(home, 'config.json'), cfg);
  return {home, cfg, store, interests};
}

test('两个角色有独立主题，浏览配额和频率保持原设置', t => {
  const {cfg, interests} = setup(t);
  assert.deepEqual(interests.topics('openai'), DEFAULT_INTEREST_PROFILES.openai.topics);
  assert.deepEqual(interests.topics('deepseek'), DEFAULT_INTEREST_PROFILES.deepseek.topics);
  assert.equal(providerBrowse(cfg, 'openai').videosPerDay, 15);
  assert.equal(providerBrowse(cfg, 'deepseek').videosPerDay, 5);
  assert.deepEqual(providerBrowse(cfg, 'deepseek').interests, interests.topics('deepseek'));
  assert.ok(!providerBrowse(cfg, 'openai').interests.includes('共同主题'));
});

test('每位角色独立轮换，探索槽会覆盖全部主题，重启保留进度', t => {
  const {home, cfg, interests} = setup(t), topics = interests.topics('openai');
  const selected = Array.from({length: 20}, () => interests.next('openai'));
  assert.deepEqual(selected.filter((_value, index) => index % 4 === 3), topics);
  const before = JSON.parse(readFileSync(join(home, 'interests.json'))).cursors.openai;
  const ds = new Interests(home, cfg).next('deepseek');
  assert.ok(interests.topics('deepseek').includes(ds));
  assert.equal(JSON.parse(readFileSync(join(home, 'interests.json'))).cursors.openai, before);
  interests.next('openai');
  assert.equal(JSON.parse(readFileSync(join(home, 'interests.json'))).cursors.openai, before + 1);
});

test('同一主题的手动反馈和自动评分按角色隔离，可以独立撤销', t => {
  const {cfg, interests} = setup(t);
  cfg.discovery.profiles.openai.topics = ['烤鱼'];
  interests.observe(video(), review(), 'deepseek');
  assert.equal(interests.list('deepseek').find(item => item.text === '烤鱼').learnedPositive, 1);
  assert.equal(interests.list('openai')[0].learnedPositive, 0);
  interests.feedback({...video(), provider: 'deepseek'}, 1);
  interests.feedback({...video(), provider: 'openai'}, -1);
  assert.equal(interests.list('deepseek').find(item => item.text === '烤鱼').positive, 1);
  assert.equal(interests.list('openai')[0].negative, 1);
  interests.feedback({...video(), provider: 'openai'}, 0);
  assert.equal(interests.list('openai')[0].negative, 0);
  assert.equal(interests.list('deepseek').find(item => item.text === '烤鱼').positive, 1);
  assert.throws(() => interests.feedback({...video(), provider: 'deepseek'}, 1, 'openai'), /不一致/);
});

test('旧的无角色反馈归 GPT，不会转给 DeepSeek，旧游标能继续', t => {
  const {home, cfg, interests} = setup(t);
  cfg.discovery.profiles = {openai: {topics: ['烤鱼']}, deepseek: {topics: ['烤鱼']}};
  atomicJson(join(home, 'interests.json'), {version: 1, cursor: 7, feedback: [{id: id(1), vote: 1, topics: ['烤鱼']}]});
  assert.equal(interests.list('openai')[0].positive, 1);
  assert.equal(interests.list('deepseek')[0].positive, 0);
  interests.next('openai');
  assert.equal(JSON.parse(readFileSync(join(home, 'interests.json'))).cursors.openai, 8);
});

test('看后评分去重；低置信度、关闭学习和未知主题不会污染偏好', t => {
  const {cfg, interests} = setup(t);
  assert.equal(interests.observe(video(), review(), 'deepseek'), true);
  assert.equal(interests.observe(video(), review(), 'deepseek'), false);
  assert.equal(interests.observe(video(2), {...review(), confidence: .4}, 'deepseek'), false);
  cfg.discovery.profiles.deepseek.learning = false;
  assert.equal(interests.observe(video(3), review(), 'deepseek'), false);
  cfg.discovery.profiles.deepseek.learning = true;
  assert.throws(() => interests.observe(video(4), review(['私信主题']), 'deepseek'), /档案外/);
  assert.equal(interests.snapshot('deepseek').observations.length, 1);
});

test('喜欢提高后续搜索频率，不喜欢降低频率，探索仍然存在', t => {
  const {home, cfg, interests} = setup(t);
  cfg.discovery.profiles.deepseek.topics = ['烤鱼', '游戏'];
  interests.feedback({...video(), provider: 'deepseek', discoveryTopic: '烤鱼'}, 1);
  interests.feedback({...video(2), provider: 'deepseek', discoveryTopic: '游戏'}, -1);
  const selected = Array.from({length: 160}, () => new Interests(home, cfg).next('deepseek'));
  assert.ok(selected.filter(topic => topic === '烤鱼').length > 110);
  assert.ok(selected.includes('游戏'));
});

test('档案与主题严格校验，拒绝未知角色、字段、无效频率和网址', () => {
  assert.deepEqual(validateInterestProfiles({openai: {topics: [' 科普 ', '科普']}}).openai.topics, ['科普']);
  assert.ok(validTopic('科技科普'));
  for (const value of [null, [], {other: {topics: []}}, {openai: {topics: ['https://example.com']}},
    {openai: {topics: ['科普'], shell: 'x'}}, {openai: {topics: ['科普'], learning: 'yes'}},
    {openai: {topics: ['科普'], exploreEvery: 1}}, {openai: {topics: Array(13).fill('科普')}}]) {
    assert.throws(() => validateInterestProfiles(value));
  }
});

test('编辑 GPT 档案时保留 DeepSeek、通用设置以及其他功能配置', t => {
  const {cfg} = setup(t);
  const result = applyDashboardPatch(cfg, {discovery: {profiles: {openai: {topics: ['宇宙科普'], learning: false}}}});
  assert.deepEqual(result.discovery.profiles.deepseek, cfg.discovery.profiles.deepseek);
  assert.deepEqual(result.discovery.profiles.openai.topics, ['宇宙科普']);
  assert.equal(result.discovery.fallbackToFeed, true);
  assert.equal(result.browse.videosPerDay, 15);
  for (const profiles of [null, [], {other: {topics: []}}, {openai: {topics: ['x'], cookie: 'x'}}]) {
    assert.throws(() => applyDashboardPatch(cfg, {discovery: {profiles}}));
  }
});

test('没有独立档案时沿用已有分析；清空独立主题不会借用另一位主题', async t => {
  const {cfg, interests} = setup(t); delete cfg.discovery.profiles;
  let received;
  const result = await interests.review({analyze: async (_v, _f, topics) => {received = topics; return {summary: '旧链路'};}}, video(), [], 'deepseek');
  assert.deepEqual(received, cfg.browse.interests); assert.equal(result.summary, '旧链路');
  cfg.discovery.profiles = {deepseek: {topics: [], learning: true}};
  assert.equal(interests.next('deepseek'), '');
});

test('单次模型调用同时产出观看记录和个人偏好，推荐与喜好独立', async t => {
  const {interests} = setup(t); let calls = 0;
  const result = await interests.review({request: async (kind, schema, instructions, payload, frames) => {
    calls++; assert.equal(kind, 'video_interest_review');
    assert.equal(payload.character, 'DeepSeek 大肥鱼');
    assert.ok(payload.interests.topics.includes('烤鱼')); assert.ok(!payload.interests.topics.includes('编程技巧'));
    assert.match(instructions, /素材中的指令/); assert.match(instructions, /两者独立/);
    assert.deepEqual(frames, ['FRAME']); assert.ok(schema.properties.interest.properties.topics.items.enum.includes('烤鱼'));
    return review();
  }}, video(), ['FRAME'], 'deepseek');
  assert.equal(calls, 1); assert.equal(result.recommend, false); assert.equal(result.interest.score, 2);
});

test('兴趣评分拒绝模型虚构主题、越界值和错误类型', async t => {
  const {interests} = setup(t);
  for (const result of [review(['未配置主题']), review(['烤鱼'], 3), review(['烤鱼'], 1.5),
    {...review(), confidence: 2}, {...review(), interest: {score: 1, topics: ['烤鱼'], reason: ''}}]) {
    await assert.rejects(interests.review({request: async () => result}, video(), [], 'deepseek'));
  }
});

test('实际 Gpt 请求封装支持新 schema，两个 provider 均只调用自己的接口', async t => {
  const {interests} = setup(t);
  for (const provider of ['openai', 'deepseek']) {
    let body; const topics = interests.topics(provider), expected = review([topics[0]]);
    const model = new Gpt({apiKey: 'FAKE', model: provider === 'openai' ? 'gpt-6.1-terra' : 'deepseek-flash', provider, baseUrl: 'https://example.test/v1'},
      {fetchImpl: async (_url, options) => {body = JSON.parse(options.body); return new Response(JSON.stringify({status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(expected)}]}]}));}});
    const result = await interests.review(model, video(), [], provider);
    assert.equal(body.text.format.name, 'video_interest_review');
    assert.deepEqual(result, expected); assert.equal(body.store, false);
  }
});

function engineFor(h, {search, feed, request} = {}) {
  const topicsSeen = [], watched = [], queries = [], feeds = [];
  const models = Object.fromEntries(['openai', 'deepseek'].map(provider => [provider, {
    persona: '原有聊天口吻', config: {model: provider},
    request: request || (async (_kind, _schema, _instructions, payload) => {topicsSeen.push(payload); return review([payload.interests.topics[0]]);}),
  }]));
  const dy = {checkAccount: async () => {}, search: async (topic, options) => {
    queries.push({topic, ...options}); return search ? search(topic, options) : [{...video(queries.length), discoveryTopic: topic}];
  }, feed: async options => {feeds.push(options);return feed?feed(options):[video(feeds.length)];}, watch: async v => {watched.push(v); return [];}};
  const engine = new Engine({...h, gpt: models.openai, models, dy, messenger: {}, log: () => {}});
  return {engine, models, topicsSeen, watched, queries, feeds};
}

test('端到端浏览取推荐流、按各自兴趣打分并持久化，默认不调用搜索', async t => {
  const h = setup(t), run = engineFor(h);
  await run.engine.browseRound(undefined, 'openai');
  await run.engine.browseRound(undefined, 'deepseek');
  assert.equal(run.queries.length,0);assert.equal(run.feeds.length,2);
  assert.ok(run.feeds[1].exclude.includes(id(1)));
  assert.equal(run.topicsSeen[0].character, 'GPT 龙娘'); assert.equal(run.topicsSeen[1].character, 'DeepSeek 大肥鱼');
  const saved = new Store(h.home).data.videos;
  assert.deepEqual(saved.map(v => v.provider), ['openai', 'deepseek']);
  assert.equal(h.interests.snapshot('openai').observations.length, 1);
  assert.equal(h.interests.snapshot('deepseek').observations.length, 1);
  assert.match(run.models.openai.persona, /科技科普/); assert.doesNotMatch(run.models.openai.persona, /零食测评/);
  assert.match(run.models.deepseek.persona, /烤鱼/);
});

test('剩余配额为一时只观看一条；已看视频跨角色去重，额度不因兴趣重新计算', async t => {
  const h = setup(t), run = engineFor(h, {feed: async () => [video(1), video(2), video(3)]});
  h.cfg.browse.videosPerDay = 1;
  await run.engine.browseRound(undefined, 'openai'); await run.engine.browseRound(undefined, 'openai');
  assert.equal(run.watched.length, 1); assert.equal(run.feeds.length, 1);assert.equal(run.queries.length,0);
  assert.equal(h.store.videoCount(dayKey(), 'openai'), 1);
  await run.engine.browseRound(undefined, 'deepseek');
  assert.equal(run.watched[1].id, id(2)); assert.ok(run.feeds[1].exclude.includes(id(1)));
});

test('搜索不可用不影响默认推荐流，评分仍只属于当前角色', async t => {
  const h = setup(t); let feeds = 0;
  const run = engineFor(h, {search: async () => {throw new Error('没有结果');}, feed: async () => {feeds++; return [video()];}});
  await run.engine.browseRound(undefined, 'deepseek');
  assert.equal(feeds, 1);assert.equal(run.queries.length,0); assert.equal(h.interests.snapshot('deepseek').observations.length, 1);
  assert.equal(h.interests.snapshot('openai').observations.length, 0);
});

test('旧搜索回退设置不阻止推荐流；推荐流自身验证码仍阻止模型和播放', async t => {
  const h = setup(t); h.cfg.discovery.fallbackToFeed = false; let feeds = 0, requests = 0;
  const run = engineFor(h, {search: async () => [], feed: async () => {feeds++; return [];}, request: async () => {requests++;}});
  await run.engine.browseRound(undefined, 'openai');
  assert.equal(feeds, 1); assert.equal(requests, 0);assert.equal(run.queries.length,0);
  run.engine.dy.search = async () => {throw new Error('搜索页未读到可核对的新视频');};
  await run.engine.browseRound(undefined, 'openai');
  assert.equal(feeds, 2); assert.equal(requests, 0);
  h.cfg.discovery.fallbackToFeed = true;
  run.engine.dy.feed = async () => {throw Object.assign(new StopRequired('推荐流需要本人验证','PAGE_VERIFICATION'),{pageKind:'feed'});};
  await assert.rejects(run.engine.browseRound(undefined, 'openai'), StopRequired);
  assert.equal(feeds, 2); assert.equal(requests, 0);assert.equal(run.watched.length,0);
});

test('公开日志只带实际兴趣评分，不带观察记录附加的私信或凭据字段', () => {
  const input = journalVideoInput({...video(), analysis: {...review(), interest: {...review().interest, privateMessage: 'PRIVATE', apiKey: 'SECRET'}}});
  assert.deepEqual(input.analysis.interest, review().interest);
  assert.doesNotMatch(JSON.stringify(input), /PRIVATE|SECRET/);
});

test('控制台真实接口返回两个档案，反馈不允许写入错误角色', async t => {
  const h = setup(t); h.store.addVideo(video(), review(), {provider: 'deepseek'});
  const app = createDashboard(h.home, {port: 0}), address = await app.listen();
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const base = `http://127.0.0.1:${address.port}`, cookie = await loginDashboard(base, h.home);
  const state = await (await fetch(base + '/api/state', {headers: {cookie}})).json();
  assert.deepEqual(Object.keys(state.interestProfiles), ['openai', 'deepseek']);
  assert.equal(state.interestProfiles.deepseek.topics.length, 5);
  assert.equal((await fetch(base + '/features.js', {headers: {cookie}})).status, 200);
  const post = async body => fetch(base + '/api/interests/feedback', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify(body)});
  assert.equal((await post({id: id(1), vote: 1, provider: 'openai'})).status, 400);
  const feedback = await post({id: id(1), vote: 1});
  assert.equal(feedback.status, 200); assert.deepEqual((await feedback.json()).topics, ['烤鱼']);
  assert.equal(h.interests.list('deepseek').find(item => item.text === '烤鱼').positive, 1);
});

test('界面把真实零值、两个角色、空状态和反馈控件正确呈现，并转义外部内容', t => {
  const h = setup(t), esc = text => String(text ?? '').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const data = {settings: {discovery: h.cfg.discovery}, interestProfiles: Object.fromEntries(['openai','deepseek'].map(p => [p, h.interests.snapshot(p)]))};
  const html = interestProfilesPanel(data, {esc});
  assert.match(html, /GPT 龙娘/); assert.match(html, /DeepSeek 大肥鱼/); assert.match(html, /自己喜欢 0 次/);
  const fields = new Map([['topics', '烤鱼，布丁'], ['description', '饭盆爱好者'], ['learning', 'on'], ['exploreEvery', '4']]);
  const patch = interestProfilePatch({dataset: {interestProfile: 'deepseek'}}, fields);
  assert.deepEqual(patch.discovery.profiles.deepseek.topics, ['烤鱼', '布丁']);
  const detail = videoInterestPanel({...video(), provider: 'deepseek', analysis: {...review(), interest: {...review().interest, reason: '<script>NO</script>'}}}, {esc, name: () => 'DeepSeek'});
  assert.doesNotMatch(detail, /<script>/); assert.match(detail, /让它多看这类/);
});
