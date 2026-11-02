import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConfig, dayKey} from '../src/config.mjs';
import {characterProfile, characterContext, characterInstructions, DEFAULT_CATCHPHRASES} from '../src/characters.mjs';
import {DEFAULT_INTEREST_PROFILES} from '../src/interest-profiles.mjs';
import {chooseShowTopic, chooseShowTopics, episodePresentation} from '../src/show-topics.mjs';
import {makeShow} from '../src/show.mjs';
import {Gpt} from '../src/openai.mjs';
import {Store, atomicJson} from '../src/store.mjs';
import {buildEpisode} from '../src/broadcast.mjs';
import {DailyJournal} from '../src/journal.mjs';
import {CommentAutomation} from '../src/comment-automation.mjs';

const id = n => String(7700000000000000000n + BigInt(n));
const v = (n, topic, score, confidence = .9) => ({id: id(n), desc: topic, analysis: {summary: `画面展示${topic}`, evidence: `抽样画面中的${topic}`, recommend: true, confidence,
  ...(score === undefined ? {} : {interest: {score, topics: [topic], reason: '记录中的内容符合当前主题'}})}});
function config() {const cfg = defaultConfig(); cfg.discovery.profiles = structuredClone(DEFAULT_INTEREST_PROFILES); return cfg;}
const data = (gpt = [], ds = []) => ({day: dayKey(), totalVideos: gpt.length + ds.length,
  providers: {openai: {videos: gpt, videoCount: gpt.length, comments: 0, replies: 0}, deepseek: {videos: ds, videoCount: ds.length, comments: 0, replies: 0}}});
const fakeModel = capture => ({request: async (name, _schema, instructions, payload) => {capture.push({name, instructions, payload}); return {say: '这条记录里的细节值得聊聊。', question: ''};}});

test('原人物卡、默认口头禅和当前兴趣组成同一份角色资料', () => {
  const cfg = config(); assert.deepEqual(cfg.video.series.catchphrases, DEFAULT_CATCHPHRASES);
  const gpt = characterProfile(cfg, 'openai'), ds = characterProfile(cfg, 'deepseek');
  assert.equal(gpt.name, 'GPT 龙娘'); assert.equal(ds.name, 'DeepSeek 大肥鱼');
  assert.match(gpt.persona, /与DeepSeek的核心关系/); assert.match(ds.persona, /与GPT的核心互动/);
  assert.match(gpt.cardHash, /^[a-f0-9]{64}$/);
  cfg.discovery.profiles.deepseek.topics = ['家常菜'];
  assert.deepEqual(characterProfile(cfg, 'deepseek').interests.topics, ['家常菜']);
  cfg.video.series.catchphrases.deepseek = '';
  assert.equal(characterProfile(cfg, 'deepseek').catchphrase, '');
});

test('公开角色上下文不包含私信、账号配置、密钥或原始人物卡对象', () => {
  const cfg = config(); cfg.account.secret = 'ACCOUNT_SECRET'; cfg.reply.contacts = [{private: 'PRIVATE_CONTACT'}];
  const profile = characterProfile(cfg, 'openai'), context = characterContext({...profile, private: 'PRIVATE_EXTRA'});
  assert.doesNotMatch(JSON.stringify(context), /ACCOUNT_SECRET|PRIVATE_CONTACT|PRIVATE_EXTRA|persona_prompt|first_message/);
  assert.match(characterInstructions(profile, 'show'), /虚构角色/);
  assert.match(characterInstructions(profile, 'show'), /偶尔使用/);
});

test('反复同步角色保持幂等；私信加载人物卡，公开评论保持独立公开上下文', async () => {
  for (const provider of ['openai', 'deepseek']) {
    const cfg = config(), model = new Gpt({provider, label: provider === 'openai' ? 'GPT' : 'DeepSeek', model: provider, baseUrl: 'https://example.test'});
    model.setCharacter(cfg); const persona = model.persona; model.setCharacter(cfg); assert.equal(model.persona, persona);
    const calls = []; model.request = async (name, _schema, instructions, payload) => {
      calls.push({name, instructions, payload}); return name === 'chat_reply' ? {shouldReply: true, text: '我会认真帮忙。', reason: '回应'} : {shouldPost: true, text: '这个细节挺有意思。', reason: '具体观察', confidence: .9};
    };
    await model.reply({contact: {label: '测试'}, history: [], incoming: [{id: 'a', text: '你喜欢什么？'}], recentVideos: [], maxChars: 100});
    assert.match(calls[0].instructions, new RegExp(provider === 'openai' ? 'GPT龙娘' : '大肥鱼'));
    assert.ok(calls[0].instructions.includes(cfg.video.series.catchphrases[provider]));
    model.persona = 'PRIVATE_PERSONA';
    await model.publicComment({video: v(1, '家常菜'), analysis: v(1, '家常菜').analysis});
    assert.equal(calls[1].payload.character.name, characterProfile(cfg, provider).name);
    assert.deepEqual(calls[1].payload.character.interests.topics, cfg.discovery.profiles[provider].topics);
    assert.doesNotMatch(JSON.stringify(calls[1]), /PRIVATE_PERSONA/);
  }
});

