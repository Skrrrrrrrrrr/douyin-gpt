import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson } from './store.mjs';
import { dayKey, makeDirs } from './config.mjs';
import {commentDiagnostic} from './send-diagnostics.mjs';
import {storedJson} from './storage.mjs';

export const COUNTED_COMMENT_STATES = ['sending', 'accepted', 'sent', 'uncertain'];
export class CommentStore {
  constructor(home) {
    makeDirs(home); this.file = join(home, 'comments.json');
    this.data = storedJson(this.file,{ version: 1, initialized: false, seen: [], actions: [], lastPollAt: 0, halted: '' });
    if (this.data.version !== 1 || !Array.isArray(this.data.seen) || !Array.isArray(this.data.actions)) throw new Error('comments.json 格式错误，评论功能停止，避免重复发送');
    this.data.deferred ??= {};
    if (typeof this.data.deferred !== 'object' || Array.isArray(this.data.deferred)) throw new Error('评论重试记录格式错误');
  }
  save() {try{atomicJson(this.file, this.data);}catch(error){if(error.code==='STORAGE_CONFLICT')this.data=storedJson(this.file);throw error;}}
  recover() {
    let changed = false;
    for (const action of this.data.actions) if (action.status === 'sending') {
      action.status = 'uncertain'; action.note = '发送期间进程退出，需核对';
      this.data.halted = '有发送结果不确定的评论'; changed = true;
    }
    if (changed) this.save();
  }
  markSeen(ids) { this.data.seen = [...new Set([...this.data.seen, ...ids.filter(Boolean)])].slice(-5000); for (const id of ids) delete this.data.deferred[id]; this.save(); }
  retryReady(id, now = Date.now()) { return !this.data.deferred[id] || now >= this.data.deferred[id].nextRetryAt; }
  defer(id, reason, now = Date.now()) {
    const attempts = (this.data.deferred[id]?.attempts || 0) + 1;
    const minutes = [5, 15, 60, 360][Math.min(attempts - 1, 3)];
    const retry = { attempts, nextRetryAt: now + minutes * 60_000, reason: String(reason).slice(0, 200) };
    this.data.deferred[id] = retry; this.save(); return retry;
  }
  baseline(events) { this.data.initialized = true; this.markSeen(events.map(e => e.id)); }
  key(kind, videoId, targetId = '') { return kind === 'comment' ? `comment:${videoId}` : `reply:${videoId}:${targetId}`; }
  has(kind, videoId, targetId = '') { return this.data.actions.some(a => a.key === this.key(kind,videoId,targetId)); }
  count(kind, today = dayKey(), provider) { return this.data.actions.filter(a => a.kind === kind && a.day === today && (!provider || (a.provider || 'openai') === provider) && COUNTED_COMMENT_STATES.includes(a.status)).length; }
  quota(kind, cfg, provider = 'openai') { const limit = kind === 'comment' ? cfg.commentsPerDay : cfg.repliesPerDay; return limit === null ? Infinity : Math.max(0, limit - this.count(kind, dayKey(), provider)); }
  canComment(cfg, now = Date.now(), provider = 'openai') {
    if (this.data.halted || !this.quota('comment', cfg, provider)) return false;
    const recent = this.data.actions.filter(a => a.kind === 'comment' && COUNTED_COMMENT_STATES.includes(a.status)).at(-1);
    return !recent || now - Date.parse(recent.sentAt || recent.updatedAt || recent.createdAt) >= cfg.commentCooldownMinutes * 60_000;
  }
  draft(kind, video, target, decision, { provider = 'openai', model = '' } = {}) {
    const key = this.key(kind, video.id, target?.id || '');
    const old = this.data.actions.find(a => a.key === key); if (old) return old;
    const action = { id: randomUUID(), key, kind, provider, model, videoId: video.id, targetId: target?.id || '', rootId: target?.rootId || '', targetAuthor: target?.authorSecUid || '', text: decision.text, reason: decision.reason, confidence: decision.confidence, status: 'draft', day: dayKey(), createdAt: new Date().toISOString() };
    this.data.actions.push(action); this.save(); return action;
  }
  transition(action, status, note = '', receipt = undefined, diagnostic = undefined) {
    Object.assign(action, { status, note, updatedAt: new Date().toISOString() });
    if (status === 'sending') action.day = dayKey();
    if (['accepted','sent'].includes(status)) action.sentAt ||= new Date().toISOString();
    if (receipt) action.receipt = receipt;
    if (diagnostic) action.diagnostic=commentDiagnostic(diagnostic,{code:diagnostic.code,stage:diagnostic.stage,attempted:diagnostic.sendAttempted});
    if (status === 'uncertain') this.data.halted = '评论发送结果待核对，已暂停公开发言';
    this.save();
  }
  confirm(action,verification){
    if(!action?.receipt?.id||!['accepted','sent','uncertain'].includes(action.status))throw new Error('该评论没有可核对的发送记录');
    const previous=action.confirmation||action.receipt.confirmation||{};
    action.confirmation={...previous,...verification,recipientVisible:previous.recipientVisible??null};
    action.confirmation.attempts=(previous.attempts||0)+1;
    action.confirmation.nextCheckAt=verification.accountVisible===true?null:Date.now()+[15000,60000,300000,900000][Math.min(action.confirmation.attempts-1,3)];
    action.receipt.confirmation=action.confirmation;
    if(verification.accountVisible===true){action.receipt.accepted=true;action.receipt.verified=true;action.status='sent';action.sentAt||=action.updatedAt||action.createdAt;action.note='已重新读取核对发送账号内的评论；对方可见性尚未确认';}
    else{action.receipt.verified=false;action.status=action.receipt.accepted?'accepted':'uncertain';action.note=verification.reason||'正在重新读取复核，尚不能确认送达';}
    action.updatedAt=new Date().toISOString();
    if(!this.data.actions.some(a=>['sending','uncertain'].includes(a.status))&&['评论发送结果待核对，已暂停公开发言','有发送结果不确定的评论'].includes(this.data.halted))this.data.halted='';
    this.save();return action;
  }
}
