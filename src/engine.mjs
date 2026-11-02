import {storageFault} from './storage.mjs';
import { dayKey, PROVIDERS, providerBrowse, providerEngagement, providerLabel } from './config.mjs';
import { sleep } from './browser.mjs';
import { StopRequired } from './douyin.mjs';
import { DailyJournal } from './journal.mjs';
import {ConversationMemory} from './memory.mjs';
import {VideoUnderstanding} from './understanding.mjs';
import {Health} from './health.mjs';
import {PublicationReview} from './publication-review.mjs';
import {Takeover} from './takeover.mjs';
import {MessageMedia} from './message-media.mjs';
import {Reviews} from './reviews.mjs';
import {VoiceCards} from './voice-cards.mjs';
import {PrivateDelivery} from './private-delivery.mjs';
import {duoReply} from './duo-reply.mjs';
import {preferences,quietNow,wantsDuo,wantsVoice,stampMessages,safeVoiceText} from './conversation-policy.mjs';
import {sameMessageWindow,snapshotMessages} from './message-snapshot.mjs';
import {StickerLibrary} from './stickers.mjs';
import {Interests} from './interests.mjs';
import {efficiencySettings, efficientFrames} from './token-policy.mjs';
import {VideoAnalysis} from './video-analysis.mjs';
import {Friends} from './friends.mjs';
import {GroupChats} from './group-chats.mjs';
import {replyContacts,allowedReplyContact,friendSnapshot} from './reply-audience.mjs';
import {meaningfulMessage} from './delivery-state.mjs';
import {usageContextFor} from './usage-context.mjs';
import {ReplyProgress,recoveryReason,saveSession,ChannelRecovery} from './recovery.mjs';

