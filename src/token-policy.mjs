// Public evidence is compacted for inference; the original records stay in the journal.
export const EFFICIENCY_DEFAULTS = Object.freeze({
  enabled: false, combineVideoComment: true, separateOCR: false,
  transcribeWithCaptions: false, cachePrompts: true, framesPerVideo: 1,
});

export function efficiencySettings(cfg = {}) {
  return {...EFFICIENCY_DEFAULTS, ...cfg.tokenEfficiency};
}

const clip = (value, max) => [...String(value ?? '')].slice(0, max).join('');

export function compactVideo(video = {}) {
  return {id: video.id, desc: clip(video.desc, 500), author: clip(video.author, 80),
    ...(video.discoveryTopic ? {discoveryTopic: clip(video.discoveryTopic, 40)} : {})};
}

export function compactPerception(perception, max = 1200) {
  if (!perception) return null;
  return {status: perception.status, transcript: clip(perception.transcript, max),
    captions: clip(perception.captions, max), captionSource: perception.captionSource || '',
    sampleStart: perception.sampleStart || 0, sampleSeconds: perception.sampleSeconds || 0,
    truncated: [...String(perception.transcript || '')].length > max || [...String(perception.captions || '')].length > max,
    ...(perception.codex ? {codex: {summary: clip(perception.codex.summary, 200), evidence: clip(perception.codex.evidence, 200),
      timeline: (perception.codex.timeline || []).slice(0, 12).map(t => ({startSeconds: t.startSeconds, endSeconds: t.endSeconds,
        observation: clip(t.observation, 120), source: t.source})), limitations: (perception.codex.limitations || []).map(t => clip(t, 120)).slice(0, 5)},
      coverage: {durationSeconds: perception.coverage?.durationSeconds, firstFrameAt: perception.coverage?.firstFrameAt,
        lastFrameAt: perception.coverage?.lastFrameAt, maxFrameGap: perception.coverage?.maxFrameGap,
        transcriptionComplete: perception.coverage?.transcriptionComplete === true}} : {})};
}

export function compactAnalysis(analysis) {
  if (!analysis) return null;
  return {summary: clip(analysis.summary, 180), evidence: clip(analysis.evidence, 160),
    recommend: analysis.recommend === true, confidence: analysis.confidence ?? null,
    ...(analysis.perception ? {perception: compactPerception(analysis.perception, 600)} : {})};
}

export function compactThread(comments = [], target = null) {
  const thread = target ? comments.filter(c => c.id === target.rootId || c.rootId === target.rootId) : comments;
  const root = target && thread.find(c => c.id === target.rootId);
  const parent = target && thread.find(c => c.id === target.replyToId);
  const chosen = new Map();
  for (const item of [root, parent, ...thread.filter(c => c.id !== target?.id).slice(-4)]) {
    if (item && !chosen.has(item.id)) chosen.set(item.id, item);
  }
  const mandatory = [...chosen.values()].slice(0, root ? 1 : 0);
  const recent = [...chosen.values()].filter(c => !mandatory.includes(c)).slice(-(4 - mandatory.length));
  return [...mandatory, ...recent].map(c => ({id: c.id, rootId: c.rootId || '',
    replyToId: c.replyToId || '', text: clip(c.text, 400)}));
}

export function compactTarget(target) {
  return target ? {id: target.id, rootId: target.rootId || '', replyToId: target.replyToId || '',
    text: clip(target.text, 600), parentText: clip(target.parentText, 400)} : null;
}

export function compactJournalVideo(video) {
  const value = {id: video.id, desc: clip(video.desc, 180), author: clip(video.author, 60),
    watchedAt: video.watchedAt || '', analysis: compactAnalysis(video.analysis)};
  // The observation already cites its source. Do not resend full captions/transcripts.
  if (value.analysis?.perception) {
    const p = value.analysis.perception;
    value.analysis.perception = {status: p.status, transcript: clip(p.transcript, 160), captions: clip(p.captions, 100),
      captionSource: p.captionSource, sampleStart: p.sampleStart, sampleSeconds: p.sampleSeconds};
  }
  if (video.analysis?.interest) value.analysis.interest = {
    score: video.analysis.interest.score, topics: video.analysis.interest.topics,
    reason: clip(video.analysis.interest.reason, 100),
  };
  return value;
}

