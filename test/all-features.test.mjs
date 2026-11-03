import {dashboardAccess} from './helpers/dashboard-access.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {defaultConfig,validateConfig} from '../src/config.mjs';import {Store,atomicJson} from '../src/store.mjs';import {applyDashboardPatch,createDashboard,dashboardState} from '../src/dashboard.mjs';import {VideoUnderstanding} from '../src/understanding.mjs';import {Health} from '../src/health.mjs';import {classifyReview,safeVideoId,nativePublishedAt,cachedPublicCheck} from '../src/publication-review.mjs';import {chooseShowTopic,makeShow} from '../src/show.mjs';
function temp(t){const home=mkdtempSync(join(tmpdir(),'dy-features-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const cfg=defaultConfig();new Store(home);atomicJson(join(home,'config.json'),cfg);return {home,cfg};}
test('控制台补丁保留未改的嵌套设置，拒绝凭证、联系人及未知设置',()=>{
 const c=defaultConfig();c.deepseek.engagement.commentCooldownMinutes=47;c.deepseek.browse.everyMinutes=37;c.reply.routing.enabled=true;c.video.voiceProfiles={openai:'D',deepseek:'B'};
 const next=applyDashboardPatch(c,{deepseek:{engagement:{commentsPerDay:4}},video:{voiceProfiles:{openai:'A'}},reply:{routing:{deepseekKeyword:'鲸鱼'}}});
 assert.equal(next.deepseek.engagement.commentCooldownMinutes,47);assert.equal(next.deepseek.browse.everyMinutes,37);assert.equal(next.video.voiceProfiles.deepseek,'B');assert.equal(next.reply.routing.enabled,true);assert.equal(c.video.voiceProfiles.openai,'D');
 for(const p of [{account:{secUid:'other'}},{reply:{contacts:[]}},{video:{python:'anything'}},{reply:{routing:true}},{deepseek:{browse:[]}}, {video:{show:{secret:'x'}}}])assert.throws(()=>applyDashboardPatch(c,p));
});
test('控制台只在本机工作，API 免登录且拒绝跨站来源；响应不包含配置中的未知秘密',async t=>{
 const h=temp(t);h.cfg.deepseek.apiKey='FAKE_SENSITIVE';atomicJson(join(h.home,'config.json'),h.cfg);atomicJson(join(h.home,'dashboard-job.json'),{status:'done',log:['','Users','test','private','file.mp4'].join('/')});
 const app=createDashboard(h.home,{port:0}),address=await app.listen();t.after(()=>new Promise(r=>app.server.close(r)));const base=`http://127.0.0.1:${address.port}`;
 assert.equal((await fetch(base+'/api/state')).status,200);const cookie=await dashboardAccess(base,h.home);
 const response=await fetch(base+'/api/state',{headers:{cookie}}),data=await response.json();assert.equal(response.status,200);const saved=await fetch(base+'/api/config',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({memory:{enabled:true}})});assert.equal(saved.status,200);assert.equal(JSON.parse(readFileSync(join(h.home,'config.json'),'utf8')).memory.enabled,true);assert.ok(!JSON.stringify(data).includes('FAKE_SENSITIVE'));assert.ok(!JSON.stringify(data).includes(['','Users','test'].join('/')));
 assert.equal((await fetch(base+'/api/config',{method:'POST',headers:{cookie,origin:'https://example.com','content-type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(base+'/api/media?kind=voice&id=../../.env',{headers:{cookie}})).status,400);
});
test('没有音轨时如实保存 visual_only，不捏造转写、不消耗音频接口',async t=>{
 const h=temp(t);h.cfg.understanding.enabled=true;h.cfg.understanding.ocr=false;let calls=0;
 const u=new VideoUnderstanding(h.home,h.cfg,{fetchImpl:async()=>{calls++;throw new Error();}}),frames=[];frames.audioCapture={error:'网页没有音轨',start:0,seconds:8};
 const result=await u.process({id:'7400000000000000001'},frames,{});assert.equal(result.status,'visual_only');assert.equal(result.transcript,'');assert.equal(calls,0);
});
test('音频转写使用独立 Audio endpoint，只提交音轨及提示；HTTP 错误不泄露凭证',async t=>{
 const h=temp(t),file=join(h.home,'clip.webm');writeFileSync(file,'fake-audio');let request;
 const u=new VideoUnderstanding(h.home,h.cfg,{fetchImpl:async(url,options)=>{request={url:String(url),options};return new Response(JSON.stringify({text:'你好呀',languages:[{code:'zh'}]}));}});
 const result=await u.transcribe(file);assert.equal(result.text,'你好呀');assert.match(request.url,/\/audio\/transcriptions$/);assert.equal(request.options.body.get('model'),'gpt-transcribe');assert.ok(request.options.body.get('file') instanceof Blob);
 u.fetch=async()=>new Response('SECRET',{status:401});await assert.rejects(u.transcribe(file),e=>e.message.includes('401')&&!e.message.includes('SECRET'));
});
test('相同异常只保留一条活跃告警，解除后才产生新的告警',t=>{
 const h=temp(t),health=new Health(h.home);health.alert('login','登录失效','请扫码');health.alert('login','登录失效','请扫码');assert.equal(health.read().alerts.length,1);assert.equal(health.read().alerts[0].occurrences,2);health.resolve('login');health.alert('login','登录失效','请扫码');assert.equal(health.read().alerts.length,2);
});
test('发布状态不把审核中或定时待发误当成已公开，视频ID必须无损',()=>{
 assert.equal(classifyReview('审核中'),'reviewing');assert.equal(classifyReview('定时发布中'),'scheduled');assert.equal(classifyReview('审核未通过'),'rejected');assert.equal(classifyReview('仅自己可见'),'private');assert.equal(classifyReview('普通作品行'),'submitted');assert.equal(classifyReview('已发布'),'published');assert.equal(safeVideoId(7702040751399652649),'');
});
test('实际发布时间来自作品卡片；游客登录要求缓存六小时且不能复用到其他作品',()=>{
 assert.equal(nativePublishedAt('2026年10月29日 21:18\n已发布'),'2026-10-29T21:18:00+08:00');assert.equal(nativePublishedAt('尚未发布'),'');
 const id='7702078521279040831',now=Date.parse('2026-10-29T14:00:00Z'),review={videoId:id,checkedAt:new Date(now).toISOString(),publicCheck:{visible:null,reason:'需要登录'}};
 assert.equal(cachedPublicCheck(review,id,now+5*3600000).visible,null);assert.equal(cachedPublicCheck(review,id,now+6*3600000),null);assert.equal(cachedPublicCheck(review,'7702078521279040832',now),null);
 const pinned={...review,checkedAt:new Date(now+3600000).toISOString(),publicCheck:{...review.publicCheck,checkedAt:new Date(now).toISOString()}};assert.equal(cachedPublicCheck(pinned,id,now+6*3600000),null);
});
test('双人节目围绕真实主题接话，拒绝不存在的事实源，包含来源声明',async()=>{
 const v={id:'7400000000000000001',desc:'手工钩织',analysis:{summary:'蜜蜂和兔子床铃',confidence:.9}},data={totalVideos:1,providers:{openai:{videos:[v],videoCount:1,comments:0,replies:0},deepseek:{videos:[],videoCount:0,comments:0,replies:0}}};
 assert.equal(chooseShowTopic(data).id,v.id);const calls=[];const models=Object.fromEntries(['openai','deepseek'].map(p=>[p,{request:async(_n,_s,_i,payload)=>{calls.push({p,payload});return {say:p==='openai'?'画面里有钩织小蜜蜂。':'如果加一朵小云也很可爱。',question:''};}}]));
 const show=await makeShow(data,models);assert.equal(show.turns.length,8);assert.deepEqual(calls.map(c=>c.p),['openai','deepseek','openai','deepseek']);assert.equal(calls[1].payload.conversation[0].provider,'openai');assert.match(show.turns.at(-1).text,/AI 角色/);
});
