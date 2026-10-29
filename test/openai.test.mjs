import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gpt, parseResponse } from '../src/openai.mjs';

function response(value) { return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }; }
test('Responses 请求正确编码图片和 JSON schema，不向模型提供发送工具', async t => {
  let received;
  const server = createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    received = { path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(parts).toString()) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response({ summary: '画面有一只猫', evidence: '截图', recommend: true, confidence: 0.8 })));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const dir = mkdtempSync(join(tmpdir(), 'dy-gpt-api-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const png = join(dir, 'frame.png'); writeFileSync(png, Buffer.from([137, 80, 78, 71]));
  const model = new Gpt({ apiKey: 'fake-test-key', model: 'test-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
  const result = await model.analyze({ id: '7400000000000000001' }, [png], ['猫']);
  assert.equal(result.summary, '画面有一只猫');
  assert.equal(received.path, '/v1/responses');
  assert.equal(received.headers.authorization, 'Bearer fake-test-key');
  assert.equal(received.body.store, false);
  assert.equal(received.body.text.format.strict, true);
  assert.equal(received.body.text.format.type, 'json_schema');
  assert.equal(received.body.tools, undefined);
  assert.match(received.body.input[0].content[1].image_url, /^data:image\/png;base64,/);
});
test('空内容、拒绝、未完成和损坏 JSON 均不会被当成回复', () => {
  assert.throws(() => parseResponse({ status: 'incomplete', output: [] }));
  assert.throws(() => parseResponse({ status: 'completed', output: [] }));
  assert.throws(() => parseResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }));
  assert.throws(() => parseResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'not-json' }] }] }));
});
test('过长回复与无效 schema 字段被拒绝', async () => {
  const fake = value => async () => new Response(JSON.stringify(response(value)), { status: 200 });
  const model = new Gpt({ apiKey: 'test', model: 'test', baseUrl: 'https://api.openai.com/v1' }, { fetchImpl: fake({ shouldReply: true, text: '太长的内容', reason: '' }) });
  const payload = { contact: {}, history: [], incoming: [], recentVideos: [], maxChars: 2 };
  await assert.rejects(model.reply(payload), /字数/);
  model.fetch = fake({ shouldReply: 'yes', text: '好', reason: '' });
  await assert.rejects(model.reply(payload), /类型/);
});
test('接口错误不包含凭证或完整上游响应', async () => {
  const model = new Gpt({ apiKey: 'SECRET_TEST', model: 'test', baseUrl: 'https://api.openai.com/v1' }, { fetchImpl: async () => new Response('sensitive', { status: 401 }) });
  await assert.rejects(model.analyze({}, []), error => error.message.includes('401') && !error.message.includes('SECRET_TEST') && !error.message.includes('sensitive'));
});
test('禁止把密钥发往明文远程接口', () => {
  assert.throws(() => new Gpt({ apiKey: 'test', model: 'test', baseUrl: 'http://example.com/v1' }), /HTTPS/);
});
test('停止信号会取消正在进行的 GPT 请求', async () => {
  const controller = new AbortController();
  const model = new Gpt({ apiKey: 'test', model: 'test', baseUrl: 'https://api.openai.com/v1' }, {
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      if (options.signal.aborted) reject(new Error('cancelled'));
      else options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }),
  });
  model.signal = controller.signal;
  const pending = model.analyze({}, []);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});
test('公开评论只发送公开上下文，不包含私信人设；链接和无依据的超长输出被拒绝', async () => {
  let request;
  const model=new Gpt({apiKey:'test',model:'gpt-6.1-terra',baseUrl:'https://api.openai.com/v1'}, {fetchImpl:async (_url,options)=>{
    request=JSON.parse(options.body);
    return new Response(JSON.stringify(response({shouldPost:true,text:'这个挂件的造型挺有意思。',reason:'具体观察',confidence:0.9})),{status:200});
  }});
  model.persona='SECRET_PRIVATE_CHAT_PERSONA';
  const result=await model.publicComment({video:{id:'7400000000000000001'},analysis:{summary:'挂件'},comments:[],maxChars:100});
  assert.equal(result.shouldPost,true);assert.equal(JSON.stringify(request).includes('SECRET_PRIVATE_CHAT_PERSONA'),false);
  assert.equal(request.model,'gpt-6.1-terra');assert.equal(request.text.format.name,'public_video_comment');
  model.fetch=async()=>new Response(JSON.stringify(response({shouldPost:true,text:'https://example.com',reason:'',confidence:0.9})),{status:200});
  await assert.rejects(model.publicComment({video:{},maxChars:100}),/不允许/);
});