export function journalGroups(videos) {
  const groups = new Map();
  for (const video of videos) {
    const topic = video.analysis?.interest?.topics?.[0] || '未标注主题';
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic).push(video);
  }
  const entries = [...groups.entries()].sort((a,b) => b[1].length - a[1].length);
  const selected = entries.slice(0, 9);
  if (entries.length > 9) selected.push(['其他主题', entries.slice(9).flatMap(entry => entry[1])]);
  return selected.map(([topic, items], index) => ({groupId: 'group' + index, topic,
    videoIds: items.map(v => v.id), count: items.length,
    examples: [...items].sort((a,b) => (b.analysis?.confidence || 0) - (a.analysis?.confidence || 0)).slice(0, 3).map(compactJournalVideo)}));
}

export function publicCodexEvidence(p) {
  if (p?.source !== 'codex-cli' || !p.codex || !p.coverage) return {};
  const c = p.coverage;
  return {source: 'codex-cli', status: p.status, codex: {summary: p.codex.summary, evidence: p.codex.evidence,
    limitations: p.codex.limitations,
    timeline: (p.codex.timeline || []).map(t => ({startSeconds: t.startSeconds, endSeconds: t.endSeconds, observation: t.observation, source: t.source}))},
    coverage: {durationSeconds: c.durationSeconds, firstFrameAt: c.firstFrameAt, lastFrameAt: c.lastFrameAt,
      maxFrameGap: c.maxFrameGap, frameTimes: c.frameTimes, refinedFrameTimes: c.refinedFrameTimes || [],
      audioPresent: c.audioPresent === true, transcriptionComplete: c.transcriptionComplete === true,
      transcribedRanges: (c.transcribedRanges || []).map(r => ({start: r.start, end: r.end}))}};
}

export function efficientFrames(settings, browse, video) {
  if (!settings.enabled) return browse.framesPerVideo;
  // Sequence-dependent clips keep multiple samples rather than guessing from one still.
  return /教程|步骤|动作|前后|剧情|对比|过程/.test(video.desc || '')
    ? Math.min(3, Math.max(2, browse.framesPerVideo)) : settings.framesPerVideo;
}

export function requestControls(name, model, configuredEffort, settings, payload) {
  const fallback = {effort: configuredEffort || 'low', maxOutput: name === 'daily_video_journal' ? 6000 : 3000, cache: false};
  if (!settings.enabled) return fallback;
  const simple = /^(video_(interest_)?review(_comment)?|public_video_comment|public_comment_reply|visible_captions|contact_memory)$/.test(name);
  const supportsNone = /^(gpt-6-luna|gpt-6\.1-terra|deepseek-(flash|v4-flash))($|-)/.test(model);
  let maxOutput = fallback.maxOutput;
  if (/^public_/.test(name)) maxOutput = 500;
  else if (/^video_.*review/.test(name)) maxOutput = name.endsWith('_comment') ? 1500 : 1000;
  else if (name === 'contact_memory') maxOutput = 900;
  else if (name === 'visible_captions') maxOutput = 1400;
  else if (name === 'daily_video_journal') maxOutput = payload.groups ? 4500 : Math.min(6000, 2500 + (payload.videos?.length || 0) * 25);
  return {effort: simple && supportsNone ? 'none' : fallback.effort, maxOutput,
    cache: settings.cachePrompts && /^gpt-6[.-]/.test(model)};
}

export function validatePublicDecision(value, maxChars) {
  if (!value || typeof value.shouldPost !== 'boolean' || typeof value.text !== 'string'
    || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    throw new Error('公开评论格式或 confidence 无效');
  }
  const result = {...value, text: value.text.trim()};
  if (result.shouldPost && (!result.text || [...result.text].length > maxChars
    || /https?:\/\/|@|sk-[A-Za-z0-9]|sessionid\s*=|Cookie\s*:/i.test(result.text))) {
    throw new Error('公开评论为空、超长或含不允许的内容');
  }
  if (!result.shouldPost) result.text = '';
  return result;
}
