import { existsSync, readFileSync, renameSync, unlinkSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dayKey, makeDirs } from './config.mjs';

export function atomicJson(file, value) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
  } finally { try { unlinkSync(tmp); } catch {} }
}
export function takeLock(home, { runtimeId = '' } = {}) {
  makeDirs(home);
  const file = join(home, 'process.lock');
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try { fd = openSync(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let prior;
      try { prior = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('进程锁无法解析，请确认程序已停止后删除 .data/process.lock'); }
      let alive = true;
      try { process.kill(prior.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
      if (alive) throw new Error(`已有程序运行（PID ${prior.pid}），请先停止它`);
      unlinkSync(file);
      continue;
    }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token, runtimeId })); } finally { closeSync(fd); }
    return () => {
      try { if (JSON.parse(readFileSync(file, 'utf8')).token === token) unlinkSync(file); } catch {}
    };
  }
  throw new Error('未取得进程锁');
}
export class Store {
  constructor(home) {
    makeDirs(home);
    this.home = home;
    this.file = join(home, 'state.json');
    this.data = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, 'utf8'))
      : { version: 1, contacts: {}, outbox: [], videos: [], apiUsage: [], lastBrowseAt: 0 };
    if (this.data.version !== 1 || !this.data.contacts || !Array.isArray(this.data.outbox) || !Array.isArray(this.data.videos)) throw new Error('state.json 格式错误，已停止，避免重复发送');
  }
  save() { atomicJson(this.file, this.data); }
  recover() {
    let changed = false;
    for (const item of this.data.outbox) {
      if (item.status === 'sending') { item.status = 'uncertain'; item.note = '上次进程在发送期间退出，需人工核对'; changed = true; }
    }
    if (changed) this.save();
  }
  contact(id) {
    if (!Object.hasOwn(this.data.contacts, id)) Object.defineProperty(this.data.contacts, id, { value: { initialized: false, seen: [], history: [] }, writable: true, enumerable: true, configurable: true });
    return this.data.contacts[id];
  }
  snapshot(id, messages) {
    const c = this.contact(id);
    c.history = messages.slice(-40);
    this.save();
  }
  remember(id, ids) {
    const c = this.contact(id);
    c.seen = [...new Set([...c.seen, ...ids.filter(Boolean)])].slice(-2000);
  }
  baseline(id, messages) {
    const c = this.contact(id);
    this.remember(id, messages.map(m => m.id));
    c.initialized = true;
    c.history = messages.slice(-40);
    this.save();
  }
  unseen(id, messages) { const c = this.contact(id); return messages.filter(m => m.from === 'them' && m.id && !c.seen.includes(m.id)); }
  blocked(id) { return this.data.outbox.some(o => o.contactId === id && ['uncertain', 'sending'].includes(o.status)); }
  quota(id, cfg, today = dayKey()) {
    const counted = this.data.outbox.filter(o => o.day === today && ['sending', 'sent', 'uncertain'].includes(o.status));
    return Math.max(0, Math.min(cfg.totalPerDay - counted.length, cfg.perContactPerDay - counted.filter(o => o.contactId === id).length));
  }
  draft(contact, messages, text, reason, { provider = 'openai', model = '' } = {}) {
    const ids = messages.map(m => m.id);
    // 同一输入批次只能入队一次；只有此处落盘成功后，调用方才能进入发送。
    const duplicate = this.data.outbox.find(o => o.contactId === contact.secUid && ids.some(id => o.inputIds.includes(id)));
    if (duplicate) return duplicate;
    const item = { id: randomUUID(), contactId: contact.secUid, label: contact.label, provider, model, inputIds: ids, text, reason, status: 'draft', day: dayKey(), createdAt: new Date().toISOString() };
    this.data.outbox.push(item);
    this.remember(contact.secUid, ids);
    this.save();
    return item;
  }
  transition(item, status, note = '') {
    const next = { ...item, status, note, updatedAt: new Date().toISOString() };
    if (status === 'sending') next.day = dayKey();
    Object.assign(item, next);
    this.save();
  }
  addVideo(video, analysis, { provider = 'openai', model = '' } = {}) {
    this.data.videos.push({ ...video, analysis, provider, model, day: dayKey(), watchedAt: new Date().toISOString() });
    this.data.videos = this.data.videos.slice(-1000);
    this.save();
  }
  recentVideos(provider = 'openai') { return this.data.videos.filter(v => (v.provider || 'openai') === provider).slice(-8).map(v => ({ id: v.id, desc: v.desc, url: v.url, analysis: v.analysis })); }
  videoCount(today = dayKey(), provider = 'openai') { return this.data.videos.filter(v => v.day === today && (v.provider || 'openai') === provider).length; }
  lastBrowseAt(provider = 'openai') { return provider === 'openai' ? this.data.lastBrowseAt || 0 : this.data.browseAt?.[provider] || 0; }
  markBrowsed(provider = 'openai', now = Date.now()) {
    if (provider === 'openai') this.data.lastBrowseAt = now;
    else { this.data.browseAt ||= {}; this.data.browseAt[provider] = now; }
    this.save();
  }
}
