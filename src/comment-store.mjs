import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson } from './store.mjs';
import { dayKey, makeDirs } from './config.mjs';

export const COUNTED_COMMENT_STATES = ['sending', 'accepted', 'sent', 'uncertain'];
export class CommentStore {
  constructor(home) {
    makeDirs(home); this.file = join(home, 'comments.json');
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { version: 1, initialized: false, seen: [], actions: [], lastPollAt: 0, halted: '' };
    if (this.data.version !== 1 || !Array.isArray(this.data.seen) || !Array.isArray(this.data.actions)) throw new Error('comments.json 格式错误，评论功能停止，避免重复发送');
  }
  save() { atomicJson(this.file, this.data); }
  recover() {
    let changed = false;
    for (const action of this.data.actions) if (action.status === 'sending') {
      action.status = 'uncertain'; action.note = '发送期间进程退出，需核对';
      this.data.halted = '有发送结果不确定的评论'; changed = true;
    }
    if (changed) this.save();
  }
  markSeen(ids) { this.data.seen = [...new Set([...this.data.seen, ...ids.filter(Boolean)])].slice(-5000); this.save(); }
  baseline(events) { this.data.initialized = true; this.markSeen(events.map(e => e.id)); }
  key(kind, videoId, targetId = '') { return kind === 'comment' ? `comment:${videoId}` : `reply:${videoId}:${targetId}`; }
  has(kind, videoId, targetId = '') { return this.data.actions.some(a => a.key === this.key(kind,videoId,targetId)); }
  count(kind, today = dayKey()) { return this.data.actions.filter(a => a.kind === kind && a.day === today && COUNTED_COMMENT_STATES.includes(a.status)).length; }
  quota(kind, cfg) { return Math.max(0, (kind === 'comment' ? cfg.commentsPerDay : cfg.repliesPerDay) - this.count(kind)); }
  canComment(cfg, now = Date.now()) {
    if (this.data.halted || !this.quota('comment', cfg)) return false;
    const recent = this.data.actions.filter(a => a.kind === 'comment' && COUNTED_COMMENT_STATES.includes(a.status)).at(-1);
    return !recent || now - Date.parse(recent.sentAt || recent.updatedAt || recent.createdAt) >= cfg.commentCooldownMinutes * 60_000;
  }
  draft(kind, video, target, decision) {
    const key = this.key(kind, video.id, target?.id || '');
    const old = this.data.actions.find(a => a.key === key); if (old) return old;
    const action = { id: randomUUID(), key, kind, videoId: video.id, targetId: target?.id || '', rootId: target?.rootId || '', targetAuthor: target?.authorSecUid || '', text: decision.text, reason: decision.reason, confidence: decision.confidence, status: 'draft', day: dayKey(), createdAt: new Date().toISOString() };
    this.data.actions.push(action); this.save(); return action;
  }
  transition(action, status, note = '', receipt = undefined) {
    Object.assign(action, { status, note, updatedAt: new Date().toISOString() });
    if (status === 'sending') action.day = dayKey();
    if (['accepted','sent'].includes(status)) action.sentAt ||= new Date().toISOString();
    if (receipt) action.receipt = receipt;
    if (status === 'uncertain') this.data.halted = '评论发送结果待核对，已暂停公开发言';
    this.save();
  }
}
