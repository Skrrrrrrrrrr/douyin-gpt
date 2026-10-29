import { CommentStore } from './comment-store.mjs';
import { PROVIDERS, providerEngagement, providerLabel } from './config.mjs';

export class CommentAutomation {
  constructor({ home, cfg, gpt, models = {}, comments, dy, store, live = false, log = console.log }) {
    Object.assign(this, { home, cfg, gpt, comments, dy, store, live, log });
    this.models = { openai: gpt, ...models };
    this.ledger = new CommentStore(home);
    this.ledger.recover();
    this.previews = [];
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
  async submit(kind, video, target, decision, provider = 'openai') {
    const cfg = this.settings(provider);
    if (!this.live || !this.ready(this.signal, provider)) return null;
    if (kind === 'comment' && !cfg.commentOnVideos || kind === 'reply' && !cfg.replyToComments) return null;
    if (!decision.shouldPost || decision.confidence < cfg.minConfidence || !decision.text.trim() || [...decision.text].length > cfg.maxChars) return null;
    // 去重键跨模型共用，不能让第二个模型接管另一模型已生成或发出的记录。
    const action = this.draft(kind, video, target, decision, provider);
    if (action.status !== 'draft' || (action.provider || 'openai') !== provider) return action;
    await this.dy.checkAccount(this.cfg.account);
    if (this.signal?.aborted || !this.ledger.quota(kind, cfg, provider)) return null;
    this.ledger.transition(action, 'sending');
    try {
      const receipt = await this.comments.send({ video, target, text: action.text, account: this.cfg.account });
      if (!receipt.accepted || !receipt.id) throw new Error('评论没有可靠回执');
      this.ledger.transition(action, receipt.verified ? 'sent' : 'accepted', receipt.verified ? '已从评论区回读确认' : '抖音已返回评论 ID，等待评论区回读', receipt);
      this.log(`[${providerLabel(provider)}] ${kind === 'comment' ? '已评论视频' : '已回复评论'} ${kind === 'comment' ? video.id : target.id}（${receipt.verified ? '回读确认' : '接口已接收'}）`);
    } catch (error) {
      if (error.sendAttempted === false) this.ledger.transition(action, 'not_sent', error.message);
      else this.ledger.transition(action, 'uncertain', error.message);
      if (error.name === 'StopRequired' || error.code === 'server_rejected') {
        this.ledger.data.halted = '评论页面需要核对：' + error.message;
        this.ledger.save();
      }
      this.log(`[${providerLabel(provider)}] 公开评论操作未完成：${error.message}`);
    }
    return action;
  }
  async onVideo(video, analysis, signal, provider = 'openai') {
    const cfg = this.settings(provider);
    if (!this.ready(signal, provider) || !cfg.commentOnVideos || !this.ledger.canComment(cfg, Date.now(), provider) || this.ledger.has('comment', video.id)) return null;
    const context = await this.comments.read(video);
    const decision = await this.models[provider].publicComment({ video, analysis, comments: context, maxChars: cfg.maxChars });
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
        let target = event.target;
        if (this.ledger.has('reply', event.video.id, target.id)) { if (this.live) this.ledger.markSeen([event.id]); continue; }
        if (!target.authorSecUid || target.authorSecUid === this.cfg.account.secUid) { if (this.live) this.ledger.markSeen([event.id]); continue; }
        let provider = this.owner(event), cfg = this.settings(provider);
        // 原模型关闭、失败或额度用完时，保留待处理，不改由另一模型回答。
        const unknownRoot = !event.replyToId && !target.rootId;
        if (!unknownRoot && (!this.ready(signal, provider) || !cfg.replyToComments || !this.ledger.quota('reply', cfg, provider))) continue;
        try {
          const video = await this.dy.detail(event.video.id);
          const context = await this.comments.read(video, target);
          const found = context.find(c => c.id === target.id && (!target.rootId || c.rootId === target.rootId) && c.authorSecUid === target.authorSecUid && (!target.text || c.text === target.text));
          if (!found) { this.log(`目标评论 ${target.id} 暂未加载，留待下一轮`); continue; }
          target = { ...target, rootId: found.rootId, text: found.text, createTime: target.createTime || found.createTime };
          // @ 通知有时不带楼根，以页面解析出的真实楼根重新核对归属。
          provider = this.owner({ ...event, target }); cfg = this.settings(provider);
          if (!this.ready(signal, provider) || !cfg.replyToComments || !this.ledger.quota('reply', cfg, provider)) continue;
          const answered = context.some(c => c.authorSecUid === this.cfg.account.secUid && c.id !== target.id && c.rootId === target.rootId && c.createTime >= target.createTime && (c.replyToId === target.id || c.replyToSecUid === target.authorSecUid || target.id === target.rootId));
          if (answered) { if (this.live) this.ledger.markSeen([event.id]); continue; }
          const old = this.store.data.videos.find(v => v.id === video.id && (v.provider || 'openai') === provider);
          const decision = await this.models[provider].publicComment({ video, analysis: old?.analysis || null, comments: context.filter(c => c.rootId === target.rootId), target: { ...target, parentText: event.parentText }, maxChars: cfg.maxChars });
          if (signal?.aborted) break;
          if (!this.live) { this.previews.push({ provider, kind: 'reply', targetId: target.id, ...decision }); continue; }
          if (decision.shouldPost && decision.confidence >= cfg.minConfidence) await this.submit('reply', video, target, decision, provider);
          else { const action = this.draft('reply', video, target, decision, provider); this.ledger.transition(action, 'skipped', decision.reason); }
          this.ledger.markSeen([event.id]);
        } catch (error) { this.log(`[${providerLabel(provider)}] 评论回复 ${target.id}：${error.message}`); }
      }
    } catch (error) {
      this.log(`读取评论互动通知失败：${error.message}`);
      this.ledger.data.lastPollAt = Date.now(); this.ledger.save();
    }
  }
}
