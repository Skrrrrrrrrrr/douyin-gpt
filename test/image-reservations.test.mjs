import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {UsageMeter,imageReservation,reservedCost} from '../src/usage.mjs';
import {Gpt} from '../src/openai.mjs';

const image='data:image/webp;base64,aW1hZ2UtZml4dHVyZS1vbmx5';
const body=(extra={})=>({model:'gpt-6-luna',input:[{role:'user',content:[{type:'input_text',text:'private-fixture-caption'},{type:'input_image',image_url:image,detail:'auto'}]}],max_output_tokens:3000,...extra});
function setup(t,limit=3){const home=mkdtempSync(join(tmpdir(),'dy-image-reserve-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const meter=new UsageMeter(home,{settings:{enabled:true,limitsUSD:{openai:limit,deepseek:1.5}}});return {home,meter};}

test('图片费用按已知模型完整上下文和输出上限预留，不用压缩文件大小猜token',()=>{
 const hold=imageReservation('gpt-6-luna',body());assert.equal(hold.inputTokens,1050000);assert.equal(hold.maxOutput,3000);assert.equal(hold.usd,1.15995);
 const large=body();large.input[0].content[1].image_url+='A'.repeat(12000);assert.deepEqual(imageReservation('gpt-6-luna',large),hold);
 const ds=imageReservation('deepseek-flash',body({model:'deepseek-flash'}));assert.equal(ds.inputTokens,1048576);assert.equal(ds.usd,.3181728);
});
test('图片失败保留未知费用和完整预留，下一条纯文字不再被未知账单锁死',t=>{
 const {meter,home}=setup(t),id=meter.begin('openai','chat_reply','gpt-6-luna',{request:body()});meter.finish(id,{status:'unknown'});
 const r=meter.read().records[0];assert.equal(r.status,'unknown');assert.equal(r.usd,null);assert.equal(reservedCost(r),1.15995);assert.doesNotThrow(()=>meter.assertAvailable('openai','gpt-6-luna'));
 assert.equal(meter.summary().providers[0].blockingUnknown,0);assert.equal(meter.summary().providers[0].reservedUSD,1.15995);assert.doesNotMatch(readFileSync(join(home,'usage.json'),'utf8'),/private-fixture-caption|aW1hZ2UtZml4dHVyZS1vbmx5|data:image/);
});
test('剩余预算不足时图片请求在HTTP前被拦截',async t=>{
 const {meter}=setup(t,.5);let fetched=0;const gpt=new Gpt({apiKey:'fixture-only',baseUrl:'https://api.openai.com/v1',model:'gpt-6-luna'},{fetchImpl:async()=>{fetched++;throw new Error('must not fetch');}});gpt.meter=meter;
 await assert.rejects(gpt.request('chat_reply',{type:'object'},'fixture',{},[image]),e=>e.code==='BUDGET_EXCEEDED');assert.equal(fetched,0);assert.equal(meter.read().records.length,0);
});
test('真实图片适配器先落盘预留，网络取消后可继续请求文字回复',async t=>{
 const {meter}=setup(t);let fetched=0;const gpt=new Gpt({apiKey:'fixture-only',baseUrl:'https://api.openai.com/v1',model:'gpt-6-luna'},{fetchImpl:async()=>{fetched++;assert.ok(reservedCost(meter.read().records.at(-1))>0);throw new Error('fixture connection reset');}});gpt.meter=meter;
 await assert.rejects(gpt.request('chat_reply',{type:'object'},'fixture',{},[image]),/connection reset/);await assert.rejects(gpt.request('chat_reply',{type:'object'},'fixture',{}),/connection reset/);assert.equal(fetched,2);assert.equal(meter.read().records.filter(r=>r.status==='unknown').length,2);
});
test('图片返回usage后释放预留，以实际费用入账；明确拒绝则记为零消费',t=>{
 const {meter}=setup(t),id=meter.begin('openai','chat_reply','gpt-6-luna',{request:body()});meter.finish(id,{usage:{input_tokens:500,output_tokens:100}});assert.equal(meter.summary().providers[0].reservedUSD,0);assert.equal(meter.summary().providers[0].estimatedUSD,.0001);
 const rejected=meter.begin('openai','chat_reply','gpt-6-luna',{request:body()});meter.finish(rejected,{status:'failed'});assert.equal(meter.read().records.at(-1).usd,0);assert.equal(meter.summary().providers[0].reservedUSD,0);
});
test('工具、延续上下文、文件、远程图片及未知模型不能套用图片预留',()=>{
 for(const extra of [{tools:[{type:'web_search'}]},{previous_response_id:'resp_old'},{conversation:'conv_old'},{model:'gpt-unknown'},{max_output_tokens:128001},{service_tier:'unpriced'}]){const r=body(extra);assert.equal(imageReservation(r.model,r),null);}
 for(const content of [[{type:'input_file',file_id:'file_old'}],[{type:'input_image',image_url:'https://example.com/photo.png'}],[{type:'input_audio',input_audio:{data:'fixture'}}]])assert.equal(imageReservation('gpt-6-luna',body({input:[{role:'user',content}]})),null);
});
test('旧图片未知调用核对后仍为unknown，以模型完整输出上限占用额度，不删除历史',t=>{
 const {meter}=setup(t),id=meter.begin('openai','chat_reply','gpt-6-luna');meter.finish(id,{status:'unknown'});assert.throws(()=>meter.assertAvailable('openai','gpt-6-luna'),e=>e.code==='BUDGET_UNKNOWN');assert.throws(()=>meter.reserveUncertainImage(id),/依据/);
 const proof={sha256:'a'.repeat(64),reason:'original cached image and request timestamp verified'};const hold=meter.reserveUncertainImage(id,proof);assert.equal(hold.maxOutput,128000);assert.equal(hold.usd,1.3662);assert.equal(meter.read().records[0].status,'unknown');assert.equal(meter.read().records[0].usd,null);
 const next=meter.begin('openai','chat_reply','gpt-6-luna',{request:body()});assert.equal(meter.read().records.length,2);assert.ok(next);assert.ok(Math.abs(meter.summary().providers[0].reservedUSD-2.52615)<1e-10);assert.throws(()=>meter.reserveUncertainImage(id,proof),/已有预留/);
});
test('被篡改或未知模型的图片预留不放宽预算保护',()=>{
 const record={kind:'chat_reply',model:'gpt-6-luna',reservation:imageReservation('gpt-6-luna',body())};assert.ok(reservedCost(record)>0);
 for(const change of [{usd:0},{inputTokens:1},{maxOutput:128001},{inputRate:0},{model:'gpt-unknown'}])assert.equal(reservedCost({...record,reservation:{...record.reservation,...change}}),null);
 assert.equal(reservedCost({...record,model:'gpt-unknown'}),null);assert.equal(reservedCost({...record,kind:'transcription'}),null);
});
