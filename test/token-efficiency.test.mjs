import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConfig, validateConfig, dayKey} from '../src/config.mjs';
import {Store} from '../src/store.mjs';
import {Gpt} from '../src/openai.mjs';
import {Interests} from '../src/interests.mjs';
import {CommentStore} from '../src/comment-store.mjs';
import {CommentAutomation} from '../src/comment-automation.mjs';
import {Engine} from '../src/engine.mjs';
import {DailyJournal} from '../src/journal.mjs';
import {VideoUnderstanding} from '../src/understanding.mjs';
import {efficiencySettings, compactThread} from '../src/token-policy.mjs';
import {usageCost, UsageMeter} from '../src/usage.mjs';
import {VideoAnalysis, codexArguments, publicVideoUrl, validateVideoAnalysis} from '../src/video-analysis.mjs';
import {Cdp, Browser} from '../src/browser.mjs';
import {runInNewContext} from 'node:vm';
import {markVideoInPage, pollFullCapture, finishFullCapture, readFullCaptureChunk} from '../src/full-video-capture.mjs';

const id = n => String(7400000000000000000n + BigInt(n));
const video = n => ({id: id(n), url: 'https://www.douyin.com/video/' + id(n), desc: '毛线小动物', author: '公开视频作者'});
const decision = {shouldPost: true, text: '这个毛线小动物的配色很柔和。', reason: '具体观察', confidence: .9};
const review = {summary: '画面是毛线小动物', evidence: '抽样画面中的造型', recommend: false, confidence: .9};
const reply = value => new Response(JSON.stringify({status: 'completed', output: [{type: 'message',
  content: [{type: 'output_text', text: JSON.stringify(value)}]}]}));
function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'dy-efficient-'));
  t.after(() => rmSync(home, {recursive: true, force: true}));
  const cfg = defaultConfig(); cfg.reply.enabled = false; cfg.deepseek.enabled = true;
  cfg.browse.videosPerRound = 1; cfg.browse.videosPerDay = null;
  cfg.engagement.enabled = true; cfg.engagement.commentsPerDay = null; cfg.engagement.repliesPerDay = null;
  const store = new Store(home);
  return {home, cfg, store};
}

test('null 表示公开活动每日不限，零仍表示禁用；无效值仍被拒绝', t => {
  const h = setup(t);
  h.cfg.deepseek.browse.videosPerDay = null;
  h.cfg.deepseek.engagement.commentsPerDay = h.cfg.deepseek.engagement.repliesPerDay = null;
  validateConfig(h.cfg);
  const ledger = new CommentStore(h.home);
  assert.equal(ledger.quota('comment', h.cfg.engagement), Infinity);
  assert.equal(ledger.quota('reply', h.cfg.engagement), Infinity);
  assert.equal(ledger.quota('comment', {...h.cfg.engagement, commentsPerDay: 0}), 0);
  h.cfg.reply.totalPerDay = null; assert.throws(() => validateConfig(h.cfg), /totalPerDay/);
  h.cfg.reply.totalPerDay = 80; h.cfg.browse.videosPerDay = -1;
  assert.throws(() => validateConfig(h.cfg), /videosPerDay/);
});

test('普通窗口后台模式拦截置前指令，窗口关闭时不自动新开抢焦点', async t => {
  const h = setup(t), suppressed = {background: true};
  assert.deepEqual(await Cdp.prototype.send.call(suppressed, 'Page.bringToFront'), {});
  assert.deepEqual(await Cdp.prototype.send.call(suppressed, 'Target.activateTarget'), {});
  const browser = new Browser(join(h.home, 'empty-browser'), {headless: false, background: true});
  assert.equal(browser.background, true);
  await assert.rejects(browser.start(), error => error.name === 'StopRequired' && /不会自动抢占焦点/.test(error.message));
});

test('后台播放器仅在链接和唯一可见视频对应时标记，加载前播放并拒绝换片', () => {
  let played = 0, paused = 0, marked = '';
  const v = {readyState: 0, duration: NaN, src: 'https://example.test/video', currentSrc: '',
    getBoundingClientRect: () => ({width: 640, height: 480, top: 0, left: 0, right: 640, bottom: 480}),
    setAttribute: (_name, value) => {marked = value;}, play: () => {played++;return Promise.resolve();}, pause: () => {paused++;}};
  const context = {document: {title: '抖音', querySelector: () => null, querySelectorAll: () => [v]},
    location: {pathname: '/video/' + id(1)}, innerWidth: 1440, innerHeight: 1000,
    getComputedStyle: () => ({display: 'block', visibility: 'visible'})};
  const call = () => runInNewContext('(' + markVideoInPage.toString() + ')(' + JSON.stringify({id: id(1)}) + ')', context);
  call(); assert.equal(played, 1); assert.equal(marked, id(1));
  v.readyState = 4; v.duration = 8.1;
  assert.equal(call().durationSeconds, 8.1); assert.equal(paused, 1);
  context.location.pathname = '/video/' + id(2);
  assert.match(call().error, /不一致/); assert.equal(paused, 1);
});

