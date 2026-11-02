import {storageFault} from './storage.mjs';
import {allowedReplyContact} from './reply-audience.mjs';
import { readFileSync, writeFileSync, openSync, closeSync, fstatSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { atomicJson } from './store.mjs';
import {storedText} from './storage.mjs';

const DAY = 86_400_000;
const KINDS = ['preference', 'plan', 'fact'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
const canonical = value => value.normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu, '').replace(/\s+/gu, ' ').trim().toLowerCase();
const digest = value => createHash('sha256').update(value).digest('hex');
const factKey = value => digest(canonical(value));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uniqueIds = value => Array.isArray(value) && value.every(validId) && new Set(value).size === value.length;
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function sensitive(value) {
  const text = canonical(value);
  return /sk-[a-z0-9]|cookie|session(?:id|_id|_key)|access[_ -]?token|refresh[_ -]?token|\btoken\b|api[_ -]?key|authorization|\bbearer\s|private[_ -]?key|\bpassword\b|\bpasswd\b|\bsecret\b|\botp\b|\bpin\s*[:=]|验证码|校验码|动态码|密码|口令|身份证|银行卡|银行账号|银行账户|支付账号|住址|家庭地址|收货地址|通讯地址/iu.test(text)
    || /\d(?:[\s-]*\d){10,}/u.test(text)
    || /[a-z0-9_-]{24,}/iu.test(text)
    || /(?:账号|帐号|account|qq|微信号|wechat)\s*[:：=]?\s*[a-z0-9_-]{6,}/iu.test(text);
}

function instruction(value) {
  return /忽略.{0,20}(?:规则|指令|提示)|(?:改|设置|关闭|开启|删除|覆盖|重置|执行|切换|调整).{0,24}(?:配置|白名单|配额|路由|系统提示|权限|记忆|自动回复)|(?:ignore|override|disregard).{0,24}(?:rules|instructions|prompt)|(?:system|developer)\s*(?:prompt|message)|(?:run|execute)\s+(?:shell|command|code)/iu.test(canonical(value));
}

// Exact, single-statement excerpts give the local validator evidence it can check.
// The extractor must still distinguish the contact's statements from fiction or quotes.
function supported(text, source) {
  if (!source.includes(text.trim())) return false;
  const excerpt = canonical(text).replace(/[。.!！]+$/gu, '');
  if (!excerpt || /[?？]/u.test(text)) return false;
  return (source.match(/[^。！？?!\n]+[。！？?!]?/gu) || []).some(sentence => {
    const normalized = canonical(sentence);
    return normalized.includes(excerpt) && !/[?？]\s*$/u.test(sentence)
      && !/如果|假如|假设|要是|也许|可能|据说|听说|他说|她说|\b(?:if|maybe|perhaps|suppose)\b|\b(?:he|she|they)\s+(?:said|says)\b/iu.test(normalized)
      && !instruction(sentence);
  });
}

export const MEMORY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { facts: { type: 'array', description: '最多八条有明确来源的记忆；没有适合保存的陈述时返回空数组。', items: {
    type: 'object', additionalProperties: false,
    properties: {
      text: { type: 'string', description: '联系人明确陈述的单条原文摘录，最多160字；保留原文，不改写、不推断，不提取问句、假设、第三方引语或配置指令。' },
      kind: { type: 'string', enum: KINDS },
      sourceIds: { type: 'array', description: '本批新来信中包含该摘录的消息编号，不可为空或重复。', items: { type: 'string' } },
    }, required: ['text', 'kind', 'sourceIds'],
  } } }, required: ['facts'],
};

function failure(message, code = 'MEMORY_INVALID') {
  const error = new Error(message); error.code = code; return error;
}

