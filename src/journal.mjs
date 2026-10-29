import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dayKey, defaultConfig, PROVIDERS, providerLabel, providerBrowse } from './config.mjs';
import { atomicJson } from './store.mjs';

const str = { type: 'string' }, strings = { type: 'array', items: str };
export const JOURNAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    overview: str,
    themes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { title: str, summary: str, videoIds: strings }, required: ['title', 'summary', 'videoIds'] } },
    highlights: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { videoId: str, reason: str }, required: ['videoId', 'reason'] } },
    reflections: strings, limitations: strings,
  }, required: ['overview', 'themes', 'highlights', 'reflections', 'limitations'],
};
export function journalVideoInput(v) {
  return { id: v.id, desc: v.desc || '', author: v.author || '', watchedAt: v.watchedAt || '', analysis: {
    summary: v.analysis?.summary || '', evidence: v.analysis?.evidence || '',
    recommend: v.analysis?.recommend === true, confidence: v.analysis?.confidence ?? null,
  } };
}
export function validateDailySummary(value, videos) {
  const fail = () => { throw new Error('每日总结格式或视频引用无效，保留原始观看记录'); };
  const text = x => typeof x === 'string' && x.trim().length > 0 && x.length <= 6000;
  if (!value || !text(value.overview) || !Array.isArray(value.themes) || value.themes.length < 1 || value.themes.length > 10
    || !Array.isArray(value.highlights) || value.highlights.length > 3
    || !Array.isArray(value.reflections) || value.reflections.length < 1 || value.reflections.length > 4
    || !Array.isArray(value.limitations) || !value.limitations.length || value.limitations.length > 6) fail();
  const ids = new Set(videos.map(v => v.id)), covered = [];
  for (const theme of value.themes) {
    if (!theme || !text(theme.title) || !text(theme.summary) || !Array.isArray(theme.videoIds) || !theme.videoIds.length || theme.videoIds.some(id => !ids.has(id))) fail();
    covered.push(...theme.videoIds);
  }
  if (covered.length !== ids.size || new Set(covered).size !== ids.size) fail();
  for (const h of value.highlights) if (!h || !ids.has(h.videoId) || !text(h.reason)) fail();
  if (new Set(value.highlights.map(h => h.videoId)).size !== value.highlights.length) fail();
  if (![...value.reflections, ...value.limitations].every(text)) fail();
  return value;
}
export function journalDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('日志日期需要 YYYY-MM-DD');
  const date = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('日志日期无效');
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const escape = value => String(value ?? '').replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]<>#|]/g, '\\$&');
const paragraphs = value => String(value).split(/\n\s*\n/).map(escape).filter(Boolean).join('\n\n');
const clock = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(date) : '时间未记录';
};
const title = v => {
  const caption = String(v.desc || '').split(/\r?\n/)[0].split('#')[0].trim();
  const chars = [...(caption || v.analysis?.summary || v.id)];
  return chars.slice(0, 54).join('') + (chars.length > 54 ? '…' : '');
};
const videoLink = v => /^\d{15,25}$/.test(v.id) ? `[${escape(title(v))}](https://www.douyin.com/video/${v.id})` : escape(title(v));
function atomicText(file, text) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, file); }
  finally { try { unlinkSync(tmp); } catch {} }
}