test('独立日志和评论入口也加载当前配置，不依赖先启动私信 Engine', t => {
  const home = mkdtempSync(join(tmpdir(), 'dy-character-entry-')); t.after(() => rmSync(home, {recursive: true, force: true}));
  const cfg = config(), store = new Store(home);
  cfg.discovery.profiles.deepseek.topics = ['园艺']; cfg.video.series.catchphrases.deepseek = '本鱼今天也在学。';
  const make = () => new Gpt({provider: 'deepseek', label: 'DeepSeek', model: 'deepseek-flash', baseUrl: 'https://example.test'});
  const diaryModel = make(); new DailyJournal({home, cfg, store, models: {deepseek: diaryModel}});
  assert.deepEqual(diaryModel.character.interests.topics, ['园艺']);
  const commentModel = make(); new CommentAutomation({home, cfg, store, models: {deepseek: commentModel}});
  assert.equal(commentModel.character.catchphrase, '本鱼今天也在学。');
  assert.deepEqual(commentModel.character.interests.topics, ['园艺']);
});

test('记录的高喜好评分优先于过去固定偏爱的猫、手工等类别', () => {
  const cfg = config(), input = data([v(1, '猫和手工', undefined, .99), v(2, '编程技巧', 2, .8)]);
  assert.equal(chooseShowTopic(input, cfg).id, id(2));
});

test('负面喜好不会因主题命中而优先；低置信度评分不冒充真实偏好', () => {
  const cfg = config(), input = data([v(1, '编程技巧', -2), v(2, '生活小技巧', undefined), v(3, '收纳整理', 2, .4)]);
  const plan = chooseShowTopics(input, {cfg});
  assert.equal(plan.primary.id, id(2));
  const low = chooseShowTopics(data([v(3, '收纳整理', 2, .4)]), {cfg});
  assert.equal(low.selected[0].rating, null); assert.equal(low.selected[0].basis, 'topic-match');
});

test('两位有各自喜欢的视频时选择两条真实素材，实际观看者以分组为准', () => {
  const cfg = config(), input = data([{...v(1, '编程技巧', 2), provider: 'deepseek'}], [v(2, '烤鱼', 2)]);
  const plan = chooseShowTopics(input, {cfg});
  assert.equal(plan.kind, 'contrast'); assert.equal(plan.selected.length, 2);
  assert.deepEqual(new Set(plan.selected.map(item => item.video.provider)), new Set(['openai', 'deepseek']));
  assert.equal(plan.selected.find(item => item.video.id === id(1)).video.provider, 'openai');
});

test('另一位只有未评分且不匹配主题的视频时，不编造双人喜好或共同观看', () => {
  const cfg = config(), plan = chooseShowTopics(data([v(1, '编程技巧', 2)], [v(2, '夜间街景', undefined)]), {cfg});
  assert.equal(plan.secondary, null); assert.equal(plan.kind, 'single');
});

test('观众点题优先匹配真实安全记录；失效或不适合的点题回到实际候选', () => {
  const cfg = config(), input = data([v(1, '编程技巧', 2), v(2, '家常菜', undefined), v(3, '案件', 2)]);
  const audienceTopic = {id: 'TOPIC', text: '下期讲讲家常菜', matchedVideoId: id(2)};
  assert.equal(chooseShowTopics(input, {cfg, audienceTopic}).primary.id, id(2));
  for (const matchedVideoId of [id(3), id(99)]) {
    const plan = chooseShowTopics(input, {cfg, audienceTopic: {...audienceTopic, matchedVideoId}});
    assert.equal(plan.primary.id, id(1)); assert.equal(plan.audienceTopic, null);
  }
  assert.equal(chooseShowTopic(data([], []), cfg), null);
});

