import test from 'node:test';
import assert from 'node:assert/strict';
import {NightService,nightWindow} from '../src/night-service.mjs';
import {defaultConfig,validateConfig} from '../src/config.mjs';
import {scheduleAction} from '../src/scheduler.mjs';
import {overnightEpisodeData,episodeTurns} from '../src/broadcast.mjs';
import {publicInteractionMainline} from '../src/storylines.mjs';
import {applyDashboardPatch} from '../src/dashboard.mjs';

const time=value=>new Date(value+'+08:00'),OWNER='MS4wLjABAAAA_NIGHT_OWNER',ID='7400000000000000001';
function config(){const cfg=defaultConfig();cfg.account.secUid=OWNER;cfg.service.enabled=true;cfg.service.overnight.enabled=true;cfg.service.prepHour=7;cfg.service.prepMinute=30;cfg.video.enabled=true;cfg.video.hour=8;cfg.video.minute=0;return cfg;}
function fixture(){
 const cfg=config(),calls=[];let saved={version:1},episode=null;const desired={worker:false,dashboard:false,maintenanceUntil:0};
 const deps={readState:()=>structuredClone(saved),saveState:s=>{saved=structuredClone(s);},desired:()=>desired,
  start:async({resume})=>{calls.push(['start',resume]);if(resume){desired.worker=true;desired.dashboard=true;}return {ok:true,worker:desired.worker,storage:{ready:true}};},
  maintain:async(_cfg,status)=>{status.worker=desired.worker;calls.push(['maintain']);},
  readEpisode:async day=>{calls.push(['read',day]);return episode?.day===day?episode:null;},
  pauseWorker:async()=>{desired.worker=false;calls.push(['pause']);},stopServices:async()=>{desired.worker=false;desired.dashboard=false;calls.push(['stop']);},
  runTask:async(args,kind)=>{calls.push([kind,args]);episode={day:'2026-11-05',account:cfg.account,status:kind==='build'?'rendered':'submitted',fingerprint:'fixture'};},
  approved:async()=>true,review:async()=>{calls.push(['review']);episode={...episode,status:'published',platformVideoId:ID,publishedAt:'2026-11-05T08:00:10+08:00',review:{status:'published'}};},
  alert:(...args)=>calls.push(['alert',...args]),resolve:()=>calls.push(['resolve'])};
 const service=new NightService('/fixture',deps),tick=clock=>service.tick(cfg,{now:time(clock)});
 return {cfg,calls,deps,desired,service,tick,state:()=>saved,setEpisode:x=>{episode=x;},episode:()=>episode};
}
test('北京时间20点至次日8点共用晨间日期，午夜不创建第二个运行窗口',()=>{
 const cfg=config();assert.equal(nightWindow(cfg,time('2026-11-04T19:59:59')).browsing,false);
 for(const clock of ['2026-11-04T20:00:00','2026-11-04T23:59:59','2026-11-05T00:00:00','2026-11-05T07:59:59']){const w=nightWindow(cfg,time(clock));assert.equal(w.day,'2026-11-05');assert.equal(w.browsing,true);assert.equal(w.publishAt,'2026-11-05T00:00:00.000Z');}
 assert.equal(nightWindow(cfg,time('2026-11-05T08:00:00')).browsing,false);assert.equal(nightWindow(cfg,time('2026-11-05T20:00:00')).day,'2026-11-06');
 assert.equal(nightWindow(cfg,time('2026-12-31T20:00:00')).day,'2027-01-01');
});
test('20点前不启动也不读业务库，20点启动一次，跨午夜继续刷取',async()=>{
 const h=fixture();assert.equal((await h.tick('2026-11-04T19:59:59')).phase,'idle');assert.deepEqual(h.calls,[]);
 for(const clock of ['2026-11-04T20:00:00','2026-11-04T20:01:00','2026-11-05T00:01:00'])await h.tick(clock);
 assert.deepEqual(h.calls.filter(c=>c[0]==='start'),[['start',true]]);assert.equal(h.state().day,'2026-11-05');assert.equal(h.desired.worker,true);
});
test('关闭夜间计划或守护后不执行定时动作',async()=>{
 for(const field of ['service','overnight']){const h=fixture();if(field==='service')h.cfg.service.enabled=false;else h.cfg.service.overnight.enabled=false;assert.equal((await h.tick('2026-11-04T20:00:00')).phase,'disabled');assert.deepEqual(h.calls,[]);}
});
test('7点30准备一次，8点暂停刷取再发布，已提交仍须复核发布后停服务',async()=>{
 const h=fixture();await h.tick('2026-11-04T20:00:00');await h.tick('2026-11-05T07:29:59');assert.equal(h.calls.some(c=>c[0]==='build'),false);
 await h.tick('2026-11-05T07:30:00');await h.tick('2026-11-05T07:31:00');assert.equal(h.calls.filter(c=>c[0]==='build').length,1);assert.equal(h.calls.some(c=>c[0]==='publish'),false);
 await h.tick('2026-11-05T08:00:00');assert.equal(h.desired.worker,false);assert.equal(h.desired.dashboard,true);assert.deepEqual(h.calls.find(c=>c[0]==='publish'),['publish',['--live','--ready-only']]);assert.ok(h.calls.findIndex(c=>c[0]==='pause')<h.calls.findIndex(c=>c[0]==='publish'));assert.equal(h.calls.some(c=>c[0]==='stop'),false);
 await h.tick('2026-11-05T08:00:30');assert.equal(h.state().phase,'stopped');assert.equal(h.state().published.videoId,ID);assert.equal(h.desired.dashboard,false);await h.tick('2026-11-05T09:00:00');assert.equal(h.calls.filter(c=>c[0]==='stop').length,1);
 await h.tick('2026-11-05T20:00:00');assert.equal(h.calls.filter(c=>c[0]==='start').length,2);assert.equal(h.state().day,'2026-11-06');
});
test('人工暂停后不恢复刷取或自动发布，当前窗口仍允许保留管理入口',async()=>{
 const h=fixture();await h.tick('2026-11-04T20:00:00');h.desired.worker=false;await h.tick('2026-11-05T07:30:00');await h.tick('2026-11-05T08:00:00');assert.equal(h.state().phase,'paused');assert.equal(h.calls.filter(c=>c[0]==='start').length,1);assert.equal(h.calls.some(c=>['build','publish','stop'].includes(c[0])),false);
});
test('启动途中新的人工暂停或维护仍优先，后续不继续生成',async()=>{
 const h=fixture();h.deps.start=async()=>{h.desired.worker=false;return {ok:true,worker:false,paused:true};};await h.tick('2026-11-04T20:00:00');assert.equal(h.state().phase,'paused');assert.equal(h.calls.some(c=>c[0]==='build'),false);
 const other=fixture();await other.tick('2026-11-04T20:00:00');other.desired.maintenanceUntil=time('2026-11-05T09:00:00').getTime();assert.equal((await other.tick('2026-11-05T08:00:00')).phase,'paused');assert.equal(other.calls.some(c=>c[0]==='pause'),false);
});
test('发布中与结果不明只读复核，不重新提交，也不提前关闭现场',async()=>{
 for(const status of ['publishing','uncertain']){
  const h=fixture();await h.tick('2026-11-04T20:00:00');h.setEpisode({day:'2026-11-05',status,account:h.cfg.account});h.deps.review=async()=>h.calls.push(['review']);await h.tick('2026-11-05T08:00:00');await h.tick('2026-11-05T08:00:30');assert.equal(h.calls.filter(c=>c[0]==='review').length,1);assert.equal(h.calls.some(c=>['publish','build','stop'].includes(c[0])),false);assert.equal(h.state().phase,'waiting_publication');
 }
});
test('上传或已准备但未提交的稿件保留，不重传或把失败记成成功',async()=>{
 for(const status of ['uploading','prepared']){const h=fixture();await h.tick('2026-11-04T20:00:00');h.setEpisode({day:'2026-11-05',status,account:h.cfg.account});await h.tick('2026-11-05T08:00:00');assert.equal(h.state().phase,'waiting_user');assert.equal(h.calls.some(c=>['publish','build','stop'].includes(c[0])),false);}
});
test('标为已发布但缺少证据时只读补核，不停机也不重新制作',async()=>{
 const h=fixture();await h.tick('2026-11-04T20:00:00');h.setEpisode({day:'2026-11-05',status:'published',account:h.cfg.account});h.deps.review=async()=>h.calls.push(['review']);await h.tick('2026-11-05T08:00:00');assert.equal(h.state().phase,'waiting_publication');assert.equal(h.calls.some(c=>['publish','build','stop'].includes(c[0])),false);assert.equal(h.calls.filter(c=>c[0]==='review').length,1);
});
test('错误日期的作品记录不能用作当前晨间发布依据',async()=>{
 const h=fixture();await h.tick('2026-11-04T20:00:00');h.deps.readEpisode=async()=>({day:'2026-11-04',status:'published',account:h.cfg.account,platformVideoId:ID,publishedAt:'2026-11-04T08:00:00+08:00'});await assert.rejects(h.tick('2026-11-05T08:00:00'),/日期/);assert.equal(h.calls.some(c=>['publish','build','stop'].includes(c[0])),false);
});
test('审核未批准不发布，失败重试有上限，超过补发窗口不再生成',async()=>{
 const h=fixture();await h.tick('2026-11-04T20:00:00');h.setEpisode({day:'2026-11-05',status:'rendered',account:h.cfg.account});h.cfg.review.videos='review';h.deps.approved=async()=>false;await h.tick('2026-11-05T08:00:00');assert.equal(h.state().phase,'waiting_review');assert.equal(h.calls.some(c=>c[0]==='publish'),false);
 const retry=fixture();await retry.tick('2026-11-04T20:00:00');retry.setEpisode({day:'2026-11-05',status:'rendered',account:retry.cfg.account});let tries=0;retry.deps.runTask=async()=>{tries++;throw new Error('fixture before-send failure');};for(const clock of ['08:00:00','08:01:00','08:05:00','08:10:00','08:15:00'])await retry.tick('2026-11-05T'+clock);assert.equal(tries,3);await retry.tick('2026-11-05T09:30:01');assert.equal(retry.state().phase,'missed');assert.equal(tries,3);
});
test('其他账号或缺失发布证据不能触发停机，停机失败也不记已停止',async()=>{
 const h=fixture();await h.tick('2026-11-04T20:00:00');h.setEpisode({day:'2026-11-05',status:'published',account:{secUid:'other'}});await assert.rejects(h.tick('2026-11-05T08:00:00'),/绑定账号/);assert.equal(h.calls.some(c=>c[0]==='stop'),false);
 const other=fixture();await other.tick('2026-11-04T20:00:00');other.setEpisode({day:'2026-11-05',status:'published',account:other.cfg.account,platformVideoId:ID,publishedAt:'2026-11-05T08:00:00+08:00'});let stops=0;other.deps.stopServices=async()=>{if(++stops===1)throw new Error('still stopping');};await assert.rejects(other.tick('2026-11-05T08:00:00'),/still stopping/);assert.equal(other.state().stoppedAt,undefined);await other.tick('2026-11-05T08:01:00');assert.ok(other.state().stoppedAt);assert.equal(stops,2);
});
test('夜间模式禁用旧发布调度，配置校验跨日边界并允许后台显示08点',()=>{
 const cfg=config();validateConfig(cfg);assert.equal(scheduleAction(cfg,{status:'rendered',day:'2026-11-05'},{now:time('2026-11-05T08:00:00')}),null);assert.equal(applyDashboardPatch(cfg,{video:{hour:8}}).video.hour,8);
 for(const change of [{startHour:7},{startHour:24},{enabled:'true'}]){const bad=config();Object.assign(bad.service.overnight,change);assert.throws(()=>validateConfig(bad));}
 const old=defaultConfig();delete old.service.overnight;assert.equal(validateConfig(old).service.overnight.enabled,false);
});
test('晨间素材包含前夜20点后记录，排除窗口外、未知时间、未确认互动及私有字段',()=>{
 const cfg=config(),watched=(id,watchedAt)=>({id,watchedAt,desc:'公开视频',privateToken:'PRIVATE_TOKEN',analysis:{summary:'公开视频',evidence:'画面'}}),journal={videos:(day,p)=>p==='deepseek'?[]:day==='2026-11-04'?[watched(ID,'2026-11-04T19:59:59+08:00'),watched('7400000000000000002','2026-11-04T20:00:00+08:00'),watched('7400000000000000003','2026-11-04T23:30:00+08:00')]:[watched('7400000000000000003','2026-11-05T01:00:00+08:00'),watched('7400000000000000004','2026-11-05T07:59:59+08:00'),watched('7400000000000000005','2026-11-05T08:00:00+08:00'),watched('7400000000000000006','unknown')]};
 const ledger={data:{outbox:[{text:'PRIVATE_MESSAGE'}],actions:[{status:'sent',kind:'comment',provider:'openai',sentAt:'2026-11-04T23:00:00+08:00',text:'PRIVATE_BODY'},{status:'accepted',kind:'reply',sentAt:'2026-11-05T01:00:00+08:00'},{status:'sent',kind:'reply',sentAt:'2026-11-04T19:00:00+08:00'}]}};
 const data=overnightEpisodeData(journal,ledger,'2026-11-05',cfg,time('2026-11-05T08:10:00'));assert.equal(data.totalVideos,3);assert.equal(data.providers.openai.comments,1);assert.equal(data.providers.openai.replies,0);assert.doesNotMatch(JSON.stringify(data),/PRIVATE_|outbox/);assert.equal(data.window.startAt,'2026-11-04T12:00:00.000Z');assert.equal(data.window.endAt,'2026-11-05T00:00:00.000Z');
 const turns=episodeTurns(data,{openai:{recap:'公开回顾',highlight:''},deepseek:{recap:'公开回顾',highlight:''}});assert.match(turns[0].text,/早上好/);assert.match(turns.at(-1).text,/明早/);
});
test('前夜已确认公开互动可进入晨间主线，但窗口外的互动不能冒充当夜',()=>{
 const cfg=config(),data=overnightEpisodeData({videos:()=>[]},{data:{actions:[]}},'2026-11-05',cfg,time('2026-11-05T07:30:00'));
 const action={status:'sent',videoId:ID,receipt:{id:'7400000000000000002'},kind:'reply',text:'这条公开评论很有意思',day:'2026-11-04',sentAt:'2026-11-04T23:00:00+08:00'};assert.ok(publicInteractionMainline(data,{data:{actions:[action]}}));assert.equal(publicInteractionMainline(data,{data:{actions:[{...action,sentAt:'2026-11-04T19:59:59+08:00'}]}}),null);
});