export class DailyJournal {
  constructor({ home, cfg, store, models = {}, ledger, log = console.log, now = () => new Date() }) {
    Object.assign(this, { home, cfg, store, models, ledger, log, now });
    this.settings = { ...defaultConfig().journal, ...cfg.journal };
    this.snapshots = new Map();
    mkdirSync(join(home, 'reports'), { recursive: true, mode: 0o700 });
  }
  videos(day, provider) {
    const file = join(this.home, 'reports', `${journalDay(day)}.videos.json`);
    let archived = [];
    if (existsSync(file)) {
      try {
        const source = JSON.parse(readFileSync(file, 'utf8'));
        if (source.version !== 1 || source.day !== day || !Array.isArray(source.videos) || source.videos.some(v => !v || typeof v.id !== 'string' || v.day !== day)) throw new Error();
        archived = source.videos;
      } catch { throw new Error(`${day} 的观看日志源记录损坏，保留现有日志`); }
    }
    // state.json 保留最近 1000 条；每日日志另存公开源记录，历史日志不会随其裁剪而丢失。
    const merged = new Map([...archived, ...this.store.data.videos.filter(v => v.day === day)].map(v => [`${v.provider || 'openai'}:${v.id}`, v]));
    return [...merged.values()].filter(v => !provider || (v.provider || 'openai') === provider).sort((a, b) => String(a.watchedAt || '').localeCompare(String(b.watchedAt || '')));
  }
  actions(day) {
    // 只保留公开互动计数，不读取或输出私信联系人及对话。
    return (this.ledger?.data?.actions || []).filter(a => a.day === day && ['sending', 'accepted', 'sent', 'uncertain'].includes(a.status));
  }
  cache(day) {
    try {
      const value = JSON.parse(readFileSync(join(this.home, 'reports', `${journalDay(day)}.summary.json`), 'utf8'));
      if (value.version === 1 && value.day === day && value.providers && typeof value.providers === 'object' && !Array.isArray(value.providers)) return value;
    } catch {}
    return { version: 1, day, providers: {} };
  }
  cachedSummary(entry, videos) {
    if (!entry || !Array.isArray(entry.videoIds)) return null;
    const covered = videos.filter(v => entry.videoIds.includes(v.id));
    if (covered.length !== entry.videoIds.length) return null;
    try { return validateDailySummary(entry.summary, covered); } catch { return null; }
  }
  render(day, cache, updatedAt) {
    const videos = this.videos(day), actions = this.actions(day);
    const lines = [
      `# 抖音每日日志 · ${day}`, '',
      `北京时间更新：${clock(updatedAt)}。当天记录持续更新；全部 ${videos.length} 条观看记录均列在下方。`, '',
      '> 内容依据视频文案与播放时抽取的画面；没有音频转写，不代表完整看完。视频中的历史、案件、地点等说法未另行核实。', '',
      '## 今日概况', '',
      '| 模型 | 已记录视频 | 当前每日上限 | 主动评论 | 回复评论 |',
      '|---|---:|---:|---:|---:|',
    ];
    for (const provider of PROVIDERS) {
      const subset = videos.filter(v => (v.provider || 'openai') === provider), own = actions.filter(a => (a.provider || 'openai') === provider);
      lines.push(`| ${providerLabel(provider)} | ${subset.length} | ${providerBrowse(this.cfg, provider).videosPerDay} | ${own.filter(a => a.kind === 'comment').length} | ${own.filter(a => a.kind === 'reply').length} |`);
    }
    lines.push('', `今日共记录 ${videos.length} 条视频；${videos.filter(v => v.analysis?.recommend === true).length} 条被浏览模型标记为推荐。${videos.length ? `观看记录时段：${clock(videos[0].watchedAt)}—${clock(videos.at(-1).watchedAt)}。` : ''}`, '',
      '公开互动统计包含抖音已接收或发送结果待核对的尝试，不代表对方已读。回看线索用于整理内容，不改写浏览时的推荐判断。', '');
    for (const provider of PROVIDERS) {
      const subset = videos.filter(v => (v.provider || 'openai') === provider), entry = cache.providers[provider];
      const summary = this.cachedSummary(entry, subset);
      const model = entry?.model || this.models[provider]?.config?.model || subset.find(v => v.model)?.model || (provider === 'openai' ? 'gpt-6.1-terra' : 'deepseek-flash');
      lines.push(`## ${providerLabel(provider)} 当日总结`, '', `模型：${escape(model)}；已记录 ${subset.length} 条视频。`, '');
      if (!subset.length) { lines.push('今天尚无该模型的观看记录。', ''); continue; }
      if (!summary) { lines.push('综合总结待生成，逐条内容和证据已完整保存。', ''); continue; }
      if (entry.videoIds.length !== subset.length) lines.push(`以下综合总结覆盖 ${entry.videoIds.length}/${subset.length} 条；新记录会在下一次汇总中纳入。`, '');
      lines.push(paragraphs(summary.overview), '', '### 内容归类', '');
      for (const theme of summary.themes) {
        lines.push(`- **${escape(theme.title)}**（${theme.videoIds.length} 条）：${escape(theme.summary)}`);
        lines.push(`  对应视频：${theme.videoIds.map(id => videoLink(subset.find(v => v.id === id))).join('；')}。`);
      }
      lines.push('', '### 回看线索', '');
      if (!summary.highlights.length) lines.push('本次未单独挑选回看线索。');
      for (const h of summary.highlights) lines.push(`- ${videoLink(subset.find(v => v.id === h.videoId))}：${escape(h.reason)}`);
      lines.push('', '### 当天观察', '', ...summary.reflections.map(item => `- ${escape(item)}`), '', '### 判断范围', '', ...summary.limitations.map(item => `- ${escape(item)}`), '');
    }
    lines.push('## 全部观看记录', '');
    if (!videos.length) lines.push('今天尚无观看记录。', '');
    videos.forEach((v, index) => {
      const confidence = Number.isFinite(v.analysis?.confidence) ? `${Math.round(v.analysis.confidence * 100)}%` : '未记录';
      lines.push(`### ${index + 1}. ${videoLink(v)}`, '',
        `${providerLabel(v.provider)} · ${clock(v.watchedAt)} · 作者：${escape(v.author || '未记录')}`, '',
        `内容：${escape(v.analysis?.summary || '没有可用摘要。')}`, '',
        `依据：${escape(v.analysis?.evidence || '没有可用证据记录。')}`, '',
        `浏览判断：${v.analysis?.recommend === true ? '推荐' : '未标记推荐'}；把握 ${confidence}。`, '',
        `视频 ID：${escape(v.id)}`, '');
    });
    return lines.join('\n').trimEnd() + '\n';
  }
  writeSnapshot(day = dayKey(this.now())) {
    journalDay(day);
    if (!this.settings.enabled) return null;
    const cache = this.cache(day), videos = this.videos(day);
    const directories = [join(this.home, 'reports'), ...(this.settings.outputDir ? [this.settings.outputDir] : [])];
    const signature = digest({ videos: videos.map(journalVideoInput), providers: videos.map(v => v.provider || 'openai'), cache, actions: this.actions(day).map(a => [a.id, a.provider, a.status, a.kind]), limits: PROVIDERS.map(p => providerBrowse(this.cfg, p).videosPerDay) });
    const paths = [...new Set(directories)].map(dir => join(dir, `${day}.md`));
    if (this.snapshots.get(day) === signature && paths.every(existsSync)) return paths[0];
    const text = this.render(day, cache, this.now());
    atomicJson(join(this.home, 'reports', `${day}.videos.json`), {version:1,day,videos:videos.map(v=>({...journalVideoInput(v),day,provider:v.provider||'openai',model:v.model||''}))});
    for (const file of paths) {
      mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
      atomicText(file, text);
    }
    this.snapshots.set(day, signature);
    return paths[0];
  }
  async refresh({ day = dayKey(this.now()), force = false, signal } = {}) {
    journalDay(day);
    if (!this.settings.enabled) return null;
    this.writeSnapshot(day);
    const cache = this.cache(day), file = join(this.home, 'reports', `${day}.summary.json`);
    for (const provider of PROVIDERS) {
      if (signal?.aborted) break;
      const videos = this.videos(day, provider), model = this.models[provider];
      if (!videos.length || typeof model?.dailySummary !== 'function') continue;
      const fingerprint = digest({ version: 1, model: model.config?.model, videos: videos.map(journalVideoInput) });
      const entry = cache.providers[provider] || {}, valid = this.cachedSummary(entry, videos);
      if (!force && valid && entry.fingerprint === fingerprint) continue;
      if (!force && this.now().getTime() - (entry.lastAttemptAt || 0) < this.settings.refreshMinutes * 60000) continue;
      entry.lastAttemptAt = this.now().getTime(); cache.providers[provider] = entry; atomicJson(file, cache);
      try {
        const result = validateDailySummary(await model.dailySummary({ day, videos: videos.map(journalVideoInput) }), videos);
        if (signal?.aborted) break;
        cache.providers[provider] = { fingerprint, model: model.lastResponse?.model || model.config?.model || providerLabel(provider), videoIds: videos.map(v => v.id), summary: result, generatedAt: this.now().toISOString(), lastAttemptAt: entry.lastAttemptAt };
        atomicJson(file, cache);
        this.log(`[${providerLabel(provider)}] 已更新 ${day} 每日总结，覆盖 ${videos.length} 条视频`);
      } catch (error) {
        this.log(`[${providerLabel(provider)}] 每日总结暂未生成：${error.message}`);
      }
      this.writeSnapshot(day);
    }
    return this.writeSnapshot(day);
  }
  async tick(signal) {
    const now = this.now(), today = dayKey(now), yesterday = dayKey(new Date(now.getTime() - 86400000));
    // 跨天后继续补齐昨日最后一轮记录；既有日期文件保持归档。
    if (this.videos(yesterday).length) await this.refresh({ day: yesterday, signal });
    if (!signal?.aborted) await this.refresh({ day: today, signal });
  }
}
