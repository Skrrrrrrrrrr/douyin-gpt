import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {atomicJson} from './store.mjs';
import {Browser} from './browser.mjs';
import {Douyin} from './douyin.mjs';
import {Health} from './health.mjs';
import {readState,updateState} from './state-file.mjs';

const read=(home,name,fallback={})=>{try{return JSON.parse(readFileSync(join(home,name),'utf8'));}catch{return fallback;}};
const reasons={
 STORAGE_UNAVAILABLE:['业务数据服务不可用','请检查Docker数据库；当前操作已停止，恢复后守护会重新核对。'],
 STORAGE_LEASE_LOST:['数据库执行锁已失效','当前发送实例已停止提交，恢复后需重新取得唯一执行锁。'],
 STORAGE_WRITER_BUSY:['已有其他发送实例','另一个实例持有数据库执行锁，本实例不会同时发送。'],
 STORAGE_CORRUPT:['业务账本需要核对','记录缺失或校验失败，已停止读取；不会使用本机旧副本补数。'],
 AUTH_REQUIRED:['抖音登录已失效','在这里重新登录；核对原账号后自动恢复。'],
 PLATFORM_VERIFICATION:['抖音需要本人验证','请在专用抖音窗口完成验证，完成后会自动检查。'],
 ACCOUNT_MISMATCH:['登录账号与绑定账号不一致','请切回原来绑定的抖音号，程序会重新核对。'],
 BROWSER_CLOSED:['专用浏览器未连接','请本人重新打开专用抖音窗口，再点击检查连接。'],
 BUDGET_EXCEEDED:['当日模型预算已用完','等待北京时间次日预算恢复，或在用量与预算中调整。'],
 BUDGET_UNKNOWN:['模型费用需要核对','请在用量与预算中查看未确认调用；消息保留待处理。'],
 MODEL_OUTPUT_FORMAT:['模型回复格式无效','已保留来信，格式修复完成后继续处理。'],
 MODEL_OUTPUT_EMPTY:['模型返回空内容','已保留来信，等待模型恢复。'],
 MODEL_OUTPUT_SCHEMA:['模型回复字段不完整','已保留来信，等待符合要求的回复。'],
 NETWORK_TRANSIENT:['抖音连接请求暂未完成','当前请求正在退避重试，可在日志查看具体原因。'],
 REMOTE_READ_EMPTY:['抖音数据暂未返回','抖音接口返回空内容，当前读取仍待核对；稍后自动重试，这不代表电脑断网。'],
 SCAN_DELAYED:['消息扫描延迟','进程仍在运行，但扫描超过五分钟未更新；请查看服务日志。'],
 CONFIG_REQUIRED:['本机配置需要核对','请检查运行设置和服务日志后启动。'],
 FRIEND_SYNC:['好友名单暂未核对','正在等待名单同步成功，再回复互关好友。'],
 COMPOSE_DRAFT:['私信输入框有草稿','请处理专用抖音窗口里的草稿；新消息保留，之后自动再检查。'],
 COMPOSE_CHANGED:['私信会话正在切换','稍后会重新读取并核对会话。'],
 COMPOSE_NOT_READY:['私信输入框暂未就绪','正在等待输入框恢复，新消息保留待处理。'],
 SEND_UNCERTAIN:['有发送结果需要核对','请在回复记录中核对后解除暂停，程序不会自动重发。'],
 SEND_NOT_SENT:['有发送步骤被拦下','请查看回复记录中的拦截原因；旧记录不会自动补发。'],
 PAGE_VERIFICATION:['部分页面需要本人验证','私信继续运行；请在专用窗口完成验证，守护会自动检查恢复，也可手动检查。'],
 UNKNOWN:['回复流程需要检查','请查看服务日志中的最新错误。'],
};
export function recoveryReason(error={}){
 let code=Object.hasOwn(reasons,error.code)?error.code:'';const message=String(error.message||error.note||'');
 if(!code)code=/账号.*不一致/.test(message)?'ACCOUNT_MISMATCH':/窗口.*关闭|浏览器.*关闭|本人打开|浏览器连接/.test(message)?'BROWSER_CLOSED':/状态\s*8\b|尚未登录|登录.*失效|扫码/.test(message)?'AUTH_REQUIRED':/验证|接口没有返回有效/.test(message)?'PLATFORM_VERIFICATION':/配置|未设置|没有绑定/.test(message)?'CONFIG_REQUIRED':/网络|超时/.test(message)?'NETWORK_TRANSIENT':'UNKNOWN';
 const [title,action]=reasons[code];return {code,title,action,canProbe:['AUTH_REQUIRED','PLATFORM_VERIFICATION','ACCOUNT_MISMATCH','BROWSER_CLOSED'].includes(code),userActionRequired:['AUTH_REQUIRED','PLATFORM_VERIFICATION','ACCOUNT_MISMATCH','BROWSER_CLOSED','CONFIG_REQUIRED'].includes(code)};
}
export function exitRecord(error){return {version:1,at:new Date().toISOString(),...recoveryReason(error),note:recoveryReason(error).title};}
export function saveSession(home,value){const data={version:1,...value,checkedAt:new Date().toISOString()};atomicJson(join(home,'session-health.json'),data);return data;}
export async function probeSession(home,cfg,{browser=new Browser(home,{...cfg.browser,background:true}),dy}={}){
 try{await browser.start();const actual=await (dy||new Douyin(home,browser)).checkAccount(cfg.account);saveSession(home,{state:'ready',code:'READY',verifiedAt:new Date().toISOString()});return {ready:true,account:actual};}
 catch(error){const reason=recoveryReason(error);saveSession(home,{state:'blocked',...reason});return {ready:false,...reason};}
 finally{browser.disconnect();}
}
export function clearSessionStop(home){
 const old=read(home,'worker-exit.json');if(old.userActionRequired&&!recoveryReason(old).canProbe)return false;if(old.userActionRequired)atomicJson(join(home,'worker-exit.json'),{version:1,userActionRequired:false,recoveredAt:new Date().toISOString(),note:'已重新核对绑定账号'});
 const health=new Health(home);for(const key of ['worker-error','worker-stopped','service-needs-user','service-worker','service-restart-failed'])health.resolve(key);
}
export function shouldProbeSession(exit,now,lastProbe,desired){return !!desired.worker&&!desired.corrupt&&desired.maintenanceUntil<now&&!!exit?.userActionRequired&&recoveryReason(exit).canProbe&&now-lastProbe>=60000;}

