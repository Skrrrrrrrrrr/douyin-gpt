// 同源 fetch、精简元数据、CDP 抽帧思路参考 Xia28zhi/dsh-douyin-scroll（MIT）。
import { writeFileSync, openSync, closeSync, writeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from './browser.mjs';
import {startCaptureInPage,finishCaptureInPage} from './understanding.mjs';
import {markVideoInPage,startFullCapture,pollFullCapture,finishFullCapture,readFullCaptureChunk} from './full-video-capture.mjs';

export class StopRequired extends Error {
  constructor(message,code) { super(message); this.name = 'StopRequired'; if(code)this.code=code; }
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
  async fetchInPage(path, {timeoutMs=20000,noCache=false}={}) {
    if (!path.startsWith('/aweme/v1/web/')) throw new Error('接口路径不在允许范围内');
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>20000)throw new Error('读取超时时间无效');
    const page = await this.browser.page('account', 'https://www.douyin.com/');
    for (let i = 0; i < 20; i++) {
      try { if (await page.ev('location.origin === "https://www.douyin.com" && document.readyState !== "loading"')) break; } catch {}
      await sleep(300);
    }
    let result;try{result = await page.ev(`(async () => {
      const r = await fetch(${JSON.stringify(path)}, { credentials: 'include', cache: ${JSON.stringify(noCache?'no-store':'default')}, signal: AbortSignal.timeout(${timeoutMs}) });
      if (!r.ok) return { httpError: r.status };
      const text=await r.text();if(!text.trim())return {empty:true};
      try { return JSON.parse(text); } catch { return { notJson: true }; }
    })()`,Math.min(30000,timeoutMs+2000));}catch(error){let title='';try{title=await page.ev('document.title',1500);}catch{}if(/验证码|安全验证/.test(title))throw new StopRequired('抖音页面需要本人完成验证');if(/Failed to fetch|NetworkError|TimeoutError|timed out|CDP .*超时|ERR_NETWORK|ERR_INTERNET|连接不可用|连接已关闭/.test(error.message))throw Object.assign(new Error('抖音网络请求暂未完成，等待恢复'),{code:'NETWORK_TRANSIENT'});throw error;}
    if(result?.httpError>=500||result?.httpError===429)throw Object.assign(new Error('抖音服务暂忙，等待恢复'),{code:'NETWORK_TRANSIENT'});
    if(result?.empty){
      let challenge=false;try{challenge=await page.ev(`/验证码中间页|安全验证|拖动.{0,8}滑块|请依次点击/.test(document.title+' '+(document.body?.innerText||'').slice(0,1200))`,1500);}catch{}
      if(challenge)throw new StopRequired('抖音页面需要本人完成验证','PLATFORM_VERIFICATION');
      throw Object.assign(new Error('抖音接口暂未返回数据，当前读取已暂缓等待重新核对'),{code:'REMOTE_READ_EMPTY',endpoint:path.split('?')[0]});
    }
    if (!result || result.httpError || result.notJson) throw new StopRequired('抖音接口没有返回有效数据，可能需要登录或完成页面验证','PLATFORM_VERIFICATION');
    if (Number(result.status_code || 0) !== 0) throw new StopRequired(`抖音接口状态 ${Number(result.status_code)}，请检查登录或页面验证`,Number(result.status_code)===8?'AUTH_REQUIRED':'PLATFORM_VERIFICATION');
    return result;
  }
  async whoami() {
    const json = await this.fetchInPage('/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383');
    const user = json.user || {};
    if (!user.sec_uid || !user.uid) throw new StopRequired('抖音尚未登录，请在控制台扫码','AUTH_REQUIRED');
    return { secUid: String(user.sec_uid), douyinId: String(user.unique_id || user.short_id || ''), nickname: String(user.nickname || '') };
  }
  async checkAccount(expected) {
    const actual = await this.whoami();
    if (!expected.secUid) throw new StopRequired('还没有绑定账号，请先运行 npm run login');
    if (actual.secUid !== expected.secUid || (expected.douyinId && actual.douyinId !== expected.douyinId)) throw new StopRequired('当前抖音登录账号与配置不一致，已停止','ACCOUNT_MISMATCH');
    return actual;
  }
  async feed({ exclude = [], limit = 3 } = {}) {
    try {
      const json = await this.fetchInPage('/aweme/v1/web/tab/feed/?device_platform=webapp&aid=6383&channel=channel_pc_web&count=12&refresh_index=1');
      const items = collectVideos(json);
      if (items.length) return items;
    } catch (error) {
      // 同源接口可能返回空响应。只退到使用者可见的正常推荐页，不重签或绕过验证。
      if (error instanceof StopRequired || error.message?.includes('账号')) throw error;
    }
    return this.feedFromPage({ exclude, limit });
  }
  async feedFromPage({ exclude = [], limit = 3 } = {}) {
    const page = await this.browser.page('feed', 'https://www.douyin.com/?recommend=1&from_nav=1');
    // 新 profile 可能先落在「精选」；使用页面自身的「推荐」导航进入信息流。
    const recommendationLink = await page.ev(`(() => location.pathname.startsWith('/video/') ? 'https://www.douyin.com/?recommend=1&from_nav=1' : location.pathname.startsWith('/jingxuan') ? [...document.querySelectorAll('a')].find(a => a.innerText.trim() === '推荐')?.href : '')()`);
    if (recommendationLink) await this.browser.navigate(page, recommendationLink);
    const excluded = new Set(exclude), items = new Map();
    for (let attempt = 0; attempt < 8 && items.size < limit; attempt++) {
      const title = String(await page.ev('document.title'));
      if (/^验证码中间页$|^安全验证/.test(title)) throw Object.assign(new StopRequired('推荐页出现验证码，请在专用浏览器完成验证','PAGE_VERIFICATION'),{pageKind:'feed',pageUrl:'https://www.douyin.com/?recommend=1&from_nav=1'});
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
  async search(query,{exclude=[],limit=3}={}){
    if(typeof query!=='string'||!query.trim()||query.length>40||/[\r\n<>]/.test(query))throw new Error('搜索主题需为1～40字');
    const url='https://www.douyin.com/search/'+encodeURIComponent(query.trim())+'?type=video',page=await this.browser.page('discovery',url);await this.browser.navigate(page,url);let ids=[];
    for(let i=0;i<40;i++){const state=await page.ev(`(()=>({title:document.title,ids:[...document.querySelectorAll('a[href]')].map(a=>{try{const u=new URL(a.href);if(u.origin!=='https://www.douyin.com')return '';return u.pathname.match(/^\\/video\\/(\\d{15,25})/)?.[1]||u.searchParams.get('modal_id')||'';}catch{return '';}}).filter(s=>/^\\d{15,25}$/.test(s))}))()`);if(/验证码|安全验证/.test(state.title))throw Object.assign(new StopRequired('搜索页需要本人完成验证','PAGE_VERIFICATION'),{pageKind:'discovery',pageUrl:url});ids=[...new Set(state.ids)].filter(id=>!exclude.includes(id));if(ids.length>=limit)break;await sleep(300);}
    const videos=[];for(const id of ids.slice(0,Math.min(10,limit)))try{videos.push({...await this.detail(id),discoveryTopic:query.trim(),discoverySource:'normal-search-page'});}catch(error){if(error instanceof StopRequired)throw error;}
    if(!videos.length)throw new Error('搜索页未读到可核对的新视频');return videos;
  }
  async mediaSource(video, signal) {
    if (!/^\d{15,25}$/.test(video.id) || video.url !== 'https://www.douyin.com/video/' + video.id) throw new Error('无效公开视频链接');
    if (!this.browser.headless && !this.browser.background) throw new Error('全片解析需要专用后台浏览器');
    const page = await this.browser.page(this.browser.background ? 'feed' : 'analysis', video.url);
    await this.browser.navigate(page, video.url);
    const selector = '.video_' + video.id + ' video, [data-e2e-vid="' + video.id + '"] video';
    for (let attempt = 0; attempt < 30; attempt++) {
      if (signal?.aborted) throw new Error('媒体采集已取消');
      const value = await page.ev('(' + markVideoInPage.toString() + ')(' + JSON.stringify({id: video.id}) + ')');
      if (/验证码|安全验证/.test(value.title)) throw Object.assign(new StopRequired('视频页面需要本人验证','PAGE_VERIFICATION'),{pageKind:this.browser.background?'feed':'analysis'});
      if (value.error) throw new Error(value.error);
      if (value.url?.startsWith('https:') && value.durationSeconds > 0) return {url: value.url, durationSeconds: value.durationSeconds};
      if (value.url?.startsWith('blob:') && value.durationSeconds > 0) throw Object.assign(new Error('分段媒体需要后台完整录制'), {code: 'MEDIA_STREAM_SOURCE'});
      await sleep(500);
    }
    throw new Error('页面没有提供可采集的完整视频媒体，未假装完成解析');
  }
  async recordFullVideo(video, {signal, maxBytes, outputFile, log = () => {}}) {
    if (!this.browser.headless && !this.browser.background) throw new Error('完整录制需要专用后台浏览器');
    if (typeof outputFile !== 'string' || !outputFile) throw new Error('完整录制需要本机输出文件');
    const page = await this.browser.page(this.browser.background ? 'feed' : 'analysis', video.url), args = {id: video.id, maxBytes};
    const started = await page.ev('(' + startFullCapture.toString() + ')(' + JSON.stringify(args) + ')');
    if (started.error) throw new Error(started.error);
    let done = false, lastAt = -1, changedAt = Date.now(), loggedAt = 0, file = null, wrote = false;
    try {
      while (!done) {
        if (signal?.aborted) throw new Error('全片录制已取消');
        await sleep(1000);
        const state = await page.ev('(' + pollFullCapture.toString() + ')(' + JSON.stringify({id: video.id}) + ')');
        if (state.error) throw new Error(state.error);
        if (state.at > lastAt + .05) {lastAt = state.at;changedAt = Date.now();}
        if (Date.now() - changedAt > 60000) throw new Error('全片录制期间播放停滞');
        if (Date.now() - loggedAt > 20000) {log('后台录制 ' + Math.floor(state.at) + '/' + Math.ceil(state.duration) + ' 秒');loggedAt = Date.now();}
        done = state.done;
      }
      const result = await page.ev('(' + finishFullCapture.toString() + ')(' + JSON.stringify({id: video.id}) + ')');
      if (result.error) throw new Error(result.error);
      if (!Number.isSafeInteger(result.bytes) || result.bytes <= 0 || result.bytes > maxBytes) throw new Error('录制媒体大小无效');
      file = openSync(outputFile, 'w', 0o600);wrote = true;
      for (let offset = 0; offset < result.bytes;) {
        if (signal?.aborted) throw new Error('录制落盘已取消');
        const chunk = await page.ev('(' + readFullCaptureChunk.toString() + ')(' + JSON.stringify({id: video.id, offset}) + ')');
        if (chunk.error || !chunk.bytes) throw new Error('录制媒体分块读取失败');
        const buffer = Buffer.from(chunk.base64, 'base64');
        if (buffer.length !== chunk.bytes || offset + chunk.bytes > result.bytes) throw new Error('录制媒体分块大小不一致');
        for (let n = 0; n < buffer.length;) n += writeSync(file, buffer, n, buffer.length - n);
        offset += buffer.length;
      }
      closeSync(file);file = null;
      await page.ev('(' + readFullCaptureChunk.toString() + ')(' + JSON.stringify({id: video.id, release: true}) + ')');
      return {file: outputFile, bytes: result.bytes, hasAudio: result.hasAudio, durationSeconds: result.durationSeconds};
    } catch (error) {
      if (file !== null) try {closeSync(file);} catch {}
      if (wrote) try {unlinkSync(outputFile);} catch {}
      try {await page.ev('(' + finishFullCapture.toString() + ')(' + JSON.stringify({id: video.id, cancel: true}) + ')');} catch {}
      throw error;
    }
  }
  async watch(video, cfg) {
    if (!/^[0-9]{15,25}$/.test(video.id)) throw new Error('无效视频 ID');
    const selector = `.video_${video.id} video, [data-e2e-vid="${video.id}"] video`;
    const page = await this.browser.page(this.browser.background ? 'feed' : 'video', video.url);
    await this.browser.navigate(page, video.url);
    if(this.browser.headless)await page.send('Page.bringToFront');
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
    if(cfg.captureAudio)await page.ev(`(${startCaptureInPage.toString()})(${JSON.stringify({id:video.id,seconds:cfg.watchSeconds})})`);
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
    } finally {
      if(cfg.captureAudio)try{files.audioCapture=await page.ev(`(${finishCaptureInPage.toString()})(${JSON.stringify({id:video.id})})`);}catch{files.audioCapture={error:'未能结束音轨采集'};}
      try { await page.ev(`document.querySelector(${JSON.stringify(selector)})?.pause()`); } catch {}
    }
    return files;
  }
}
