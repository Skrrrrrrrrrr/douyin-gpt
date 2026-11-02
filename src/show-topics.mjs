import {INTEREST_PROVIDERS} from './interest-profiles.mjs';
import {characterProfile} from './characters.mjs';
import {journalVideoInput} from './journal.mjs';

const sensitive = /案件|碎尸|战役|鬼子|伟人|自杀|医学|投资|理财|法律/;
const confidenceOf = video => Number.isFinite(video.analysis?.confidence) ? Math.max(0, Math.min(1, video.analysis.confidence)) : 0;
const compare = (a, b) => b.priority - a.priority || (b.rating ?? 0) - (a.rating ?? 0)
  || b.matchedTopics.length - a.matchedTopics.length || confidenceOf(b.video) - confidenceOf(a.video) || a.video.id.localeCompare(b.video.id);

export function chooseShowTopics(data, {cfg = {}, audienceTopic = null} = {}) {
  const characters = Object.fromEntries(INTEREST_PROVIDERS.map(provider => [provider, characterProfile(cfg, provider)]));
  const candidates = INTEREST_PROVIDERS.flatMap(provider => (data.providers?.[provider]?.videos || []).flatMap(raw => {
    if (typeof raw.id !== 'string' || !raw.id || !raw.analysis?.summary
      || sensitive.test(`${raw.desc || ''} ${raw.analysis.summary}`)) return [];
    const video = {...journalVideoInput(raw), ...(raw.day ? {day: raw.day} : {}), provider};
    const topics = characters[provider].interests.topics, content = `${video.desc} ${video.analysis.summary}`;
    const interest = video.analysis.interest, score = interest?.score;
    const rating = confidenceOf(video) >= .6 && Number.isInteger(score) && score >= -2 && score <= 2 ? score : null;
    const matchedTopics = topics.filter(topic => content.includes(topic) || (rating !== null && interest.topics?.includes(topic)));
    const priority = rating > 0 ? 3 : rating !== null && rating < 0 ? -1 : matchedTopics.length ? 2 : rating === 0 ? 1 : 0;
    return [{video, matchedTopics, rating, priority,
      basis: rating !== null ? 'recorded-rating' : matchedTopics.length ? 'topic-match' : 'evidence-confidence'}];
  })).sort(compare);
  const requested = audienceTopic && candidates.find(item => item.video.id === audienceTopic.matchedVideoId);
  const first = requested || candidates[0];
  if (!first) return {primary: null, secondary: null, selected: [], kind: 'none', audienceTopic: null};
  const other = candidates.find(item => item.video.provider !== first.video.provider && item.video.id !== first.video.id
    && confidenceOf(item.video) >= .6 && (item.rating > 0 || item.rating === null && item.matchedTopics.length));
  const selected = [first, ...(other ? [other] : [])];
  const shared = other && first.matchedTopics.some(topic => other.matchedTopics.includes(topic));
  return {primary: first.video, secondary: other?.video || null, selected,
    kind: other ? shared ? 'two-perspectives' : 'contrast' : 'single', audienceTopic: requested ? audienceTopic : null};
}

export function chooseShowTopic(data, cfg = {}) {return chooseShowTopics(data, {cfg}).primary;}

const short = (text, length) => [...text].length > length ? [...text].slice(0, length - 1).join('') + '…' : text;
export function episodePresentation(data, show, cfg = {}) {
  if(show?.narrative){const n=show.narrative,label=({diary:'一件小事',qa:'你们问我俩答',weekly:'本周回访'})[n.column];return {title:short(label+'｜'+n.mainline.title+'｜'+data.day.slice(5).replace('-','月')+'日',30),coverTitle:short(n.mainline.title,12),topicDescription:label+'：'+short(n.mainline.subject,60)};}
  const labels = (show?.selectedTopics || []).map(item => ({provider: item.provider, topic: item.matchedTopics?.[0] || ''}));
  const named = labels.filter(item => item.topic);
  const date = data.day.slice(5).replace('-', '月') + '日';
  const parts = named.map(item => `${characterProfile(cfg, item.provider).nickname}聊${short(item.topic, 8)}`);
  const subject = parts.length ? (data.weekly ? '本周' : '') + parts.join('，') : '龙娘和大肥鱼的' + (data.weekly ? '本周精选' : '今日选片');
  return {title: `${subject}｜${date}`,
    coverTitle: named.length >= 2 ? named.slice(0, 2).map(item => short(item.topic, 4)).join(' × ')
      : named.length ? `${characterProfile(cfg, named[0].provider).nickname}聊${short(named[0].topic, 5)}`
        : data.weekly ? '这周，我们挑了啥？' : '今天，我们挑了啥？',
    topicDescription: named.map(item => `${characterProfile(cfg, item.provider).name}：${item.topic}`).join('；')};
}