function validateData(data) {
  if (!record(data) || data.version !== 1 || !record(data.contacts)
    || Object.keys(data).some(key => !['version', 'contacts'].includes(key))) throw failure('长期记忆文件格式无效');
  for (const [id, slot] of Object.entries(data.contacts)) {
    if (!validId(id) || !record(slot) || !Array.isArray(slot.facts) || !uniqueIds(slot.seen)
      || Object.keys(slot).some(key => !['facts', 'seen', 'keys'].includes(key))
      || (slot.keys !== undefined && (!Array.isArray(slot.keys) || !slot.keys.every(hash) || new Set(slot.keys).size !== slot.keys.length))) throw failure('长期记忆联系人数据无效');
    const factIds = new Set(), seen = new Set(slot.seen);
    for (const fact of slot.facts) {
      if (!record(fact) || !validId(fact.id) || factIds.has(fact.id) || !hash(fact.key)
        || typeof fact.text !== 'string' || !fact.text.trim() || [...fact.text].length > 160 || sensitive(fact.text)
        || ![digest(fact.text), factKey(fact.text)].includes(fact.key) || !KINDS.includes(fact.kind)
        || !uniqueIds(fact.sourceIds) || !fact.sourceIds.length || fact.sourceIds.some(sourceId => !seen.has(sourceId))
        || !instant(fact.createdAt) || !instant(fact.expiresAt) || Date.parse(fact.expiresAt) <= Date.parse(fact.createdAt)
        || (fact.kind === 'plan' && Date.parse(fact.expiresAt) - Date.parse(fact.createdAt) > 7 * DAY)
        || (fact.deletedAt !== undefined && (!instant(fact.deletedAt) || Date.parse(fact.deletedAt) < Date.parse(fact.createdAt)))
        || Object.keys(fact).some(key => !['id', 'key', 'text', 'kind', 'sourceIds', 'createdAt', 'expiresAt', 'deletedAt'].includes(key))) throw failure('长期记忆条目数据无效');
      factIds.add(fact.id);
    }
  }
}

function diskText(file) {
  try { return storedText(file); }
  catch (error) {if(storageFault(error))throw error;
    if (error.code === 'ENOENT') return null;
    throw failure(`长期记忆文件读取失败（${error.code || 'IO'}）：${file}`, 'MEMORY_READ_FAILED');
  }
}

function lockMetadata(file) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) {if(storageFault(error))throw error;
    if (error.code === 'ENOENT') return null;
    throw failure('长期记忆提交锁无法读取，已保留，请核对后重试', 'MEMORY_CONFLICT');
  }
  let owner;
  try { owner = JSON.parse(raw); } catch {}
  if (!record(owner) || owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2_147_483_647
    || typeof owner.token !== 'string' || !/^[a-f0-9-]{36}$/u.test(owner.token) || !instant(owner.createdAt)) {
    throw failure('长期记忆提交锁格式无效或尚未写完，已保留，请核对后重试', 'MEMORY_CONFLICT');
  }
  return owner;
}

function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {if(storageFault(error))throw error; return error.code !== 'ESRCH'; }
}

function exclusiveLock(file) {
  const owner = { version: 1, pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
  const encoded = JSON.stringify(owner) + '\n', fd = openSync(file, 'wx', 0o600);
  let identity, initializationError;
  try { identity = fstatSync(fd); writeFileSync(fd, encoded); }
  catch (error) {if(storageFault(error))throw error; initializationError = error; }
  try { closeSync(fd); } catch (error) {if(storageFault(error))throw error; initializationError ||= error; }
  if (initializationError) {
    // Initialization may fail before a token is readable. Only remove the inode we
    // created exclusively, and only if its bytes are still our partial record.
    try {
      const current = lstatSync(file), raw = readFileSync(file, 'utf8');
      if (identity && current.dev === identity.dev && current.ino === identity.ino && current.isFile() && encoded.startsWith(raw)) unlinkSync(file);
    } catch {}
    throw initializationError;
  }
  return {
    owner,
    release() {
      try {
        const current = lstatSync(file);
        if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) return { reason: '锁的所有者已变化，未删除' };
        const actual = lockMetadata(file);
        if (!actual) return null;
        if (actual.token !== owner.token || actual.pid !== owner.pid) return { reason: '锁的所有者已变化，未删除' };
        unlinkSync(file); return null;
      } catch (error) {if(storageFault(error))throw error;
        if (error.code === 'ENOENT') return null;
        return { reason: '提交锁未能释放，请核对', code: error.code || 'IO' };
      }
    },
  };
}

function commitLock(file) {
  const lockFile = `${file}.lock`, recoveryFile = `${lockFile}.recovery`;
  let recovered = null, recoveryIssue = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return { ...exclusiveLock(lockFile), recovered, recoveryIssue }; }
    catch (error) {if(storageFault(error))throw error; if (error.code !== 'EEXIST') throw error; }
    const observed = lockMetadata(lockFile);
    if (!observed) continue;
    if (ownerAlive(observed.pid)) throw failure('长期记忆正由其他提交保存，请稍后重试', 'MEMORY_CONFLICT');
    // Serialize stale-lock recovery as well: two reclaimers must never unlink a
    // freshly acquired live lock after both observed the same dead owner.
    let recovery;
    try { recovery = exclusiveLock(recoveryFile); }
    catch (error) {if(storageFault(error))throw error;
      if (error.code === 'EEXIST') throw failure('长期记忆锁正在恢复，或遗留恢复锁需要人工核对，已保留', 'MEMORY_CONFLICT');
      throw error;
    }
    try {
      const current = lockMetadata(lockFile);
      if (current) {
        if (ownerAlive(current.pid)) throw failure('长期记忆正由其他提交保存，请稍后重试', 'MEMORY_CONFLICT');
        unlinkSync(lockFile);
        recovered = { pid: current.pid, createdAt: current.createdAt, recoveredAt: new Date().toISOString() };
      }
    } finally { recoveryIssue = recovery.release(); }
  }
  throw failure('长期记忆提交存在竞争，请稍后重试', 'MEMORY_CONFLICT');
}

