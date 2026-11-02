import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Gpt,REPLY_SCHEMA} from '../src/openai.mjs';import {UsageMeter} from '../src/usage.mjs';
const response=text=>new Response(JSON.stringify({status:'completed',model:'deepseek-flash',usage:{input_tokens:100,output_tokens:30},output:[{type:'message',content:[{type:'output_text',text}]}]}));
const config={provider:'deepseek',label:'DeepSeek',apiKey:'fixture',model:'deepseek-flash',baseUrl:'https://api.deepseek.com'};
test('DeepSeek首次返回普通台词时只进行一次同模型JSON模式修复，每次请求单独计量',async t=>{
 const home=mkdtempSync(join(tmpdir(),'dy-format-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const bodies=[];
 const gpt=new Gpt(config,{fetchImpl:async(_url,options)=>{bodies.push(JSON.parse(options.body));return response(bodies.length===1?'普通台词':JSON.stringify({shouldReply:true,text:'收到啦。',reason:'回应'}));}});gpt.meter=new UsageMeter(home,{settings:{enabled:true,limitsUSD:{deepseek:1}}});
 const result=await gpt.request('chat_reply',REPLY_SCHEMA,'人物口吻，只写台词',{incoming:[{text:'大肥鱼你好'}]});assert.equal(result.text,'收到啦。');assert.equal(bodies.length,2);assert.equal(bodies[0].text.format.type,'json_schema');assert.equal(bodies[1].text.format.type,'json_object');assert.equal(bodies[1].model,'deepseek-flash');assert.equal(bodies[1].reasoning.effort,'none');assert.equal(gpt.meter.read().records.length,2);assert.ok(gpt.meter.read().records.every(r=>r.status==='completed'));
});
test('格式修复仍失败就抛明确错误，不把普通正文拼成获准回复',async()=>{
 let calls=0;const gpt=new Gpt(config,{fetchImpl:async()=>{calls++;return response('不是JSON');}});await assert.rejects(gpt.request('chat_reply',REPLY_SCHEMA,'test',{}),e=>e.code==='MODEL_OUTPUT_FORMAT');assert.equal(calls,2);
});
test('JSON模式仍校验全部字段类型、必需字段和枚举',async()=>{
 const schema={...REPLY_SCHEMA,properties:{...REPLY_SCHEMA.properties,delivery:{type:'string',enum:['text']}},required:[...REPLY_SCHEMA.required,'delivery']};let calls=0;
 const gpt=new Gpt(config,{fetchImpl:async()=>{calls++;return response(JSON.stringify({shouldReply:true,text:'内容',reason:'回应',delivery:'external_command'}));}});await assert.rejects(gpt.request('chat_reply',schema,'test',{}),e=>e.code==='MODEL_OUTPUT_SCHEMA');assert.equal(calls,2);
});
test('拒绝、未完成和HTTP错误不触发格式重试，也不切换到GPT',async()=>{
 for(const data of [{status:'incomplete',output:[]},{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}]}]){let calls=0;const gpt=new Gpt(config,{fetchImpl:async()=>{calls++;return new Response(JSON.stringify(data));}});await assert.rejects(gpt.request('chat_reply',REPLY_SCHEMA,'test',{}));assert.equal(calls,1);}
 let calls=0;const gpt=new Gpt(config,{fetchImpl:async()=>{calls++;return new Response('{}',{status:429});}});await assert.rejects(gpt.request('chat_reply',REPLY_SCHEMA,'test',{}));assert.equal(calls,1);
});