test('全片结束后平台自动跳下一条仍能收尾，中途换片则拒绝', () => {
  const state = {id: id(1), ended: true, done: true, duration: 8.1, bytes: 2000, error: ''};
  const context = {window: {__douyinFullCapture: state}, location: {pathname: '/video/' + id(2)}, document: {}};
  const call = () => runInNewContext('(' + pollFullCapture.toString() + ')(' + JSON.stringify({id: id(1)}) + ')', context);
  assert.equal(call().done, true); assert.equal(call().ended, true);
  state.ended = false; assert.match(call().error, /作品已变化/);
});

test('后台标签只模拟页面内焦点，不激活系统窗口', async t => {
  const h = setup(t), calls = [], page = {send: async (method, params) => {calls.push({method, params});return {};}};
  const b = new Browser(h.home, {headless: false, background: true});
  b.runtime = {port: 1234, tabs: {chat: 'owned-chat'}};b.cdp = {ws: {readyState: 1}};
  t.mock.method(globalThis, 'fetch', async () => ({json: async () => [{id: 'owned-chat', type: 'page', webSocketDebuggerUrl: 'ws://local/owned'}]}));
  t.mock.method(Cdp, 'connect', async () => page);
  assert.equal(await b.page('chat', 'https://www.douyin.com/chat'), page);
  assert.ok(calls.some(c => c.method === 'Emulation.setFocusEmulationEnabled' && c.params.enabled));
  assert.ok(calls.every(c => !['Page.bringToFront','Target.activateTarget'].includes(c.method)));
});

test('完整录制按小块读取并释放，不把整片编码成一条巨型消息', async () => {
  class Reader {
    readAsDataURL(blob) {blob.arrayBuffer().then(value => {this.result = 'data:video/webm;base64,' + Buffer.from(value).toString('base64');this.onload();});}
  }
  const context = {window: {__douyinFullCapture: {id: id(1), video: {pause() {}, removeEventListener() {}},
    recorder: {state: 'inactive'}, finished: Promise.resolve(), ended: true, chunks: [new Blob(['0123456789'])],
    duration: 8.1, hasAudio: true}}, document: {querySelectorAll: () => []}, Blob, FileReader: Reader, setTimeout: fn => fn()};
  const invoke = (fn, args) => runInNewContext('(' + fn.toString() + ')(' + JSON.stringify(args) + ')', context);
  const finished = await invoke(finishFullCapture, {id: id(1)});
  assert.equal(finished.bytes, 10);assert.equal(finished.base64, undefined);
  const chunks = [];
  for (let offset = 0; offset < 10; offset += 4) chunks.push(Buffer.from((await invoke(readFullCaptureChunk, {id: id(1), offset, size: 4})).base64, 'base64'));
  assert.equal(Buffer.concat(chunks).toString(), '0123456789');
  await invoke(readFullCaptureChunk, {id: id(1), release: true});
  assert.equal(context.window.__douyinFullCapture, undefined);
});

test('单次请求同时看视频、评分并拟评论；复用草稿发送，不再调用评论模型', async t => {
  const h = setup(t), requests = [], sent = [];
  const model = new Gpt({apiKey: 'FAKE', provider: 'openai', model: 'gpt-6-luna', baseUrl: 'https://example.test/v1'},
    {fetchImpl: async (_url, options) => {requests.push(JSON.parse(options.body));return reply({...review, commentDecision: decision});}});
  const dy = {checkAccount: async () => {}, feed: async () => [video(1)], watch: async () => []};
  const comments = {read: async () => [], send: async value => {sent.push(value);return {accepted: true, verified: true, id: id(20)};}};
  const service = new CommentAutomation({...h, gpt: model, dy, comments, live: true, log: () => {}});
  const engine = new Engine({...h, gpt: model, dy, messenger: {}, engagement: service, live: true, log: () => {}});
  await engine.browseRound();
  assert.equal(requests.length, 1); assert.equal(sent.length, 1);
  assert.equal(requests[0].text.format.name, 'video_review_comment');
  assert.equal(requests[0].reasoning.effort, 'none');
  assert.equal(requests[0].max_output_tokens, 1500);
  assert.deepEqual(requests[0].prompt_cache_options, {mode: 'explicit', ttl: '30m'});
  assert.equal(requests[0].input[0].role, 'developer');
  assert.equal(service.ledger.data.actions[0].provider, 'openai');
  await service.onVideo(video(1), engine.store.data.videos[0].analysis, undefined, 'openai');
  assert.equal(requests.length, 1); assert.equal(sent.length, 1);
});