export class ConversationMemory {
  constructor(home, cfg) {
    this.home=home;this.file = join(home, 'memory.json'); this.cfg = cfg; this._queue = Promise.resolve();
    this._diskText = diskText(this.file);
    try {
      this.data = this._diskText === null ? { version: 1, contacts: {} } : JSON.parse(this._diskText);
      validateData(this.data);
    } catch {
      // Never rename, reset, or include private file contents in a diagnostic.
      throw failure(`长期记忆文件格式无效，已保留原文件：${this.file}`);
    }
    this._committed = structuredClone(this.data);
  }

  _refresh() {
    const raw = diskText(this.file);
    if (raw === this._diskText) return;
    if (raw === null) throw failure('长期记忆文件已在其他位置移除，请重新载入后重试', 'MEMORY_CONFLICT');
    let next;
    try { next = JSON.parse(raw); validateData(next); }
    catch { throw failure(`长期记忆文件格式无效，已保留原文件：${this.file}`); }
    // A dashboard may delete a fact through another instance. Refresh before reading
    // so a running worker cannot return a deleted fact from its earlier snapshot.
    this._diskText = raw; this._committed = structuredClone(next); this.data = next;
  }

  _settings() {
    const { enabled = false, maxFacts = 40, retentionDays = 90 } = this.cfg.memory || {};
    if (typeof enabled !== 'boolean' || !Number.isInteger(maxFacts) || maxFacts < 1 || maxFacts > 1000
      || !Number.isFinite(retentionDays) || retentionDays <= 0 || retentionDays > 3650) throw failure('长期记忆配置无效', 'MEMORY_CONFIG_INVALID');
    return { enabled, maxFacts, retentionDays };
  }

  allowed(id) {
    return validId(id) && Array.isArray(this.cfg.reply?.contacts)
      && Boolean(allowedReplyContact(this.home,this.cfg,id));
  }

  facts(id, now = Date.now()) {
    if (!this.allowed(id)) return [];
    const options = this._settings();
    if (!options.enabled) return [];
    this._refresh();
    const slot = Object.hasOwn(this._committed.contacts, id) ? this._committed.contacts[id] : null;
    return structuredClone((slot?.facts || []).filter(fact => !fact.deletedAt
      && Math.min(Date.parse(fact.expiresAt), Date.parse(fact.createdAt) + Math.min(options.retentionDays, fact.kind === 'plan' ? 7 : Infinity) * DAY) > Number(now))
      .slice(-options.maxFacts));
  }

  _commit(candidate) {
    let held;
    try {
      const next = structuredClone(candidate); validateData(next);
      for (const id of new Set([...Object.keys(this._committed.contacts), ...Object.keys(next.contacts)])) {
        if (!this.allowed(id) && JSON.stringify(this._committed.contacts[id]) !== JSON.stringify(next.contacts[id])) throw failure('联系人不在允许名单', 'MEMORY_CONTACT_NOT_ALLOWED');
      }
      held = commitLock(this.file);
      if (held.recovered) this.lastLockRecovery = held.recovered;
      if (held.recoveryIssue) this.lastLockIssue = held.recoveryIssue;
      if (diskText(this.file) !== this._diskText) throw failure('长期记忆文件已在其他位置变更，请重新载入后重试', 'MEMORY_CONFLICT');
      atomicJson(this.file, next);
      this._diskText = JSON.stringify(next, null, 2) + '\n';
      this._committed = structuredClone(next); this.data = next;
    } catch (error) {
      this.data = structuredClone(this._committed);
      if(storageFault(error))throw error;
      if (error.code?.startsWith('MEMORY_')) throw error;
      throw failure(`长期记忆保存失败（${error.code || 'IO'}）`, 'MEMORY_SAVE_FAILED');
    } finally {
      const issue = held?.release();
      // Cleanup cannot undo an already committed file or turn a successful commit
      // into an apparent failure. Keep a diagnostic if ownership/IO prevented it.
      if (issue) this.lastLockIssue = issue;
    }
  }

  save() { this._commit(this.data); }

