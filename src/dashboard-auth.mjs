import {existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync} from 'node:fs';
import {join} from 'node:path';
import {createHash, randomBytes, scrypt, scryptSync, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {atomicJson} from './store.mjs';
import {makeDirs} from './config.mjs';

const derive = promisify(scrypt);
const SCRYPT = {N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024};
const digest = value => createHash('sha256').update(value).digest('hex');
const passwordValid = value => typeof value === 'string' && value.length >= 12 && value.length <= 128 && Buffer.byteLength(value) <= 512;
const authError = (status, code, message, retryAfter) => Object.assign(new Error(message), {status, code, retryAfter});
const readRecord = file => {
  let data;
  try {data = JSON.parse(readFileSync(file, 'utf8'));} catch {throw new Error('后台登录凭证无法读取，请使用本机重置命令恢复');}
  if (!data || typeof data !== 'object' || data.version !== 1 || data.username !== 'admin' || !/^[a-f0-9]{32}$/.test(data.salt) || !/^[a-f0-9]{128}$/.test(data.hash) || typeof data.mustChangePassword !== 'boolean' || !/^[a-f0-9]{32}$/.test(data.revision)) throw new Error('后台登录凭证无效，已拒绝启动');
  return data;
};

// 明文初始密码仅供本机第一次登录；正式凭证只保存 scrypt 盐值和散列。
export function provisionDashboardAuth(home, {reset = false} = {}) {
  makeDirs(home);
  const file = join(home, 'dashboard-auth.json'), bootstrapFile = join(home, 'dashboard-initial-password.txt');
  if (!reset && existsSync(file)) {readRecord(file); chmodSync(file, 0o600); return {file, bootstrapFile};}
  if (!reset && existsSync(bootstrapFile)) throw new Error('后台登录记录缺失，请使用本机重置命令恢复');
  const password = randomBytes(24).toString('base64url'), salt = randomBytes(16).toString('hex');
  const record = {version: 1, username: 'admin', salt, hash: scryptSync(password, salt, 64, SCRYPT).toString('hex'), revision: randomBytes(16).toString('hex'), mustChangePassword: true, updatedAt: new Date().toISOString()};
  // 初始密码不经 stdout、接口、日志或配置 DTO 输出。
  if (reset && existsSync(bootstrapFile)) unlinkSync(bootstrapFile);
  writeFileSync(bootstrapFile, `留座中转站后台管理\n账号：admin\n初始密码：${password}\n\n首次登录必须改成自己的密码（12–128 个字符）。\n完成修改后此文件自动删除。\n`, {flag: 'wx', mode: 0o600});
  try {atomicJson(file, record);} catch (error) {unlinkSync(bootstrapFile); throw error;}
  return {file, bootstrapFile};
}

export class DashboardAuth {
  constructor(home, {now = Date.now, sessionTtlMs = 8 * 3600000, idleTtlMs = 30 * 60000, attemptWindowMs = 15 * 60000, maxAttempts = 5} = {}) {
    const files = provisionDashboardAuth(home);
    Object.assign(this, files, {now, sessionTtlMs, idleTtlMs, attemptWindowMs, maxAttempts});
    this.record = readRecord(this.file);
    this.sessions = new Map();
    this.attempts = {count: 0, until: 0};
  }
  current() {
    // 本机显式重置后，运行中的旧会话也立即失效。
    const record = readRecord(this.file);
    if (record.revision !== this.record.revision) {this.sessions.clear(); this.record = record;}
    return record;
  }
  cookieName(port) {return `douyin_dashboard_${port}`;}
  cookie(port, token, {secure=false}={}) {return `${this.cookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.sessionTtlMs / 1000)}${secure?'; Secure':''}`;}
  clearCookie(port, {secure=false}={}) {return `${this.cookieName(port)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure?'; Secure':''}`;}
  token(req, port) {
    if(req.headers.authorization!==undefined){const match=/^Bearer ([a-f0-9]{64})$/.exec(String(req.headers.authorization));return match?.[1]||'';}
    const parts = String(req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(this.cookieName(port) + '='));
    const value = parts.length === 1 ? parts[0].slice(this.cookieName(port).length + 1) : '';
    return /^[a-f0-9]{64}$/.test(value) ? value : '';
  }
  session(req, port) {
    this.current();
    const token = this.token(req, port), key = token && digest(token), session = this.sessions.get(key), now = this.now();
    if (!session || session.expiresAt <= now || session.seenAt + this.idleTtlMs <= now) {if (key) this.sessions.delete(key); return null;}
    session.seenAt = now;
    return {...session, mustChangePassword: this.record.mustChangePassword};
  }
  issue() {
    const now = this.now();
    for (const [key, session] of this.sessions) if (session.expiresAt <= now || session.seenAt + this.idleTtlMs <= now) this.sessions.delete(key);
    while (this.sessions.size >= 10) this.sessions.delete(this.sessions.keys().next().value);
    const token = randomBytes(32).toString('hex'), session = {username: this.record.username, expiresAt: now + this.sessionTtlMs, seenAt: now};
    this.sessions.set(digest(token), session);
    return {token, ...session, mustChangePassword: this.record.mustChangePassword};
  }
  attempt() {
    const now = this.now();
    if (this.attempts.until <= now) this.attempts = {count: 0, until: now + this.attemptWindowMs};
    if (this.attempts.count >= this.maxAttempts) throw authError(429, 'LOGIN_RATE_LIMIT', '尝试次数过多，请稍后再登录', Math.ceil((this.attempts.until - now) / 1000));
    this.attempts.count++;
  }
  async verify(password, record) {
    const candidate = await derive(typeof password === 'string' && password.length <= 128 ? password : '', record.salt, 64, SCRYPT);
    return passwordValid(password) && timingSafeEqual(candidate, Buffer.from(record.hash, 'hex'));
  }
  async login(username, password) {
    this.attempt();
    const record = this.current(), valid = await this.verify(password, record);
    if (!valid || username !== record.username || this.current().revision !== record.revision) throw authError(401, 'INVALID_CREDENTIALS', '账号或密码不正确');
    this.attempts = {count: 0, until: 0};
    return this.issue();
  }
  logout(req, port) {const token = this.token(req, port); if (token) this.sessions.delete(digest(token));}
  async changePassword(currentPassword, newPassword) {
    if (!passwordValid(newPassword)) throw authError(400, 'PASSWORD_POLICY', '新密码需要 12–128 个字符');
    if (newPassword === currentPassword) throw authError(400, 'PASSWORD_POLICY', '新密码需要与当前密码不同');
    this.attempt();
    const previous = this.current();
    if (!await this.verify(currentPassword, previous)) throw authError(401, 'INVALID_PASSWORD', '当前密码不正确');
    const salt = randomBytes(16).toString('hex'), hash = (await derive(newPassword, salt, 64, SCRYPT)).toString('hex');
    if (this.current().revision !== previous.revision) throw authError(409, 'AUTH_CHANGED', '登录凭证已变更，请重新登录');
    const next = {...previous, salt, hash, revision: randomBytes(16).toString('hex'), mustChangePassword: false, updatedAt: new Date().toISOString()};
    atomicJson(this.file, next);
    this.record = next;
    this.sessions.clear();
    this.attempts = {count: 0, until: 0};
    if (existsSync(this.bootstrapFile)) unlinkSync(this.bootstrapFile);
    return this.issue();
  }
}

export async function authBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw authError(415, 'JSON_REQUIRED', '请使用 JSON 请求');
  let size = 0; const parts = [];
  for await (const part of req) {size += part.length; if (size > 4096) throw authError(413, 'BODY_TOO_LARGE', '登录请求过大'); parts.push(part);}
  let body; try {body = JSON.parse(Buffer.concat(parts).toString('utf8'));} catch {throw authError(400, 'INVALID_JSON', '登录请求格式无效');}
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw authError(400, 'INVALID_JSON', '登录请求格式无效');
  return body;
}