test('合并任务保留各自兴趣，DeepSeek 不接收 OpenAI 专属缓存参数', async t => {
  const h = setup(t); h.cfg.discovery.profiles.deepseek = {description: '喜欢手工', topics: ['手工'], learning: true, exploreEvery: 4};
  let body;
  const model = new Gpt({apiKey: 'FAKE', provider: 'deepseek', label: 'DeepSeek', model: 'deepseek-flash', baseUrl: 'https://example.test'},
    {fetchImpl: async (_url, options) => {body = JSON.parse(options.body);return reply({...review,
      interest: {score: 1, topics: ['手工'], reason: '实际画面是毛线造型'}, commentDecision: decision});}});
  model.setCharacter(h.cfg);
  const result = await new Interests(h.home, h.cfg).review(model, video(1), [], 'deepseek', null, {comments: [], maxChars: 100});
  assert.equal(result.interest.score, 1); assert.equal(body.reasoning.effort, 'none');
  assert.equal(body.prompt_cache_options, undefined);
  assert.ok(body.instructions.includes(JSON.stringify(body.text.format.schema)));
});

test('不合格的合并评论只跳过评论，观看记录仍然保留', async t => {
  const h = setup(t);
  const model = new Gpt({apiKey: 'FAKE', provider: 'openai', model: 'gpt-6-luna', baseUrl: 'https://example.test'},
    {fetchImpl: async () => reply({...review, commentDecision: {...decision, text: 'https://example.com'}})});
  model.setCharacter(h.cfg);
  const value = await model.analyze(video(1), [], [], null, {comments: [], maxChars: 100});
  assert.equal(value.summary, review.summary); assert.equal(value.commentDecision.shouldPost, false);
  assert.equal(value.commentDecision.text, '');
});

test('评论上下文保留楼根和最近互动，过滤其他楼层与本机附加字段', async t => {
  const h = setup(t), root = {id: id(1), rootId: id(1), text: '自己的原评论', privateToken: 'SECRET'};
  const comments = [root, ...Array.from({length: 10}, (_, n) => ({id: id(n + 2), rootId: id(1), text: '留言' + n})),
    {id: id(50), rootId: id(50), text: 'UNRELATED'}];
  let body;
  const model = new Gpt({apiKey: 'FAKE', model: 'gpt-6-luna', baseUrl: 'https://example.test'},
    {fetchImpl: async (_url, options) => {body = JSON.parse(options.body);return reply(decision);}});
  model.setCharacter(h.cfg);
  await model.publicComment({video: {...video(1), localPath: 'PRIVATE_PATH'}, analysis: {...review,
    perception: {transcript: '口播'.repeat(5000)}}, comments, target: {id: id(12), rootId: id(1), text: '问题'}, maxChars: 100});
  const payload = JSON.parse(body.input.find(i => i.role === 'user').content[0].text);
  assert.equal(payload.comments[0].id, root.id); assert.ok(payload.comments.length <= 4);
  assert.ok(payload.analysis.perception.transcript.length <= 600);
  assert.doesNotMatch(JSON.stringify(body), /SECRET|UNRELATED|PRIVATE_PATH/);
  assert.equal(compactThread(comments, {id: id(12), rootId: id(1)})[0].text, root.text);
});

test('已有页面字幕时不转写；画面不再单独调用 OCR 模型', async t => {
  const h = setup(t); h.cfg.understanding.enabled = true;
  const u = new VideoUnderstanding(h.home, h.cfg); let transcribes = 0, ocr = 0;
  u.transcribe = async () => {transcribes++;return {text: '不应调用'};};
  const frames = ['FRAME']; frames.audioCapture = {base64: 'Zg==', captions: [{text: '页面实际字幕'}], seconds: 8};
  const model = {visibleCaptions: async () => {ocr++;return {text: '不应调用'};}};
  const result = await u.process(video(1), frames, model);
  assert.equal(result.status, 'captions_only'); assert.equal(transcribes, 0); assert.equal(ocr, 0);
  const noText = ['FRAME']; noText.audioCapture = {error: '没有音轨'};
  await u.process(video(2), noText, model); assert.equal(ocr, 0);
});

