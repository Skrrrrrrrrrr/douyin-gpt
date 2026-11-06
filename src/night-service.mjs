import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {readState} from './state-file.mjs';
import {atomicJson} from './store.mjs';
import {dayKey} from './config.mjs';
import {publishedWitness} from './storylines.mjs';
import {safeDeliveryNote} from './send-diagnostics.mjs';

export function shiftDay(day,offset){return new Date(Date.parse(day+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);}
const at=(day,hour,minute)=>new Date(`${day}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00+08:00`).toISOString();
const accountHash=cfg=>createHash('sha256').update(cfg.account.secUid).digest('hex');
export function nightWindow(cfg,now=new Date()){
 const today=dayKey(now),startToday=at(today,cfg.service.overnight.startHour,cfg.service.overnight.startMinute),startDay=now>=new Date(startToday)?today:shiftDay(today,-1),day=shiftDay(startDay,1);
 const startAt=at(startDay,cfg.service.overnight.startHour,cfg.service.overnight.startMinute),prepareAt=at(day,cfg.service.prepHour,cfg.service.prepMinute),publishAt=at(day,cfg.video.hour,cfg.video.minute);
 return {day,startAt,prepareAt,publishAt,nextStartAt:at(day,cfg.service.overnight.startHour,cfg.service.overnight.startMinute),browsing:now>=new Date(startAt)&&now<new Date(publishAt)};
}
export const nightState=home=>readState(home,'service-window.json',{version:1});

// The existing LaunchAgent owns this controller. It is the only publication
// scheduler in overnight mode; the Codex heartbeat remains read-only.
export class NightService{
 constructor(home,deps){this.home=home;this.deps=deps;}
 read(){return this.deps.readState?this.deps.readState():nightState(this.home);}
 save(state){if(this.deps.saveState)this.deps.saveState(state);else atomicJson(join(this.home,'service-window.json'),state);}
 async job(state,kind,args,now){
  const attempt=state.jobs[kind]||{count:0,retryAt:0};
  if(attempt.count>=3||attempt.retryAt>now.getTime())return;
  state.jobs[kind]={count:attempt.count+1,retryAt:now.getTime()+300000};state.task={kind,startedAt:now.toISOString()};this.save(state);
  try{await this.deps.runTask(args,kind);state.task.status='done';delete state.error;this.deps.resolve();}
  catch(error){state.task.status='failed';state.error=safeDeliveryNote(error.stderr||error.message);this.deps.alert('夜间作品任务需要处理',state.error);}
  state.task.finishedAt=new Date().toISOString();this.save(state);
 }
 async finish(state,episode){
  state.published={day:episode.day,videoId:episode.platformVideoId||episode.review?.videoId,publishedAt:episode.publishedAt,confirmedAt:new Date().toISOString()};state.phase='stopping';this.save(state);
  await this.deps.stopServices();state.phase='stopped';state.stoppedAt=new Date().toISOString();delete state.error;this.save(state);this.deps.resolve();return state;
 }
 async tick(cfg,{now=new Date(),status={}}={}){
  if(!cfg.service.enabled||!cfg.service.overnight?.enabled)return {phase:'disabled'};
  const window=nightWindow(cfg,now);let state=this.read();
  if(window.browsing&&state.day!==window.day){
   const history=[...(state.history||[]),...(state.day?[{day:state.day,phase:state.phase,stoppedAt:state.stoppedAt,published:state.published,error:state.error,task:state.task}]:[])].slice(-7);
   state={version:1,accountHash:accountHash(cfg),...window,phase:'starting',jobs:{},startAttempts:0,history};this.save(state);
  }
  if(state.day!==window.day||state.stoppedAt)return {phase:'idle',nextStartAt:window.nextStartAt,...(state.stoppedAt?{lastCompletedDay:state.day}:{} )};
  state.browsing=window.browsing;
  if(state.accountHash!==accountHash(cfg))throw new Error('夜间运行记录与绑定账号不一致，已保持停止');
  if(!state.startedAt){
   if(!window.browsing)return {...state,phase:'idle'};
   const desired=this.deps.desired();if(state.startRequestedAt&&!desired.worker)return {...state,phase:'paused'};
   if(state.startAttempts>=5||(state.startRetryAt||0)>now.getTime())return state;
   const resume=!state.startRequestedAt;state.startRequestedAt||=now.toISOString();state.startAttempts++;state.startRetryAt=now.getTime()+60000;this.save(state);
   try{
    const started=await this.deps.start({resume});
    if(started.ok||started.storage?.ready){state.startedAt=now.toISOString();state.phase=started.worker?'running':'waiting_user';delete state.error;this.save(state);if(started.worker)this.deps.resolve();}
    else throw new Error(started.action||started.code||'夜间服务尚未启动');
   }catch(error){state.error=safeDeliveryNote(error.stderr||error.message);this.save(state);this.deps.alert('夜间服务启动需要处理',state.error);return state;}
  }
  const desired=this.deps.desired();
  if(desired.corrupt||desired.maintenanceUntil>now.getTime())return {...state,phase:'paused'};
  if(!state.pauseForPublish&&!desired.worker){state.phase='paused';this.save(state);await this.deps.maintain(cfg,status);return state;}
  if(now>=new Date(window.publishAt)&&!state.workerPaused){
   state.pauseForPublish=true;this.save(state);await this.deps.pauseWorker();state.workerPaused=true;state.phase='finishing';this.save(state);
  }
  await this.deps.maintain(cfg,status);
  if(!state.pauseForPublish){state.phase=status.worker===false?'waiting_user':'running';this.save(state);}
  let episode=await this.deps.readEpisode(window.day);
  if(episode&&(episode.day!==window.day||episode.account?.secUid!==cfg.account.secUid))throw new Error('晨间作品日期或绑定账号不一致，未继续操作');
  if(now>=new Date(window.publishAt)){
   if(episode&&publishedWitness(episode,cfg.account))return this.finish(state,episode);
   if(['submitted','scheduled','published','publishing','uncertain'].includes(episode?.status)){
    if((state.reviewRetryAt||0)<=now.getTime()){
     state.reviewRetryAt=now.getTime()+60000;this.save(state);
     try{await this.deps.review(window.day);}catch(error){state.error=safeDeliveryNote(error.stderr||error.message);this.save(state);this.deps.alert('晨间作品仍待核对',state.error);return state;}
     episode=await this.deps.readEpisode(window.day);if(episode&&publishedWitness(episode,cfg.account))return this.finish(state,episode);
    }
    state.phase='waiting_publication';this.save(state);
    if(['published','publishing','uncertain'].includes(episode?.status))this.deps.alert('晨间作品结果需要核对','保留原发布记录，只做读取复核，不自动重发。');
    return state;
   }
   if(['uploading','prepared'].includes(episode?.status)){state.phase='waiting_user';this.save(state);this.deps.alert('晨间作品尚未提交','上传稿件需要核对，刷取已暂停，未重新上传或发布。');return state;}
   if(now.getTime()>Date.parse(window.publishAt)+cfg.service.lateGraceMinutes*60000){state.phase='missed';this.save(state);this.deps.alert('晨间作品错过自动发布时段','刷取已暂停，保留成片和管理入口供本人核对。');return state;}
   if(!cfg.video.enabled){state.phase='waiting_user';this.save(state);this.deps.alert('晨间作品功能已关闭','刷取已暂停，保留当前人工设置。');return state;}
   if(episode?.status==='rendered'){
    if(cfg.review.videos==='review'&&!await this.deps.approved(episode)){state.phase='waiting_review';this.save(state);this.deps.alert('晨间作品等待批准','刷取已暂停，当前成片尚未批准，不自动越过审核。');return state;}
    await this.job(state,'publish',['--live','--ready-only'],now);
   }else await this.job(state,'build',[],now);
  }else if(now>=new Date(window.prepareAt)&&cfg.video.enabled&&status.worker!==false&&!['rendered','submitted','scheduled','published','publishing','uncertain','uploading','prepared'].includes(episode?.status))await this.job(state,'build',[],now);
  return state;
 }
}
