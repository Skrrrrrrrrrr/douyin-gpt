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
export const PROVIDERS = ['openai', 'deepseek'];
export const providerLabel = provider => provider === 'deepseek' ? 'DeepSeek' : 'GPT';
export function providerBrowse(cfg, provider = 'openai') {
  if (provider === 'openai') return cfg.browse;
  const settings = cfg.deepseek?.browse || defaultConfig().deepseek.browse;
  return { ...cfg.browse, videosPerDay: settings.videosPerDay, videosPerRound: settings.videosPerRound, everyMinutes: settings.everyMinutes, enabled: Boolean(cfg.deepseek?.enabled && cfg.browse.enabled) };
}
export function providerEngagement(cfg, provider = 'openai') {
  if (provider === 'openai') return cfg.engagement;
  return { ...cfg.engagement, ...cfg.deepseek?.engagement, enabled: Boolean(cfg.deepseek?.enabled && cfg.deepseek?.engagement?.enabled) };
}
export function validateConfig(cfg) {
  const defaults = defaultConfig();
  cfg.video = { ...defaults.video, ...(cfg.video || {}), voices: { ...defaults.video.voices, ...(cfg.video?.voices || {}) } };
  cfg.journal = { ...defaults.journal, ...(cfg.journal || {}) };
  cfg.engagement = { ...defaults.engagement, ...(cfg.engagement || {}) };
  const ds = cfg.deepseek || {};
  cfg.deepseek = { ...defaults.deepseek, ...ds,
    browse: { ...defaults.deepseek.browse, ...(ds.browse || {}) },
    engagement: { ...defaults.deepseek.engagement, ...(ds.engagement || {}) },
  };
  const positive = (value, key, min, max) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} 必须是 ${min}～${max} 之间的整数`);
  };
  for (const key of ['account', 'browser', 'browse', 'reply']) {
    if (!cfg[key] || typeof cfg[key] !== 'object') throw new Error(`缺少配置 ${key}`);
  }
  cfg.reply.routing = { ...defaults.reply.routing, ...(cfg.reply.routing || {}) };
  if (typeof cfg.reply.routing.enabled !== 'boolean') throw new Error('reply.routing.enabled 必须是布尔值');
  if (typeof cfg.reply.routing.deepseekKeyword !== 'string' || !cfg.reply.routing.deepseekKeyword.trim() || [...cfg.reply.routing.deepseekKeyword].length > 40) throw new Error('reply.routing.deepseekKeyword 必须是 1～40 字的非空关键词');
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
  if (typeof cfg.deepseek.enabled !== 'boolean' || typeof cfg.deepseek.engagement.enabled !== 'boolean') throw new Error('deepseek.enabled 和 deepseek.engagement.enabled 必须是布尔值');
  if (typeof cfg.journal.enabled !== 'boolean') throw new Error('journal.enabled 必须是布尔值');
  positive(cfg.journal.refreshMinutes, 'journal.refreshMinutes', 1, 1440);
  if(typeof cfg.video.enabled!=='boolean')throw new Error('video.enabled 必须是布尔值');
  positive(cfg.video.hour,'video.hour',0,23);positive(cfg.video.minute,'video.minute',0,59);
  for(const key of ['python','speechModel'])if(typeof cfg.video[key]!=='string'||!cfg.video[key].trim())throw new Error(`video.${key} 不能为空`);
  if(typeof cfg.video.outputDir!=='string'||cfg.video.outputDir&&resolve(cfg.video.outputDir)!==cfg.video.outputDir)throw new Error('video.outputDir 必须为空或绝对路径');
  for(const provider of PROVIDERS)if(typeof cfg.video.voices[provider]!=='string'||!cfg.video.voices[provider])throw new Error('视频配音必须配置两个声音');
  if (typeof cfg.journal.outputDir !== 'string' || (cfg.journal.outputDir && resolve(cfg.journal.outputDir) !== cfg.journal.outputDir)) throw new Error('journal.outputDir 必须为空或绝对路径');
  for (const [key,min,max] of [['videosPerDay',0,300],['videosPerRound',1,10],['everyMinutes',1,1440]]) positive(cfg.deepseek.browse[key], `deepseek.browse.${key}`, min, max);
  for (const provider of PROVIDERS) {
    const settings = providerEngagement(cfg, provider);
    for (const key of ['enabled', 'commentOnVideos', 'replyToComments']) if (typeof settings[key] !== 'boolean') throw new Error(`${provider}.engagement.${key} 必须是布尔值`);
    for (const [key,min,max] of [['commentsPerDay',0,20],['repliesPerDay',0,50],['perRound',1,3],['pollSeconds',30,3600],['commentCooldownMinutes',1,1440],['maxChars',1,200]]) positive(settings[key], `${provider}.engagement.${key}`, min, max);
    if (!Number.isFinite(settings.minConfidence) || settings.minConfidence < 0 || settings.minConfidence > 1) throw new Error(`${provider}.engagement.minConfidence 必须在 0～1 之间`);
  }
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
export function modelConfig(provider = 'openai') {
  if (!PROVIDERS.includes(provider)) throw new Error('未知模型服务');
  const prefix = provider === 'deepseek' ? 'DEEPSEEK' : 'OPENAI';
  const privateFile = join(homePath(), `${provider}.json`);
  let privateCfg = {};
  if (existsSync(privateFile)) {
    try { privateCfg = JSON.parse(readFileSync(privateFile, 'utf8')); }
    catch { throw new Error(`本机 ${provider}.json 格式无效`); }
  }
  return {
    provider, label: providerLabel(provider), envPrefix: prefix,
    apiKey: privateCfg.apiKey || process.env[`${prefix}_API_KEY`] || '',
    model: privateCfg.model || process.env[`${prefix}_MODEL`] || (provider === 'deepseek' ? 'deepseek-flash' : 'gpt-6.1-terra'),
    reasoningEffort: privateCfg.reasoningEffort || process.env[`${prefix}_REASONING_EFFORT`] || 'low',
    baseUrl: privateCfg.baseUrl || process.env[`${prefix}_BASE_URL`] || (provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1'),
  };
}