test('全片音频转写保留完整长文本，短片与私信沿用原有裁剪', async t => {
  const h = setup(t), file = join(h.home, 'audio.webm'), text = '已识别的完整发言。'.repeat(1600);
  writeFileSync(file, 'fake-audio');
  const u = new VideoUnderstanding(h.home, h.cfg, {fetchImpl: async () => new Response(JSON.stringify({text, duration: 600}))});
  assert.equal((await u.transcribe(file, {full: true})).text, text);
  assert.equal((await u.transcribe(file)).text.length, 12000);
});

const dailySummary = videos => ({overview: '今天记录了具体的毛线造型。', themes: [{title: '手工', summary: '实际画面中的造型', videoIds: videos.map(v => v.id)}],
  highlights: [], reflections: ['继续观察做法'], limitations: ['只依据采样证据']});
test('逐条日志及时落盘，晚间每角色只定时总结一次；次日补齐最后记录', async t => {
  const h = setup(t); h.cfg.journal.summaryMode = 'evening';
  let now = new Date('2026-10-30T12:40:00Z'), calls = 0;
  h.store.data.videos = [{...video(1), provider: 'openai', day: '2026-10-30', analysis: {...review,
    perception: {transcript: '原始口播'.repeat(1000)}}}];
  const model = {config: {model: 'gpt-6-luna'}, dailySummary: async ({videos}) => {calls++;assert.ok(videos[0].analysis.perception.transcript.length <= 160);return dailySummary(videos);}};
  const journal = new DailyJournal({...h, models: {openai: model}, now: () => now, log: () => {}});
  await journal.tick(); assert.equal(calls, 0);
  assert.match(readFileSync(join(h.home, 'reports/2026-10-30.md'), 'utf8'), /毛线/);
  now = new Date('2026-10-30T12:46:00Z'); await journal.tick(); assert.equal(calls, 1);
  h.store.data.videos.push({...video(2), provider: 'openai', day: '2026-10-30', analysis: {...review, perception: {transcript: '新增口播'}}});
  now = new Date('2026-10-30T13:30:00Z'); await journal.tick(); assert.equal(calls, 1);
  assert.match(readFileSync(join(h.home, 'reports/2026-10-30.videos.json'), 'utf8'), /原始口播原始口播/);
  now = new Date('2026-10-30T16:05:00Z'); await journal.tick(); assert.equal(calls, 2);
});

test('费用记录包含缓存写入和推理用量，异常计数不低估为零', t => {
  const h = setup(t), u = {input_tokens: 12000, output_tokens: 100, input_tokens_details: {
    cached_tokens: 4000, cache_write_tokens: 7000, cache_write_tokens_details: {ttl_30m_tokens: 3000, ttl_12h_tokens: 4000}},
    output_tokens_details: {reasoning_tokens: 60}};
  assert.equal(usageCost('gpt-6-luna', u), (1000 * .1 + 4000 * .01 + 3000 * .125 + 4000 * .25 + 100 * .5) / 1e6);
  const meter = new UsageMeter(h.home, {settings: {enabled: false}});
  const key = meter.begin('openai', 'test', 'gpt-6-luna'); meter.finish(key, {usage: u});
  assert.equal(meter.read().records[0].usage.input_tokens_details.cache_write_tokens, 7000);
  assert.equal(meter.read().records[0].usage.output_tokens_details.reasoning_tokens, 60);
  const invalid = {...u, input_tokens_details: {...u.input_tokens_details, cached_tokens: -1}};
  assert.equal(usageCost('gpt-6-luna', invalid), null);
  const other = meter.begin('openai', 'test', 'gpt-6-luna'); meter.finish(other, {usage: invalid});
  assert.equal(meter.read().records[1].usd, null);
});

const parsedVideo = {summary: '开头与结尾出现不同造型', evidence: '时间标记截图', recommend: true, confidence: .8,
  timeline: [{startSeconds: 0, endSeconds: 12, observation: '画面造型变化', source: 'visual'}],
  limitations: ['画面仍为抽样，可能遗漏瞬间细节'], refineTimes: []};
