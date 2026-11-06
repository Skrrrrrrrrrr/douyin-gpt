import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {validatePreferences} from './conversation-policy.mjs';
import {roleInterestTopics, validateInterestProfiles} from './interest-profiles.mjs';
import { parseEnv } from 'node:util';
import {dashboardNetwork} from './dashboard-network.mjs';

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
  const interests = roleInterestTopics(cfg, provider, cfg.browse.interests);
  if (provider === 'openai') return {...cfg.browse, interests};
  const settings = cfg.deepseek?.browse || defaultConfig().deepseek.browse;
  return { ...cfg.browse, interests, videosPerDay: settings.videosPerDay, videosPerRound: settings.videosPerRound, everyMinutes: settings.everyMinutes, enabled: Boolean(cfg.deepseek?.enabled && cfg.browse.enabled) };
}
export function providerEngagement(cfg, provider = 'openai') {
  if (provider === 'openai') return cfg.engagement;
  return { ...cfg.engagement, ...cfg.deepseek?.engagement, enabled: Boolean(cfg.deepseek?.enabled && cfg.deepseek?.engagement?.enabled) };
}
export function validateConfig(cfg) {
  const defaults = defaultConfig();
  for(const section of ['understanding','memory','monitor','dashboard','audience','analytics','discovery','budget','review','service','backup','official','tokenEfficiency','videoAnalysis'])cfg[section]={...defaults[section],...(cfg[section]||{})};
  cfg.service.overnight={...defaults.service.overnight,...cfg.service.overnight};
  cfg.video = { ...defaults.video, ...(cfg.video || {}), voices: { ...defaults.video.voices, ...(cfg.video?.voices || {}) }, voiceProfiles: { ...(cfg.video?.voiceProfiles || {}) } };
  cfg.video.show={enabled:false,format:'roundtable',...(cfg.video.show||{})};
  cfg.video.animation=cfg.video.animation??false;
  for(const key of ['series','production','weekly','narrative'])cfg.video[key]={...defaults.video[key],...(cfg.video[key]||{})};
  cfg.video.series.catchphrases={...defaults.video.series.catchphrases,...cfg.video.series.catchphrases};
  cfg.budget.limitsUSD={...defaults.budget.limitsUSD,...cfg.budget.limitsUSD};cfg.budget.prices={...cfg.budget.prices};
  cfg.journal = { ...defaults.journal, ...(cfg.journal || {}) };
  cfg.engagement = { ...defaults.engagement, ...(cfg.engagement || {}) };
  const ds = cfg.deepseek || {};
  cfg.deepseek = { ...defaults.deepseek, ...ds,
    browse: { ...defaults.deepseek.browse, ...(ds.browse || {}) },
    engagement: { ...defaults.deepseek.engagement, ...(ds.engagement || {}) },
  };
  const positive = (value, key, min, max) => {
    if (value === null && /(?:^|\.)(videosPerDay|commentsPerDay|repliesPerDay)$/.test(key)) return;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} 必须是 ${min}～${max} 之间的整数`);
  };
  for(const [s,k]of [['understanding','enabled'],['understanding','ocr'],['memory','enabled'],['monitor','enabled'],['monitor','notify']])if(typeof cfg[s][k]!=='boolean')throw new Error(`${s}.${k} 必须是布尔值`);
  for(const [s,k,min,max]of [['memory','maxFacts',1,100],['memory','retentionDays',1,365],['monitor','pollSeconds',60,3600],['monitor','reviewGraceMinutes',10,1440],['dashboard','port',1024,65535]])positive(cfg[s][k],`${s}.${k}`,min,max);
  if(cfg.dashboard.host!==undefined||cfg.dashboard.publicUrl!==undefined)dashboardNetwork(cfg.dashboard);
  if(typeof cfg.understanding.model!=='string'||!cfg.understanding.model)throw new Error('understanding.model 不能为空');
  for (const key of ['account', 'browser', 'browse', 'reply']) {
    if (!cfg[key] || typeof cfg[key] !== 'object') throw new Error(`缺少配置 ${key}`);
  }
  if (!Object.hasOwn(cfg.browser, 'background')) cfg.browser.background = defaults.browser.background;
  if (typeof cfg.browser.background !== 'boolean') throw new Error('browser.background 必须是布尔值');
  for(const key of ['takeover','media','stickers','delivery','collaboration','voiceCards','usageContext'])cfg.reply[key]={...defaults.reply[key],...(cfg.reply[key]||{})};
  const usage=cfg.reply.usageContext;
  if(typeof usage.enabled!=='boolean'||typeof usage.groups!=='boolean'||!['allowlist','friends'].includes(usage.audience)||!Array.isArray(usage.contacts)||usage.contacts.length>2000||new Set(usage.contacts).size!==usage.contacts.length||usage.contacts.some(id=>typeof id!=='string'||!(/^[A-Za-z0-9_-]{10,200}$/).test(id)))throw new Error('后台费用查询范围无效');
  cfg.reply.routing = { ...defaults.reply.routing, ...(cfg.reply.routing || {}) };
  cfg.reply.audience??=defaults.reply.audience;
  cfg.reply.friends={...defaults.reply.friends,...cfg.reply.friends};
  cfg.reply.groups={...defaults.reply.groups,...cfg.reply.groups};
  if(typeof cfg.reply.groups.enabled!=='boolean'||typeof cfg.reply.groups.enabledAt!=='string'||cfg.reply.groups.enabledAt&&!Number.isFinite(Date.parse(cfg.reply.groups.enabledAt)))throw new Error('群聊回复设置无效');
  if(cfg.reply.groups.enabled&&!cfg.reply.groups.enabledAt)throw new Error('群聊模式需要启用时间，请通过后台开启');
  positive(cfg.reply.groups.cooldownSeconds,'reply.groups.cooldownSeconds',15,600);positive(cfg.reply.groups.maxChars,'reply.groups.maxChars',20,500);
  if(!['allowlist','friends'].includes(cfg.reply.audience))throw new Error('reply.audience 必须是 allowlist 或 friends');
  positive(cfg.reply.friends.syncSeconds,'reply.friends.syncSeconds',30,3600);
  if(typeof cfg.reply.friends.enabledAt!=='string'||cfg.reply.friends.enabledAt&&!Number.isFinite(Date.parse(cfg.reply.friends.enabledAt)))throw new Error('好友模式启用时间无效');
  if(cfg.reply.audience==='friends'&&!cfg.reply.friends.enabledAt)throw new Error('好友模式需要启用时间，请通过后台切换');
  if(!Array.isArray(cfg.reply.friends.overrides)||cfg.reply.friends.overrides.length>2000)throw new Error('好友偏好设置无效');
  const friendIds=new Set();for(const c of cfg.reply.friends.overrides){if(!c||typeof c.secUid!=='string'||!/^[A-Za-z0-9_-]{10,200}$/.test(c.secUid)||friendIds.has(c.secUid)||typeof c.enabled!=='boolean')throw new Error('好友偏好需要唯一稳定账号 ID 和启用状态');friendIds.add(c.secUid);if(c.preferences)validatePreferences(c.preferences,cfg);}
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
  if (!['interval', 'evening'].includes(cfg.journal.summaryMode)) throw new Error('journal.summaryMode 必须是 interval 或 evening');
  positive(cfg.journal.summaryHour, 'journal.summaryHour', 0, 23);
  positive(cfg.journal.summaryMinute, 'journal.summaryMinute', 0, 59);
  for (const key of ['enabled','combineVideoComment','separateOCR','transcribeWithCaptions','cachePrompts']) {
    if (typeof cfg.tokenEfficiency[key] !== 'boolean') throw new Error(`tokenEfficiency.${key} 必须是布尔值`);
  }
  positive(cfg.tokenEfficiency.framesPerVideo, 'tokenEfficiency.framesPerVideo', 1, 3);
  for (const key of ['enabled', 'retainMedia']) if (typeof cfg.videoAnalysis[key] !== 'boolean') throw new Error('videoAnalysis.' + key + ' 必须是布尔值');
  for (const key of ['command','python']) if (typeof cfg.videoAnalysis[key] !== 'string') throw new Error('videoAnalysis.' + key + ' 必须是字符串');
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(cfg.videoAnalysis.model)) throw new Error('视频解析模型名称无效');
  for (const [key,min,max] of [['sampleIntervalSeconds',1,60],['maxSceneFrames',0,200],['timeoutSeconds',30,1200],['maxMediaBytes',1000000,2147483648]]) positive(cfg.videoAnalysis[key], 'videoAnalysis.' + key, min, max);
  if(typeof cfg.video.enabled!=='boolean')throw new Error('video.enabled 必须是布尔值');
  if(typeof cfg.video.animation!=='boolean'||typeof cfg.video.show.enabled!=='boolean'||!['roundtable','mini-scene'].includes(cfg.video.show.format))throw new Error('节目与动画设置无效');
  positive(cfg.video.hour,'video.hour',0,23);positive(cfg.video.minute,'video.minute',0,59);
  for(const key of ['python','speechModel'])if(typeof cfg.video[key]!=='string'||!cfg.video[key].trim())throw new Error(`video.${key} 不能为空`);
  if(typeof cfg.video.outputDir!=='string'||cfg.video.outputDir&&resolve(cfg.video.outputDir)!==cfg.video.outputDir)throw new Error('video.outputDir 必须为空或绝对路径');
  for(const provider of PROVIDERS)if(typeof cfg.video.voices[provider]!=='string'||!cfg.video.voices[provider])throw new Error('视频配音必须配置两个声音');
  for(const provider of PROVIDERS){const id=cfg.video.voiceProfiles[provider];if(id!==undefined&&(typeof id!=='string'||!/^[A-D]$/i.test(id)))throw new Error('video.voiceProfiles 需要使用 A、B、C 或 D');if(id)cfg.video.voiceProfiles[provider]=id.toUpperCase();}
  if (typeof cfg.journal.outputDir !== 'string' || (cfg.journal.outputDir && resolve(cfg.journal.outputDir) !== cfg.journal.outputDir)) throw new Error('journal.outputDir 必须为空或绝对路径');
  for (const [key,min,max] of [['videosPerDay',0,300],['videosPerRound',1,10],['everyMinutes',1,1440]]) positive(cfg.deepseek.browse[key], `deepseek.browse.${key}`, min, max);
  for (const provider of PROVIDERS) {
    const settings = providerEngagement(cfg, provider);
    for (const key of ['enabled', 'commentOnVideos', 'replyToComments']) if (typeof settings[key] !== 'boolean') throw new Error(`${provider}.engagement.${key} 必须是布尔值`);
    for (const [key,min,max] of [['commentsPerDay',0,100],['repliesPerDay',0,200],['perRound',1,3],['pollSeconds',30,3600],['commentCooldownMinutes',1,1440],['maxChars',1,200]]) positive(settings[key], `${provider}.engagement.${key}`, min, max);
    if (!Number.isFinite(settings.minConfidence) || settings.minConfidence < 0 || settings.minConfidence > 1) throw new Error(`${provider}.engagement.minConfidence 必须在 0～1 之间`);
  }
  if (!Array.isArray(cfg.browse.interests) || cfg.browse.interests.some(x => typeof x !== 'string')) throw new Error('browse.interests 必须是字符串数组');
  if (!Array.isArray(cfg.reply.contacts)) throw new Error('reply.contacts 必须是数组');
  const seen = new Set();
  for (const c of cfg.reply.contacts) {
    if (!c || typeof c.secUid !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(c.secUid)) throw new Error('联系人必须填写稳定 secUid，不能用昵称代替');
    if (seen.has(c.secUid)) throw new Error('联系人 secUid 重复');
    if (typeof c.label !== 'string' || typeof c.enabled !== 'boolean') throw new Error('联系人需要 label 和 enabled');
    if(c.preferences)validatePreferences(c.preferences,cfg);
    seen.add(c.secUid);
  }
  for(const [o,k]of [[cfg.audience,'enabled'],[cfg.audience,'autoSelect'],[cfg.analytics,'enabled'],[cfg.discovery,'enabled'],[cfg.discovery,'fallbackToFeed'],[cfg.budget,'enabled'],[cfg.reply.takeover,'enabled'],[cfg.reply.media,'enabled'],[cfg.reply.stickers,'enabled'],[cfg.reply.stickers,'unlimited'],[cfg.video.series,'enabled'],...[ 'enabled','camera','cards','music'].map(k=>[cfg.video.production,k])])if(typeof o[k]!=='boolean')throw new Error('新增功能开关必须为布尔值');
  if(!['native','image'].includes(cfg.reply.stickers.mode))throw new Error('表情发送模式必须是 native 或 image');
  positive(cfg.reply.stickers.perContactPerDay,'stickers.perContactPerDay',0,20);positive(cfg.reply.stickers.cooldownMinutes,'stickers.cooldownMinutes',1,1440);positive(cfg.reply.stickers.maxBytes,'stickers.maxBytes',100000,16000000);
  positive(cfg.reply.takeover.minutes,'takeover.minutes',1,1440);positive(cfg.reply.media.maxBytes,'media.maxBytes',100000,16000000);positive(cfg.video.series.maxEpisodes,'series.maxEpisodes',1,30);
  if(!Array.isArray(cfg.discovery.topics)||cfg.discovery.topics.length>12||cfg.discovery.topics.some(t=>typeof t!=='string'||!t.trim()||t.length>40||/[\n\r<>]|https?:\/\//i.test(t)))throw new Error('兴趣主题最多12个，每个1～40字');cfg.discovery.topics=[...new Set(cfg.discovery.topics.map(t=>t.trim()))];
  cfg.discovery.profiles = validateInterestProfiles(cfg.discovery.profiles ?? {});
  for(const p of PROVIDERS){const n=cfg.budget.limitsUSD[p];if(n!==null&&(!Number.isFinite(n)||n<0||n>10000))throw new Error('每日预算必须为空或0～10000美元');const text=cfg.video.series.catchphrases[p];if(typeof text!=='string'||text.length>30)throw new Error('角色口头禅最多30字');}
  for(const [model,rates]of Object.entries(cfg.budget.prices)){if(!/^[a-zA-Z0-9._-]{1,100}$/.test(model)||!rates||typeof rates!=='object'||Object.keys(rates).some(k=>!['input','cached','output'].includes(k))||['input','cached','output'].some(k=>!Number.isFinite(rates[k])||rates[k]<0||rates[k]>1000))throw new Error('自定义模型价格无效');}
  if(!Number.isFinite(cfg.video.production.musicVolume)||cfg.video.production.musicVolume<0||cfg.video.production.musicVolume>.25)throw new Error('背景音乐音量需为0～0.25');
  for(const key of ['enabled','audienceQA','followups','growth'])if(typeof cfg.video.narrative[key]!=='boolean')throw new Error('叙事栏目开关必须是布尔值');
  for(const [o,k]of [[cfg.reply.delivery,'enabled'],[cfg.reply.delivery,'textWithSticker'],[cfg.reply.collaboration,'enabled'],[cfg.reply.voiceCards,'enabled'],[cfg.reply.voiceCards,'reviewBeforeSend'],[cfg.video.weekly,'enabled'],[cfg.service,'enabled'],[cfg.backup,'enabled'],[cfg.official,'enabled']])if(typeof o[k]!=='boolean')throw new Error('增强功能开关必须为布尔值');
  for(const key of ['private','comments','videos'])if(!['auto','review'].includes(cfg.review[key]))throw new Error('审核模式无效');
  for(const [o,k,min,max]of [[cfg.reply.delivery,'continueMinutes',1,60],[cfg.reply.voiceCards,'maxChars',10,120],[cfg.reply.voiceCards,'maxSeconds',5,30],[cfg.video.weekly,'weekday',0,6],[cfg.video.weekly,'days',2,7],[cfg.service,'pollSeconds',10,300],[cfg.service,'prepHour',0,23],[cfg.service,'prepMinute',0,59],[cfg.service,'lateGraceMinutes',0,120],[cfg.backup,'keep',1,30]])positive(o[k],k,min,max);
  if(typeof cfg.service.overnight.enabled!=='boolean')throw new Error('夜间运行开关必须为布尔值');
  positive(cfg.service.overnight.startHour,'overnight.startHour',0,23);positive(cfg.service.overnight.startMinute,'overnight.startMinute',0,59);
  if(cfg.service.overnight.enabled&&(cfg.service.overnight.startHour*60+cfg.service.overnight.startMinute<=cfg.video.hour*60+cfg.video.minute||cfg.service.prepHour*60+cfg.service.prepMinute>=cfg.video.hour*60+cfg.video.minute))throw new Error('夜间运行需要跨日，晨间准备时间必须早于发布时间');
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
    provider, label: providerLabel(provider), envPrefix: prefix, meterHome: homePath(),
    apiKey: privateCfg.apiKey || process.env[`${prefix}_API_KEY`] || '',
    model: privateCfg.model || process.env[`${prefix}_MODEL`] || (provider === 'deepseek' ? 'deepseek-flash' : 'gpt-6-luna'),
    reasoningEffort: privateCfg.reasoningEffort || process.env[`${prefix}_REASONING_EFFORT`] || 'low',
    baseUrl: privateCfg.baseUrl || process.env[`${prefix}_BASE_URL`] || (provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1'),
  };
}
