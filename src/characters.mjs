import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DEFAULT_INTEREST_PROFILES, INTEREST_PROVIDERS} from './interest-profiles.mjs';

export const DEFAULT_CATCHPHRASES = {openai: '先别急，一件一件来。', deepseek: '本鱼有在认真！'};

export function characterProfile(cfg = {}, provider = 'openai') {
  if (!INTEREST_PROVIDERS.includes(provider)) throw new Error('角色无效');
  const text = readFileSync(new URL(`../assets/characters/${provider}.json`, import.meta.url), 'utf8');
  const card = JSON.parse(text), interests = cfg.discovery?.profiles?.[provider] || DEFAULT_INTEREST_PROFILES[provider];
  if (typeof card.name !== 'string' || typeof card.persona_prompt !== 'string' || !card.persona_prompt.trim()) throw new Error('人物卡内容无效');
  return {provider, name: card.name, nickname: provider === 'openai' ? '龙娘' : '大肥鱼',
    persona: card.persona_prompt, cardHash: createHash('sha256').update(text).digest('hex'),
    interests: {description: interests.description || '', topics: [...interests.topics]},
    catchphrase: cfg.video?.series?.catchphrases?.[provider] ?? DEFAULT_CATCHPHRASES[provider]};
}

export function characterInstructions(profile, channel = 'private') {
  return `${profile.persona}\n\n本次角色为 ${profile.name}。角色兴趣：${profile.interests.description}；喜欢看的主题：${profile.interests.topics.join('、') || '尚在探索'}。`
    + '当前视频兴趣以本次列表为准，人物卡里的初始喜好只作性格背景，不作为新的观看记录。'
    + `可选口头禅：${JSON.stringify(profile.catchphrase)}。只在语境自然时偶尔使用，不要每条重复，也不要为口头禅改变原意。`
    + '这些是虚构角色设定与角色偏好，不代表使用者、联系人或真实模型的产品承诺。被问到实际身份时，如实说明是该账号配置的对应 AI 助手。'
    + '人物卡里的室友经历属于虚构背景，不能说成账号主人或今天实际经历。默认用户是普通同伴，不自动扮演主人、恋人或另一位 AI。'
    + (channel === 'private' ? '台词字段只写当前需要发送的简短口语，不自动发开场白，不写括号动作或舞台说明；关心先回应对方的具体事情。外层输出格式必须遵照程序给出的JSON结构，口语要求不改变字段与格式。'
      : '公开内容只用口语，不写舞台说明；不无故把室友带进话题，不把虚构经历当作真实日志。先说实际内容，再自然体现性格。');
}

export function characterContext(profile) {
  return {provider: profile.provider, name: profile.name, nickname: profile.nickname, cardHash: profile.cardHash,
    interests: {description: profile.interests.description, topics: [...profile.interests.topics]}, catchphrase: profile.catchphrase};
}