test('Codex 使用独立无工具 CLI，拒绝不可信链接与虚构音频范围', () => {
  const args = codexArguments({folder: '/local', schema: '/local/schema', output: '/local/out', model: 'gpt-6-luna', images: ['/local/one.jpg']});
  assert.ok(args.includes('--ignore-user-config')); assert.ok(args.includes('--ephemeral'));
  assert.ok(args.includes('--no-daemon')); assert.ok(args.includes('read-only'));
  assert.ok(args.includes('shell_tool')); assert.ok(args.includes('multi_agent'));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  for (const url of ['http://www.douyin.com/video/' + id(1), 'https://evil.test/video/' + id(1), 'https://www.douyin.com/user/self']) assert.throws(() => publicVideoUrl(url));
  assert.throws(() => validateVideoAnalysis({...parsedVideo, timeline: [{...parsedVideo.timeline[0], source: 'audio'}]}, 12, {transcriptionComplete: false}), /未转写/);
  assert.throws(() => validateVideoAnalysis({...parsedVideo, refineTimes: [15]}, 12, {}), /补帧/);
});

test('链接解析结果跨角色复用，失败退避，Codex 消耗不冒算成 API 费用', async t => {
  const h = setup(t); let collects = 0, parses = 0;
  const analyzer = new VideoAnalysis({...h, dy: {}, transcriber: {},
    collect: async () => {collects++;return {durationSeconds: 12, frames: [{at: 0}, {at: 11.8}], sheets: ['MOCK_IMAGE'], audio: {present: false}, transcripts: []};},
    run: async (_command, args) => {
      parses++; writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(parsedVideo));
      return {code: 0, stdout: JSON.stringify({type: 'turn.completed', usage: {input_tokens: 100, output_tokens: 50}}), stderr: ''};
    }});
  const first = await analyzer.analyze(video(1)), second = await analyzer.analyze(video(1));
  assert.deepEqual(first, second); assert.equal(collects, 1); assert.equal(parses, 1);
  assert.equal(first.coverage.transcriptionComplete, false);
  assert.equal(JSON.parse(readFileSync(analyzer.file(id(1)), 'utf8')).usageSource, 'codex-account');
  const failing = new VideoAnalysis({...h, dy: {}, transcriber: {}, collect: async () => {throw new Error('采集失败');}});
  await assert.rejects(failing.analyze(video(2)), /采集失败/);
  await assert.rejects(failing.analyze(video(2)), /退避/);
  assert.ok(failing.deferredIds().includes(id(2)));
});

test('长视频解析等待期间继续轮询私信和评论，完成后不遗留定时器', async t => {
  const h = setup(t), engine = new Engine({...h, gpt: {}, dy: {}, messenger: {}, log: () => {}});
  let polls = 0, commentPolls = 0;
  engine.pollReplies = async () => {polls++;};
  engine.engagement = {poll: async () => {commentPolls++;}};
  engine.videoAnalysis = {analyze: async () => new Promise(resolve => setTimeout(() => resolve({codex: parsedVideo}), 25))};
  assert.equal((await engine.analyzeVideo(video(1), undefined, 3)).codex.summary, parsedVideo.summary);
  assert.ok(polls >= 1); assert.equal(polls, commentPolls);
});

test('千条观看记录按本机主题统计压缩，模型不重复输出全量 ID，日志仍完整覆盖', async t => {
  const h = setup(t); let body;
  const videos = Array.from({length: 1000}, (_, n) => ({...video(n + 1), analysis: {...review,
    interest: {score: 1, topics: ['手工' + n % 12], reason: '实际画面支持'}}}));
  const model = new Gpt({apiKey: 'FAKE', model: 'gpt-6-luna', baseUrl: 'https://example.test'},
    {fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      const input = JSON.parse(body.input.find(i => i.role === 'user').content[0].text);
      assert.equal(input.totalVideos, 1000); assert.ok(input.groups.length <= 10);
      assert.ok(input.groups.every(g => !g.videoIds && g.examples.length <= 3));
      return reply({overview: '依据代表样本归纳具体的手工造型。', themes: input.groups.map(g => ({
        groupId: g.groupId, title: g.topic, summary: '示例中可见毛线造型。'})), highlights: [],
        reflections: ['继续观察细节'], limitations: ['综合总结使用代表样本。']});
    }});
  model.setCharacter(h.cfg);
  const result = await model.dailySummary({day: '2026-10-30', videos});
  const ids = result.themes.flatMap(t => t.videoIds);
  assert.equal(ids.length, 1000); assert.equal(new Set(ids).size, 1000);
  assert.ok(body.input.find(i => i.role === 'user').content[0].text.length < 18000);
  assert.match(result.limitations.at(-1), /全量视频另有逐条记录/);
});
