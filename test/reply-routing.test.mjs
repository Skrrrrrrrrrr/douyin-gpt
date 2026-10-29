import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConfig,validateConfig} from '../src/config.mjs';
import {Store} from '../src/store.mjs';
import {Engine,selectReplyProvider} from '../src/engine.mjs';
import {Gpt} from '../src/openai.mjs';

const contact={secUid:'MS4wLjABAAAA_ROUTING_CONTACT',label:'大肥鱼朋友',enabled:true};
function harness(t){
  const home=mkdtempSync(join(tmpdir(),'dy-routing-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const cfg=defaultConfig();cfg.reply.contacts=[contact];cfg.reply.routing.enabled=true;cfg.deepseek.enabled=true;
  cfg.browse.enabled=false;cfg.journal.enabled=false;cfg.account.secUid='MS4wLjABAAAA_ROUTING_OWNER';
  const old={id:'old',from:'them',text:'历史消息'},store=new Store(home);store.baseline(contact.secUid,[old]);
  const state={messages:[old,{id:'new',from:'them',text:'你好'}],calls:[],sends:[],reads:0};
  const models=Object.fromEntries(['openai','deepseek'].map(provider=>[provider,{
    config:{model:provider==='openai'?'gpt-6.1-terra':'deepseek-flash'},
    reply:async input=>{state.calls.push({provider,kind:'reply',input});return {shouldReply:true,text:`${provider} 回复`,reason:'回应新消息'};},
    analyze:async()=>{state.calls.push({provider,kind:'analyze'});return {summary:`${provider} 画面分析`,evidence:'抽样画面',recommend:false,confidence:0.8};},
  }]));
  const messenger={read:async()=>{state.reads++;return structuredClone(state.messages);},send:async(c,text)=>{state.sends.push({contactId:c.secUid,text});state.messages.push({id:`mine-${state.sends.length}`,from:'me',text});}};
  const dy={checkAccount:async()=>({}),detail:async id=>({id,desc:'测试视频'}),watch:async()=>[]};
  const engine=new Engine({home,cfg,store,gpt:models.openai,models,dy,messenger,live:true,log:()=>{}});
  return {home,cfg,store,state,models,messenger,dy,engine};
}

test('旧配置默认保持 GPT；路由只接受布尔开关和非空关键词',()=>{
  const cfg=defaultConfig();delete cfg.reply.routing;validateConfig(cfg);assert.equal(cfg.reply.routing.enabled,false);
  cfg.reply.routing.deepseekKeyword=' ';assert.throws(()=>validateConfig(cfg),/关键词/);
  cfg.reply.routing.deepseekKeyword='大肥鱼';cfg.reply.routing.enabled='true';assert.throws(()=>validateConfig(cfg),/布尔/);
});
test('只匹配单条新消息中的连续文字，不跨消息拼接或使用非文字字段',()=>{
  const rule={enabled:true,deepseekKeyword:'大肥鱼'};
  assert.equal(selectReplyProvider([{text:'嗨，大肥鱼！'}],rule),'deepseek');
  assert.equal(selectReplyProvider([{text:'大肥'},{text:'鱼'}],rule),'openai');
  assert.equal(selectReplyProvider([{item:'大肥鱼'}],rule),'openai');
  assert.equal(selectReplyProvider([{text:'大肥鱼'}],{...rule,enabled:false}),'openai');
});
test('同一联系人连续新消息可交替使用 DeepSeek 和 GPT；记录真实模型且重启不重复',async t=>{
  const h=harness(t);h.state.messages.at(-1).text='大肥鱼，你好';
  await h.engine.pollReplies();
  assert.equal(h.store.data.outbox[0].provider,'deepseek');assert.equal(h.store.data.outbox[0].model,'deepseek-flash');
  h.state.messages.push({id:'normal-next',from:'them',text:'普通问题'});await h.engine.pollReplies();
  assert.deepEqual(h.state.calls.map(c=>c.provider),['deepseek','openai']);assert.equal(h.state.sends.length,2);
  h.engine.store=new Store(h.home);await h.engine.pollReplies();assert.equal(h.state.sends.length,2);
});
test('历史和联系人昵称中的大肥鱼不会误触发，已处理的旧来信也不会影响路由',async t=>{
  const h=harness(t);h.state.messages[0].text='大肥鱼，历史内容';
  await h.engine.pollReplies();assert.equal(h.state.calls[0].provider,'openai');
  assert.equal(h.state.calls.length,1);
});
test('一次多条未处理消息中任一条命中就选择 DeepSeek，超过十条也不会漏掉路由触发',async t=>{
  const h=harness(t);h.state.messages=[h.state.messages[0],...Array.from({length:12},(_,i)=>({id:`new-${i}`,from:'them',text:i===0?'大肥鱼':'补充'}))];
  await h.engine.pollReplies();assert.equal(h.state.calls.length,1);assert.equal(h.state.calls[0].provider,'deepseek');
  assert.equal(h.state.calls[0].input.incoming.length,10);
});
test('DeepSeek 关闭或接口失败时保留输入，不转给 GPT，恢复后仍按规则处理',async t=>{
  const h=harness(t);h.state.messages.at(-1).text='大肥鱼，在吗';h.cfg.deepseek.enabled=false;
  await h.engine.pollReplies();assert.equal(h.state.calls.length,0);assert.equal(h.store.contact(contact.secUid).seen.includes('new'),false);
  h.cfg.deepseek.enabled=true;const reply=h.models.deepseek.reply;
  h.models.deepseek.reply=async()=>{throw new Error('DeepSeek HTTP 429');};await h.engine.pollReplies();
  assert.equal(h.state.calls.length,0);assert.equal(h.state.sends.length,0);assert.equal(h.store.contact(contact.secUid).seen.includes('new'),false);
  h.models.deepseek.reply=reply;await h.engine.pollReplies();assert.equal(h.state.sends.length,1);assert.equal(h.store.data.outbox[0].provider,'deepseek');
});
test('两个模型共用私信每日额度，额度用尽时不会因换模型继续发送',async t=>{
  const h=harness(t);h.cfg.reply.perContactPerDay=1;h.state.messages.at(-1).text='大肥鱼';await h.engine.pollReplies();
  h.state.messages.push({id:'gpt-next',from:'them',text:'普通消息'});await h.engine.pollReplies();
  assert.equal(h.state.sends.length,1);assert.equal(h.state.calls.length,1);assert.equal(h.store.quota(contact.secUid,h.cfg.reply),0);
});
test('GPT 生成期间出现带关键词的新消息，取消旧回复，下轮交给 DeepSeek',async t=>{
  const h=harness(t),reply=h.models.openai.reply;
  h.models.openai.reply=async input=>{const value=await reply(input);h.state.messages.push({id:'new-trigger',from:'them',text:'大肥鱼，你来答'});return value;};
  await h.engine.pollReplies();assert.equal(h.state.sends.length,0);assert.equal(h.store.data.outbox[0].status,'superseded');
  await h.engine.pollReplies();assert.equal(h.state.sends.length,1);assert.equal(h.store.data.outbox.at(-1).provider,'deepseek');
});
test('DeepSeek 发送结果不明时仍暂停该联系人，不能换 GPT 重复发送',async t=>{
  const h=harness(t);h.state.messages.at(-1).text='大肥鱼';h.messenger.send=async()=>{throw new Error('回读超时');};
  await h.engine.pollReplies();assert.equal(h.store.data.outbox[0].status,'uncertain');assert.equal(h.store.data.outbox[0].provider,'deepseek');
  h.state.messages.push({id:'other',from:'them',text:'普通问题'});await h.engine.pollReplies();assert.equal(h.state.calls.length,1);
});
test('命中消息中的视频卡片也由 DeepSeek 分析，近期视频仅使用所选模型记录',async t=>{
  const h=harness(t);h.state.messages.at(-1).text='大肥鱼看看这个';h.state.messages.at(-1).item='7400000000000000001';
  const analysis={summary:'视频记录',evidence:'画面',recommend:false,confidence:0.8};
  h.store.addVideo({id:'7400000000000000002',desc:'GPT视频'},analysis,{provider:'openai'});
  h.store.addVideo({id:'7400000000000000003',desc:'DeepSeek视频'},analysis,{provider:'deepseek'});
  await h.engine.pollReplies();
  assert.deepEqual(h.state.calls.map(c=>[c.provider,c.kind]),[['deepseek','analyze'],['deepseek','reply']]);
  const input=h.state.calls.at(-1).input;assert.equal(input.sharedVideo.analysis.summary,'deepseek 画面分析');
  assert.deepEqual(input.recentVideos.map(v=>v.desc),['DeepSeek视频']);
});
test('预览和名单限制对 DeepSeek 同样有效，不消耗输入、不向陌生人发信',async t=>{
  const h=harness(t);h.state.messages.at(-1).text='大肥鱼';h.engine.live=false;await h.engine.pollReplies();
  assert.equal(h.engine.previews[0].provider,'deepseek');assert.equal(h.state.sends.length,0);assert.equal(h.store.contact(contact.secUid).seen.includes('new'),false);
  h.engine.live=true;h.cfg.reply.contacts[0]={...contact,enabled:false};await h.engine.pollReplies();assert.equal(h.state.calls.length,1);
});
test('DeepSeek 私信请求使用自己的身份和同一私信人设，不自称 GPT',async()=>{
  let request;
  const model=new Gpt({apiKey:'TEST',model:'deepseek-flash',label:'DeepSeek',baseUrl:'https://api.deepseek.com'},{fetchImpl:async(_url,options)=>{
    request=JSON.parse(options.body);return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({shouldReply:true,text:'我是账号配置的 DeepSeek 助手。',reason:'回答身份'})}]}]}));
  }});
  await model.reply({contact,history:[],incoming:[{text:'大肥鱼，你是谁？'}],recentVideos:[],sharedVideo:null,maxChars:240});
  assert.equal(request.model,'deepseek-flash');assert.match(request.instructions,/DeepSeek 助手/);assert.doesNotMatch(request.instructions,/GPT 助手|\{\{MODEL_NAME\}\}/);
});
