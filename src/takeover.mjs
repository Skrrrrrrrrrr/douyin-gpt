import {allowedReplyContact} from './reply-audience.mjs';
import {isBotMessage,meaningfulMessage} from './delivery-state.mjs';
import {readState,updateState} from './state-file.mjs';
const empty={version:1,contacts:{}};
export class Takeover{
 constructor(home,cfg){this.home=home;this.cfg=cfg;}
 allowed(id){return Boolean(allowedReplyContact(this.home,this.cfg,id));}
 get(id){if(!this.allowed(id))throw new Error('联系人未授权');const value=readState(this.home,'takeover.json',empty).contacts[id]||{};return {until:value.until||0,active:(value.until||0)>Date.now(),reason:value.reason||''};}
 pause(id,minutes=30,reason='控制台接管'){if(!this.allowed(id)||!Number.isSafeInteger(minutes)||minutes<1||minutes>1440)throw new Error('接管对象或时长无效');return updateState(this.home,'takeover.json',empty,d=>{const c=d.contacts[id]||={};c.until=Date.now()+minutes*60000;c.reason=reason;c.source='manual';return this.getValue(c);});}
 resume(id){if(!this.allowed(id))throw new Error('联系人未授权');return updateState(this.home,'takeover.json',empty,d=>{const c=d.contacts[id]||={};c.until=0;c.reason='';});}
 getValue(c){return {until:c.until||0,active:(c.until||0)>Date.now(),reason:c.reason||''};}
 observe(contact,messages,outbox=[]){if(!this.allowed(contact.secUid))return false;return updateState(this.home,'takeover.json',empty,d=>{
  const own=messages.filter(m=>m.from==='me'&&m.id),c=d.contacts[contact.secUid]||={known:[],initialized:false},now=Date.now(),window=this.cfg.reply.takeover.minutes*60000;
  const aliases=m=>[m.id,...(m.aliases||[])].filter(Boolean),fresh=c.initialized?own.filter(m=>meaningfulMessage(m)&&!aliases(m).some(id=>c.known?.includes(id))):[];
  const manual=fresh.filter(m=>!isBotMessage(m,contact.secUid,outbox)).filter(m=>!m.createdAt||Number.isFinite(Date.parse(m.createdAt))&&Date.parse(m.createdAt)>now-window&&Date.parse(m.createdAt)<=now+30000);
  // Repair only a demonstrably stale automatic pause. An explicit dashboard pause is preserved.
  if(c.source!=='manual'&&c.reason==='检测到本人手动回复'&&c.until>now){
   const unmatched=own.filter(m=>!isBotMessage(m,contact.secUid,outbox));
   if(unmatched.length&&unmatched.every(m=>!meaningfulMessage(m)||Number.isFinite(Date.parse(m.createdAt))&&Date.parse(m.createdAt)<=now-window)){c.until=0;c.reason='';c.source='reconciled_automatic';}
  }
  c.known=[...new Set([...(c.known||[]),...own.flatMap(aliases)])].slice(-600);c.initialized=true;
  if(manual.length&&this.cfg.reply.takeover.enabled&&!(c.source==='manual'&&c.until>now)){c.until=Math.max(c.until||0,...manual.map(m=>(Date.parse(m.createdAt)||now)+window));c.reason='检测到本人手动回复';c.source='detected_manual';c.detectedAt=new Date().toISOString();}
  return manual.length>0;
 });}
}