export class ReplyProgress{
 constructor(home){this.home=home;this.data={version:1,pid:process.pid,startedAt:new Date().toISOString(),contacts:{}};}
 set(contact,stage,extra={}){const key=createHash('sha256').update(contact.secUid).digest('hex').slice(0,20);this.data.contacts[key]={key,label:contact.label,stage,updatedAt:new Date().toISOString(),...extra};this.write();}
 scan(stage='ready',extra={}){Object.assign(this.data,{stage,lastScanAt:new Date().toISOString(),...extra});this.write();}
 write(){try{atomicJson(join(this.home,'reply-progress.json'),this.data);}catch{/* 诊断失败不能改变发送行为。 */}}
}
const channelLabels={'browse:openai':'GPT 浏览','browse:deepseek':'DeepSeek 浏览','discovery-search':'视频搜索','public-comments':'公开评论','public-review':'作品复核','group-replies':'群聊回复'};
const channelInitial={version:1,channels:{}};
const recoveryUrl=value=>{try{const u=new URL(value);return u.origin==='https://www.douyin.com'&&!u.username&&!u.password?u.origin+u.pathname:'';}catch{return '';}};
function matchesPage(row,target){
 if(target.type!=='page')return false;const url=recoveryUrl(target.url);if(!url)return false;
 if(row.pageUrl&&url!==row.pageUrl)return false;
 const path=new URL(url).pathname;
 return row.pageKind==='discovery'?path.startsWith('/search/')
  :row.pageKind==='feed'?path==='/'||path.startsWith('/jingxuan')||/^\/video\/\d+/.test(path)
  :['analysis','comments'].includes(row.pageKind)?/^\/(video|note)\/\d+/.test(path):false;
}
export function channelPageStateInPage(){
 const text=document.body?.innerText||'',url=location.origin+location.pathname;
 const challenge=/验证码中间页|安全验证|拖动.{0,8}滑块|请依次点击/.test(document.title+' '+text.slice(0,1200))
  ||[...document.querySelectorAll('iframe[src*="captcha"],[id*="captcha"],[class*="captcha"]')].some(el=>{const r=el.getBoundingClientRect();return r.width>20&&r.height>20&&getComputedStyle(el).visibility!=='hidden';});
 const links=[...document.querySelectorAll('a[href]')].some(a=>{try{const u=new URL(a.href);return u.origin===location.origin&&/^\/video\/\d{15,25}/.test(u.pathname);}catch{return false;}});
 const searchReady=!!document.querySelector('[data-e2e="search-card-video"]')||links||/暂无(?:相关)?(?:视频|结果|内容)|没有找到相关|搜索结果为空/.test(text);
 return {url,ready:document.readyState==='complete',challenge,hasContent:!!text.trim(),searchReady,videoReady:!!document.querySelector('video')};
}
export class ChannelRecovery{
 constructor(home){this.home=home;}
 list(now=Date.now()){return Object.values(readState(this.home,'channel-health.json',channelInitial).channels).map(row=>{const since=row.firstBlockedAt||row.updatedAt,elapsedMinutes=Math.max(0,Math.floor((now-Date.parse(since))/60000))||0;return {...row,firstBlockedAt:since,elapsedMinutes,longPaused:elapsedMinutes>=30};});}
 isolateSearch(){
  if(!this.list().some(r=>/^browse:(openai|deepseek)$/.test(r.key)&&r.requiresUser&&r.pageKind==='discovery'&&r.code==='PAGE_VERIFICATION'))return [];
  const moved=updateState(this.home,'channel-health.json',channelInitial,d=>{
   const rows=Object.values(d.channels).filter(r=>/^browse:(openai|deepseek)$/.test(r.key)&&r.requiresUser&&r.pageKind==='discovery'&&r.code==='PAGE_VERIFICATION');if(!rows.length)return [];
   const existing=d.channels['discovery-search'],all=[...rows,...(existing?[existing]:[])],first=all.map(r=>r.firstBlockedAt||r.updatedAt).filter(v=>Number.isFinite(Date.parse(v))).sort()[0];
   d.channels['discovery-search']={...rows[0],...existing,key:'discovery-search',revision:existing?.revision||randomUUID(),label:channelLabels['discovery-search'],firstBlockedAt:first||new Date().toISOString(),requiresUser:true,migratedAt:new Date().toISOString(),migratedFrom:[...new Set([...(existing?.migratedFrom||[]),...rows.map(r=>r.key)])],action:'搜索等待本人验证；推荐流独立运行。请在专用窗口完成搜索页验证后检查恢复。'};
   for(const row of rows)delete d.channels[row.key];return rows.map(r=>r.key);
  });
  const health=new Health(this.home);for(const key of moved)health.resolve('channel:'+key);return moved;
 }
 blocked(key){const row=this.list().find(r=>r.key===key);return !!row&&(row.requiresUser||row.retryAt>Date.now());}
 fail(key,error){if(!channelLabels[key])throw new Error('任务通道无效');if(error.code==='PAGE_VERIFICATION'&&error.pageKind==='discovery')key='discovery-search';return updateState(this.home,'channel-health.json',channelInitial,d=>{const old=d.channels[key],reason=recoveryReason(error),count=(old?.attempts||0)+1,requiresUser=error.code==='PAGE_VERIFICATION',now=new Date().toISOString();return d.channels[key]={key,revision:randomUUID(),label:channelLabels[key],code:reason.code,title:reason.title,action:reason.action,requiresUser,pageKind:['discovery','feed','analysis','comments'].includes(error.pageKind)?error.pageKind:'',pageUrl:recoveryUrl(error.pageUrl),firstBlockedAt:old?.firstBlockedAt||old?.updatedAt||now,attempts:count,retryAt:requiresUser?null:Date.now()+Math.min(600000,30000*2**Math.min(count,5)),updatedAt:now};});}
 clear(key,{expectedUpdatedAt,expectedRevision}={}){if(!channelLabels[key])throw new Error('任务通道无效');const cleared=updateState(this.home,'channel-health.json',channelInitial,d=>{if(expectedRevision?d.channels[key]?.revision!==expectedRevision:expectedUpdatedAt&&d.channels[key]?.updatedAt!==expectedUpdatedAt)return false;delete d.channels[key];return true;});if(cleared)new Health(this.home).resolve('channel:'+key);return cleared;}
 refreshAlerts({notify=false,force=false,now=Date.now()}={}){
  const health=new Health(this.home,{notify}),alerts=health.read().alerts;
  for(const row of this.list(now)){
   const severity=row.longPaused?'error':'warning',key='channel:'+row.key,old=alerts.find(a=>a.key===key&&!a.resolvedAt);
   if(!force&&old?.persistent&&old.severity===severity&&now-Date.parse(old.lastSeenAt)<60000)continue;
   const detail=row.lastCheck?.state==='page_missing'?'原标签已关闭；请在专用窗口打开对应抖音页面，完成验证后检查恢复。':row.action;
   health.alert(key,row.label+(row.longPaused?'已长期暂停':'暂缓'),`已暂停 ${row.elapsedMinutes} 分钟。${detail}`,{severity,persistent:true,remindAfterMs:row.longPaused?6*3600000:0});
  }
 }
 noteCheck(row,result,cfg){updateState(this.home,'channel-health.json',channelInitial,d=>{const current=d.channels[row.key];if(row.revision?current?.revision===row.revision:current?.updatedAt===row.updatedAt)current.lastCheck={...result,at:new Date().toISOString()};});this.refreshAlerts({notify:cfg.monitor?.notify,force:true});return {ready:false,message:result.message};}
 async check(key,cfg,{browser=new Browser(this.home,{...cfg.browser,background:true}),dy}={}){
  if(!channelLabels[key])throw new Error('任务通道无效');const row=this.list().find(r=>r.key===key);if(!row)return {ready:true};
  if(!row.requiresUser){this.clear(key);return {ready:true};}
  try{
   await browser.start();const id=browser.runtime.tabs[row.pageKind];
   const {targetInfos}=await browser.cdp.send('Target.getTargets'),candidates=targetInfos.filter(t=>matchesPage(row,t)),tracked=candidates.find(t=>t.targetId===id),target=tracked||(candidates.length===1?candidates[0]:null);
   if(!target)return this.noteCheck(row,{state:'page_missing',message:candidates.length>1?'找到多个相关页面，请保留要核对的页面后再检查。':'原验证标签已关闭；请在专用窗口打开对应页面，完成验证后再检查。'},cfg);
   if(/验证码|安全验证/.test(target.title))return this.noteCheck(row,{state:'verification',message:'相关页面仍在等待本人验证'},cfg);
   const page=browser.attachExistingPage?await browser.attachExistingPage(row.pageKind,target.targetId):target.targetId===id?await browser.page(row.pageKind,target.url):null;
   if(!page)return this.noteCheck(row,{state:'page_missing',message:'当前浏览器适配器不能重新连接标签，请重新检查连接。'},cfg);
   const inspect=()=>page.ev('('+channelPageStateInPage.toString()+')()'),ready=state=>state.ready&&!state.challenge&&state.hasContent&&matchesPage(row,{type:'page',url:state.url})&&(row.pageKind==='discovery'?state.searchReady:row.pageKind==='feed'||row.pageKind==='analysis'?state.videoReady:true);
   if(!ready(await inspect()))return this.noteCheck(row,{state:'verification',message:'相关页面仍在验证、加载或尚未恢复正常内容，继续保留暂停。'},cfg);
   await (dy||new Douyin(this.home,browser)).checkAccount(cfg.account);
   if(!ready(await inspect()))return this.noteCheck(row,{state:'verification',message:'核对期间页面已变化，继续保留暂停。'},cfg);
   if(!this.clear(key,{expectedUpdatedAt:row.updatedAt,expectedRevision:row.revision}))return {ready:false,message:'核对期间任务状态已变化，已保留新的暂停记录。'};
   return {ready:true};
  }finally{browser.disconnect();}
 }
}
export function recoverySummary(home,cfg,{running=false,pid}={},desired={worker:true}){
 const session=read(home,'session-health.json'),exit=read(home,'worker-exit.json'),progress=read(home,'reply-progress.json'),health=read(home,'health.json');
 const current=!pid||progress.pid===pid,rows=Object.values(current?progress.contacts||{}:{}).filter(r=>r&&typeof r.stage==='string').map(row=>{
  if(row.code!=='NETWORK_TRANSIENT')return row;
  // Older running workers used the network code for empty responses. Match the
  // exact stable peer hash and failure time, never another contact's display name.
  const alert=health.alerts?.find(a=>!a.resolvedAt&&a.key?.startsWith('reply:')&&createHash('sha256').update(a.key.slice(6)).digest('hex').slice(0,20)===row.key&&Math.abs(Date.parse(a.lastSeenAt)-Date.parse(row.updatedAt))<2000&&/接口暂未返回数据/.test(a.message||''));
  return alert?{...row,...recoveryReason({code:'REMOTE_READ_EMPTY'})}:row;
 });
 const blocked=rows.filter(r=>r.stage==='blocked'),retry=rows.filter(r=>r.stage==='retrying');
 const manual=desired.corrupt||!desired.worker;
 let code=manual?'PAUSED':!running&&exit.userActionRequired?recoveryReason(exit).code:running&&health.alerts?.some(a=>a.key==='worker-read'&&!a.resolvedAt)?'REMOTE_READ_EMPTY':running&&health.alerts?.some(a=>a.key==='worker-network'&&!a.resolvedAt)?'NETWORK_TRANSIENT':running&&progress.stage==='blocked'?progress.code||'UNKNOWN':running&&blocked.length?blocked[0].code||'UNKNOWN':running&&retry.length?(Object.hasOwn(reasons,retry[0].code)?retry[0].code:'RETRYING'):running?'READY':'STARTING';
 if(running&&code==='READY'&&(!current||!progress.lastScanAt))code='STARTING';
 if(running&&code==='READY'&&Date.now()-Date.parse(progress.lastScanAt)>Math.max(300000,cfg.reply.pollSeconds*6000))code='SCAN_DELAYED';
 if(!cfg.reply.enabled&&running)code='REPLY_DISABLED';
 let channels=[];try{channels=new ChannelRecovery(home).list();}catch{channels=[{label:'任务状态',code:'STATE_ERROR',title:'任务状态记录需核对',action:'请查看本机服务日志'}];}
 const meta=reasons[code]||({PAUSED:['后台已暂停','本人暂停会一直保留，点击启动后台才会恢复。'],REPLY_DISABLED:['自动回复已关闭','可在运行设置中开启自动回复。'],READY:['回复通道正在运行','只处理获准范围内的新消息，发送后核对平台回执。'],RETRYING:['有消息等待重试','仅重试尚未提交的处理步骤；发送结果不确定时等待核对。'],STARTING:['等待后台恢复','服务守护会按退避间隔检查启动。']})[code]||reasons.UNKNOWN;
 return {code,title:meta[0],action:meta[1],channels,needsLogin:recoveryReason({code}).canProbe,checkedAt:session.checkedAt||null,verifiedAt:session.verifiedAt||null,lastScanAt:current?progress.lastScanAt||null:null,heartbeatAt:health.lastHeartbeatAt||null,contacts:rows.slice(-30).map(r=>({label:r.label,stage:r.stage,pending:r.pending??0,provider:r.provider||'',code:r.code||'',retryAt:r.retryAt||null,updatedAt:r.updatedAt})),pending:rows.reduce((n,r)=>n+(r.pending||0),0)};
}
