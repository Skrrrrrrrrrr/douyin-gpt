export const INTEREST_PROVIDERS = ['openai', 'deepseek'];

// 大肥鱼的初始偏好来自人物卡；龙娘的主题是可编辑的初始补充设定。
export const DEFAULT_INTEREST_PROFILES = {
  openai: {
    description: 'GPT 龙娘，喜欢弄清事物原理、解决具体问题和把生活安排妥当。',
    topics: ['科技科普', '编程技巧', '生活小技巧', '收纳整理', '游戏解谜'],
    learning: true,
    exploreEvery: 4,
  },
  deepseek: {
    description: 'DeepSeek 大肥鱼，爱吃白饭、零食、布丁和烤鱼，喜欢温暖舒适的日常，也愿意分享。',
    topics: ['家常菜', '甜品布丁', '烤鱼', '零食测评', '温暖治愈日常'],
    learning: true,
    exploreEvery: 4,
  },
};

export function validTopic(text) {
  return typeof text === 'string' && text.trim().length > 0 && [...text].length <= 40
    && !/[\n\r<>]|https?:\/\//i.test(text);
}

export function validateInterestProfiles(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('角色兴趣档案格式无效');
  const result = {};
  for (const [provider, profile] of Object.entries(value)) {
    if (!INTEREST_PROVIDERS.includes(provider)) throw new Error('兴趣档案只能配置 GPT 和 DeepSeek');
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)
      || Object.keys(profile).some(key => !['description', 'topics', 'learning', 'exploreEvery'].includes(key))) {
      throw new Error('角色兴趣档案含无效字段');
    }
    if (!Array.isArray(profile.topics) || profile.topics.length > 12 || profile.topics.some(topic => !validTopic(topic))) {
      throw new Error('每位角色最多十二个兴趣主题，每个一至四十字');
    }
    const description = profile.description ?? '';
    if (typeof description !== 'string' || [...description].length > 240 || /[\n\r<>]|https?:\/\//i.test(description)) {
      throw new Error('兴趣说明最多二百四十字，不包含网址或换行');
    }
    const learning = profile.learning ?? true, exploreEvery = profile.exploreEvery ?? 4;
    if (typeof learning !== 'boolean') throw new Error('兴趣学习开关必须是布尔值');
    if (!Number.isSafeInteger(exploreEvery) || exploreEvery < 2 || exploreEvery > 10) throw new Error('兴趣探索间隔必须为二至十轮');
    result[provider] = {description: description.trim(), topics: [...new Set(profile.topics.map(topic => topic.trim()))], learning, exploreEvery};
  }
  return result;
}

export function roleInterestTopics(cfg, provider = 'openai', fallback = []) {
  return cfg.discovery?.profiles?.[provider]?.topics ?? fallback;
}
