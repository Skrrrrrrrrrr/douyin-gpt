import {storageFault} from './storage.mjs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readState} from './state-file.mjs';
import {atomicJson} from './store.mjs';
import {accountFingerprint} from './reply-audience.mjs';
import {GroupMessenger} from './group-messenger.mjs';
import {groupKey,groupCalled,validGroup,groupWindowCompatible,groupReplyProvider} from './group-policy.mjs';
import {StopRequired} from './douyin.mjs';
import {meaningfulMessage} from './delivery-state.mjs';
import {usageContextFor} from './usage-context.mjs';
const initial={version:1,groups:[],checkedAt:null};
export function groupSummary(home,cfg,store) {
 let s;try{s=readState(home,'groups.json',initial);}catch{return {enabled:cfg.reply.groups.enabled,ready:false,error:'群身份记录无法核对',groups:[]};}
 const ready=Array.isArray(s.groups)&&s.groups.every(g=>validGroup(g)&&g.key===groupKey(g))&&s.accountHash===accountFingerprint(cfg.account)&&Date.now()-Date.parse(s.checkedAt)<120000;
 return {enabled:cfg.reply.groups.enabled,ready,checkedAt:s.checkedAt||null,trigger:'mention',groups:ready?s.groups.map(g=>({id:g.key,label:g.label,participantCount:g.participantCount,pausedReason:store.data.groupChats?.[g.key]?.pausedReason||'',pausedUntil:store.data.groupChats?.[g.key]?.pausedUntil||0})):[]};
}
export class GroupChats {
 constructor({home,cfg,store,models,dy,browser,messenger,live=false,log=()=>{}}){Object.assign(this,{home,cfg,store,models,dy,live,log});this.messenger=messenger||new GroupMessenger(home,browser,dy);}
 async sync(){
  const self=(await this.dy.fetchInPage('/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383')).user;
  if(self?.sec_uid!==this.cfg.account.secUid||typeof self.uid!=='string'||!/^\d{5,25}$/.test(self.uid))throw new StopRequired('群聊登录账号无法核对');
  this.account={...this.cfg.account,uid:self.uid,nickname:String(self.nickname||'')};
  const old=readState(this.home,'groups.json',initial),groups=(await this.messenger.list()).filter(validGroup).map(g=>{const prior=old.accountHash===accountFingerprint(this.cfg.account)&&old.groups.find(x=>x.id===g.id&&x.shortId===g.shortId);return {...g,key:groupKey(g),membershipId:prior?.membershipId||randomUUID(),since:prior?.since||new Date().toISOString()};});
  atomicJson(join(this.home,'groups.json'),{version:1,accountHash:accountFingerprint(this.cfg.account),checkedAt:new Date().toISOString(),groups});return groups;
 }
 state(group){this.store.data.groupChats??={};return this.store.data.groupChats[group.key]??={initialized:false,seen:[],history:[],lastSentAt:0,pausedReason:'',pausedUntil:0};}
 remember(state,messages){state.seen=[...new Set([...state.seen,...messages.map(m=>m.id)])].slice(-1500);state.history=messages.slice(-40);this.store.save();}
 blocked(group,state){return this.store.data.outbox.some(o=>o.contactId===group.key&&(o.status==='sending'||o.status==='uncertain'&&Date.parse(o.updatedAt||o.createdAt)>(state.recheckedAt||0)));}
 async poll(signal){
  if(!this.cfg.reply.enabled||!this.cfg.reply.groups.enabled||signal?.aborted)return;this.signal=signal;this.messenger.signal=signal;
  try{for(const group of await this.sync()){if(signal?.aborted)break;try{await this.reply(group);}catch(error){if(storageFault(error))throw error;if(error instanceof StopRequired)throw error;this.log('群聊处理暂未完成：'+error.message);}}}
  catch(error){if(storageFault(error))throw error;if(error instanceof StopRequired)throw error;this.log('群身份暂未核对：'+error.message);}
 }
 async reply(group){
  const state=this.state(group);if(state.pausedReason||state.pausedUntil>Date.now()||this.blocked(group,state)||!this.store.quota(group.key,this.cfg.reply))return;
  const messages=await this.messenger.read(group,this.account),now=Date.now();
  if(state.membershipId!==group.membershipId||state.enabledAt!==this.cfg.reply.groups.enabledAt){const cutoff=state.membershipId&&state.enabledAt===this.cfg.reply.groups.enabledAt?group.since:this.cfg.reply.groups.enabledAt;state.initialized=false;state.seen=messages.filter(m=>!m.createdAt||Date.parse(m.createdAt)<Date.parse(cutoff)).map(m=>m.id);state.membershipId=group.membershipId;state.enabledAt=this.cfg.reply.groups.enabledAt;}
  const fresh=messages.filter(m=>!state.seen.includes(m.id));
  const mine=new Set(this.store.data.outbox.filter(o=>o.recipientKind==='group'&&o.contactId===group.key).map(o=>o.receipt?.id).filter(Boolean));
  const takeoverWindow=this.cfg.reply.takeover.minutes*60000,manual=fresh.filter(m=>m.from==='me'&&meaningfulMessage(m)&&!mine.has(m.id)&&Number.isFinite(Date.parse(m.createdAt))&&Date.parse(m.createdAt)>now-takeoverWindow&&Date.parse(m.createdAt)<=now+30000);
  if(state.initialized&&this.cfg.reply.takeover.enabled&&manual.length){state.pausedUntil=Math.max(state.pausedUntil,...manual.map(m=>Date.parse(m.createdAt)+takeoverWindow));this.remember(state,messages);return;}
  state.initialized=true;
  const incoming=fresh.filter(m=>m.createdAt&&Date.parse(m.createdAt)>=(state.resumeAfter||0)&&Date.parse(m.createdAt)<=now+30000&&now-Date.parse(m.createdAt)<=1800000&&groupCalled(m,this.account));
  if(!incoming.length){this.remember(state,messages);return;}
  if(now-state.lastSentAt<this.cfg.reply.groups.cooldownSeconds*1000)return;
  const provider=groupReplyProvider(incoming,this.cfg.reply.routing,this.account),model=this.models[provider];
  if(!model||provider==='deepseek'&&!this.cfg.deepseek.enabled)return;
  model.meter?.assertAvailable(provider,model.config.model);
  const usageContext=usageContextFor(this.home,this.cfg,incoming,{group},{history:messages});
  const decision=await model.groupReply({group,history:messages,incoming:incoming.slice(-8),maxChars:this.cfg.reply.groups.maxChars,usageContext});
  if(this.signal?.aborted)return;
  if(!decision.shouldReply){this.remember(state,messages);return;}
  const text=String(decision.text||'').trim();if(!text||[...text].length>this.cfg.reply.groups.maxChars||/sk-[\w-]+|Cookie\s*:/i.test(text))throw new Error('群回复内容未通过检查');
  if(!this.live){this.log('群聊回复预览已生成');return;}
  const latest=await this.messenger.read(group,this.account),ids=incoming.map(m=>m.id);if(!groupWindowCompatible(latest,messages,ids,this.account))return;
  const action=this.store.groupDraft(group,incoming,text,decision.reason,{provider,model:model.lastResponse?.model||model.config.model});if(action.status!=='draft')return;
  this.remember(state,latest);this.store.transition(action,'sending');
  try{const receipt=await this.messenger.send(group,text,latest,ids,this.account);if(!receipt.accepted||!receipt.id)throw new Error('群回复缺少平台回执');action.receipt=receipt;action.sentMessageId=receipt.id;state.lastSentAt=Date.now();this.store.transition(action,'accepted','平台已接收，已从群内本人消息回读；不代表其他成员已读');this.log('群回复已获平台回执');}
  catch(error){if(storageFault(error))throw error;action.failureCode=error.code||'';this.store.transition(action,error.sendAttempted===false?'not_sent':'uncertain',error.message);if(error.sendAttempted!==false)state.pausedReason=error.message;this.store.save();this.log('群回复未完成：'+error.message);}
 }
}
export function applyGroupAction(home,cfg,store,body){
 if(Object.keys(body).some(k=>!['id','action'].includes(k))||!['pause','resume'].includes(body.action))throw new Error('群操作无效');
 if(!groupSummary(home,cfg,store).groups.some(g=>g.id===body.id))throw new Error('此群身份尚未核对，请先同步群列表');
 store.data.groupChats??={};const state=store.data.groupChats[body.id]??={initialized:false,seen:[],history:[],lastSentAt:0};
 if(body.action==='pause')state.pausedUntil=Date.now()+cfg.reply.takeover.minutes*60000;
 else{state.pausedUntil=0;state.pausedReason='';state.recheckedAt=Date.now();state.resumeAfter=Date.now();for(const o of store.data.outbox.filter(o=>o.recipientKind==='group'&&o.contactId===body.id&&o.status==='uncertain')){o.manualReviewedAt=new Date().toISOString();o.note+='；本人已核对，只恢复后续新消息，旧尝试不补发';}}
 store.save();return {ok:true};
}
