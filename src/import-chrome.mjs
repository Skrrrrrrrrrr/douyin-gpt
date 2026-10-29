import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// 在同一台 Mac、同一 Chrome 应用中迁移抖音 Cookie 的加密字段。
// 不读取 Keychain，不解密凭证，不读取其他网站的 Cookie。
export async function copyDouyinCookies(sourceFile, targetFile) {
  if (resolve(sourceFile) === resolve(targetFile)) throw new Error('来源和目标 Cookie 数据库不能相同');
  if (!existsSync(sourceFile) || !existsSync(targetFile)) throw new Error('Cookie 数据库不存在，需要先初始化独立浏览器');
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { throw new Error('自动导入 Chrome 登录态需要 Node.js 22.13 或以上；也可直接使用 login 扫码'); }
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  let target;
  try {
    const hosts = ['.douyin.com', 'douyin.com', 'www.douyin.com'];
    const select = source.prepare('SELECT * FROM cookies WHERE host_key IN (?, ?, ?)');
    // Chromium 的微秒时间戳超过 Number.MAX_SAFE_INTEGER，必须无损读写。
    select.setReadBigInts(true);
    const rows = select.all(...hosts);
    if (!rows.length || !rows.some(row => /^(sessionid|sessionid_ss|sid_tt|ssid_ucp_v1)$/.test(row.name))) throw new Error('当前 Chrome profile 没有可复用的抖音登录 Cookie');
    target = new DatabaseSync(targetFile);
    const names = target.prepare('PRAGMA table_info(cookies)').all().map(row => row.name);
    const columns = names.filter(name => /^[A-Za-z0-9_]+$/.test(name) && Object.hasOwn(rows[0], name));
    const insert = target.prepare(`INSERT OR REPLACE INTO cookies (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    target.exec('BEGIN IMMEDIATE');
    try {
      target.prepare('DELETE FROM cookies WHERE host_key IN (?, ?, ?)').run(...hosts);
      for (const row of rows) insert.run(...columns.map(name => row[name]));
      target.exec('COMMIT');
    } catch (error) { target.exec('ROLLBACK'); throw error; }
    return { imported: rows.length, domains: [...new Set(rows.map(row => row.host_key))] };
  } finally { target?.close(); source.close(); }
}
export function chromeCookieDatabase(profileRoot) {
  return ['Cookies', 'Network/Cookies'].map(file => join(profileRoot, file)).find(file => existsSync(file)) || '';
}
export async function importChromeLogin(home, profileName) {
  if (process.platform !== 'darwin') throw new Error('自动读取当前 Chrome 登录态目前仅适用于 Mac；其他系统使用 login 扫码');
  const root = join(homedir(), 'Library/Application Support/Google/Chrome');
  let profile = profileName;
  if (!profile) profile = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8')).profile?.last_used || 'Default';
  if (!/^[A-Za-z0-9 _-]+$/.test(profile)) throw new Error('无效 Chrome profile 名称');
  const result = await copyDouyinCookies(chromeCookieDatabase(join(root, profile)), chromeCookieDatabase(join(home, 'browser', 'Default')));
  return { ...result, profile };
}
