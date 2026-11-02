import test from 'node:test';import assert from 'node:assert/strict';import {runInNewContext} from 'node:vm';
import {Douyin} from '../src/douyin.mjs';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {defaultConfig} from '../src/config.mjs';import {atomicJson,Store} from '../src/store.mjs';import {ReplyProgress,recoverySummary} from '../src/recovery.mjs';import {Health} from '../src/health.mjs';import {Engine} from '../src/engine.mjs';

function fixture({body='',status=200,title='正常页面'}={}){let calls=0;const context={location:{origin:'https://www.douyin.com'},document:{title,readyState:'complete',body:{innerText:'正常账号页面'}},AbortSignal,fetch:async()=>{calls++;return new Response(body,{status});}};const page={ev:async expression=>runInNewContext(expression,context)};return {dy:new Douyin('/fixture',{page:async()=>page}),calls:()=>calls};}
test('HTTP200空响应只暂缓读取，不误报登录失效或自动更换读取方式',async()=>{
 const h=fixture();await assert.rejects(h.dy.fetchInPage('/aweme/v1/web/user/profile/other/?private_id=fixture'),e=>e.code==='REMOTE_READ_EMPTY'&&e.name!=='StopRequired'&&e.endpoint==='/aweme/v1/web/user/profile/other/'&&!e.message.includes('private_id'));assert.equal(h.calls(),1);
});
test('空白响应同样退避，调用方仍得不到任何可用于授权或发送的数据',async()=>{
 const h=fixture({body:' \n\t '});await assert.rejects(h.dy.fetchInPage('/aweme/v1/web/notice/'),e=>e.code==='REMOTE_READ_EMPTY');assert.equal(h.calls(),1);
});
test('空响应但页面确实显示验证码时保留平台验证拦截',async()=>{
 const h=fixture({title:'验证码中间页'});await assert.rejects(h.dy.fetchInPage('/aweme/v1/web/user/profile/self/'),e=>e.name==='StopRequired'&&e.code==='PLATFORM_VERIFICATION');
});
test('HTTP403和非空验证HTML继续阻止操作，不能当作已授权成功',async()=>{
 for(const h of [fixture({status:403}),fixture({body:'<html>安全验证</html>'})])await assert.rejects(h.dy.fetchInPage('/aweme/v1/web/notice/'),e=>e.name==='StopRequired'&&e.code==='PLATFORM_VERIFICATION');
});
test('有效JSON与明确登录失效状态保留原行为',async()=>{
 const ok=fixture({body:JSON.stringify({status_code:0,user:{sec_uid:'fixture'}})});assert.equal((await ok.dy.fetchInPage('/aweme/v1/web/user/profile/self/')).user.sec_uid,'fixture');const denied=fixture({body:'{"status_code":8}'});await assert.rejects(denied.dy.fetchInPage('/aweme/v1/web/user/profile/self/'),e=>e.code==='AUTH_REQUIRED');
});
test('真正的网络异常仍使用传输错误代码，不与接口空内容混淆',async()=>{
 const context={location:{origin:'https://www.douyin.com'},document:{title:'正常页面',readyState:'complete'},AbortSignal,fetch:async()=>{throw new Error('NetworkError');}},page={ev:async expression=>runInNewContext(expression,context)},dy=new Douyin('/fixture',{page:async()=>page});await assert.rejects(dy.fetchInPage('/aweme/v1/web/notice/'),e=>e.code==='NETWORK_TRANSIENT');
});
test('旧worker的空响应提示按稳定联系人及同次错误识别，不混入其他联系人或旧告警',t=>{
 const home=mkdtempSync(join(tmpdir(),'dy-empty-label-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const cfg=defaultConfig(),p=new ReplyProgress(home),health=new Health(home),peer={secUid:'MS4wLjABAAAA_EMPTY_PEER',label:'同名联系人'};cfg.reply.enabled=true;p.set(peer,'retrying',{code:'NETWORK_TRANSIENT',pending:0});p.scan();health.alert('reply:'+peer.secUid,'读取失败','同名联系人：抖音接口暂未返回数据，当前读取已暂缓等待重新核对');
 let summary=recoverySummary(home,cfg,{running:true,pid:process.pid},{worker:true});assert.equal(summary.code,'REMOTE_READ_EMPTY');assert.equal(summary.title,'抖音数据暂未返回');assert.match(summary.action,/不代表电脑断网/);assert.equal(summary.needsLogin,false);
 const data=health.read();data.alerts[0].key='reply:MS4wLjABAAAA_OTHER_PEER';atomicJson(join(home,'health.json'),data);summary=recoverySummary(home,cfg,{running:true,pid:process.pid},{worker:true});assert.equal(summary.code,'NETWORK_TRANSIENT');
 data.alerts[0].key='reply:'+peer.secUid;data.alerts[0].lastSeenAt=new Date(Date.now()-60000).toISOString();atomicJson(join(home,'health.json'),data);assert.equal(recoverySummary(home,cfg,{running:true,pid:process.pid},{worker:true}).code,'NETWORK_TRANSIENT');
});
test('主循环遇到空读取保持退避，不退出进程，也不调用模型或发送',async t=>{
 const home=mkdtempSync(join(tmpdir(),'dy-empty-loop-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const cfg=defaultConfig();cfg.reply.enabled=true;cfg.memory.enabled=false;cfg.monitor.enabled=false;cfg.understanding.enabled=false;cfg.reply.media.enabled=false;cfg.monitor.notify=false;const signal={aborted:false};let checks=0,generated=0,sent=0;
 const engine=new Engine({home,cfg,store:new Store(home),gpt:{config:{model:'fixture'},reply:async()=>{generated++;}},dy:{checkAccount:async()=>{checks++;signal.aborted=true;throw Object.assign(new Error('empty read'),{code:'REMOTE_READ_EMPTY'});}},messenger:{send:async()=>{sent++;}},live:true,log:()=>{}});await engine.run(signal);assert.equal(checks,1);assert.equal(generated,0);assert.equal(sent,0);assert.ok(new Health(home).read().alerts.some(a=>a.key==='worker-read'&&!a.resolvedAt));
});
