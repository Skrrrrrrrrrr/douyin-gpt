import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {dayKey} from './config.mjs';
import {readState,updateState} from './state-file.mjs';
const empty={version:1,startedAt:'',records:[]};
// A timeout or server failure does not establish that a request consumed no resources.
export const requestDefinitelyRejected=status=>[400,401,403,404,405,413,415,422,429].includes(status);
export const PRICE_DATE='2026-10-30';
export const PRICES={'gpt-transcribe':{perMinute:.0045,source:'https://developers.openai.com/api/docs/pricing',basis:'按实际采集片段秒数估算'},'gpt-6-luna':{input:.1,cached:.01,output:.5,cacheWrite30m:.125,cacheWrite12h:.25,longContextThreshold:272000,source:'https://developers.openai.com/api/docs/models/gpt-6-luna',basis:'标准服务价格，含缓存写入费'},'gpt-6.1-terra':{input:1,cached:.05,output:5,cacheWrite30m:1.25,cacheWrite12h:2.5,longContextThreshold:272000,source:'https://developers.openai.com/api/docs/models/gpt-6.1-terra',basis:'标准服务价格'},'deepseek-flash':{input:.3,cached:.006,output:1.2,source:'https://api-docs.deepseek.com/quick_start/pricing/',basis:'按峰值价格上限估算，未扣除非高峰优惠'}};
function number(value){return Number.isSafeInteger(value)&&value>=0?value:null;}
const modelRate=(model,prices)=>prices[Object.keys(prices).sort((a,b)=>b.length-a.length).find(k=>model===k||model.startsWith(k+'-'))];
// Images share the model's context limit. Reserve the whole context rather than
// guessing image tokens from file size, dimensions, or a different model's rules.
const VISION_LIMITS={
 'gpt-6-luna':{inputTokens:1050000,maxOutput:128000,inputMultiplier:4.4,outputMultiplier:3.3,source:'https://developers.openai.com/api/docs/models/gpt-6-luna'},
 'deepseek-flash':{inputTokens:1048576,maxOutput:393216,inputMultiplier:1,outputMultiplier:1,source:'https://api-docs.deepseek.com/api/list-models/'},
};
const visionLimits=model=>VISION_LIMITS[Object.keys(VISION_LIMITS).find(k=>model===k||new RegExp('^'+k+'-\\d{4}-\\d{2}-\\d{2}$').test(model))];
const isolatedRequest=request=>request&&(!request.tools||Array.isArray(request.tools)&&!request.tools.length)&&!request.tool_choice&&!request.previous_response_id&&!request.conversation;
function contextReservation(model,maxOutput,prices){
 const limits=visionLimits(model),rate=modelRate(model,prices);
 if(!limits||!Number.isSafeInteger(maxOutput)||maxOutput<=0||maxOutput>limits.maxOutput||!Number.isFinite(rate?.input)||!Number.isFinite(rate?.output))return null;
 // OpenAI: cover long-context, cache writes, Fast tier and regional premium.
 // DeepSeek: the configured peak prices already cover the supported request.
 const inputRate=Math.max(rate.input,rate.cached||0,rate.cacheWrite30m??rate.input,rate.cacheWrite12h??rate.input)*limits.inputMultiplier,outputRate=rate.output*limits.outputMultiplier;
 const usd=Math.ceil((limits.inputTokens*inputRate+maxOutput*outputRate)/1e6*1e10)/1e10;
 if(!Number.isFinite(usd)||usd<=0||inputRate<=0||outputRate<=0)return null;
 return {basis:'model_context_and_output_cap',model,inputTokens:limits.inputTokens,maxOutput,inputRate,outputRate,usd,priceDate:PRICE_DATE,source:limits.source};
}
export function imageReservation(model,request,prices=PRICES){
 if(!isolatedRequest(request)||request.model!==model||!Array.isArray(request.input)||!request.input.length||request.service_tier&&!['auto','default','flex','fast'].includes(request.service_tier))return null;
 let images=0;
 for(const row of request.input){
  if(row.type&&row.type!=='message'||!['user','developer','system'].includes(row.role)||!Array.isArray(row.content)||!row.content.length)return null;
  for(const c of row.content){
   if(c.type==='input_text'&&typeof c.text==='string')continue;
   if(c.type==='input_image'&&typeof c.image_url==='string'&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(c.image_url)){images++;continue;}
   return null;
  }
 }
 return images?contextReservation(model,request.max_output_tokens,prices):null;
}
export function audioReservation(model,seconds,prices=PRICES){
 const rate=modelRate(model,prices);if(!Number.isFinite(seconds)||seconds<=0||seconds>86400||!Number.isFinite(rate?.perMinute)||rate.perMinute<=0)return null;
 const wholeSeconds=Math.ceil(seconds),usd=Math.ceil(wholeSeconds/60*rate.perMinute*1e10)/1e10;
 return {basis:'full_input_audio_duration',model,seconds:wholeSeconds,perMinute:rate.perMinute,usd,priceDate:PRICE_DATE,source:rate.source||'local-price-configuration'};
}
export function textReservation(model,request,prices=PRICES){
 const rate=modelRate(model,prices);
 if(!isolatedRequest(request)||request.model!==model||!Array.isArray(request.input)||request.input.some(row=>!Array.isArray(row.content)||row.content.some(c=>c.type!=='input_text'||typeof c.text!=='string'))||!Number.isSafeInteger(request.max_output_tokens)||request.max_output_tokens<=0||request.max_output_tokens>1000000||!Number.isFinite(rate?.input)||!Number.isFinite(rate?.output))return null;
 const inputBytes=Buffer.byteLength(JSON.stringify(request),'utf8'),inputTokens=inputBytes*2+4096;
 if(inputBytes>16000000)return null;
 const inputRate=Math.max(rate.input,rate.cached||0,rate.cacheWrite30m||rate.input*1.25,rate.cacheWrite12h||rate.input*2.5)*2,outputRate=rate.output*1.5;
 const usd=Math.ceil((inputTokens*inputRate+request.max_output_tokens*outputRate)/1e6*1e10)/1e10;
 if(usd<=0)return null;
 return {basis:'text_bytes_and_output_cap',model,inputBytes,inputTokens,maxOutput:request.max_output_tokens,inputRate,outputRate,usd,priceDate:PRICE_DATE,source:rate.source||'local-price-configuration'};
}
export function reservedCost(record){
 const hold=record.reservation;
 if(record.kind!=='transcription'&&hold?.basis==='model_context_and_output_cap'){
  const limits=visionLimits(record.model);
  if(!limits||hold.model!==record.model||hold.inputTokens!==limits.inputTokens||!Number.isSafeInteger(hold.maxOutput)||hold.maxOutput<=0||hold.maxOutput>limits.maxOutput||!Number.isFinite(hold.inputRate)||hold.inputRate<=0||!Number.isFinite(hold.outputRate)||hold.outputRate<=0)return null;
  const expected=Math.ceil((hold.inputTokens*hold.inputRate+hold.maxOutput*hold.outputRate)/1e6*1e10)/1e10;return Number.isFinite(hold.usd)&&hold.usd>0&&Math.abs(hold.usd-expected)<1e-10?hold.usd:null;
 }
 if(record.kind!=='transcription'&&hold?.basis==='text_bytes_and_output_cap'){
  if(hold.model!==record.model||!Number.isSafeInteger(hold.inputBytes)||hold.inputBytes<=0||hold.inputBytes>16000000||hold.inputTokens!==hold.inputBytes*2+4096||!Number.isSafeInteger(hold.maxOutput)||hold.maxOutput<=0||hold.maxOutput>1000000||!Number.isFinite(hold.inputRate)||hold.inputRate<=0||!Number.isFinite(hold.outputRate)||hold.outputRate<=0)return null;
  const expected=Math.ceil((hold.inputTokens*hold.inputRate+hold.maxOutput*hold.outputRate)/1e6*1e10)/1e10;return Number.isFinite(hold.usd)&&Math.abs(hold.usd-expected)<1e-10?hold.usd:null;
 }
 const r=record.reservation;if(record.kind!=='transcription'||!r||r.basis!=='full_input_audio_duration'||r.model!==record.model||!Number.isSafeInteger(r.seconds)||r.seconds<=0||r.seconds>86400||!Number.isFinite(r.perMinute)||r.perMinute<=0||!Number.isFinite(r.usd)||r.usd<=0)return null;
 const expected=Math.ceil(r.seconds/60*r.perMinute*1e10)/1e10;return Math.abs(r.usd-expected)<1e-10?r.usd:null;
}
const knownCost=r=>['completed','failed'].includes(r.status)&&Number.isFinite(r.usd)&&r.usd>=0?r.usd:null;
const budgetCost=r=>knownCost(r)??reservedCost(r);
export function normalizeUsage(usage) {
 if(!usage)return null;
 const details=usage.input_tokens_details||{},writes=details.cache_write_tokens_details;
 const writeTokens=number(Object.hasOwn(details,'cache_write_tokens')?details.cache_write_tokens:(writes?(writes.ttl_30m_tokens||0)+(writes.ttl_12h_tokens||0):0));
 return {input_tokens:number(usage.input_tokens??usage.prompt_tokens),output_tokens:number(usage.output_tokens??usage.completion_tokens),
  input_tokens_details:{cached_tokens:number(Object.hasOwn(details,'cached_tokens')?details.cached_tokens:usage.prompt_cache_hit_tokens??0),cache_write_tokens:writeTokens,
   cache_write_tokens_details:{ttl_30m_tokens:number(writes&&Object.hasOwn(writes,'ttl_30m_tokens')?writes.ttl_30m_tokens:writeTokens),ttl_12h_tokens:number(writes&&Object.hasOwn(writes,'ttl_12h_tokens')?writes.ttl_12h_tokens:0)}},
  output_tokens_details:{reasoning_tokens:number(usage.output_tokens_details?.reasoning_tokens??0)}};
}
export function usageCost(model,usage,prices=PRICES){
 const key=Object.keys(prices).sort((a,b)=>b.length-a.length).find(k=>model===k||model.startsWith(k+'-')),rate=prices[key],u=normalizeUsage(usage);
 if(!rate||!u||!Number.isFinite(rate.input)||!Number.isFinite(rate.output)||!Number.isFinite(rate.cached))return null;
 const input=u.input_tokens,output=u.output_tokens,cached=u.input_tokens_details.cached_tokens,written=u.input_tokens_details.cache_write_tokens;
 const {ttl_30m_tokens:w30,ttl_12h_tokens:w12}=u.input_tokens_details.cache_write_tokens_details;
 if([input,output,cached,written,w30,w12].some(n=>n===null)||cached+written>input||w30+w12!==written)return null;
 const long=rate.longContextThreshold&&input>rate.longContextThreshold,im=long?2:1,om=long?1.5:1;
 return (((input-cached-written)*rate.input+cached*rate.cached+w30*(rate.cacheWrite30m??rate.input*1.25)+w12*(rate.cacheWrite12h??rate.input*2.5))*im+output*rate.output*om)/1e6;
}
export class UsageMeter{
 constructor(home,{settings}={}){this.home=home;this.settings=settings;}
 config(){if(this.settings)return this.settings;const file=join(this.home,'config.json');return existsSync(file)?JSON.parse(readFileSync(file,'utf8')).budget||{}:{};}
 read(){return readState(this.home,'usage.json',empty);}
 summary(today=dayKey()){
  const state=this.read();return {startedAt:state.startedAt,priceDate:PRICE_DATE,providers:['openai','deepseek','edge'].map(provider=>{const all=state.records.filter(r=>r.day===today&&r.provider===provider),done=all.filter(r=>r.status==='completed'),unknown=all.filter(r=>r.status==='unknown'||r.status==='completed'&&r.usd===null);return {provider,requests:all.length,completed:done.length,pending:all.filter(r=>r.status==='pending').length,unknown:unknown.length,inputTokens:done.reduce((s,r)=>s+(r.usage?.input_tokens||0),0),outputTokens:done.reduce((s,r)=>s+(r.usage?.output_tokens||0),0),seconds:done.reduce((s,r)=>s+(r.seconds||0),0),estimatedUSD:done.reduce((s,r)=>s+(r.usd||0),0),reservedUSD:all.filter(r=>knownCost(r)===null).reduce((s,r)=>s+(reservedCost(r)??0),0),blockingUnknown:unknown.filter(r=>reservedCost(r)===null).length,limitUSD:this.config().limitsUSD?.[provider]??null};}),records:state.records.slice(-80).reverse().map(({usage,...r})=>({...r,inputTokens:usage?.input_tokens??null,outputTokens:usage?.output_tokens??null}))};
 }
 assertAvailable(provider,model,records=this.read().records,reservation=null){const cfg=this.config(),today=dayKey(),own=records.filter(r=>r.day===today&&r.provider===provider),limit=cfg.limitsUSD?.[provider];if(cfg.enabled!==false&&limit!==null&&limit!==undefined){const spent=own.reduce((s,r)=>s+(budgetCost(r)??0),0);if(spent>=limit||reservation&&spent+reservation.usd>limit)throw Object.assign(new Error(`${provider} 已达到每日费用预算，暂停新请求`),{code:'BUDGET_EXCEEDED'});if(own.some(r=>(r.status==='pending'||r.status==='unknown'||r.status==='completed'&&r.usd===null)&&budgetCost(r)===null))throw Object.assign(new Error(`${provider} 有待结算或无法估算的调用，暂不开始新请求`),{code:'BUDGET_UNKNOWN'});if(!Object.keys({...PRICES,...cfg.prices}).some(k=>model===k||model.startsWith(k+'-')))throw Object.assign(new Error('该模型尚未配置价格，无法执行预算限制'),{code:'BUDGET_UNKNOWN'});}}
 begin(provider,kind,model,{seconds,request}={}){return updateState(this.home,'usage.json',empty,d=>{const prices={...PRICES,...this.config().prices},reservation=kind==='transcription'?audioReservation(model,seconds,prices):textReservation(model,request,prices)||imageReservation(model,request,prices);this.assertAvailable(provider,model,d.records,reservation);const today=dayKey();
   const item={id:randomUUID(),provider,kind,model,ownerPid:process.pid,day:today,status:'pending',usd:null,createdAt:new Date().toISOString(),...(reservation?{reservation}:{})};d.startedAt||=item.createdAt;d.records.push(item);return item.id;});}
 recover(){return updateState(this.home,'usage.json',empty,d=>{let count=0;for(const r of d.records){if(r.status!=='pending'||!Number.isSafeInteger(r.ownerPid)||r.ownerPid<1)continue;let alive=true;try{process.kill(r.ownerPid,0);}catch(e){if(e.code==='ESRCH')alive=false;}if(!alive){r.status='unknown';r.finishedAt=new Date().toISOString();r.recoveryReason='调用所属进程已退出，保留原费用预留等待结算';count++;}}return count;});}
 finish(id,{usage,seconds,status='completed',model,free=false}={}){return updateState(this.home,'usage.json',empty,d=>{const r=d.records.find(r=>r.id===id);if(!r||r.status!=='pending')return;r.model=model||r.model;r.status=status;r.finishedAt=new Date().toISOString();r.seconds=Number.isFinite(seconds)?Math.max(0,seconds):Number.isFinite(usage?.seconds)?usage.seconds:0;r.usage=normalizeUsage(usage);const prices={...PRICES,...this.config().prices},rate=modelRate(r.model,prices);r.usd=free?0:status==='failed'?0:rate?.perMinute&&r.seconds>0?r.seconds/60*rate.perMinute:usageCost(r.model,r.usage,prices);});}
 reserveUncertainAudio(id,seconds,{sha256,reason}={}){if(!/^[a-f0-9]{64}$/.test(sha256||'')||typeof reason!=='string'||!reason.trim())throw new Error('需要核对音频文件及恢复依据');return updateState(this.home,'usage.json',empty,d=>{const r=d.records.find(r=>r.id===id);if(!r||r.kind!=='transcription'||r.status!=='unknown')throw new Error('仅可核对未确认的音频转写');const reservation=audioReservation(r.model,seconds,{...PRICES,...this.config().prices});if(!reservation)throw new Error('音频时长或计费单价无法核对');if(r.reservation)throw new Error('这笔转写已有预留记录');r.reservation={...reservation,reconciledAt:new Date().toISOString(),evidenceSha256:sha256,reason:reason.slice(0,200)};return r.reservation;});}
 reserveUncertainImage(id,{sha256,reason}={}){if(!/^[a-f0-9]{64}$/.test(sha256||'')||typeof reason!=='string'||!reason.trim())throw new Error('需要核对原图片及恢复依据');return updateState(this.home,'usage.json',empty,d=>{const r=d.records.find(r=>r.id===id);if(!r||!['chat_reply','reply','private_reply'].includes(r.kind)||r.status!=='unknown')throw new Error('仅可核对未确认的图片回复调用');if(r.reservation)throw new Error('这笔调用已有预留记录');const limits=visionLimits(r.model),reservation=limits&&contextReservation(r.model,limits.maxOutput,{...PRICES,...this.config().prices});if(!reservation)throw new Error('图片模型计费上限无法核对');r.reservation={...reservation,reconciledAt:new Date().toISOString(),evidenceSha256:sha256,reason:reason.slice(0,200)};return r.reservation;});}
 async measure(provider,kind,model,run,context={}){const id=this.begin(provider,kind,model,context);try{const result=await run();this.finish(id,{usage:result.usage,seconds:result.seconds,model:result.model,status:'completed',free:provider==='edge'});return result;}catch(error){try{this.finish(id,{status:error.httpRejected?'failed':'unknown'});}catch{}throw error;}}
}
