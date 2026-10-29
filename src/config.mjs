import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function loadEnv() {
  const file = join(ROOT, '.env');
  if (existsSync(file)) {
    for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
export function homePath() { return resolve(process.env.DOUYIN_GPT_HOME || join(ROOT, '.data')); }
export function makeDirs(home) {
  for (const folder of [home, join(home, 'frames'), join(home, 'reports'), join(home, 'browser')]) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  }
}
export function writePrivate(file, value) {
  writeFileSync(file, value, { mode: 0o600 });
  chmodSync(file, 0o600);
}
export function defaultConfig() { return JSON.parse(readFileSync(join(ROOT, 'config.example.json'), 'utf8')); }
export function validateConfig(cfg) {
  cfg.engagement = { ...defaultConfig().engagement, ...(cfg.engagement || {}) };
  const positive = (value, key, min, max) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} 必须是 ${min}～${max} 之间的整数`);
  };
  for (const key of ['account', 'browser', 'browse', 'reply']) {
    if (!cfg[key] || typeof cfg[key] !== 'object') throw new Error(`缺少配置 ${key}`);
  }
  for (const key of ['douyinId', 'secUid']) if (typeof cfg.account[key] !== 'string') throw new Error(`account.${key} 必须是字符串`);
  for (const [section, key] of [['browser', 'headless'], ['browse', 'enabled'], ['reply', 'enabled']]) {
    if (typeof cfg[section][key] !== 'boolean') throw new Error(`${section}.${key} 必须是布尔值`);
  }
  positive(cfg.browse.everyMinutes, 'browse.everyMinutes', 1, 1440);
  positive(cfg.browse.videosPerRound, 'browse.videosPerRound', 1, 10);
  positive(cfg.browse.videosPerDay, 'browse.videosPerDay', 0, 300);
  positive(cfg.browse.watchSeconds, 'browse.watchSeconds', 3, 60);
  positive(cfg.browse.framesPerVideo, 'browse.framesPerVideo', 1, 3);
  positive(cfg.reply.pollSeconds, 'reply.pollSeconds', 10, 3600);
  positive(cfg.reply.maxChars, 'reply.maxChars', 1, 1000);
  positive(cfg.reply.perContactPerDay, 'reply.perContactPerDay', 0, 500);
  positive(cfg.reply.totalPerDay, 'reply.totalPerDay', 0, 1000);
  for (const key of ['enabled', 'commentOnVideos', 'replyToComments']) if (typeof cfg.engagement[key] !== 'boolean') throw new Error(`engagement.${key} 必须是布尔值`);
  for (const [key,min,max] of [['commentsPerDay',0,20],['repliesPerDay',0,50],['perRound',1,3],['pollSeconds',30,3600],['commentCooldownMinutes',1,1440],['maxChars',1,200]]) positive(cfg.engagement[key], `engagement.${key}`, min, max);
  if (!Number.isFinite(cfg.engagement.minConfidence) || cfg.engagement.minConfidence < 0 || cfg.engagement.minConfidence > 1) throw new Error('engagement.minConfidence 必须在 0～1 之间');
  if (!Array.isArray(cfg.browse.interests) || cfg.browse.interests.some(x => typeof x !== 'string')) throw new Error('browse.interests 必须是字符串数组');
  if (!Array.isArray(cfg.reply.contacts)) throw new Error('reply.contacts 必须是数组');
  const seen = new Set();
  for (const c of cfg.reply.contacts) {
    if (!c || typeof c.secUid !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(c.secUid)) throw new Error('联系人必须填写稳定 secUid，不能用昵称代替');
    if (seen.has(c.secUid)) throw new Error('联系人 secUid 重复');
    if (typeof c.label !== 'string' || typeof c.enabled !== 'boolean') throw new Error('联系人需要 label 和 enabled');
    seen.add(c.secUid);
  }
  return cfg;
}
export function readConfig(home) {
  const file = join(home, 'config.json');
  if (!existsSync(file)) throw new Error('还未初始化。先运行 npm run init');
  return validateConfig(JSON.parse(readFileSync(file, 'utf8')));
}
export function initConfig(home) {
  makeDirs(home);
  if (!existsSync(join(home, 'config.json'))) writePrivate(join(home, 'config.json'), JSON.stringify(defaultConfig(), null, 2) + '\n');
}
export function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export function modelConfig() {
  const privateFile = join(homePath(), 'openai.json');
  let privateCfg = {};
  if (existsSync(privateFile)) {
    try { privateCfg = JSON.parse(readFileSync(privateFile, 'utf8')); }
    catch { throw new Error('本机 openai.json 格式无效'); }
  }
  return {
    apiKey: privateCfg.apiKey || process.env.OPENAI_API_KEY || '',
    model: privateCfg.model || process.env.OPENAI_MODEL || 'gpt-6.1-terra',
    reasoningEffort: privateCfg.reasoningEffort || process.env.OPENAI_REASONING_EFFORT || 'low',
    baseUrl: privateCfg.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  };
}
