import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConfig,dayKey} from '../src/config.mjs';
import {atomicJson,Store} from '../src/store.mjs';
import {ChannelRecovery} from '../src/recovery.mjs';
import {Health} from '../src/health.mjs';
import {Browser,Cdp} from '../src/browser.mjs';
import {Douyin,StopRequired} from '../src/douyin.mjs';
import {Engine} from '../src/engine.mjs';
import {Interests} from '../src/interests.mjs';
import {DEFAULT_INTEREST_PROFILES} from '../src/interest-profiles.mjs';
import {createDashboard} from '../src/dashboard.mjs';
import {dashboardAccess} from './helpers/dashboard-access.mjs';

function setup(t){const home=mkdtempSync(join(tmpdir(),'dy-feed-recovery-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const cfg=defaultConfig();cfg.account={secUid:'bound-fixture',douyinId:'fixture'};cfg.reply.enabled=false;cfg.memory.enabled=false;cfg.monitor.enabled=false;cfg.monitor.notify=false;cfg.understanding.enabled=false;cfg.videoAnalysis.enabled=false;cfg.journal.enabled=false;cfg.deepseek.enabled=true;cfg.browse.videosPerRound=1;cfg.deepseek.browse.videosPerRound=1;cfg.discovery={...cfg.discovery,enabled:true,profiles:structuredClone(DEFAULT_INTEREST_PROFILES)};atomicJson(join(home,'config.json'),cfg);return {home,cfg,channels:new ChannelRecovery(home)};}
const verification=(kind='discovery')=>Object.assign(new StopRequired('fixture verification','PAGE_VERIFICATION'),{pageKind:kind,pageUrl:kind==='discovery'?'https://www.douyin.com/search/fixture?type=video':undefined});
const video=n=>({id:String(7700000000000000000n+BigInt(n)),desc:n===1?'科技科普':'烤鱼',url:'https://www.douyin.com/video/'+String(7700000000000000000n+BigInt(n))});
function pausedSearch(h){h.channels.fail('discovery-search',verification());return h.channels.list()[0];}
function browserFixture({targets,states,accountCheck}={}){const operations=[];let reads=0;const page={ev:async()=>{reads++;return typeof states==='function'?states(reads):{url:'https://www.douyin.com/search/fixture',ready:true,hasContent:true,searchReady:true,challenge:false};}};const browser={runtime:{tabs:{discovery:'closed-tab'}},start:async()=>operations.push('start'),disconnect:()=>operations.push('disconnect'),cdp:{send:async method=>{operations.push(method);return {targetInfos:targets||[{targetId:'replacement',type:'page',url:'https://www.douyin.com/search/fixture',title:'搜索结果'}]};}},attachExistingPage:async(kind,id)=>{operations.push('attach:'+id);browser.runtime.tabs[kind]=id;return page;}};return {browser,operations,dy:{checkAccount:accountCheck||(async()=>operations.push('account'))}};}

test('旧搜索验证迁移为独立搜索，保留原时间及验证状态，不解除真正的推荐流暂停',t=>{
 const h=setup(t),at='2026-10-31T04:57:56.816Z';atomicJson(join(h.home,'channel-health.json'),{version:1,channels:{'browse:openai':{key:'browse:openai',code:'PAGE_VERIFICATION',requiresUser:true,pageKind:'discovery',updatedAt:at,attempts:1},'browse:deepseek':{key:'browse:deepseek',code:'PAGE_VERIFICATION',requiresUser:true,pageKind:'feed',updatedAt:at,attempts:1}}});
 const config=readFileSync(join(h.home,'config.json'),'utf8');assert.deepEqual(h.channels.isolateSearch(),['browse:openai']);assert.equal(h.channels.blocked('browse:openai'),false);assert.equal(h.channels.blocked('browse:deepseek'),true);assert.equal(h.channels.blocked('discovery-search'),true);assert.equal(h.channels.list().find(c=>c.key==='discovery-search').firstBlockedAt,at);assert.deepEqual(h.channels.isolateSearch(),[]);assert.equal(readFileSync(join(h.home,'config.json'),'utf8'),config);
});
test('搜索已暂停时两位仍取推荐流、理解视频并保留自动评论调用，跨角色去重',async t=>{
 const h=setup(t);pausedSearch(h);h.cfg.engagement.enabled=true;h.cfg.deepseek.engagement.enabled=true;
 const store=new Store(h.home),calls={search:0,feed:0,analysis:[],comments:[]},perception={status:'ready',codex:{summary:'fixture full-video analysis',evidence:'fixture captured frames',timeline:[],limitations:['抽样画面']},coverage:{durationSeconds:12,transcriptionComplete:false}};
 const models=Object.fromEntries(['openai','deepseek'].map(provider=>[provider,{config:{model:provider},request:async(_k,_s,_i,payload)=>{assert.equal(payload.perception.codex.summary,perception.codex.summary);assert.ok(payload.perception.codex.limitations.includes('抽样画面'));return {summary:'fixture',evidence:'fixture frames',recommend:true,confidence:.9,interest:{score:1,topics:[],reason:'fixture evidence'}};}}]));
 const dy={checkAccount:async()=>h.cfg.account,feed:async()=>{calls.feed++;return [video(1),video(2)];},search:async()=>{calls.search++;throw verification();}};
 const engagement={onVideo:async(v,analysis,_s,provider)=>{assert.deepEqual(analysis.perception,perception);calls.comments.push({id:v.id,provider});return {status:'sent'};}};
 const engine=new Engine({...h,store,models,gpt:models.openai,dy,engagement,messenger:{},live:true,log:()=>{}});engine.videoAnalysis={deferredIds:()=>[],analyze:async v=>{calls.analysis.push(v.id);return perception;}};
 await engine.browseRound(undefined,'openai');await engine.browseRound(undefined,'deepseek');assert.equal(calls.search,0);assert.equal(calls.feed,2);assert.equal(store.videoCount(dayKey(),'openai'),1);assert.equal(store.videoCount(dayKey(),'deepseek'),1);assert.deepEqual(calls.analysis,[video(1).id,video(2).id]);assert.deepEqual(calls.comments.map(c=>c.provider),['openai','deepseek']);assert.equal(h.channels.blocked('discovery-search'),true);
});
test('兴趣只排序推荐流真实候选，不丢弃未命中视频，两个角色排序独立',t=>{
 const h=setup(t),interests=new Interests(h.home,h.cfg),videos=[video(2),video(1),{...video(3),desc:'其他主题'}];assert.equal(interests.rankCandidates(videos,'openai')[0].id,video(1).id);assert.equal(interests.rankCandidates(videos,'deepseek')[0].id,video(2).id);assert.equal(interests.rankCandidates(videos,'deepseek').length,3);assert.deepEqual(videos.map(v=>v.id),[video(2).id,video(1).id,video(3).id]);h.cfg.discovery.enabled=false;assert.deepEqual(interests.rankCandidates(videos),videos);
});
test('原验证标签关闭后能重新连接正确的新标签，核对账号与正常结果后才恢复',async t=>{
 const h=setup(t);pausedSearch(h);const f=browserFixture();assert.equal((await h.channels.check('discovery-search',h.cfg,f)).ready,true);assert.equal(h.channels.blocked('discovery-search'),false);assert.ok(f.operations.includes('attach:replacement'));assert.ok(f.operations.includes('account'));assert.ok(!f.operations.some(s=>/activateTarget|bringToFront|createTarget/.test(s)));
});
test('没有对应页面或存在多个候选时保持暂停、记录明确原因，不打开新窗口',async t=>{
 const h=setup(t);pausedSearch(h);
 for(const targets of [[],[{targetId:'foreign',type:'page',url:'https://example.com/search/fixture'}],[1,2].map(n=>({targetId:String(n),type:'page',url:'https://www.douyin.com/search/fixture'}))]){const f=browserFixture({targets});assert.equal((await h.channels.check('discovery-search',h.cfg,f)).ready,false);assert.equal(h.channels.blocked('discovery-search'),true);assert.ok(!f.operations.some(s=>s.startsWith('attach:')||s==='account'));}
 assert.equal(h.channels.list()[0].lastCheck.state,'page_missing');
});
test('加载中、无结果证据、验证码或核对途中变页均不能解除搜索暂停',async t=>{
 const base={url:'https://www.douyin.com/search/fixture',ready:true,hasContent:true,searchReady:true,challenge:false};
 for(const patch of [{ready:false},{searchReady:false},{hasContent:false},{challenge:true},{url:'https://www.douyin.com/search/another'}]){const h=setup(t);pausedSearch(h);const f=browserFixture({states:()=>({...base,...patch})});assert.equal((await h.channels.check('discovery-search',h.cfg,f)).ready,false);assert.equal(h.channels.blocked('discovery-search'),true);}
 const h=setup(t);pausedSearch(h);const f=browserFixture({states:n=>({...base,challenge:n>1})});assert.equal((await h.channels.check('discovery-search',h.cfg,f)).ready,false);assert.equal(h.channels.blocked('discovery-search'),true);
});
test('错误账号和核对过程中出现的新阻塞保留原保护，不被旧检查清除',async t=>{
 const h=setup(t);pausedSearch(h);const f=browserFixture({accountCheck:async()=>{throw new StopRequired('wrong account','ACCOUNT_MISMATCH');}});await assert.rejects(h.channels.check('discovery-search',h.cfg,f),e=>e.code==='ACCOUNT_MISMATCH');assert.equal(h.channels.blocked('discovery-search'),true);
 const original=h.channels.list()[0].revision,changed=browserFixture({accountCheck:async()=>h.channels.fail('discovery-search',verification())});assert.equal((await h.channels.check('discovery-search',h.cfg,changed)).ready,false);assert.notEqual(h.channels.list()[0].revision,original);assert.equal(h.channels.blocked('discovery-search'),true);
});
test('长期暂停告警不被普通历史挤掉，丢失时可重建，恢复后才解除',t=>{
 const h=setup(t);pausedSearch(h);const d=JSON.parse(readFileSync(join(h.home,'channel-health.json'),'utf8'));d.channels['discovery-search'].firstBlockedAt=new Date(Date.now()-2*86400000).toISOString();atomicJson(join(h.home,'channel-health.json'),d);h.channels.refreshAlerts();const health=new Health(h.home),key='channel:discovery-search';assert.equal(health.read().alerts.find(a=>a.key===key).severity,'error');
 for(let n=0;n<105;n++)health.alert('history:'+n,'fixture history','resolved shortly');assert.ok(health.read().alerts.find(a=>a.key===key&&!a.resolvedAt));assert.ok(health.read().alerts.length<=100);
 atomicJson(join(h.home,'health.json'),{version:1,alerts:[]});h.channels.refreshAlerts();assert.ok(health.read().alerts.find(a=>a.key===key&&!a.resolvedAt));h.channels.clear('discovery-search');assert.ok(health.read().alerts.find(a=>a.key===key).resolvedAt);
});
test('附着已有标签只连接现存目标并保留其他映射，不激活或新开页面',async t=>{
 const h=setup(t),file=join(h.home,'browser-runtime.json'),runtime={port:1234,profile:join(h.home,'browser'),wsUrl:'ws://127.0.0.1/fixture',tabs:{chat:'existing-chat',discovery:'closed'}};atomicJson(file,runtime);const oldFetch=globalThis.fetch,oldConnect=Cdp.connect,calls=[];t.after(()=>{globalThis.fetch=oldFetch;Cdp.connect=oldConnect;});
 globalThis.fetch=async()=>({json:async()=>[{id:'new',type:'page',url:'https://www.douyin.com/search/fixture',webSocketDebuggerUrl:'ws://127.0.0.1/page'}]});Cdp.connect=async()=>({send:async method=>calls.push(method),close(){}});
 const b=new Browser(h.home,{headless:false,background:true});b.runtime=runtime;b.cdp={ws:{readyState:1}};await b.attachExistingPage('discovery','new');assert.equal(JSON.parse(readFileSync(file)).tabs.chat,'existing-chat');assert.equal(JSON.parse(readFileSync(file)).tabs.discovery,'new');assert.ok(!calls.some(s=>/createTarget|activateTarget|bringToFront/.test(s)));await assert.rejects(b.attachExistingPage('discovery','missing'),/关闭/);
});
test('推荐接口明确要求验证时不切换其他读取方式，保持验证边界',async t=>{
 const h=setup(t),dy=new Douyin(h.home,{});let fallback=0;dy.fetchInPage=async()=>{throw verification('feed');};dy.feedFromPage=async()=>{fallback++;return [video(1)];};await assert.rejects(dy.feed(),e=>e.code==='PAGE_VERIFICATION');assert.equal(fallback,0);
});
test('独立搜索验证会在管理API中直接阻止重试，不改动后台运行目标',async t=>{
 const h=setup(t);pausedSearch(h);const desired={version:1,worker:false,dashboard:true,maintenanceUntil:0};atomicJson(join(h.home,'service-desired.json'),desired);const app=createDashboard(h.home,{port:0}),addr=await app.listen();t.after(()=>new Promise(resolve=>app.server.close(resolve)));const base='http://127.0.0.1:'+addr.port,cookie=await dashboardAccess(base,h.home),r=await fetch(base+'/api/discovery/search',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({query:'fixture'})});assert.equal(r.status,409);assert.equal((await r.json()).code,'PAGE_VERIFICATION');assert.deepEqual(JSON.parse(readFileSync(join(h.home,'service-desired.json'))),desired);
});
