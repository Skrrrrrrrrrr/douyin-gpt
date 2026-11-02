import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {defaultConfig} from '../src/config.mjs';
import {atomicJson,Store} from '../src/store.mjs';
import {recoveryReason,exitRecord,probeSession,shouldProbeSession,clearSessionStop,ReplyProgress,recoverySummary,ChannelRecovery} from '../src/recovery.mjs';
import {Douyin,StopRequired} from '../src/douyin.mjs';
import {LoginRecovery,loginDomInPage} from '../src/login-recovery.mjs';
import {Health} from '../src/health.mjs';
import {Engine} from '../src/engine.mjs';
import {createDashboard} from '../src/dashboard.mjs';
import {loginDashboard} from './helpers/dashboard-login.mjs';
import {bootstrapWithRetry} from '../src/service-control.mjs';
import {Takeover} from '../src/takeover.mjs';
import {unanswered} from '../src/engine.mjs';
import {Messenger} from '../src/messenger.mjs';

function fixture(t){const home=mkdtempSync(join(tmpdir(),'dy-recovery-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const cfg=defaultConfig();cfg.account={secUid:'bound-fixture',douyinId:'fixture'};cfg.reply.contacts=[{secUid:'peer-fixture',label:'测试联系人',enabled:true}];cfg.memory.enabled=false;cfg.monitor.enabled=false;cfg.reply.media.enabled=false;cfg.reply.takeover.enabled=false;cfg.understanding.enabled=false;atomicJson(join(home,'config.json'),cfg);return {home,cfg};}
test('恢复原因可识别旧登录退出记录，网络与配置分别处理',()=>{
 assert.equal(recoveryReason({message:'抖音接口状态 8，请检查登录或页面验证'}).code,'AUTH_REQUIRED');
 assert.equal(recoveryReason({note:'登录、账号或平台验证需要本人处理'}).canProbe,true);
 assert.equal(recoveryReason({message:'专用后台窗口已关闭，请由本人重新打开'}).code,'BROWSER_CLOSED');
 assert.equal(exitRecord(new Error('temporary internal failure')).userActionRequired,false);
 assert.equal(exitRecord(new Error('未设置 API 配置')).code,'CONFIG_REQUIRED');
 assert.equal(recoveryReason({code:'BUDGET_UNKNOWN'}).canProbe,false);
});
test('只在运行目标开启、无维护且满一分钟后检查登录，人工暂停永不恢复',()=>{
 const exit=exitRecord(new StopRequired('登录失效','AUTH_REQUIRED')),desired={worker:true,maintenanceUntil:0};
 assert.equal(shouldProbeSession(exit,100000,0,desired),true);
 assert.equal(shouldProbeSession(exit,100000,50000,desired),false);
 assert.equal(shouldProbeSession(exit,100000,0,{...desired,worker:false}),false);
 assert.equal(shouldProbeSession(exit,100000,0,{...desired,corrupt:true}),false);
 assert.equal(shouldProbeSession(exit,100000,0,{...desired,maintenanceUntil:200000}),false);
 assert.equal(shouldProbeSession(exitRecord(new Error('配置错误')),100000,0,desired),false);
});
test('登录核对必须是原账号，检查后断开连接，不启动前台窗口',async t=>{
 const h=fixture(t);let disconnected=0,start=0;
 const browser={start:async()=>{start++;},disconnect:()=>{disconnected++;}};
 const dy=new Douyin(h.home,browser);dy.whoami=async()=>({...h.cfg.account});
 assert.equal((await probeSession(h.home,h.cfg,{browser,dy})).ready,true);
 dy.whoami=async()=>({secUid:'different-account',douyinId:'other'});
 const result=await probeSession(h.home,h.cfg,{browser,dy});assert.equal(result.ready,false);assert.equal(result.code,'ACCOUNT_MISMATCH');assert.equal(disconnected,2);assert.equal(start,2);
 assert.deepEqual(JSON.parse(readFileSync(join(h.home,'config.json'))).account,h.cfg.account);
});
test('浏览器关闭时只记录所需操作，不请求新窗口',async t=>{
 const h=fixture(t);let disconnect=0;const result=await probeSession(h.home,h.cfg,{browser:{start:async()=>{throw new Error('专用后台窗口已关闭，请由本人重新打开');},disconnect:()=>{disconnect++;}}});
 assert.equal(result.code,'BROWSER_CLOSED');assert.equal(disconnect,1);assert.equal(result.ready,false);
});
test('核对成功后只清除登录退出阻塞，保留人工暂停与其他告警',t=>{
 const h=fixture(t),desired={version:1,worker:false,dashboard:true,maintenanceUntil:0};atomicJson(join(h.home,'service-desired.json'),desired);atomicJson(join(h.home,'worker-exit.json'),exitRecord(new StopRequired('登录失效','AUTH_REQUIRED')));
 const health=new Health(h.home);health.alert('service-needs-user','等待登录','旧原因');health.alert('unrelated','保留','待核对发送');clearSessionStop(h.home);
 assert.equal(JSON.parse(readFileSync(join(h.home,'worker-exit.json'))).userActionRequired,false);assert.deepEqual(JSON.parse(readFileSync(join(h.home,'service-desired.json'))),desired);assert.ok(health.read().alerts.find(a=>a.key==='unrelated'&&!a.resolvedAt));assert.ok(health.read().alerts.find(a=>a.key==='service-needs-user').resolvedAt);
});
test('健康告警更新为最新原因，诊断文件损坏不会阻止业务',t=>{
 const h=fixture(t),health=new Health(h.home);health.alert('same','旧原因','old');health.alert('same','新原因','new');assert.equal(health.read().alerts[0].message,'new');assert.equal(health.read().alerts[0].occurrences,2);
 atomicJson(join(h.home,'health.json'),{version:2});assert.doesNotThrow(()=>health.heartbeat());
});
function fakeLogin(h){let verified=false;const operations=[],page={ev:async expression=>{const op=JSON.parse(expression.match(/\((\{"op".*\})\)$/)[1]).op;operations.push(op);return op==='inspect'?{formReady:true,clip:{x:0,y:0,width:600,height:400}}:{point:{x:10,y:10}};},send:async(method,params)=>{operations.push(method);if(method==='Page.captureScreenshot')return {data:Buffer.from('fixture-png').toString('base64')};if(method==='Input.dispatchMouseEvent'&&operations.at(-3)==='submit')verified=true;return {};}};
 const recovery=new LoginRecovery(h.home,{browserFactory:()=>({start:async()=>{},page:async()=>page,disconnect:()=>{}}),probe:async()=>({ready:verified,code:verified?'READY':'AUTH_REQUIRED'}),wait:async()=>{}});
 return {recovery,operations,page,setVerified:()=>{verified=true;}};
}
test('二维码临时保存于内存，过期后不可读取，刷新可重新获取',async t=>{
 const h=fixture(t),f=fakeLogin(h);assert.equal((await f.recovery.execute('prepare')).hasImage,true);assert.equal(f.recovery.screenshot().toString(),'fixture-png');assert.equal(readdirSync(h.home).some(n=>n.endsWith('.png')),false);
 f.recovery.expiresAt=Date.now()-1;assert.equal(f.recovery.screenshot(),null);assert.equal(f.recovery.view().hasImage,false);assert.equal((await f.recovery.execute('refresh')).hasImage,true);
});
test('获取短信只在明确操作时执行并有六十秒冷却，电话和验证码不落盘',async t=>{
 const h=fixture(t),f=fakeLogin(h),phone='13900000000',code='123456';await f.recovery.execute('prepare');assert.ok(!f.operations.includes('sms'));assert.equal((await f.recovery.execute('sms',{phone})).smsRequested,true);
 await assert.rejects(f.recovery.execute('sms',{phone}),e=>e.status===429);
 await f.recovery.execute('submit',{code});
 for(const file of readdirSync(h.home).filter(f=>f.endsWith('.json')))assert.doesNotMatch(readFileSync(join(h.home,file),'utf8'),new RegExp(phone+'|'+code));
});
test('登录错误不得回显输入手机号或验证码，已经验证时不再展示旧二维码',async t=>{
 const h=fixture(t),f=fakeLogin(h);f.page.send=async()=>{throw new Error('13900000000 123456');};await assert.rejects(f.recovery.execute('submit',{code:'123456'}),e=>e.status===503&&!/13900000000|123456/.test(e.message));f.setVerified();assert.equal((await f.recovery.execute('check')).ready,true);assert.equal(f.recovery.screenshot(),null);
});
test('短信提交从验证码表单寻找宽按钮，不会误点页面导航登录',()=>{
 const element=(tag,text='',x=0,width=100)=>({tag,textContent:text,placeholder:'',children:[],getBoundingClientRect:()=>({x,y:10,width,height:30}),contains(n){return n===this||this.children.some(c=>c.contains(n));},querySelectorAll(selector){const all=this.children.flatMap(c=>[c,...c.querySelectorAll('*')]);return selector==='input'?all.filter(c=>c.tag==='input'):all;}});
 const add=(p,...children)=>{p.children.push(...children);for(const c of children)c.parentElement=p;};
 const phone=element('input');phone.placeholder='请输入手机号';const code=element('input');code.placeholder='请输入验证码';const form=element('div','phone and code'),submit=element('button','登录',200,300),popup=element('div','扫码登录'),header=element('button','登录',20,180),body=element('body');add(form,phone,code);add(popup,form,submit);add(body,header,popup);const document={body,querySelectorAll:s=>body.querySelectorAll(s)},ctx={document,getComputedStyle:()=>({visibility:'visible'})};
 let result=runInNewContext(`(${loginDomInPage.toString()})({op:'submit'})`,ctx);assert.equal(result.point.x,350);
 popup.children=popup.children.filter(c=>c!==submit);result=runInNewContext(`(${loginDomInPage.toString()})({op:'submit'})`,ctx);assert.equal(result.point,null);
});
test('新消息在预算拦截前写入扫描状态，未标为已处理，恢复后可继续一次',async t=>{
 const h=fixture(t),contact=h.cfg.reply.contacts[0],store=new Store(h.home),incoming={id:'new-input',from:'them',text:'fixture-private-body'};store.baseline(contact.secUid,[{id:'baseline',from:'them',text:'older'}]);let blocked=true,sends=0,calls=0;
 const model={config:{model:'fixture'},meter:{assertAvailable:()=>{if(blocked)throw Object.assign(new Error('unsettled'),{code:'BUDGET_UNKNOWN'});}},reply:async()=>{calls++;return {shouldReply:true,text:'fixture reply',reason:'response'};}},messages=[{id:'baseline',from:'them',text:'older'},incoming],messenger={read:async()=>structuredClone(messages),send:async()=>{sends++;messages.push({id:'own-server',from:'me',text:'fixture reply'});return {messageId:'own-server'};}};
 const engine=new Engine({...h,store,gpt:model,messenger,dy:{checkAccount:async()=>h.cfg.account},live:true,log:()=>{}});await engine.pollReplies();assert.equal(calls,0);assert.equal(store.unseen(contact.secUid,[incoming]).length,1);let summary=recoverySummary(h.home,h.cfg,{running:true},{worker:true});assert.equal(summary.code,'BUDGET_UNKNOWN');assert.equal(summary.pending,1);assert.doesNotMatch(JSON.stringify(summary),/fixture-private-body|new-input/);
 blocked=false;await engine.pollReplies();await engine.pollReplies();assert.equal(calls,1);assert.equal(sends,1);summary=recoverySummary(h.home,h.cfg,{running:true},{worker:true});assert.equal(summary.pending,0);assert.equal(summary.code,'READY');
});
test('已有草稿在模型生成前被识别，原输入保持未处理，下一轮就绪后正常发送',async t=>{
 const h=fixture(t),contact=h.cfg.reply.contacts[0],store=new Store(h.home),old={id:'baseline',from:'them',text:'old'},fresh={id:'fresh',from:'them',text:'new'};store.baseline(contact.secUid,[old]);let draft=true,calls=0,sends=0;const messages=[old,fresh],model={config:{model:'fixture'},reply:async()=>{calls++;return {shouldReply:true,text:'reply',reason:'response'};}},messenger={read:async()=>structuredClone(messages),composePreflight:async()=>{if(draft)throw Object.assign(new Error('existing draft'),{code:'COMPOSE_DRAFT'});},send:async()=>{sends++;messages.push({id:'own',from:'me',text:'reply'});return {messageId:'own'};}};
 const engine=new Engine({...h,store,gpt:model,messenger,dy:{checkAccount:async()=>h.cfg.account},live:true,log:()=>{}});await engine.pollReplies();assert.equal(calls,0);assert.equal(store.unseen(contact.secUid,[fresh]).length,1);draft=false;await engine.pollReplies();assert.equal(calls,1);assert.equal(sends,1);
});
test('登录恢复 API 与二维码均需要已改初始密码的会话，HTTP 日志不记录短信输入',async t=>{
 const h=fixture(t),app=createDashboard(h.home,{port:0,recoveryOptions:{probe:async()=>({ready:true})}}),addr=await app.listen();t.after(()=>new Promise(r=>app.server.close(r)));const base='http://127.0.0.1:'+addr.port;
 assert.equal((await fetch(base+'/api/recovery/image')).status,401);assert.equal((await fetch(base+'/api/recovery/login',{method:'POST',body:'{}'})).status,401);const cookie=await loginDashboard(base,h.home),headers={cookie,'content-type':'application/json'};
 const response=await fetch(base+'/api/recovery/login',{method:'POST',headers,body:JSON.stringify({action:'check',phone:'13900000000',code:'123456'})});assert.equal(response.status,200);assert.equal((await response.json()).ready,true);assert.equal((await fetch(base+'/api/recovery/image',{headers})).status,410);assert.doesNotMatch(readFileSync(join(h.home,'http-requests.log'),'utf8'),/13900000000|123456/);
});
test('搜索页验证只暂停独立搜索，浏览与私信可继续，不重复触发受限搜索',async t=>{
 const h=fixture(t),contact=h.cfg.reply.contacts[0],store=new Store(h.home),old={id:'old',from:'them',text:'old'},messages=[old,{id:'new',from:'them',text:'new'}];store.baseline(contact.secUid,[old]);let searches=0,sends=0;
 const engine=new Engine({...h,store,gpt:{config:{model:'fixture'},reply:async()=>({shouldReply:true,text:'reply',reason:'response'})},dy:{checkAccount:async()=>h.cfg.account},messenger:{read:async()=>structuredClone(messages),send:async()=>{sends++;messages.push({id:'own',from:'me',text:'reply'});return {messageId:'own'};}},live:true,log:()=>{}});
 const search=async()=>{searches++;throw Object.assign(new StopRequired('搜索页需要本人验证','PAGE_VERIFICATION'),{pageKind:'discovery'});};
 await engine.runChannel('discovery-search',search);await engine.runChannel('discovery-search',search);await engine.pollReplies();assert.equal(searches,1);assert.equal(sends,1);assert.equal(new ChannelRecovery(h.home).blocked('discovery-search'),true);assert.equal(new ChannelRecovery(h.home).blocked('browse:openai'),false);assert.equal(recoverySummary(h.home,h.cfg,{running:true},{worker:true}).code,'READY');assert.equal(recoverySummary(h.home,h.cfg,{running:true},{worker:true}).channels[0].requiresUser,true);
 await assert.rejects(engine.runChannel('browse:deepseek',async()=>{throw new StopRequired('账号不一致','ACCOUNT_MISMATCH');}),e=>e.code==='ACCOUNT_MISMATCH');
});
test('账号已登录不代表搜索验证码已解除，必须检查相关页面后才能恢复该通道',async t=>{
 const h=fixture(t),channels=new ChannelRecovery(h.home);channels.fail('browse:openai',Object.assign(new StopRequired('搜索页验证','PAGE_VERIFICATION'),{pageKind:'discovery'}));let challenged=true,checks=0;
 const browser={runtime:{tabs:{discovery:'target-fixture'}},start:async()=>{},disconnect:()=>{},cdp:{send:async()=>({targetInfos:[{targetId:'target-fixture',type:'page',url:'https://www.douyin.com/search/fixture',title:challenged?'安全验证':'fixture 搜索'}]})},page:async()=>({ev:async()=>{checks++;return {url:'https://www.douyin.com/search/fixture',ready:true,hasContent:true,searchReady:true,challenge:challenged};}})};
 assert.equal((await channels.check('discovery-search',h.cfg,{browser,dy:{checkAccount:async()=>h.cfg.account}})).ready,false);assert.equal(channels.blocked('discovery-search'),true);assert.equal(checks,0);challenged=false;assert.equal((await channels.check('discovery-search',h.cfg,{browser,dy:{checkAccount:async()=>h.cfg.account}})).ready,true);assert.equal(checks,2);assert.equal(channels.blocked('discovery-search'),false);
});
test('macOS 启动项卸载后的注册竞态会有界重试，真实故障不会无限循环',async()=>{
 let calls=0;const waits=[];await bootstrapWithRetry(async()=>{if(++calls===1)throw new Error('Bootstrap failed: 5');},{loaded:async()=>false,wait:async ms=>waits.push(ms)});assert.equal(calls,2);assert.deepEqual(waits,[500]);
 calls=0;await assert.rejects(bootstrapWithRetry(async()=>{calls++;throw new Error('still unavailable');},{loaded:async()=>false,wait:async()=>{}}),/unavailable/);assert.equal(calls,4);
 calls=0;await bootstrapWithRetry(async()=>{calls++;throw new Error('already loaded');},{loaded:async()=>true,wait:async()=>{throw new Error('should not wait');}});assert.equal(calls,1);
});
test('重新登录读到的历史空白本人消息不触发接管，也不能截断待回复来信',t=>{
 const h=fixture(t),contact=h.cfg.reply.contacts[0];h.cfg.reply.takeover.enabled=true;const takeover=new Takeover(h.home,h.cfg),blank={id:'old-empty',from:'me',text:'',createdAt:new Date(Date.now()-3600000).toISOString()};
 takeover.observe(contact,[]);takeover.observe(contact,[blank]);assert.equal(takeover.get(contact.secUid).active,false);const incoming={id:'fresh',from:'them',text:'new question'};assert.deepEqual(unanswered([incoming,blank]),[incoming]);
 const file=join(h.home,'takeover.json'),state=JSON.parse(readFileSync(file));state.contacts[contact.secUid].until=Date.now()+1800000;state.contacts[contact.secUid].reason='检测到本人手动回复';atomicJson(file,state);takeover.observe(contact,[blank]);assert.equal(takeover.get(contact.secUid).active,false);
 takeover.pause(contact.secUid,30);takeover.observe(contact,[blank]);assert.equal(takeover.get(contact.secUid).active,true);
});
test('自动接管按真实消息时间计算，重启不把过期人工消息重新暂停半小时',t=>{
 const h=fixture(t),contact=h.cfg.reply.contacts[0];h.cfg.reply.takeover.enabled=true;const takeover=new Takeover(h.home,h.cfg);takeover.observe(contact,[]);
 takeover.observe(contact,[{id:'hour-old',from:'me',text:'old manual reply',createdAt:new Date(Date.now()-3600000).toISOString()}]);assert.equal(takeover.get(contact.secUid).active,false);
 takeover.observe(contact,[{id:'recent',from:'me',text:'manual reply',createdAt:new Date(Date.now()-120000).toISOString()}]);assert.equal(takeover.get(contact.secUid).active,true);assert.ok(takeover.get(contact.secUid).until<Date.now()+29*60000);
});
test('平台客户端消息换成服务器ID时，稳定别名仍能识别机器人回显',t=>{
 const h=fixture(t),contact=h.cfg.reply.contacts[0];h.cfg.reply.takeover.enabled=true;const takeover=new Takeover(h.home,h.cfg);takeover.observe(contact,[]);takeover.observe(contact,[{id:'server-message',aliases:['client-message'],from:'me',text:'old bot',createdAt:new Date().toISOString()}],[{contactId:contact.secUid,status:'sent',sentMessageId:'client-message',text:'old bot',createdAt:new Date(Date.now()-3600000).toISOString()}]);assert.equal(takeover.get(contact.secUid).active,false);
});
test('原生私信编辑器的零宽占位不是草稿，真实文字和媒体草稿仍被保护',async()=>{
 const contact={secUid:'peer-fixture'},editor={innerText:'\u200b\u2060\ufeff',getBoundingClientRect:()=>({width:300,height:44}),querySelector:()=>null};
 const node={__reactFiber$fixture:{memoizedProps:{curConversation:{toParticipantSecUserId:contact.secUid}}},getBoundingClientRect:()=>({width:300,height:40})},panel={querySelectorAll:selector=>selector.includes('messageMessageBox')?[node]:[editor]},document={querySelector:()=>panel};
 const page={ev:expression=>runInNewContext(expression,{document})},messenger=new Messenger('/unused',{page:async()=>page});assert.equal(await messenger.composePreflight(contact),true);
 editor.innerText='尚未发送的草稿';await assert.rejects(messenger.composePreflight(contact),e=>e.code==='COMPOSE_DRAFT');assert.equal(editor.innerText,'尚未发送的草稿');editor.innerText='\u200b';editor.querySelector=()=>({});await assert.rejects(messenger.composePreflight(contact),e=>e.code==='COMPOSE_DRAFT');
});
