// 同源 fetch、精简元数据、CDP 抽帧思路参考 Xia28zhi/dsh-douyin-scroll（MIT）。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from './browser.mjs';

export class StopRequired extends Error {
  constructor(message) { super(message); this.name = 'StopRequired'; }
}
export function normalizeVideo(a) {
  const id = String(a.aweme_id || '');
  if (!/^\d{15,25}$/.test(id)) return null;
  const stats = a.statistics || {};
  return {
    id, desc: String(a.desc || '').slice(0, 2000), author: String(a.author?.nickname || ''),
    durationSeconds: Number(a.video?.duration || a.duration || 0) / 1000,
    likes: Number(stats.digg_count || 0), comments: Number(stats.comment_count || 0),
    favorites: Number(stats.collect_count || 0), shares: Number(stats.share_count || 0),
    url: `https://www.douyin.com/video/${id}`,
  };
}
export function collectVideos(value, result = new Map()) {
  if (Array.isArray(value)) { for (const child of value) collectVideos(child, result); }
  else if (value && typeof value === 'object') {
    if (value.aweme_id && (value.desc !== undefined || value.statistics)) {
      const item = normalizeVideo(value);
      if (item) result.set(item.id, item);
    } else for (const child of Object.values(value)) collectVideos(child, result);
  }
  return [...result.values()];
}
export class Douyin {
  constructor(home, browser) { this.home = home; this.browser = browser; }
  async fetchInPage(path) {
    if (!path.startsWith('/aweme/v1/web/')) throw new Error('接口路径不在允许范围内');
    const page = await this.browser.page('account', 'https://www.douyin.com/');
    for (let i = 0; i < 20; i++) {
      try { if (await page.ev('location.origin === "https://www.douyin.com" && document.readyState !== "loading"')) break; } catch {}
      await sleep(300);
    }
    const result = await page.ev(`(async () => {
      const r = await fetch(${JSON.stringify(path)}, { credentials: 'include', signal: AbortSignal.timeout(20000) });
      if (!r.ok) return { httpError: r.status };
      try { return await r.json(); } catch { return { notJson: true }; }
    })()`);
    if (!result || result.httpError || result.notJson) throw new StopRequired('抖音接口没有返回有效数据，可能需要登录或完成页面验证');
    if (Number(result.status_code || 0) !== 0) throw new StopRequired(`抖音接口状态 ${Number(result.status_code)}，请检查登录或页面验证`);
    return result;
  }
  async whoami() {
    const json = await this.fetchInPage('/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383');
    const user = json.user || {};
    if (!user.sec_uid || !user.uid) throw new StopRequired('抖音尚未登录，请运行 npm run login 扫码');
    return { secUid: String(user.sec_uid), douyinId: String(user.unique_id || user.short_id || ''), nickname: String(user.nickname || '') };
  }
  async checkAccount(expected) {
    const actual = await this.whoami();
    if (!expected.secUid) throw new StopRequired('还没有绑定账号，请先运行 npm run login');
    if (actual.secUid !== expected.secUid || (expected.douyinId && actual.douyinId !== expected.douyinId)) throw new StopRequired('当前抖音登录账号与配置不一致，已停止');
    return actual;
  }
  async feed({ exclude = [], limit = 3 } = {}) {
    try {
      const json = await this.fetchInPage('/aweme/v1/web/tab/feed/?device_platform=webapp&aid=6383&channel=channel_pc_web&count=12&refresh_index=1');
      const items = collectVideos(json);
      if (items.length) return items;
    } catch (error) {
      // 同源接口可能返回空响应。只退到使用者可见的正常推荐页，不重签或绕过验证。
      if (error.message?.includes('账号')) throw error;
    }
    return this.feedFromPage({ exclude, limit });
  }
  async feedFromPage({ exclude = [], limit = 3 } = {}) {
    const page = await this.browser.page('feed', 'https://www.douyin.com/?recommend=1&from_nav=1');
    // 新 profile 可能先落在「精选」；使用页面自身的「推荐」导航进入信息流。
    const recommendationLink = await page.ev(`(() => location.pathname.startsWith('/jingxuan') ? [...document.querySelectorAll('a')].find(a => a.innerText.trim() === '推荐')?.href : '')()`);
    if (recommendationLink) await this.browser.navigate(page, recommendationLink);
    const excluded = new Set(exclude), items = new Map();
    for (let attempt = 0; attempt < 8 && items.size < limit; attempt++) {
      const title = String(await page.ev('document.title'));
      if (/^验证码中间页$|^安全验证/.test(title)) throw new StopRequired('推荐页出现验证码，请在专用浏览器完成验证后再启动');
      const result = await page.ev(`(() => {
        const videos = [...document.querySelectorAll('video')].filter(v => {
          const r=v.getBoundingClientRect();return r.width>100&&r.height>100&&r.bottom>0&&r.top<innerHeight;
        }).sort((a,b)=>{const area=v=>{const r=v.getBoundingClientRect();return Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top))*r.width};return area(b)-area(a)});
        const active=document.querySelector('[data-e2e="feed-active-video"]');
        const video=active?.querySelector('video') || videos[0];if(!video)return null;
        const activeId=active?.getAttribute('data-e2e-vid') || '';
        const visited=new WeakSet();
        function find(o,depth){
          if(!o||typeof o!=='object'||depth>4||visited.has(o))return null;
          visited.add(o);
          if(o.aweme_id&&(o.desc!==undefined||o.statistics))return o;
          for(const key of Object.keys(o).slice(0,50)){
            if(key==='children'||key==='return'||key==='stateNode'||key.startsWith('__react'))continue;
            const hit=find(o[key],depth+1);if(hit)return hit;
          }
          return null;
        }
        let n=video;
        for(let i=0;n&&i<8;i++,n=n.parentElement){
          const key=Object.keys(n).find(k=>k.startsWith('__reactFiber$'));
          let f=key&&n[key];
          for(let j=0;f&&j<12;j++,f=f.return){
            const a=find(f.memoizedProps,0);
            if(a)return {aweme_id:String(a.aweme_id),desc:String(a.desc||''),author:{nickname:String(a.author?.nickname||'')},duration:a.duration||a.video?.duration||0,statistics:{digg_count:a.statistics?.digg_count||0,comment_count:a.statistics?.comment_count||0,collect_count:a.statistics?.collect_count||0,share_count:a.statistics?.share_count||0}};
          }
        }
        return /^[0-9]{15,25}$/.test(activeId) ? {aweme_id:activeId,desc:'',author:{},duration:Number(video.duration||0)*1000,_fromDom:true} : null;
      })()`);
      let item = result && normalizeVideo(result);
      if (item && result._fromDom) {
        try { item = await this.detail(item.id); }
        catch { item.metadataLimited = true; }
      }
      if (item && !excluded.has(item.id)) items.set(item.id, item);
      if (items.size >= limit) break;
      if (item) {
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
      }
      await sleep(item ? 1200 : 1000);
    }
    if (!items.size) throw new Error('推荐页面没有读到新视频。请检查专用浏览器页面；本轮未使用旧数据补数');
    return [...items.values()];
  }
  async detail(id) {
    if (!/^\d{15,25}$/.test(id)) throw new Error('无效视频 ID');
    const json = await this.fetchInPage(`/aweme/v1/web/aweme/detail/?device_platform=webapp&aid=6383&aweme_id=${id}`);
    const item = collectVideos(json).find(v => v.id === id);
    if (!item) throw new Error('没有获取到这条视频的元数据');
    return item;
  }
  async watch(video, cfg) {
    if (!/^[0-9]{15,25}$/.test(video.id)) throw new Error('无效视频 ID');
    const selector = `.video_${video.id} video, [data-e2e-vid="${video.id}"] video`;
    const page = await this.browser.page('video', video.url);
    await this.browser.navigate(page, video.url);
    let ready = false;
    for (let i = 0; i < 24; i++) {
      ready = await page.ev(`(() => {
        const v = document.querySelector(${JSON.stringify(selector)});
        if (!v || v.readyState < 2) return false;
        v.muted = true;
        v.play().catch(() => {});
        return true;
      })()`);
      if (ready) break;
      await sleep(500);
    }
    if (!ready) throw new Error('视频无法播放，可能已下架或需要页面验证');
    const files = [];
    const interval = cfg.watchSeconds * 1000 / cfg.framesPerVideo;
    let lastTime = -1;
    try {
      for (let i = 0; i < cfg.framesPerVideo; i++) {
        await sleep(interval);
        const box = await page.ev(`(async () => {
          const v = document.querySelector(${JSON.stringify(selector)});
          if (!v) return null;
          if (v.requestVideoFrameCallback && !v.paused) await new Promise(resolve => { const timer=setTimeout(resolve,1500);v.requestVideoFrameCallback(()=>{clearTimeout(timer);resolve()}) });
          const r = v.getBoundingClientRect();
          const x = Math.max(0, Math.ceil(r.left)), y = Math.max(0, Math.ceil(r.top));
          return { x, y, width: Math.max(0, Math.min(innerWidth, r.right) - x), height: Math.max(0, Math.min(innerHeight, r.bottom) - y), at: v.currentTime, paused: v.paused };
        })()`);
        if (!box || box.width < 40 || box.height < 40) throw new Error('视频画面不在可截图区域');
        if (box.at <= lastTime && box.paused) throw new Error('视频没有继续播放');
        lastTime = box.at;
        const { at, paused, ...clip } = box;
        const shot = await page.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
        if (!shot.data) throw new Error('浏览器没有返回视频截图');
        const file = join(this.home, 'frames', `${video.id}-${Date.now()}-${i}.png`);
        writeFileSync(file, Buffer.from(shot.data, 'base64'), { mode: 0o600 });
        files.push(file);
      }
    } finally { try { await page.ev(`document.querySelector(${JSON.stringify(selector)})?.pause()`); } catch {} }
    return files;
  }
}