export const messageSignature = messages => JSON.stringify(messages.map(m => [m.id, m.from, m.text, m.item]));
export function selectReplyProvider(incoming, routing) {
  return routing?.enabled && routing.deepseekKeyword && incoming.some(m => typeof m.text === 'string' && m.text.includes(routing.deepseekKeyword)) ? 'deepseek' : 'openai';
}
export function unanswered(messages) {
  messages=messages.filter(m=>m.from!=='me'||meaningfulMessage(m));
  let lastMine = -1;
  messages.forEach((m, i) => { if (m.from === 'me') lastMine = i; });
  const tail = messages.slice(lastMine + 1);
  // 最新消息归属无法识别时，不猜它是谁发的。
  if (!tail.length || tail.at(-1).from !== 'them') return [];
  return tail.filter(m => m.from === 'them' && m.id && (m.text || m.item));
}
export class Engine {
  constructor({ home, cfg, store, gpt, models = {}, dy, messenger, engagement, live = false, log = console.log }) {
    Object.assign(this, { home, cfg, store, gpt, dy, messenger, engagement, live, log });
    this.models = { openai: gpt, ...models };
    this.health=new Health(home,{notify:cfg.monitor?.notify});
    this.progress=new ReplyProgress(home);
    this.channels=new ChannelRecovery(home);
    if(live){this.channels.isolateSearch();this.channels.refreshAlerts({notify:cfg.monitor?.notify});}
    this.memory=cfg.memory?.enabled?new ConversationMemory(home,cfg):null;
    this.understanding=cfg.understanding?.enabled?new VideoUnderstanding(home,cfg):null;
    this.videoAnalysis=cfg.videoAnalysis?.enabled?new VideoAnalysis({home,cfg,dy,transcriber:this.understanding||new VideoUnderstanding(home,cfg),log}):null;
    this.review=cfg.monitor?.enabled&&dy.browser?new PublicationReview(home,cfg,dy.browser,{log}):null;
    this.reviews=new Reviews(home);if(live)this.reviews.recover();this.voiceCards=new VoiceCards(home,cfg);
    this.stickers=new StickerLibrary(home,cfg);
    this.takeover=new Takeover(home,cfg);this.interests=new Interests(home,cfg);
    for(const provider of PROVIDERS){const profile=cfg.discovery?.profiles?.[provider],model=this.models[provider];if(typeof model?.setCharacter==='function')model.setCharacter(cfg);else if(profile&&typeof model?.persona==='string')model.persona+=`\n你的角色兴趣说明：${profile.description}。喜欢看的主题：${profile.topics.join('、')||'尚在探索'}。这是角色偏好，不代表账号主人或联系人偏好；具体看过什么只依据本轮给出的真实观看记录。`;}
    this.messageMedia=cfg.reply.media?.enabled&&typeof messenger.media==='function'?new MessageMedia(home,cfg,messenger):null;
    this.journal = new DailyJournal({ home, cfg, store, models: this.models, ledger: engagement?.ledger, log });
    this.previews = [];
    this.previewedInputs = new Map();this.replyRetry=new Map();
    this.friends=new Friends(home,cfg,dy);
    this.groups=new GroupChats({home,cfg,store,models:this.models,dy,browser:dy.browser,live,log});
    if(this.engagement)this.engagement.yieldToReplies=async()=>{if(!this.signal?.aborted&&Date.now()-(this.lastReplyPollAt||0)>=this.cfg.reply.pollSeconds*1000)await this.pollReplies();};
  }
  async verifyAccount() { const account=await this.dy.checkAccount(this.cfg.account);if(this.live&&Date.now()-(this.lastSessionSaved||0)>60000){saveSession(this.home,{state:'ready',code:'READY',verifiedAt:new Date().toISOString()});this.lastSessionSaved=Date.now();}return account; }
  async pollReplies() {
    if (!this.cfg.reply.enabled) return;
    this.lastReplyPollAt=Date.now();
    if(this.live)this.progress.scan('checking');
    await this.verifyAccount();
    await this.runChannel('group-replies',()=>this.groups.poll(this.signal));
    let contacts=replyContacts(this.home,this.cfg);
    if(this.cfg.reply.audience==='friends'){
      try{await this.friends.sync();const status=friendSnapshot(this.home,this.cfg);if(!status.ready)throw new Error(status.error);this.health.resolve('friend-sync');}
      catch(error){if(storageFault(error))throw error;if(error instanceof StopRequired)throw error;if(this.live)this.progress.scan('blocked',{code:'FRIEND_SYNC'});this.health.alert('friend-sync','好友名单暂未核对成功','好友模式暂停授权，等待登录或网络恢复');return;}
      if(typeof this.messenger.contacts!=='function')throw new Error('当前适配器不能核对好友的新会话');
      const recent=await this.messenger.contacts(),ids=new Set(recent.filter(c=>!c.is_group&&c.sec_uid).map(c=>c.sec_uid));
      if(!friendSnapshot(this.home,this.cfg).ready)await this.friends.sync({force:true});
      contacts=replyContacts(this.home,this.cfg).filter(c=>ids.has(c.secUid));
    }
    for (const contact of contacts) {
      if (this.signal?.aborted) break;
      if(this.backgroundRun&&(this.replyRetry.get(contact.secUid)?.at||0)>Date.now())continue;
      try { await this.replyTo(contact);this.replyRetry.delete(contact.secUid);if(!this.store.blocked(contact.secUid))this.health.resolve('reply:'+contact.secUid); }
      catch (error) {if(storageFault(error))throw error;
        if (error instanceof StopRequired) throw error;
        const retries=(this.replyRetry.get(contact.secUid)?.count||0)+1;this.replyRetry.set(contact.secUid,{count:retries,at:Date.now()+Math.min(300000,15000*2**(retries-1))});
        if(this.live){const reason=recoveryReason(error);this.progress.set(contact,['BUDGET_UNKNOWN','BUDGET_EXCEEDED'].includes(reason.code)?'blocked':'retrying',{...reason,retryAt:new Date(this.replyRetry.get(contact.secUid).at).toISOString(),pending:this.pendingCounts?.get(contact.secUid)||0});}
        this.log(`联系人 ${contact.label || contact.secUid.slice(-6)}：${error.message}`);
        if(!this.signal?.aborted)try{this.health.alert(`reply:${contact.secUid}`,'私信处理需要关注',`${contact.label}：${error.message}`);}catch(noticeError){this.log(`异常通知暂未写入：${noticeError.message}`);}
      }
    }
    if(this.live&&!this.signal?.aborted)this.progress.scan('ready');
  }
  async runChannel(key,run){
    if(this.live&&this.channels.blocked(key)){this.channels.refreshAlerts({notify:this.cfg.monitor?.notify});return;}
    try{await run();if(this.live)this.channels.clear(key);}
    catch(error){if(storageFault(error))throw error;
      if(error.name==='StopRequired'&&error.code!=='PAGE_VERIFICATION')throw error;
      if(this.signal?.aborted)return;
      this.log(`任务暂缓（${key}）：${error.message}`);
      if(this.live){this.channels.fail(key,error);this.channels.refreshAlerts({notify:this.cfg.monitor?.notify,force:true});}
    }
  }
  async replyTo(contact) {
    if(!this.live)return this.replyToInner(contact);
    this.progress.set(contact,'reading');
    try{await this.replyToInner(contact);}
    catch(error){if(storageFault(error))throw error;this.progress.set(contact,'blocked',{...recoveryReason(error),pending:this.pendingCounts?.get(contact.secUid)||0});throw error;}
  }
  async replyToInner(contact) {
    if (!this.cfg.reply.enabled || !allowedReplyContact(this.home,this.cfg,contact.secUid)) return;
    if (this.signal?.aborted) return;
    const state = this.store.contact(contact.secUid);
    if (this.store.blocked(contact.secUid)) { if(this.live)this.progress.set(contact,'blocked',{code:'SEND_UNCERTAIN'});this.log(`${contact.label} 有发送结果待核对，暂不继续回复`); return; }
    if (this.live && this.store.quota(contact.secUid, this.cfg.reply) <= 0) {this.progress.set(contact,'limited',{code:'QUOTA_REACHED'});return;}
    if(this.cfg.reply.audience==='friends'&&!await this.ensureRecipient(contact))return;
    const messages = await this.messenger.read(contact);
    if(this.live)this.store.snapshot(contact.secUid,messages);
    if(this.live&&this.cfg.reply.audience==='friends'&&!await this.ensureRecipient(contact))return;
    if(this.live&&contact.source==='friend'&&(state.friendMembershipId!==contact.membershipId||state.friendAudienceSince!==this.cfg.reply.friends.enabledAt)){
      const keep=state.initialized&&!state.friendMembershipId&&this.cfg.reply.contacts.some(c=>c.enabled&&c.secUid===contact.secUid);
      if(!keep){state.initialized=false;state.friendBaselineAfter=state.friendMembershipId&&state.friendAudienceSince===this.cfg.reply.friends.enabledAt?contact.since:this.cfg.reply.friends.enabledAt;
        for(const old of this.store.data.outbox.filter(o=>o.contactId===contact.secUid&&['draft','partial'].includes(o.status))){if(old.steps)this.store.cancelPending(old,'好友授权范围已变化，旧计划已取消');else this.store.transition(old,'superseded','好友授权范围已变化，旧计划已取消');}
      }
      state.friendMembershipId=contact.membershipId;state.friendAudienceSince=this.cfg.reply.friends.enabledAt;this.store.save();
    }
    const contactPolicy=preferences(this.cfg,contact);
    if(this.live&&quietNow(contactPolicy)){this.progress.set(contact,'quiet');return;}
    if(this.live&&this.reviews.list().some(r=>r.kind==='private'&&r.status==='uncertain'&&r.payload.contactId===contact.secUid))return;
    if(this.live){this.takeover.observe(contact,messages,this.store.data.outbox);if(this.takeover.get(contact.secUid).active){this.progress.set(contact,'takeover');return;}}
    const pending=this.store.data.outbox.find(o=>o.contactId===contact.secUid&&!o.reviewId&&o.steps?.some(s=>s.status==='pending')&&['draft','partial'].includes(o.status));if(this.live&&pending){await this.executor().execute(contact,pending);return;}
    if (this.live && !state.initialized) {
      if (!messages.length || !messages.some(m => m.id)) { this.log(`${contact.label} 未读到可靠消息 ID，暂不建立消息基线，请检查页面或运行 doctor`); return; }
      const cutoff=Date.parse(state.friendBaselineAfter||this.cfg.reply.friends?.enabledAt||''),now=Date.now();
      const fresh=new Set(contact.source==='friend'?unanswered(messages).filter(m=>m.serverConfirmed&&Date.parse(m.createdAt)>=cutoff&&Date.parse(m.createdAt)<=now+30000).map(m=>m.id):[]);
      this.store.baseline(contact.secUid, messages.filter(m=>!fresh.has(m.id)));
      if(!fresh.size){this.log(`已记录 ${contact.label} 的消息基线，只回复此后新到的消息`);return;}
    }
    const waiting = unanswered(messages);
    let incoming = this.live ? this.store.unseen(contact.secUid, waiting) : waiting.slice(-3);
    this.pendingCounts??=new Map();this.pendingCounts.set(contact.secUid,incoming.length);
    if(this.live)this.progress.set(contact,incoming.length?'pending':'idle',{pending:incoming.length});
    if (!incoming.length) {
      if (this.live) {
        // 主人已经手动回过的输入也要记为已处理。
        const lastMine = messages.findLastIndex(m => m.from === 'me');
        this.store.remember(contact.secUid, messages.slice(0, lastMine + 1).map(m => m.id));
        this.store.snapshot(contact.secUid, messages);
        await this.remember(contact,messages.filter(m=>m.from==='them').slice(-20),this.models[selectReplyProvider(messages.slice(-3),this.cfg.reply.routing)]);
      }
      return;
    }
    // 只用本轮未处理的来信判断路由；昵称、主人发言和历史中的关键词不影响选择。
    const media=this.messageMedia&&incoming.some(m=>m.mediaAvailable)?await this.messageMedia.enrich(contact,incoming,this.signal):{messages:incoming,images:[]};incoming=media.messages;
    const provider = selectReplyProvider(incoming, this.cfg.reply.routing), model = this.models[provider];
    if(this.live)this.progress.set(contact,'pending',{pending:incoming.length,provider});
    if (!model || (provider === 'deepseek' && !this.cfg.deepseek?.enabled)) { this.log(`${providerLabel(provider)} 未启用，保留 ${contact.label} 的消息待处理`); return; }
    model.meter?.assertAvailable(provider,model.config.model);
    if(this.live&&typeof this.messenger.composePreflight==='function')await this.messenger.composePreflight(contact);
    incoming = incoming.slice(-10);
    const previewKey = `${provider}:${messageSignature(incoming)}`;
    if (!this.live && this.previewedInputs.get(contact.secUid) === previewKey) return;
    let sharedVideo = null;
    const card = [...incoming].reverse().find(m => /^\d{15,25}$/.test(m.item || ''));
    if (card) {
      try {
        const video = await this.dy.detail(card.item);
        const frames = await this.dy.watch(video, {...this.cfg.browse,captureAudio:Boolean(this.understanding)});
        const perception=await this.understanding?.process(video,frames,model,this.signal);
        sharedVideo = { video, analysis: {...await model.analyze(video, frames, providerBrowse(this.cfg,provider).interests,perception),perception} };
      } catch (error) {if(storageFault(error))throw error;
        if (error instanceof StopRequired&&error.code!=='PAGE_VERIFICATION') throw error;
        sharedVideo = { error: error.code==='PAGE_VERIFICATION'?'分享的视频页需要本人验证，没有读到画面或声音；如实说明，不猜视频内容':'没有读到对方分享视频的画面；回复时如实说明' };
      }
    }
    const modern=this.cfg.reply.delivery.enabled||this.cfg.reply.voiceCards.enabled||this.cfg.review.private==='review'||contactPolicy.reviewReplies==='review'||wantsDuo(incoming,this.cfg);
    const reviewKey='private:'+contact.secUid+':'+stampMessages(messages);if(this.live&&this.reviews.pending(reviewKey))return;
    const voiceRequested=wantsVoice(incoming,contactPolicy,this.cfg),offered=contactPolicy.replyFormat==='text'?[]:typeof this.messenger.sendSticker==='function'?this.stickers.offered(provider,this.store.data.outbox,contact.secUid):[];
    const usageScope=this.cfg.reply.usageContext;
    if((this.cfg.reply.audience==='friends'||usageScope?.enabled&&(usageScope.audience==='friends'||usageScope.contacts.includes(contact.secUid)))&&!await this.ensureRecipient(contact))return;
    const usageContext=usageContextFor(this.home,this.cfg,incoming,{contact},{history:messages});
    const replyInput={contact,history:messages,incoming,recentVideos:this.store.recentVideos(provider),sharedVideo,memory:this.memory?.facts(contact.secUid)||[],mediaImages:media.images,usageContext,profile:{addressAs:contactPolicy.addressAs,tone:contactPolicy.tone,language:contactPolicy.language}};
    if(this.live)this.progress.set(contact,'generating',{pending:incoming.length,provider});
    const generated = wantsDuo(incoming,this.cfg)?await duoReply(this.models,replyInput,{maxChars:contactPolicy.maxChars,recentVideos:p=>this.store.recentVideos(p)}):await model.reply({...replyInput,stickers:offered,stickerStatus:this.stickers.status(this.store.data.outbox,contact.secUid),deliveryModes:modern?['text',...(offered.length?['sticker',...(this.cfg.reply.delivery.textWithSticker?['text_sticker']:[])]:[]),...(voiceRequested?['voice_card']:[])]:[],preferredMode:voiceRequested?'voice_card':'auto',voiceMaxChars:this.cfg.reply.voiceCards.maxChars,maxChars:contactPolicy.maxChars});
    if (this.signal?.aborted) return;
    if(this.live&&!await this.ensureRecipient(contact))return;
    if (!generated.shouldReply) {
      if (this.live) { this.store.remember(contact.secUid, incoming.map(m => m.id)); this.store.snapshot(contact.secUid, messages); }
      this.log(`[${providerLabel(provider)}] ${contact.label}：本条不需要回复`);
      if(this.live)this.progress.set(contact,'skipped',{pending:0,provider});
      if(this.live)await this.remember(contact,incoming,model);
      return;
    }
    if(modern)return this.modernReply(contact,messages,incoming,provider,model,generated,{voiceRequested,contactPolicy,reviewKey});
    const sticker=generated.stickerId&&generated.stickerId!=='none'?this.stickers.choose(generated.stickerId,provider,this.store.data.outbox,contact.secUid):null;
    if(generated.stickerId&&generated.stickerId!=='none'&&!sticker)throw new Error('所选表情已不可用或触发频率限制');
    if(sticker&&typeof this.messenger.sendSticker!=='function')throw new Error('当前发送器尚不支持图片表情');
    const replyText=sticker?`[表情包：${sticker.label}]`:generated.text;
    if (!this.live) {
      const preview = { contactId: contact.secUid, label: contact.label, provider, model: model.config?.model || '', text: replyText, reason: generated.reason,kind:sticker?'sticker':'text',stickerId:sticker?.id||'' };
      this.previews.push(preview);
      this.previewedInputs.set(contact.secUid, previewKey);
      this.log(`[${providerLabel(provider)}] 预览 ${contact.label}：${generated.text}`);
      return;
    }
    const item = this.store.draft(contact, incoming, replyText, generated.reason, { provider, model: model.lastResponse?.model || model.config?.model || '',kind:sticker?'sticker':'text',sticker });
    if (item.status !== 'draft' || (item.provider || 'openai') !== provider) return;
    const fresh = await this.messenger.read(contact);
    if (!sameMessageWindow(fresh,messages)) {
      this.store.transition(item, 'superseded', '生成期间会话有变化，已取消旧回复');
      this.log(`${contact.label} 的会话已变化，取消本条回复`);
      return;
    }
    await this.verifyAccount();
    if(!await this.ensureRecipient(contact)){this.store.transition(item,'superseded','好友关系或授权已变化，未发送');return;}
    if(this.live&&this.takeover.get(contact.secUid).active){this.store.transition(item,'superseded','本人已接管，取消待发回复');return;}
    if (this.signal?.aborted) return;
    if (this.store.quota(contact.secUid, this.cfg.reply) <= 0) return;
    // 先落盘再发送；落盘失败时绝不进入外部发送器。
    if(sticker&&!this.stickers.choose(sticker.id,provider,this.store.data.outbox,contact.secUid))throw new Error('表情额度或冷却已变化，未发送');
    this.store.transition(item, 'sending');
    this.progress.set(contact,'sending',{pending:incoming.length,provider});
    try {
      const receipt=sticker?await this.messenger.sendSticker(contact,sticker,messages,{account:this.cfg.account,guard:()=>this.takeover.get(contact.secUid).active}):await this.messenger.send(contact, item.text, messages);
      if(receipt?.messageId)item.sentMessageId=receipt.messageId;
      this.store.transition(item, 'sent', '已在本人发出的消息中回读确认；不代表对方已读');
    } catch (error) {if(storageFault(error))throw error;
      this.store.transition(item, error.sendAttempted===false?'not_sent':'uncertain', error.message);
      this.progress.set(contact,'blocked',{pending:0,provider,code:error.sendAttempted===false?'SEND_NOT_SENT':'SEND_UNCERTAIN'});
      this.log(sticker&&error.sendAttempted===false?`${contact.label} 的表情在上传前被拦截，未发送`:`${contact.label} 的发送结果不确定，已暂停该会话，请核对后 resolve`);
      return;
    }
    this.log(`[${providerLabel(provider)}] 已回复 ${contact.label}`);
    this.progress.set(contact,'replied',{pending:0,provider});
    try{this.health.resolve(`reply:${contact.secUid}`);await this.remember(contact,incoming,model);}
    catch(error){if(storageFault(error))throw error;this.log(`回复已回读，附加记录暂未更新：${error.message}`);}
  }
  async ensureRecipient(contact){return this.friends.verify(contact);}
  executor(){return new PrivateDelivery({home:this.home,cfg:this.cfg,store:this.store,messenger:this.messenger,dy:this.dy,signal:this.signal,authorize:contact=>this.ensureRecipient(contact),mediaResolver:id=>this.voiceCards.asset(id),log:this.log});}
  async modernReply(contact,messages,incoming,provider,model,generated,{voiceRequested,contactPolicy,reviewKey}){
    let mode=generated.delivery||(generated.stickerId&&generated.stickerId!=='none'?'sticker':'text');
    if(voiceRequested&&!generated.contributors?.length&&safeVoiceText(generated.text)&&[...generated.text].length<=this.cfg.reply.voiceCards.maxChars)mode='voice_card';
    if(mode==='voice_card'&&(!safeVoiceText(generated.text)||[...generated.text].length>this.cfg.reply.voiceCards.maxChars))mode='text';
    const steps=[];let asset;
    if(['sticker','text_sticker'].includes(mode)){asset=this.stickers.choose(generated.stickerId,provider,this.store.data.outbox,contact.secUid);if(!asset)throw new Error('本轮表情不可用，未发送');}
    if(mode==='voice_card'){const card=await this.voiceCards.build(provider,generated.text,{signal:this.signal});steps.push({kind:'voice_card',text:generated.text,card:{id:card.id,sha256:card.sha256}});}
    else{if(mode!=='sticker'){if(!generated.text)throw new Error('缺少完整回复文字');steps.push({kind:'text',text:generated.text});}if(asset)steps.push({kind:'sticker',sticker:{id:asset.id,label:asset.label,sha256:asset.sha256,format:asset.format}});}
    if(steps.length>this.store.quota(contact.secUid,this.cfg.reply)&&steps[0].kind==='text')steps.splice(1);
    const plan={baseStamp:stampMessages(messages),baseMessages:snapshotMessages(messages),steps},text=generated.text||(asset?'[表情包：'+asset.label+']':'');
    if(!this.live){this.previews.push({contactId:contact.secUid,label:contact.label,provider,text,kind:steps.length>1?'bundle':steps[0].kind,plan});return;}
    const review=(contactPolicy.reviewReplies||this.cfg.review.private)==='review'||mode==='voice_card'&&this.cfg.reply.voiceCards.reviewBeforeSend;
    if(review){this.reviews.add('private',reviewKey,{contactId:contact.secUid,label:contact.label,provider,model:model.config?.model||'',inputIds:incoming.map(m=>m.id),baseStamp:plan.baseStamp,baseMessages:plan.baseMessages,text,plan,contributors:generated.contributors||[]});this.store.remember(contact.secUid,incoming.map(m=>m.id));this.store.snapshot(contact.secUid,messages);this.progress.set(contact,'review',{pending:0,provider});this.log('已保存 '+contact.label+' 的待审回复');return;}
    const item=this.store.draft(contact,incoming,text,generated.reason,{provider,model:model.lastResponse?.model||model.config?.model||'',plan,contributors:generated.contributors});
    if(['draft','partial'].includes(item.status)){this.progress.set(contact,'sending',{pending:incoming.length,provider});await this.executor().execute(contact,item);}
    this.progress.set(contact,item.status==='sent'?'replied':item.status==='uncertain'?'blocked':'finished',{pending:0,provider,...(item.status==='uncertain'?{code:'SEND_UNCERTAIN'}:{})});
    if(item.status==='sent'){await this.remember(contact,incoming,model);this.health.resolve('reply:'+contact.secUid);}
  }
  async processReviews(){
    if(!this.live||this.signal?.aborted)return;
    for(const entry of this.reviews.list().filter(r=>r.status==='approved'&&r.kind!=='episode').slice(0,3)){
      if(entry.kind==='comment'){if(this.engagement?.sendApproved)await this.runChannel('public-comments',()=>this.engagement.sendApproved(entry,this.reviews));continue;}
      const payload=entry.payload,contact=allowedReplyContact(this.home,this.cfg,payload.contactId);
      if(!contact){this.reviews.finish(entry.id,'stale','联系人已停用');continue;}
      if(quietNow(preferences(this.cfg,contact))||this.takeover.get(contact.secUid).active)continue;
      const fresh=await this.messenger.read(contact),existing=this.store.data.outbox.find(o=>o.reviewId===entry.id),sentIds=new Set(existing?.steps?.filter(s=>s.status==='sent').map(s=>s.receipt?.messageId).filter(Boolean)||[]);
      if(payload.baseMessages?!sameMessageWindow(fresh.filter(m=>!sentIds.has(m.id)),payload.baseMessages):stampMessages(fresh.filter(m=>!sentIds.has(m.id)))!==payload.baseStamp){if(existing?.steps)this.store.cancelPending(existing,'审核等待期间会话已变化');this.reviews.finish(entry.id,'stale','会话已变化，请查看更新后的草稿');continue;}
      const claimed=this.reviews.claim(entry.id);if(!claimed)continue;
      try{const item=this.store.draft(contact,payload.inputIds.map(id=>({id})),payload.text,'已由操作者批准',{provider:payload.provider,model:payload.model,plan:payload.plan,contributors:payload.contributors,reviewId:entry.id});
        if(['draft','partial'].includes(item.status))await this.executor().execute(contact,item);
        this.reviews.finish(entry.id,item.status==='sent'?'sent':item.status==='uncertain'?'uncertain':item.steps?.some(s=>s.status==='pending')?'approved':'stale',item.note||'');
      }catch(error){if(storageFault(error))throw error;this.reviews.finish(entry.id,'failed',error.message);if(error instanceof StopRequired)throw error;}
    }
  }
  async remember(contact,messages,model){if(!this.memory||!this.live||this.signal?.aborted)return;try{await this.memory.observe(contact,messages.filter(m=>!m.item&&!m.mediaProcessed&&!m.mediaAvailable),model,this.signal);this.health.resolve(`memory:${contact.secUid}`);}catch(error){if(storageFault(error))throw error;if(this.signal?.aborted)return;this.log(`长期记忆：${error.message}`);try{this.health.alert(`memory:${contact.secUid}`,'长期记忆暂未更新',`${contact.label}：${error.message}`);}catch(noticeError){this.log(`记忆通知暂未写入：${noticeError.message}`);}}}
  report() {
    return this.journal.writeSnapshot();
  }
  async refreshJournal(signal) {
    try { await this.journal.tick(signal); }
    catch (error) {if(storageFault(error))throw error; this.log(`每日日志暂未更新：${error.message}`); }
  }
  async analyzeVideo(video, signal, pollMilliseconds = 10000) {
    const controller = new AbortController();
    const analysisSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const pending = this.videoAnalysis.analyze(video, analysisSignal).then(value => ({done: true, value}), error => ({done: true, error}));
    try {
      while (true) {
        let timer;
        const tick = new Promise(resolve => {timer = setTimeout(() => resolve({done: false}), pollMilliseconds); timer.unref?.();});
        const result = await Promise.race([pending, tick]);
        clearTimeout(timer);
        if (result.done) {if (result.error) throw result.error;return result.value;}
        if (!analysisSignal.aborted) {
          this.health.heartbeat({running: true});
          await this.pollReplies();
          await this.runChannel('public-comments',()=>this.engagement?.poll?.(signal));
        }
      }
    } catch (error) {controller.abort();await pending;throw error;}
  }
  async browseRound(signal, provider = 'openai') {
    const browse = providerBrowse(this.cfg, provider), engagement = providerEngagement(this.cfg, provider);
    const efficiency = efficiencySettings(this.cfg);
    const model = this.models[provider];
    if (!model || !browse.enabled || browse.videosPerDay !== null && this.store.videoCount(dayKey(), provider) >= browse.videosPerDay) return;
    try{model.meter?.assertAvailable(provider,model.config.model);}catch(error){if(storageFault(error))throw error;if(!['BUDGET_EXCEEDED','BUDGET_UNKNOWN'].includes(error.code))throw error;this.log(error.message);this.store.markBrowsed(provider);return;}
    await this.verifyAccount();
    const known = new Set([...this.store.data.videos.map(v => v.id), ...(this.videoAnalysis?.deferredIds?.() || [])]);
    const remaining = Math.min(browse.videosPerRound, browse.videosPerDay === null ? Infinity : browse.videosPerDay - this.store.videoCount(dayKey(), provider));
    this.log(`[${providerLabel(provider)}] 从推荐流取视频，按本角色兴趣排序`);
    const candidates=await this.dy.feed({exclude:[...known],limit:remaining});
    const videos = this.interests.rankCandidates(candidates.filter(v => !known.has(v.id)),provider).slice(0, remaining);
    let commented=0;
    for (const video of videos) {
      if (signal?.aborted) break;
      try {
        const frames = this.videoAnalysis ? [] : await this.dy.watch(video, {...browse,framesPerVideo:efficientFrames(efficiency,browse,video),captureAudio:Boolean(this.understanding)});
        const perception = this.videoAnalysis ? await this.analyzeVideo(video, signal) : await this.understanding?.process(video,frames,model,signal);
        let commentPlan = null;
        if (efficiency.enabled && efficiency.combineVideoComment && commented < engagement.perRound && typeof model.reviewWithComment === 'function') {
          try { commentPlan = await this.engagement?.prepareVideo?.(video, signal, provider); }
          catch (error) {if(storageFault(error))throw error; if (error instanceof StopRequired) throw error; this.log(`合并评论上下文暂不可用：${error.message}`); }
        }
        const analysis = {...await this.interests.review(model,video,frames,provider,perception,commentPlan),...(perception?{perception}:{})};
        this.store.addVideo(video, analysis, { provider, model: model.config?.model || '' });
        try{this.interests.observe(video,analysis,provider);}catch(error){if(storageFault(error))throw error;this.log(`[${providerLabel(provider)}] 兴趣记录暂未更新：${error.message}`);}
        this.report();
        this.log(`[${providerLabel(provider)}] 已浏览 ${video.id}，${analysis.recommend ? '值得看' : '已记录'}`);
        if(this.engagement&&commented<engagement.perRound){
          try{const action=await this.engagement.onVideo(video,analysis,signal,provider,commentPlan);if(action&&['accepted','sent'].includes(action.status))commented++;}
          catch(error){if(storageFault(error))throw error;this.log(`[${providerLabel(provider)}] 视频评论 ${video.id}：${error.message}`);}
        }
      } catch (error) {if(storageFault(error))throw error;
        if (error instanceof StopRequired) throw error;
        this.log(`[${providerLabel(provider)}] 视频 ${video.id}：${error.message}`);
      }
      if (!signal?.aborted) await this.pollReplies();
    }
    this.store.markBrowsed(provider);
  }
  async once(signal) {
    this.signal = signal;
    await this.pollReplies();
    if (!signal?.aborted) await this.engagement?.poll(signal,{force:true});
    for (const provider of PROVIDERS) if (!signal?.aborted) await this.browseRound(signal,provider);
    if (!signal?.aborted) await this.refreshJournal(signal);
  }
  async run(signal) {
    this.backgroundRun=true;this.signal = signal;
    while (!signal.aborted) {
      try{
      this.health.heartbeat({running:true});
      this.channels.refreshAlerts({notify:this.cfg.monitor?.notify});
      await this.processReviews();
      await this.pollReplies();
      if(!signal.aborted)await this.runChannel('public-comments',()=>this.engagement?.poll(signal));
      if (signal.aborted) break;
      for (const provider of PROVIDERS) {
        if (signal.aborted) break;
        const browse = providerBrowse(this.cfg, provider);
        if (Date.now() - this.store.lastBrowseAt(provider) >= browse.everyMinutes * 60_000) await this.runChannel('browse:'+provider,()=>this.browseRound(signal,provider));
      }
      if (!signal.aborted) await this.refreshJournal(signal);
      if(!signal.aborted)await this.runChannel('public-review',()=>this.review?.tick(signal));
      this.health.resolve('worker-network');
      this.health.resolve('worker-read');
      }catch(error){if(storageFault(error))throw error;if(!['NETWORK_TRANSIENT','REMOTE_READ_EMPTY'].includes(error.code))throw error;this.log(error.message);const empty=error.code==='REMOTE_READ_EMPTY';this.health.alert(empty?'worker-read':'worker-network',empty?'抖音数据暂未返回':'抖音网络暂不可用',empty?'接口返回空内容，相关读取暂缓，稍后重新核对。':'后台正在退避等待，未执行发送');for(let i=0;i<30&&!signal.aborted;i++)await sleep(1000);continue;}
      for (let i = 0; i < this.cfg.reply.pollSeconds && !signal.aborted; i++) await sleep(1000);
    }
  }
}
