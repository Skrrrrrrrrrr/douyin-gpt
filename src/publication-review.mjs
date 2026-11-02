import {readStoredFile as readFileSync, storedExists as existsSync, storedReadDir as readdirSync} from './storage.mjs';

import {join} from 'node:path';
import {atomicJson} from './store.mjs';
import {Health} from './health.mjs';
import {Cdp,sleep} from './browser.mjs';
import {Douyin} from './douyin.mjs';
import {Storylines} from './storylines.mjs';
import {Audience} from './audience.mjs';
import {Analytics} from './analytics.mjs';
export const safeVideoId=x=>typeof x==='string'&&/^\d{15,25}$/.test(x)?x:'';
export function creatorCardsInPage(){
 const seen=new WeakSet();
 function find(o,depth=0){if(!o||typeof o!=='object'||depth>5||seen.has(o))return '';seen.add(o);for(const k of ['aweme_id','awemeId','item_id','itemId'])if(typeof o[k]==='string'&&/^\d{15,25}$/.test(o[k]))return o[k];for(const k of Object.keys(o).slice(0,35)){if(['return','stateNode','_owner','ref'].includes(k)||typeof o[k]==='function')continue;const id=find(o[k],depth+1);if(id)return id;}return '';}
 return [...document.querySelectorAll('div[class*=video-card-content]')].map(card=>{let id='';for(let n=card,i=0;n&&i<5;i++,n=n.parentElement){const key=Object.keys(n).find(k=>k.startsWith('__reactFiber$'));let f=key&&n[key];for(let j=0;f&&j<7&&!id;j++,f=f.return)id=find(f.memoizedProps);if(id)break;}return {text:card.innerText,id};});
}
export function classifyReview(text){if(/审核不通过|未通过审核|审核未通过|作品违规|不予发布|发布失败/.test(text))return 'rejected';if(/审核中|审核处理中/.test(text))return 'reviewing';if(/定时发布中|定时待发布/.test(text))return 'scheduled';if(/仅自己可见|私密/.test(text))return 'private';if(/已发布/.test(text))return 'published';return 'submitted';}
export function nativePublishedAt(text){const m=String(text).match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})/);if(!m)return '';const value=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}T${m[4].padStart(2,'0')}:${m[5]}:00+08:00`;return Number.isFinite(Date.parse(value))?value:'';}
export function cachedPublicCheck(previous,id,now=Date.now()){
 const check=previous?.publicCheck;if(!check||previous.videoId!==id)return null;const checkedAt=check.checkedAt||previous.checkedAt,age=now-Date.parse(checkedAt);const ttl=(check.visible===true?24:check.visible===false?.25:6)*3600000;
 return Number.isFinite(age)&&age>=0&&age<ttl?{...check,checkedAt}:null;
}
export function mergePublicationReview(state,current){
 const old=state.review||{},confirmed=old.status&&old.status!=='unknown'?{status:old.status,checkedAt:old.checkedAt,publishedAt:old.publishedAt,videoId:old.videoId}:old.lastConfirmed||null;
 return {...current,videoId:current.videoId||state.platformVideoId||old.videoId||'',publishedAt:current.publishedAt||state.publishedAt||old.publishedAt||confirmed?.publishedAt||'',lookupMisses:current.status==='unknown'?(old.lookupMisses||0)+1:0,lastConfirmed:current.status==='unknown'?confirmed:null,publicCheck:current.publicCheck||(['unknown','published','submitted'].includes(current.status)?old.publicCheck:undefined)};
}
export function reviewCardsReady(cards,title,text,attempt){return cards.some(c=>c.text.includes(title))||attempt>=10&&text.includes('没有更多作品')&&cards.every(c=>/20\d{2}年\d{1,2}月\d{1,2}日/.test(c.text));}
export class PublicationReview{
 constructor(home,cfg,browser,{log=console.log}={}){Object.assign(this,{home,cfg,browser,log});this.health=new Health(home,{notify:cfg.monitor.notify});this.lastAt=0;}
 async publicProbe(id){
  if(!safeVideoId(id))return {visible:null,reason:'尚未取得公开作品 ID'};let context,page;
  try{
   ({browserContextId:context}=await this.browser.cdp.send('Target.createBrowserContext',{disposeOnDetach:true}));
   const {targetId}=await this.browser.cdp.send('Target.createTarget',{url:`https://www.douyin.com/video/${id}`,browserContextId:context,background:true});
   let target;for(let i=0;i<20&&!target;i++){const targets=await(await fetch(`http://127.0.0.1:${this.browser.runtime.port}/json/list`)).json();target=targets.find(t=>t.id===targetId);if(!target)await sleep(200);}
   if(!target)throw new Error('未能打开公开访问检查页');page=await Cdp.connect(target.webSocketDebuggerUrl);page.background=true;await page.send('Runtime.enable');
   for(let i=0;i<26;i++){
    const result=await page.ev(`(()=>{const v=document.querySelector('.video_${id} video,[data-e2e-vid="${id}"] video');if(v){v.muted=true;v.play().catch(()=>{});}return {ready:!!v&&v.readyState>=2&&v.duration>0,title:document.title,text:document.body?.innerText.slice(0,800)||''}})()`);
    if(result.ready)return {visible:true,checkedBy:'anonymous-browser',checkedAt:new Date().toISOString()};
    if(/验证码|安全验证|请先登录|登录后观看/.test(result.title+result.text))return {visible:null,reason:'游客页面需要登录或验证，暂不能确认公开可见'};
    if(/视频不存在|作品已删除|暂时无法播放/.test(result.text))return {visible:false,reason:'游客页面暂无法播放该作品'};await sleep(500);
   }
   return {visible:null,reason:'游客页面未在本轮加载完成'};
  }catch(error){return {visible:null,reason:error.message};}finally{page?.close();if(context)try{await this.browser.cdp.send('Target.disposeBrowserContext',{browserContextId:context});}catch{}}
 }
 async check(day,{probe=true}={}){
  const file=join(this.home,'video',day,'episode.json');if(!existsSync(file))return null;const state=JSON.parse(readFileSync(file,'utf8'));
  if(state.account?.secUid!==this.cfg.account.secUid)throw new Error('复核记录与绑定账号不一致');
  if(!['scheduled','submitted','published','uncertain','publishing'].includes(state.status))return null;
  await new Douyin(this.home,this.browser).checkAccount(this.cfg.account);
  const page=await this.browser.page('review','https://creator.douyin.com/creator-micro/content/manage');await this.browser.navigate(page,'https://creator.douyin.com/creator-micro/content/manage');
  let cards=[],text='';for(let i=0;i<40;i++){text=await page.ev('document.body.innerText');cards=await page.ev(`(${creatorCardsInPage.toString()})()`);if(reviewCardsReady(cards,state.title,text,i))break;if(/扫码登录|登录创作者中心/.test(text))throw new Error('创作者中心登录已失效');await sleep(300);}
  const matches=cards.filter(c=>c.text.includes(state.title));let review;
  if(matches.length!==1)review={status:'unknown',reason:matches.length?'同名作品不唯一，需核对':'作品管理暂未定位到该期作品'};
  else{const card=matches[0];review={status:classifyReview(card.text),cardText:card.text.slice(0,1800),videoId:safeVideoId(card.id)||state.platformVideoId||'',publicVisible:null};
   if(review.status==='published')review.publishedAt=nativePublishedAt(card.text);
   if(probe&&['submitted','published'].includes(review.status)&&review.videoId){const result=cachedPublicCheck(state.review,review.videoId)||{...await this.publicProbe(review.videoId),checkedAt:new Date().toISOString()};review.publicVisible=result.visible;review.publicCheck=result;review.reason=result.reason||'';if(result.visible)review.status='published';}
  }
  review.checkedAt=new Date().toISOString();review=mergePublicationReview(state,review);state.review=review;if(review.videoId){state.platformVideoId=review.videoId;state.platformUrl=`https://www.douyin.com/video/${review.videoId}`;}if(review.publishedAt)state.publishedAt=review.publishedAt;if(review.status==='published')state.status='published';atomicJson(file,state);
  if(review.lookupMisses>=3)this.health.alert(`publication-lookup:${day}`,'晚报作品连续未能定位','之前的发布记录已保留，请在作品管理核对当前状态');else if(review.status!=='unknown')this.health.resolve(`publication-lookup:${day}`);
  if(state.status==='published'&&review.status==='published'){try{new Storylines(this.home,this.cfg).commitPublished(state);if(state.show?.audienceTopic?.id)new Audience(this.home).used(state.show.audienceTopic.id,state.day);}catch(error){this.health.alert('public-story-index','公开节目历史待同步',error.message);}}
  try{new Analytics(this.home,this.cfg).capture(state);}catch(error){this.log(`作品数据暂未保存：${error.message}`);}
  if(matches.length===1)try{this.health.resolve(`video-missed:${day}`);}catch{}
  if(['rejected','private'].includes(review.status))this.health.alert(`publication:${day}`,`${day} 晚报发布需要处理`,review.status==='rejected'?'平台审核未通过，请在作品管理查看原因':'该作品当前不是公开可见',{severity:'error'});
  else if(review.publicVisible===false)this.health.alert(`publication:${day}`,'晚报游客播放检查未通过',review.reason||'作品管理状态与游客播放结果需要核对');
  else if(review.status==='reviewing'&&Date.now()-Date.parse(state.submittedAt||state.publishAttemptAt)>this.cfg.monitor.reviewGraceMinutes*60000)this.health.alert(`publication:${day}`,'晚报仍在审核中','作品提交后仍未通过审核，请查看创作者中心');
  else if(review.status==='published')this.health.resolve(`publication:${day}`);
  this.log(`发布复核 ${day}：${review.status}${review.publicVisible===true?'，游客可播放':''}`);return review;
 }
 async tick(signal){if(!this.cfg.monitor.enabled||signal?.aborted||Date.now()-this.lastAt<this.cfg.monitor.pollSeconds*1000)return;this.lastAt=Date.now();const base=join(this.home,'video');if(!existsSync(base))return;
  for(const day of readdirSync(base).filter(s=>/^\d{4}-\d{2}-\d{2}$/.test(s)).sort().slice(-3)){
   if(signal?.aborted)break;try{await this.check(day);this.health.resolve(`review:${day}`);}catch(error){this.health.alert(`review:${day}`,'晚报复核暂未完成',error.message);this.log(`发布复核：${error.message}`);}
  }
 }
}
