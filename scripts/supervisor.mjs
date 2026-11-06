import {storedExists as existsSync, readStoredFile as readFileSync} from '../src/storage.mjs';
import {safeDeliveryNote} from '../src/send-diagnostics.mjs';
import {NightService,nightState} from '../src/night-service.mjs';
import {startLocal} from './start-local.mjs';
import {Browser,ownedBrowserProcess,probe} from '../src/browser.mjs';
import {storageStatus} from '../src/storage.mjs';
import {supervisePending} from '../src/supervised-task.mjs';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {join} from 'node:path';import {mkdirSync} from 'node:fs';
import {ROOT,loadEnv,homePath,readConfig,dayKey} from '../src/config.mjs';import {takeLock,atomicJson} from '../src/store.mjs';import {serviceDesired,serviceStatus,installService,uninstallService,setDesired,endMaintenance} from '../src/service-control.mjs';import {Backups} from '../src/backups.mjs';import {scheduleAction} from '../src/scheduler.mjs';import {approvedEpisode} from '../src/episode-review.mjs';import {Health} from '../src/health.mjs';import {sleep} from '../src/browser.mjs';
import {probeSession,shouldProbeSession,clearSessionStop,recoveryReason,ChannelRecovery} from '../src/recovery.mjs';
loadEnv();const home=homePath(),action=process.argv[2]||'status',exec=promisify(execFile),env={...process.env,DOUYIN_GPT_HOME:home},read=(f,d=null)=>{try{return JSON.parse(readFileSync(f));}catch(error){if(error.code?.startsWith('STORAGE_'))throw error;return d;}},run=(script,args=[],timeout=65000)=>exec(process.execPath,[join(ROOT,'scripts',script),...args],{cwd:ROOT,env,timeout,maxBuffer:1000000});
async function pauseNightWorker(){
 setDesired(home,'worker',false);await run('background.mjs',['stop','--maintenance','--keep-browser']);
 if(JSON.parse((await run('background.mjs',['status'])).stdout).running)throw new Error('执行进程尚未停止，保留浏览器与管理入口');
 endMaintenance(home);
}
async function stopNightServices(){
 await pauseNightWorker();setDesired(home,'dashboard',false);
 const cfg=readConfig(home),owned=ownedBrowserProcess(join(home,'browser'));
 if(owned&&await probe(owned.port)){
  const browser=new Browser(home,cfg.browser);try{await browser.start();await browser.quit();}finally{browser.disconnect();}
 }
 await run('dashboard.mjs',['stop','--maintenance']);endMaintenance(home);
}
async function main(){
 if(action==='install'){console.log(JSON.stringify(await installService(home),null,2));return;}if(action==='uninstall'){console.log(JSON.stringify(await uninstallService(home),null,2));return;}if(action==='status'){const cfg=readConfig(home),schedule=cfg.service.overnight.enabled?{start:String(cfg.service.overnight.startHour).padStart(2,'0')+':'+String(cfg.service.overnight.startMinute).padStart(2,'0'),prepare:String(cfg.service.prepHour).padStart(2,'0')+':'+String(cfg.service.prepMinute).padStart(2,'0'),publish:String(cfg.video.hour).padStart(2,'0')+':'+String(cfg.video.minute).padStart(2,'0'),stop:'after_confirmed_publication',timeZone:'Asia/Shanghai'}:null;console.log(JSON.stringify({...await serviceStatus(home),schedule,window:cfg.service.overnight.enabled?nightState(home):null},null,2));return;}if(action!=='run')throw new Error('用法：supervisor.mjs install|uninstall|status|run');
 const control=join(home,'service');mkdirSync(control,{recursive:true,mode:0o700});const release=takeLock(control),health=new Health(home);let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
 const attempts={worker:0,dashboard:0},retryAt={worker:0,dashboard:0};let lastSessionProbe=0,lastChannelProbe=0;const maintain=async(cfg,desired,status)=>{
   let storageReady=true;try{status.storage=storageStatus(home);health.resolve('service-storage');}catch{storageReady=false;status.storage={backend:'postgres',ready:false};health.alert('service-storage','业务数据库不可用','请检查Docker数据库，恢复后守护会重新检查；没有回退本机旧账本。',{severity:'error',persistent:true});}
   for(const key of ['worker','dashboard']){
    if(!desired[key])continue;const script=key==='worker'?'background.mjs':'dashboard.mjs';
    if(key==='worker'&&!storageReady)continue;
    try{
     const result=JSON.parse((await run(script,['status'],8000)).stdout);status[key]=result.running;
     if(result.running){attempts[key]=0;health.resolve('service-'+key);if(key==='worker')health.resolve('service-restart-failed');continue;}
     const lock=read(join(home,'process.lock'));if(key==='worker'&&lock?.pid){let alive=false;try{process.kill(lock.pid,0);alive=true;}catch{}if(alive)continue;}
     let exit=key==='worker'?read(join(home,'worker-exit.json')):null;
     if(shouldProbeSession(exit,Date.now(),lastSessionProbe,serviceDesired(home))){
      lastSessionProbe=Date.now();const session=await probeSession(home,cfg);status.session={ready:session.ready,code:session.code||'READY'};
      if(session.ready){clearSessionStop(home);exit=null;attempts.worker=0;retryAt.worker=0;console.log(new Date().toISOString()+' 原账号登录已恢复，准备继续后台');}
     }
     if(exit?.userActionRequired){const reason=recoveryReason(exit);health.alert('service-needs-user',reason.title,reason.action);continue;}
     if(Date.now()<retryAt[key])continue;
     if(attempts[key]>=5){health.alert('service-restart-failed','后台连续启动失败','请处理控制台异常后手动启动');continue;}
     // Re-read after probing: a manual pause always takes precedence over recovery.
     const latest=serviceDesired(home);if(!latest[key]||latest.corrupt||latest.maintenanceUntil>Date.now())continue;
     attempts[key]++;retryAt[key]=Date.now()+Math.min(300000,30000*2**(attempts[key]-1));await run(script,['start','--maintenance']);status[key]=true;console.log(new Date().toISOString()+' 已恢复 '+key);
    }catch(error){status[key]=false;health.alert('service-'+key,'后台恢复暂未完成','请检查 '+key+' 的运行记录');}
   }
   if(desired.worker&&Date.now()-lastChannelProbe>=60000){lastChannelProbe=Date.now();try{const channels=new ChannelRecovery(home),moved=channels.isolateSearch();channels.refreshAlerts({notify:cfg.monitor?.notify,force:moved.length>0});for(const row of channels.list().filter(r=>r.requiresUser)){const result=await channels.check(row.key,cfg);if(result.ready)console.log(new Date().toISOString()+' 已核对页面恢复 '+row.key);}}catch{}}
 };
 const night=new NightService(home,{
  desired:()=>serviceDesired(home),
  start:async({resume})=>{const releaseStartup=takeLock(join(home,'startup'));try{return await startLocal({home,cfg:readConfig(home),resume,log:console.log});}finally{releaseStartup();}},
  pauseWorker:pauseNightWorker,stopServices:stopNightServices,
  maintain:async(cfg,status)=>{await maintain(cfg,serviceDesired(home),status);if(cfg.backup.enabled&&status.storage?.ready)try{const backups=new Backups(home);if(!backups.list().some(b=>b.day===dayKey()))backups.create({reason:'daily'});status.backupDay=backups.list()[0]?.day;health.resolve('service-backup');}catch{health.alert('service-backup','加密备份未完成','请查看备份页；现有文件已保留');}return status;},
  readEpisode:async day=>read(join(home,'video',day,'episode.json'),null),
  approved:async state=>!!approvedEpisode(home,state),
  runTask:async(args,kind)=>supervisePending(()=>run('evening.mjs',args,1200000),async()=>{const currentCfg=readConfig(home),desired=serviceDesired(home),status={version:1,pid:process.pid,checkedAt:new Date().toISOString(),desired,task:{kind,day:nightState(home).day},window:nightState(home)};if(!stopping&&currentCfg.service.enabled&&!desired.corrupt&&desired.maintenanceUntil<Date.now())await maintain(currentCfg,desired,status);atomicJson(join(home,'supervisor-runtime.json'),status);},{intervalMs:Math.max(1000,readConfig(home).service.pollSeconds*1000),onTickError:()=>health.alert('night-service','夜间守护检查暂未完成','原任务仍保留，不重复创建任务')}),
  review:async day=>exec(process.execPath,[join(ROOT,'src/cli.mjs'),'video-review','--day',day],{cwd:ROOT,env,timeout:90000,maxBuffer:1000000}),
  alert:(title,message)=>health.alert('night-service',title,message,{severity:'error',persistent:true}),resolve:()=>health.resolve('night-service'),
 });
 try{while(!stopping){const cfg=readConfig(home),desired=serviceDesired(home),status={version:1,pid:process.pid,checkedAt:new Date().toISOString(),desired};
  if(desired.corrupt)health.alert('service-desired-corrupt','后台运行目标需核对','运行目标记录损坏，已保持暂停；请在控制台明确选择启动或停止以重建。');
  if(cfg.service.enabled&&!desired.corrupt&&desired.maintenanceUntil<Date.now()){
   if(cfg.service.overnight.enabled){
    health.notify=cfg.monitor?.notify;
    try{status.window=await night.tick(cfg,{status});status.desired=serviceDesired(home);for(const key of ['worker','dashboard'])if(!status.desired[key])status[key]=false;health.resolve('service-watchdog');}
    catch(error){status.window={phase:'blocked',code:error.code||'NIGHT_SERVICE_ERROR'};health.alert('night-service','夜间任务需要处理',safeDeliveryNote(error.message),{severity:'error',persistent:true});}
   }else{
   await maintain(cfg,desired,status);health.resolve('service-watchdog');
   if(desired.worker){try{const day=dayKey(),state=read(join(home,'video',day,'episode.json')),job=scheduleAction(cfg,state,{approved:state?.status==='rendered'&&cfg.review.videos==='review'?!!approvedEpisode(home,state):false});if(job){if(job.kind==='missed')health.alert('video-missed:'+day,'今晚晚报尚未提交','已超过自动补发时段，保留稿件供本人核对');else{const file=join(home,'service-schedule.json'),prior=read(file,{version:1,attempts:{}}),attempt=prior.attempts[job.key]||{count:0,retryAt:0};if(attempt.count<3&&attempt.retryAt<Date.now()){prior.attempts[job.key]={count:attempt.count+1,retryAt:Date.now()+300000};prior.current={kind:job.kind,startedAt:new Date().toISOString()};atomicJson(file,prior);try{await supervisePending(()=>run('evening.mjs',job.args,1200000),async()=>{const currentCfg=readConfig(home),currentDesired=serviceDesired(home),currentStatus={version:1,pid:process.pid,checkedAt:new Date().toISOString(),desired:currentDesired,task:{kind:job.kind,startedAt:prior.current.startedAt}};if(!stopping&&currentCfg.service.enabled&&!currentDesired.corrupt&&currentDesired.maintenanceUntil<Date.now())await maintain(currentCfg,currentDesired,currentStatus);atomicJson(join(home,'supervisor-runtime.json'),currentStatus);},{intervalMs:Math.max(1000,cfg.service.pollSeconds*1000),onTickError:()=>health.alert('service-watchdog','守护检查暂未完成','晚报任务仍保留，下一轮会重新检查服务')});prior.current.status='done';health.resolve('service-video');}catch(error){prior.current.status='failed';prior.current.error=safeDeliveryNote(error.stderr||error.message);health.alert('service-video','晚报任务需要留意',prior.current.error||'制作或提交未完成，已保留稿件并限制自动重试');}prior.current.finishedAt=new Date().toISOString();atomicJson(file,prior);}}}}catch(error){health.alert('service-video','晚报任务需要留意',error.message);}}
   if(cfg.backup.enabled)try{const backups=new Backups(home);if(!backups.list().some(b=>b.day===dayKey()))backups.create({reason:'daily'});status.backupDay=backups.list()[0]?.day;health.resolve('service-backup');}catch{health.alert('service-backup','加密备份未完成','请查看备份页；现有文件已保留');}
   }
  }
  atomicJson(join(home,'supervisor-runtime.json'),status);for(let i=0;i<cfg.service.pollSeconds&&!stopping;i++)await sleep(1000);
 }}finally{release();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