test('节目只收到公开字段和各自的真实选片 ID，四轮共享同一套人设和口头禅', async () => {
  const cfg = config(), input = data([{...v(1, '编程技巧', 2), private: 'PRIVATE_CONTEXT'}], [v(2, '烤鱼', 2)]), calls = [];
  const show = await makeShow(input, {openai: fakeModel(calls), deepseek: fakeModel(calls)}, {cfg});
  assert.equal(show.turns.length, 8); assert.equal(show.selectedTopics.length, 2);
  assert.equal(calls[0].payload.character.name, 'GPT 龙娘'); assert.equal(calls[1].payload.character.name, 'DeepSeek 大肥鱼');
  assert.equal(calls[0].payload.character.catchphrase, cfg.video.series.catchphrases.openai);
  assert.deepEqual(calls[0].payload.ownSelectedIds, [id(1)]); assert.deepEqual(calls[1].payload.ownSelectedIds, [id(2)]);
  assert.match(calls[0].instructions, /不能补造评分/); assert.doesNotMatch(JSON.stringify(calls), /PRIVATE_CONTEXT/);
});

test('标题和封面跟随选中的真实主题；周精选带上本周标记，封面长度受控', async () => {
  const cfg = config(), input = data([v(1, '编程技巧', 2)], [v(2, '烤鱼', 2)]);
  const show = await makeShow(input, {openai: fakeModel([]), deepseek: fakeModel([])}, {cfg});
  const presentation = episodePresentation(input, show, cfg);
  assert.match(presentation.title, /龙娘聊编程技巧/); assert.match(presentation.title, /大肥鱼聊烤鱼/);
  assert.match(presentation.coverTitle, /烤鱼/); assert.ok([...presentation.coverTitle].length <= 11);
  assert.match(episodePresentation({...input, weekly: true}, show, cfg).title, /本周/);
  const empty = episodePresentation(input, null, cfg); assert.doesNotMatch(empty.title, /烤鱼|编程技巧/);
});

test('实际制作流程更新角色缓存与封面元数据，配置变更会重新写稿，不额外发消息或渲染', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dy-character-sync-')); t.after(() => rmSync(home, {recursive: true, force: true}));
  const cfg = config(); cfg.video.enabled = true; cfg.video.show = {enabled: true, format: 'roundtable'}; cfg.journal.enabled = false;
  const store = new Store(home); store.addVideo(v(1, '编程技巧', 2), v(1, '编程技巧', 2).analysis, {provider: 'openai'});
  store.addVideo(v(2, '烤鱼', 2), v(2, '烤鱼', 2).analysis, {provider: 'deepseek'});
  const calls = [], models = {openai: fakeModel(calls), deepseek: fakeModel(calls)}, signal = AbortSignal.abort();
  const build = () => buildEpisode({home, cfg, models, day: dayKey(), signal, log: () => {}});
  await assert.rejects(build(), /视频制作已停止/);
  const file = join(home, 'video', dayKey(), 'episode.json'), first = JSON.parse(readFileSync(file));
  assert.equal(calls.length, 4); assert.equal(first.characters.openai.catchphrase, DEFAULT_CATCHPHRASES.openai);
  assert.match(first.coverTitle, /烤鱼/); assert.match(first.description, /本期选题/);
  const dummy = join(home, 'fixture.mp4'); writeFileSync(dummy, 'test-only');
  atomicJson(file, {...first, status: 'rendered', videoPath: dummy});
  assert.equal((await build()).status, 'rendered'); assert.equal(calls.length, 4);
  cfg.video.series.catchphrases.openai = '先把这件事弄明白。';
  await assert.rejects(build(), /视频制作已停止/);
  assert.equal(calls.length, 8); const second = JSON.parse(readFileSync(file)); assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal(new Store(home).data.outbox.length, 0);
  for (const status of ['published', 'scheduled', 'submitted', 'uncertain']) {
    atomicJson(file, {...second, status}); const before = readFileSync(file, 'utf8');
    assert.equal((await buildEpisode({home, cfg, models, force: true, log: () => {}})).status, status);
    assert.equal(readFileSync(file, 'utf8'), before);
  }
  assert.equal(calls.length, 8);
});
