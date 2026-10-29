import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dayKey, PROVIDERS, providerBrowse, providerEngagement, providerLabel } from './config.mjs';
import { sleep } from './browser.mjs';
import { StopRequired } from './douyin.mjs';

export const messageSignature = messages => JSON.stringify(messages.map(m => [m.id, m.from, m.text, m.item]));
export function unanswered(messages) {
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
    this.previews = [];
    this.previewedInputs = new Map();
  }
  async verifyAccount() { return this.dy.checkAccount(this.cfg.account); }
  async pollReplies() {
    if (!this.cfg.reply.enabled) return;
    await this.verifyAccount();
    for (const contact of this.cfg.reply.contacts.filter(c => c.enabled)) {
      if (this.signal?.aborted) break;
      try { await this.replyTo(contact); }
      catch (error) {
        if (error instanceof StopRequired) throw error;
        this.log(`联系人 ${contact.label || contact.secUid.slice(-6)}：${error.message}`);
      }
    }
  }
  async replyTo(contact) {
    if (!this.cfg.reply.enabled || !this.cfg.reply.contacts.some(c => c.enabled && c.secUid === contact.secUid)) return;
    if (this.signal?.aborted) return;
    const state = this.store.contact(contact.secUid);
    if (this.store.blocked(contact.secUid)) { this.log(`${contact.label} 有发送结果待核对，暂不继续回复`); return; }
    if (this.live && this.store.quota(contact.secUid, this.cfg.reply) <= 0) return;
    const messages = await this.messenger.read(contact);
    if (this.live && !state.initialized) {
      if (!messages.length || !messages.some(m => m.id)) { this.log(`${contact.label} 未读到可靠消息 ID，暂不建立消息基线，请检查页面或运行 doctor`); return; }
      this.store.baseline(contact.secUid, messages);
      this.log(`已记录 ${contact.label} 的消息基线，只回复此后新到的消息`);
      return;
    }
    const waiting = unanswered(messages);
    let incoming = this.live ? this.store.unseen(contact.secUid, waiting) : waiting.slice(-3);
    if (!incoming.length) {
      if (this.live) {
        // 主人已经手动回过的输入也要记为已处理。
        const lastMine = messages.findLastIndex(m => m.from === 'me');
        this.store.remember(contact.secUid, messages.slice(0, lastMine + 1).map(m => m.id));
        this.store.snapshot(contact.secUid, messages);
      }
      return;
    }
    incoming = incoming.slice(-10);
    const previewKey = messageSignature(incoming);
    if (!this.live && this.previewedInputs.get(contact.secUid) === previewKey) return;
    let sharedVideo = null;
    const card = [...incoming].reverse().find(m => /^\d{15,25}$/.test(m.item || ''));
    if (card) {
      try {
        const video = await this.dy.detail(card.item);
        const frames = await this.dy.watch(video, this.cfg.browse);
        sharedVideo = { video, analysis: await this.gpt.analyze(video, frames, this.cfg.browse.interests) };
      } catch (error) {
        if (error instanceof StopRequired) throw error;
        sharedVideo = { error: '没有读到对方分享视频的画面；回复时如实说明' };
      }
    }
    const generated = await this.gpt.reply({ contact, history: messages, incoming, recentVideos: this.store.recentVideos(), sharedVideo, maxChars: this.cfg.reply.maxChars });
    if (this.signal?.aborted) return;
    if (!generated.shouldReply) {
      if (this.live) { this.store.remember(contact.secUid, incoming.map(m => m.id)); this.store.snapshot(contact.secUid, messages); }
      this.log(`${contact.label}：本条不需要回复`);
      return;
    }
    if (!this.live) {
      const preview = { contactId: contact.secUid, label: contact.label, text: generated.text, reason: generated.reason };
      this.previews.push(preview);
      this.previewedInputs.set(contact.secUid, previewKey);
      this.log(`预览 ${contact.label}：${generated.text}`);
      return;
    }
    const item = this.store.draft(contact, incoming, generated.text, generated.reason);
    if (item.status !== 'draft') return;
    const fresh = await this.messenger.read(contact);
    if (messageSignature(fresh) !== messageSignature(messages)) {
      this.store.transition(item, 'superseded', '生成期间会话有变化，已取消旧回复');
      this.log(`${contact.label} 的会话已变化，取消本条回复`);
      return;
    }
    await this.verifyAccount();
    if (this.signal?.aborted) return;
    if (this.store.quota(contact.secUid, this.cfg.reply) <= 0) return;
    // 先落盘再发送；落盘失败时绝不进入外部发送器。
    this.store.transition(item, 'sending');
    try {
      await this.messenger.send(contact, item.text, messages);
      this.store.transition(item, 'sent', '已在本人发出的消息中回读确认；不代表对方已读');
      this.log(`已回复 ${contact.label}`);
    } catch (error) {
      this.store.transition(item, 'uncertain', error.message);
      this.log(`${contact.label} 的发送结果不确定，已暂停该会话，请核对后 resolve`);
    }
  }
  report() {
    const videos = this.store.data.videos.filter(v => v.day === dayKey());
    const text = [`# 抖音浏览记录 · ${dayKey()}`, '', '> 判断依据：文案和抽样画面；本版没有音频转写。', '', ...videos.flatMap(v => [
      `## ${v.id}`, `${v.desc.replace(/\n/g, ' ')} · ${v.author}`, '', v.url, '',
      `模型：${providerLabel(v.provider)}${v.model ? `（${v.model}）` : ''}`,
      `记录：${v.analysis.summary}`, `证据：${v.analysis.evidence}`, `推荐：${v.analysis.recommend ? '是' : '否'} · 把握：${v.analysis.confidence}`, '',
    ])].join('\n');
    writeFileSync(join(this.home, 'reports', `${dayKey()}.md`), text, { mode: 0o600 });
  }
  async browseRound(signal, provider = 'openai') {
    const browse = providerBrowse(this.cfg, provider), engagement = providerEngagement(this.cfg, provider);
    const model = this.models[provider];
    if (!model || !browse.enabled || this.store.videoCount(dayKey(), provider) >= browse.videosPerDay) return;
    await this.verifyAccount();
    const known = new Set(this.store.data.videos.map(v => v.id));
    const remaining = Math.min(browse.videosPerRound, browse.videosPerDay - this.store.videoCount(dayKey(), provider));
    const videos = (await this.dy.feed({ exclude: [...known], limit: remaining })).filter(v => !known.has(v.id)).slice(0, remaining);
    let commented=0;
    for (const video of videos) {
      if (signal?.aborted) break;
      try {
        const frames = await this.dy.watch(video, browse);
        const analysis = await model.analyze(video, frames, browse.interests);
        this.store.addVideo(video, analysis, { provider, model: model.config?.model || '' });
        this.report();
        this.log(`[${providerLabel(provider)}] 已浏览 ${video.id}，${analysis.recommend ? '值得看' : '已记录'}`);
        if(this.engagement&&commented<engagement.perRound){
          try{const action=await this.engagement.onVideo(video,analysis,signal,provider);if(action&&['accepted','sent'].includes(action.status))commented++;}
          catch(error){this.log(`[${providerLabel(provider)}] 视频评论 ${video.id}：${error.message}`);}
        }
      } catch (error) {
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
  }
  async run(signal) {
    this.signal = signal;
    while (!signal.aborted) {
      await this.pollReplies();
      if(!signal.aborted)await this.engagement?.poll(signal);
      if (signal.aborted) break;
      for (const provider of PROVIDERS) {
        if (signal.aborted) break;
        const browse = providerBrowse(this.cfg, provider);
        if (Date.now() - this.store.lastBrowseAt(provider) >= browse.everyMinutes * 60_000) await this.browseRound(signal,provider);
      }
      for (let i = 0; i < this.cfg.reply.pollSeconds && !signal.aborted; i++) await sleep(1000);
    }
  }
}
