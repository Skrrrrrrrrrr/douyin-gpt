import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {UsageMeter,audioReservation,reservedCost} from '../src/usage.mjs';
import {defaultConfig} from '../src/config.mjs';
import {atomicJson} from '../src/store.mjs';
import {VideoUnderstanding} from '../src/understanding.mjs';

function setup(t,limit=3){const home=mkdtempSync(join(tmpdir(),'dy-usage-reserve-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const cfg=defaultConfig();cfg.budget={enabled:true,limitsUSD:{openai:limit,deepseek:1.5},prices:{}};atomicJson(join(home,'config.json'),cfg);return {home,cfg,meter:new UsageMeter(home)};}
test('完整音频时长向上取整作费用预留，未知模型或未知时长不猜费用',()=>{
 const r=audioReservation('gpt-transcribe',108.31);assert.equal(r.seconds,109);assert.ok(r.usd>=108.31/60*.0045);assert.equal(audioReservation('unknown-model',10),null);assert.equal(audioReservation('gpt-transcribe',0),null);assert.equal(audioReservation('gpt-transcribe',NaN),null);
});
test('取消的已知时长转写仍为unknown，但预留完整请求费用后不锁死GPT',async t=>{
 const h=setup(t);await assert.rejects(h.meter.measure('openai','transcription','gpt-transcribe',async()=>{throw new Error('aborted');},{seconds:108.31}),/aborted/);
 const r=h.meter.read().records[0];assert.equal(r.status,'unknown');assert.equal(r.usd,null);assert.ok(r.reservation.usd>0);assert.doesNotThrow(()=>h.meter.assertAvailable('openai','gpt-6-luna'));
 const s=h.meter.summary().providers[0];assert.equal(s.unknown,1);assert.equal(s.blockingUnknown,0);assert.equal(s.estimatedUSD,0);assert.equal(s.reservedUSD,r.reservation.usd);
});
test('未知文本请求和无时长音频继续阻止请求，不能作为零消费放行',t=>{
 const h=setup(t);const id=h.meter.begin('openai','chat_reply','gpt-6-luna');h.meter.finish(id,{status:'unknown'});assert.throws(()=>h.meter.assertAvailable('openai','gpt-6-luna'),e=>e.code==='BUDGET_UNKNOWN');
 const b=setup(t),audio=b.meter.begin('openai','transcription','gpt-transcribe');b.meter.finish(audio,{status:'unknown'});assert.throws(()=>b.meter.assertAvailable('openai','gpt-6-luna'),e=>e.code==='BUDGET_UNKNOWN');
});
test('预留参与预算，超过剩余额度的转写在发送HTTP前被拦截',async t=>{
 const h=setup(t,.001);let started=false;await assert.rejects(h.meter.measure('openai','transcription','gpt-transcribe',async()=>{started=true;},{seconds:60}),e=>e.code==='BUDGET_EXCEEDED');assert.equal(started,false);assert.equal(h.meter.read().records.length,0);
});
test('在途转写可预留，未估算的在途文本仍保持原预算串行保护',t=>{
 const h=setup(t),id=h.meter.begin('openai','transcription','gpt-transcribe',{seconds:30});assert.doesNotThrow(()=>h.meter.assertAvailable('openai','gpt-6-luna'));h.meter.begin('openai','chat_reply','gpt-6-luna');assert.throws(()=>h.meter.assertAvailable('openai','gpt-6-luna'),e=>e.code==='BUDGET_UNKNOWN');assert.equal(h.meter.read().records.find(r=>r.id===id).status,'pending');
});
test('成功返回duration usage后用实际秒数计价，已拒绝请求释放预留',t=>{
 const h=setup(t),id=h.meter.begin('openai','transcription','gpt-transcribe',{seconds:30});h.meter.finish(id,{usage:{type:'duration',seconds:20.5}});assert.equal(h.meter.read().records[0].usd,20.5/60*.0045);assert.equal(h.meter.summary().providers[0].reservedUSD,0);
 const failed=h.meter.begin('openai','transcription','gpt-transcribe',{seconds:30});h.meter.finish(failed,{status:'failed'});assert.equal(h.meter.read().records.at(-1).usd,0);assert.equal(h.meter.summary().providers[0].reservedUSD,0);
});
test('补核旧取消记录保留原状态及账单未知，需可靠音频依据且不能重复补核',t=>{
 const h=setup(t),id=h.meter.begin('openai','transcription','gpt-transcribe');h.meter.finish(id,{status:'unknown'});assert.throws(()=>h.meter.reserveUncertainAudio(id,108.31),/依据/);
 const proof={sha256:createHash('sha256').update('verified audio').digest('hex'),reason:'local input duration confirmed'};h.meter.reserveUncertainAudio(id,108.31,proof);const r=h.meter.read().records[0];assert.equal(r.status,'unknown');assert.equal(r.usd,null);assert.ok(r.reservation.evidenceSha256);assert.doesNotThrow(()=>h.meter.assertAvailable('openai','gpt-6-luna'));assert.throws(()=>h.meter.reserveUncertainAudio(id,108.31,proof),/已有预留/);
});
test('零金额、错误模型、错误单位或被篡改预留均不能放宽保护',()=>{
 const r={kind:'transcription',model:'gpt-transcribe',reservation:audioReservation('gpt-transcribe',30)};assert.ok(reservedCost(r)>0);for(const patch of [{usd:0},{usd:1},{seconds:0},{model:'another'},{basis:'not-audio'}])assert.equal(reservedCost({...r,reservation:{...r.reservation,...patch}}),null);assert.equal(reservedCost({...r,kind:'chat_reply'}),null);
});
test('真实转写适配器在调用fetch前持久化输入时长，取消后仍可执行聊天',async t=>{
 const h=setup(t),oldHome=process.env.DOUYIN_GPT_HOME;process.env.DOUYIN_GPT_HOME=h.home;t.after(()=>{if(oldHome===undefined)delete process.env.DOUYIN_GPT_HOME;else process.env.DOUYIN_GPT_HOME=oldHome;});atomicJson(join(h.home,'openai.json'),{apiKey:'test-only',model:'gpt-6-luna'});const file=join(h.home,'audio.webm');writeFileSync(file,'fixture audio');let fetchCalls=0;
 const transcriber=new VideoUnderstanding(h.home,h.cfg,{fetchImpl:async()=>{fetchCalls++;assert.equal(h.meter.read().records[0].reservation.seconds,109);throw new Error('cancelled by signal');}});
 await assert.rejects(transcriber.transcribe(file,{seconds:108.31}),/cancelled/);assert.equal(fetchCalls,1);assert.equal(h.meter.read().records[0].status,'unknown');assert.doesNotThrow(()=>h.meter.assertAvailable('openai','gpt-6-luna'));
});
