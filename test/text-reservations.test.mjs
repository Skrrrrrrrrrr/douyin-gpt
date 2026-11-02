import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {UsageMeter,textReservation,reservedCost,usageCost} from '../src/usage.mjs';
import {Gpt} from '../src/openai.mjs';
import {atomicJson} from '../src/store.mjs';

const request=(extra={})=>({model:'gpt-6-luna',instructions:'fixture instructions',input:[{role:'user',content:[{type:'input_text',text:'test-only-private-text'}]}],max_output_tokens:800,...extra});
function fixture(t,limit=3){const home=mkdtempSync(join(tmpdir(),'dy-text-reserve-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const meter=new UsageMeter(home,{settings:{enabled:true,limitsUSD:{openai:limit}}});return {home,meter};}
test('纯文本费用预留覆盖最大输出、缓存写入与长上下文，原提示不写入用量文件',t=>{
 const {meter,home}=fixture(t),body=request(),id=meter.begin('openai','private_reply',body.model,{request:body});const record=meter.read().records.find(r=>r.id===id);assert.ok(reservedCost(record)>0);
 const actual=usageCost(body.model,{input_tokens:200,output_tokens:800,input_tokens_details:{cached_tokens:0,cache_write_tokens:100,cache_write_tokens_details:{ttl_30m_tokens:0,ttl_12h_tokens:100}}});assert.ok(record.reservation.usd>actual);assert.doesNotMatch(readFileSync(join(home,'usage.json'),'utf8'),/test-only-private-text|fixture instructions/);
});
test('取消纯文本请求后保留unknown与预留，后续聊天仍受剩余预算约束',t=>{
 const {meter}=fixture(t),body=request(),id=meter.begin('openai','reply',body.model,{request:body});meter.finish(id,{status:'unknown'});assert.equal(meter.read().records[0].usd,null);assert.equal(meter.read().records[0].status,'unknown');assert.doesNotThrow(()=>meter.assertAvailable('openai',body.model));assert.equal(meter.summary().providers[0].blockingUnknown,0);assert.ok(meter.summary().providers[0].reservedUSD>0);
});
test('无法界定的图片、未知模型与无上限请求保留原阻塞保护',()=>{
 assert.equal(textReservation('gpt-6-luna',request({input:[{role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,eA=='}]}]})),null);
 assert.equal(textReservation('unknown',request({model:'unknown'})),null);assert.equal(textReservation('gpt-6-luna',request({max_output_tokens:undefined})),null);
});
test('发送前先核对费用预留，剩余预算不足时没有HTTP请求',async t=>{
 const {meter}=fixture(t,.00001);let fetched=0;const gpt=new Gpt({apiKey:'fixture-only',baseUrl:'https://api.openai.com/v1',model:'gpt-6-luna'} ,{fetchImpl:async()=>{fetched++;throw new Error('should not run');}});gpt.meter=meter;
 await assert.rejects(gpt.request('fixture',{type:'object'},'fixture',{}),e=>e.code==='BUDGET_EXCEEDED');assert.equal(fetched,0);assert.equal(meter.read().records.length,0);
});
test('真实请求适配器在HTTP前落盘预留，取消后下一次仍可发起且没有重复发送',async t=>{
 const {meter}=fixture(t);let fetched=0;const gpt=new Gpt({apiKey:'fixture-only',baseUrl:'https://api.openai.com/v1',model:'gpt-6-luna'},{fetchImpl:async()=>{fetched++;assert.ok(meter.read().records.at(-1).reservation);throw new Error('aborted');}});gpt.meter=meter;
 await assert.rejects(gpt.request('fixture',{type:'object'},'fixture',{}),/aborted/);await assert.rejects(gpt.request('fixture',{type:'object'},'fixture',{}),/aborted/);assert.equal(fetched,2);assert.equal(meter.read().records.filter(r=>r.status==='unknown').length,2);
});
test('调用进程退出只把pending转为unknown，保留预留和无法估算的旧调用',t=>{
 const {home,meter}=fixture(t),body=request(),id=meter.begin('openai','reply',body.model,{request:body}),data=meter.read();data.records[0].ownerPid=2147483647;data.records.push({id:'legacy',provider:'openai',model:body.model,status:'pending',day:data.records[0].day,usd:null});atomicJson(join(home,'usage.json'),data);
 assert.equal(meter.recover(),1);const record=meter.read().records.find(r=>r.id===id);assert.equal(record.status,'unknown');assert.ok(record.reservation);assert.equal(meter.read().records.find(r=>r.id==='legacy').status,'pending');assert.throws(()=>meter.assertAvailable('openai',body.model),e=>e.code==='BUDGET_UNKNOWN');
});
test('有效结果用实际账单替代预留，篡改的预留不得放行',t=>{
 const {meter}=fixture(t),body=request(),id=meter.begin('openai','reply',body.model,{request:body}),record=meter.read().records[0];assert.equal(reservedCost({...record,reservation:{...record.reservation,usd:0}}),null);assert.equal(reservedCost({...record,reservation:{...record.reservation,inputTokens:1}}),null);
 meter.finish(id,{usage:{input_tokens:200,output_tokens:80}});assert.equal(meter.summary().providers[0].reservedUSD,0);assert.ok(meter.summary().providers[0].estimatedUSD>0);
});