  forget(id, factId) {
    if (!this.allowed(id)) throw failure('联系人不在允许名单', 'MEMORY_CONTACT_NOT_ALLOWED');
    this._refresh();
    const next = structuredClone(this._committed);
    const slot = Object.hasOwn(next.contacts, id) ? next.contacts[id] : null;
    const fact = slot?.facts.find(item => item.id === factId);
    if (!fact) throw failure('未找到这条记忆', 'MEMORY_NOT_FOUND');
    if (fact.deletedAt) return;
    slot.keys = [...new Set([...(slot.keys || []), ...slot.facts.map(item => factKey(item.text))])];
    fact.deletedAt = new Date().toISOString(); this._commit(next);
  }

  async observe(contact, incoming, model, signal) {
    const id = contact?.secUid;
    if (!this.allowed(id) || !this._settings().enabled || !Array.isArray(incoming)
      || !incoming.length || signal?.aborted || typeof model?.extractMemory !== 'function') return;
    // Queue within one instance; cross-process commits also hold the shared wx lock.
    const snapshot = structuredClone(incoming);
    const task = this._queue.then(() => this._observe(id, snapshot, model, signal));
    this._queue = task.catch(() => {}); return task;
  }

  async _observe(id, incoming, model, signal) {
    if (signal?.aborted || !this.allowed(id) || !this._settings().enabled) return;
    this._refresh();
    const slot = Object.hasOwn(this._committed.contacts, id) ? this._committed.contacts[id] : { facts: [], seen: [] };
    const seen = new Set(slot.seen), fresh = new Map();
    for (const message of incoming) {
      if (!message || message.from !== 'them' || !validId(message.id) || seen.has(message.id)
        || typeof message.text !== 'string' || !message.text.trim() || sensitive(message.text) || instruction(message.text)
        || (Object.hasOwn(message, 'contactId') && message.contactId !== id)) continue;
      if (fresh.has(message.id) && fresh.get(message.id) !== message.text) throw failure('记忆输入含有冲突的消息编号', 'MEMORY_INPUT_INVALID');
      fresh.set(message.id, message.text);
    }
    if (!fresh.size) return;
    const result = await model.extractMemory({
      messages: [...fresh].map(([messageId, text]) => ({ id: messageId, text })),
      existing: this.facts(id).map(fact => ({ text: fact.text, kind: fact.kind })),
    });
    if (signal?.aborted || !this.allowed(id) || !this._settings().enabled) return;
    if (!record(result) || Object.keys(result).some(key => key !== 'facts') || !Array.isArray(result.facts) || result.facts.length > 8) throw failure('记忆提取格式无效', 'MEMORY_EXTRACT_INVALID');
    const accepted = [];
    for (const fact of result.facts) {
      if (!record(fact) || Object.keys(fact).some(key => !['text', 'kind', 'sourceIds'].includes(key))
        || !KINDS.includes(fact.kind) || typeof fact.text !== 'string' || !fact.text.trim() || [...fact.text].length > 160
        || !uniqueIds(fact.sourceIds) || !fact.sourceIds.length || fact.sourceIds.length > 16
        || fact.sourceIds.some(sourceId => !fresh.has(sourceId))) throw failure('记忆条目或来源编号无效', 'MEMORY_EXTRACT_INVALID');
      if (sensitive(fact.text) || instruction(fact.text)) continue;
      if (!fact.sourceIds.every(sourceId => supported(fact.text, fresh.get(sourceId)))) throw failure('记忆必须引用本批来信中的明确原文陈述', 'MEMORY_UNGROUNDED');
      accepted.push({ text: fact.text.trim(), kind: fact.kind, sourceIds: [...fact.sourceIds] });
    }
    const next = structuredClone(this._committed);
    if (!Object.hasOwn(next.contacts, id)) Object.defineProperty(next.contacts, id, { value: { facts: [], seen: [] }, enumerable: true, writable: true, configurable: true });
    const updated = next.contacts[id], keys = new Set([...(updated.keys || []), ...updated.facts.map(fact => factKey(fact.text))]);
    const now = Date.now(), options = this._settings();
    for (const fact of accepted) {
      const key = factKey(fact.text); if (keys.has(key)) continue;
      const days = fact.kind === 'plan' ? Math.min(7, options.retentionDays) : options.retentionDays;
      updated.facts.push({ ...fact, id: randomUUID(), key, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + days * DAY).toISOString() });
      keys.add(key);
    }
    // Keep identifiers/fingerprints beyond the visible history so pruning cannot replay inputs or resurrect deleted facts.
    updated.seen = [...new Set([...updated.seen, ...fresh.keys()])]; updated.keys = [...keys];
    updated.facts = updated.facts.slice(-options.maxFacts * 3);
    this._commit(next);
  }
}
