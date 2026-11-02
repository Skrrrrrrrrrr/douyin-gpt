import {storageFault} from './storage.mjs';
import { CommentStore } from './comment-store.mjs';
import { PROVIDERS, providerEngagement, providerLabel } from './config.mjs';
import {Reviews} from './reviews.mjs';
import {Audience} from './audience.mjs';
import {validatePublicDecision} from './token-policy.mjs';
import {accountConfirmation} from './comment-confirmation.mjs';

export class CommentAutomation {
  constructor({ home, cfg, gpt, models = {}, comments, dy, store, live = false, log = console.log }) {
    Object.assign(this, { home, cfg, gpt, comments, dy, store, live, log });
    this.models = { openai: gpt, ...models };
    for (const provider of PROVIDERS) this.models[provider]?.setCharacter?.(cfg);
    this.ledger = new CommentStore(home);
    this.ledger.recover();
    this.previews = [];
    this.audience=new Audience(home);this.reviews=new Reviews(home);
  }
  settings(provider) { return providerEngagement(this.cfg, provider); }
  ready(signal, provider = 'openai') {
    this.signal = signal;
    this.comments.signal = signal;
    return Boolean(this.models[provider] && this.settings(provider).enabled && !signal?.aborted && !this.ledger.data.halted);
  }
  owner(event) {
    // 优先匹配被回复的精确评论，再按楼根归属；旧记录属于 GPT。
    for (const id of [event.replyToId, event.target.rootId]) {
      if (!id) continue;
      const action = this.ledger.data.actions.find(a => a.videoId === event.video.id && a.receipt?.id === id);
      if (action) return action.provider || 'openai';
    }
    return 'openai';
  }
  draft(kind, video, target, decision, provider) {
    return this.ledger.draft(kind, video, target, decision, { provider, model: this.models[provider]?.config?.model || '' });
  }
  async submit(kind, video, target, decision, provider = 'openai', {approved=false}={}) {
    const cfg = this.settings(provider);
    if (!this.live || !this.ready(this.signal, provider)) return null;
    if (kind === 'comment' && !cfg.commentOnVideos || kind === 'reply' && !cfg.replyToComments) return null;
    decision = validatePublicDecision(decision, cfg.maxChars);
    if (kind === 'comment' && !this.ledger.canComment(cfg, Date.now(), provider)) return null;
    if (!decision.shouldPost || decision.confidence < cfg.minConfidence || !decision.text.trim() || [...decision.text].length > cfg.maxChars) return null;
    if(!approved&&this.cfg.review.comments==='review'){return this.reviews.add('comment','public:'+this.ledger.key(kind,video.id,target?.id||''),{kind,video:{id:video.id,desc:video.desc,author:video.author,url:video.url},target,decision,provider,text:decision.text});}
    // 去重键跨模型共用，不能让第二个模型接管另一模型已生成或发出的记录。
    const action = this.draft(kind, video, target, decision, provider);
    if (action.status !== 'draft' || (action.provider || 'openai') !== provider) return action;
    await this.dy.checkAccount(this.cfg.account);
    if (this.signal?.aborted || !this.ledger.quota(kind, cfg, provider)) return null;
    this.ledger.transition(action, 'sending');
    try {
      const receipt = await this.comments.send({ video, target, text: action.text, account: this.cfg.account });
      if (!receipt.accepted || !receipt.id) throw new Error('评论没有可靠回执');
      this.ledger.transition(action, receipt.verified ? 'sent' : 'accepted', receipt.verified ? '已从发送账号内回读；对方可见性未确认' : '平台已接收，等待重新读取复核', receipt);
      if(typeof this.comments.verifyDelivery==='function')await this.verifyAction(action);
      this.log(`[${providerLabel(provider)}] ${kind === 'comment' ? '评论提交' : '评论回复提交'} ${kind === 'comment' ? video.id : target.id}（${action.status==='sent'?'账号内复核通过，对方可见性未确认':'平台接收，等待复核'}）`);
    } catch (error) {if(storageFault(error))throw error;
      if (error.sendAttempted === false) this.ledger.transition(action, 'not_sent', error.message,undefined,error.diagnostic);
      else this.ledger.transition(action, 'uncertain', error.message,error.receipt,error.diagnostic);
      if (error.name === 'StopRequired' || error.code === 'server_rejected') {
        this.ledger.data.halted = '评论页面需要核对：' + error.message;
        this.ledger.save();
      }
      this.log(`[${providerLabel(provider)}] 公开评论操作未完成：${error.message}`);
    }
    return action;
  }
  async verifyAction(action){
    if(this.signal?.aborted||typeof this.comments.verifyDelivery!=='function')return;
    let result;try{result=await this.comments.verifyDelivery(action,this.cfg.account);}
    catch(error){if(storageFault(error))throw error;result=accountConfirmation(null,'read_failed',{reason:error.name==='StopRequired'?'页面需要本人核对，评论保留待复核':'复核读取暂未完成；保留原提交记录，不重发'});}
    this.ledger.confirm(action,result);
  }
  async reconcileDeliveries(signal){
    if(!this.live||signal?.aborted||typeof this.comments.verifyDelivery!=='function')return;
    this.signal=signal;this.comments.signal=signal;
    const candidates=this.ledger.data.actions.filter(a=>['accepted','uncertain'].includes(a.status)&&a.receipt?.version===2&&a.receipt?.id&&(a.confirmation?.attempts||0)<4&&(a.confirmation?.nextCheckAt||0)<=Date.now());
    for(const action of candidates.slice(-2)){if(signal?.aborted)break;await this.yieldToReplies?.();await this.verifyAction(action);}
  }
  async sendApproved(entry,reviews=this.reviews){
    const p=entry.payload,cfg=this.settings(p.provider);if(!this.ready(this.signal,p.provider)||!this.ledger.quota(p.kind,cfg,p.provider))return;
    if(typeof p.text!=='string'||!p.text.trim()||[...p.text].length>cfg.maxChars||/https?:\/\/|@|sk-[\w-]+|Cookie\s*:/i.test(p.text)){reviews.finish(entry.id,'stale','评论文字不符合长度或内容要求');return;}
    try{const video=await this.dy.detail(p.video.id),context=await this.comments.read(video,p.target);
      if(p.target){const target=context.find(c=>c.id===p.target.id&&c.authorSecUid===p.target.authorSecUid&&c.rootId===p.target.rootId&&c.text===p.target.text);if(!target||context.some(c=>c.authorSecUid===this.cfg.account.secUid&&c.createTime>=target.createTime&&c.rootId===target.rootId&&(c.replyToId===target.id||c.replyToSecUid===target.authorSecUid||target.id===target.rootId))){reviews.finish(entry.id,'stale','目标已变化或本人已回复');return;}}
      else if(!this.ledger.canComment(cfg,Date.now(),p.provider))return;
      if(!reviews.claim(entry.id))return;const action=await this.submit(p.kind,video,p.target,{...p.decision,text:p.text},p.provider,{approved:true});reviews.finish(entry.id,action?.status==='uncertain'?'uncertain':['accepted','sent'].includes(action?.status)?'sent':'stale',action?.note||'发送条件已改变');
    }catch(error){if(storageFault(error))throw error;reviews.finish(entry.id,'failed',error.message);}
  }
  async prepareVideo(video, signal, provider = 'openai') {
    const cfg = this.settings(provider);
    if (!this.ready(signal, provider) || !cfg.commentOnVideos || !this.ledger.canComment(cfg, Date.now(), provider)
      || this.ledger.has('comment', video.id) || this.reviews.pending('public:' + this.ledger.key('comment', video.id))) return null;
    return {videoId: video.id, provider, maxChars: cfg.maxChars, comments: await this.comments.read(video)};
  }
  async onVideo(video, analysis, signal, provider = 'openai', prepared = null) {
    const cfg = this.settings(provider);
    if (!this.ready(signal, provider) || !cfg.commentOnVideos || !this.ledger.canComment(cfg, Date.now(), provider) || this.ledger.has('comment', video.id)||this.reviews.pending('public:'+this.ledger.key('comment',video.id))) return null;
    const reusable = prepared?.videoId === video.id && prepared.provider === provider && prepared.maxChars === cfg.maxChars && analysis.commentDecision;
    const context = reusable ? prepared.comments : await this.comments.read(video);
    const decision = reusable ? validatePublicDecision(analysis.commentDecision, cfg.maxChars)
      : await this.models[provider].publicComment({ video, analysis, comments: context, maxChars: cfg.maxChars });
    if (signal?.aborted) return null;
    if (!this.live) {
      this.previews.push({ provider, kind: 'comment', videoId: video.id, ...decision });
      this.log(`[${providerLabel(provider)}] 评论预览 ${video.id}：${decision.shouldPost ? decision.text : decision.reason}`);
      return null;
    }
    if (!decision.shouldPost || decision.confidence < cfg.minConfidence) {
      const action = this.draft('comment', video, null, decision, provider);
      this.ledger.transition(action, 'skipped', decision.reason);
      return action;
    }
    return this.submit('comment', video, null, decision, provider);
  }
  async poll(signal, { force = false } = {}) {
    await this.reconcileDeliveries(signal);
    const active = PROVIDERS.filter(p => this.ready(signal, p) && this.settings(p).replyToComments);
    if (!active.length) return;
    const interval = Math.min(...active.map(p => this.settings(p).pollSeconds)) * 1000;
    if (!force && Date.now() - this.ledger.data.lastPollAt < interval) return;
    try {
      await this.dy.checkAccount(this.cfg.account);
      const events = await this.comments.notices(this.cfg.account);
      this.ledger.data.lastPollAt = Date.now();
      this.ledger.save();
      if (!this.ledger.data.initialized) {
        if (this.live) { this.ledger.baseline(events); this.log(`已建立评论通知基线 ${events.length} 条，只回复此后新互动`); }
        return;
      }
      for (const event of events) {
        if (signal?.aborted || this.ledger.data.halted) break;
        if (this.ledger.data.seen.includes(event.id)) continue;
        if (!this.ledger.retryReady(event.id)) continue;
        await this.yieldToReplies?.();
        if(signal?.aborted)break;
        if(this.live&&this.cfg.audience?.enabled)try{this.audience.collect(event);}catch(error){if(storageFault(error))throw error;this.log(`观众选题暂未入库：${error.message}`);}
        let target = event.target;
        if (this.ledger.has('reply', event.video.id, target.id)||this.reviews.pending('public:'+this.ledger.key('reply',event.video.id,target.id))) { if (this.live) this.ledger.markSeen([event.id]); continue; }
        if (!target.authorSecUid || target.authorSecUid === this.cfg.account.secUid) { if (this.live) this.ledger.markSeen([event.id]); continue; }
        let provider = this.owner(event), cfg = this.settings(provider);
        // 原模型关闭、失败或额度用完时，保留待处理，不改由另一模型回答。
        const unknownRoot = !event.replyToId && !target.rootId;
        if (!unknownRoot && (!this.ready(signal, provider) || !cfg.replyToComments || !this.ledger.quota('reply', cfg, provider))) continue;
        let reading = true;
        try {
          const video = await this.dy.detail(event.video.id);
          const context = await this.comments.read(video, target);
          const found = context.find(c => c.id === target.id && (!target.rootId || c.rootId === target.rootId) && c.authorSecUid === target.authorSecUid && (!target.text || c.text === target.text));
          if (!found) {
            const retry = this.live ? this.ledger.defer(event.id, '目标评论暂未加载或无法核对') : null;
            this.log(`目标评论 ${target.id} 暂未加载${retry ? `，${Math.ceil((retry.nextRetryAt - Date.now()) / 60000)} 分钟后重试` : ''}`); continue;
          }
          reading = false;
          target = { ...target, rootId: found.rootId, text: found.text, createTime: target.createTime || found.createTime };
          // @ 通知有时不带楼根，以页面解析出的真实楼根重新核对归属。
          provider = this.owner({ ...event, target }); cfg = this.settings(provider);
          if (!this.ready(signal, provider) || !cfg.replyToComments || !this.ledger.quota('reply', cfg, provider)) continue;
          const answered = context.some(c => c.authorSecUid === this.cfg.account.secUid && c.id !== target.id && c.rootId === target.rootId && c.createTime >= target.createTime && (c.replyToId === target.id || c.replyToSecUid === target.authorSecUid || target.id === target.rootId));
          if (answered) { if (this.live) this.ledger.markSeen([event.id]); continue; }
          if(this.live&&this.cfg.audience?.enabled)try{this.audience.collect({...event,target});}catch(error){if(storageFault(error))throw error;this.log(`观众选题暂未入库：${error.message}`);}
          const old = this.store.data.videos.find(v => v.id === video.id && (v.provider || 'openai') === provider);
          const decision = await this.models[provider].publicComment({ video, analysis: old?.analysis || null, comments: context.filter(c => c.rootId === target.rootId), target: { ...target, parentText: event.parentText }, maxChars: cfg.maxChars });
          if (signal?.aborted) break;
          if (!this.live) { this.previews.push({ provider, kind: 'reply', targetId: target.id, ...decision }); continue; }
          if (decision.shouldPost && decision.confidence >= cfg.minConfidence) await this.submit('reply', video, target, decision, provider);
          else { const action = this.draft('reply', video, target, decision, provider); this.ledger.transition(action, 'skipped', decision.reason); }
          this.ledger.markSeen([event.id]);
        } catch (error) {if(storageFault(error))throw error; if (reading && this.live && !signal?.aborted) this.ledger.defer(event.id, error.message); this.log(`[${providerLabel(provider)}] 评论回复 ${target.id}：${error.message}`); }
      }
    } catch (error) {if(storageFault(error))throw error;
      this.log(`读取评论互动通知失败：${error.message}`);
      this.ledger.data.lastPollAt = Date.now(); this.ledger.save();
    }
  }
}
