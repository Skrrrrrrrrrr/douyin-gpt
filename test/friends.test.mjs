import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConfig,validateConfig} from '../src/config.mjs';
import {Store,atomicJson} from '../src/store.mjs';
import {Friends} from '../src/friends.mjs';
import {StopRequired} from '../src/douyin.mjs';
import {Engine} from '../src/engine.mjs';
import {friendSnapshot,replyContacts,mutualFriend,accountFingerprint} from '../src/reply-audience.mjs';
import {PrivateDelivery} from '../src/private-delivery.mjs';
import {snapshotMessages} from '../src/message-snapshot.mjs';
import {ConversationMemory} from '../src/memory.mjs';
import {Takeover} from '../src/takeover.mjs';
import {StickerLibrary} from '../src/stickers.mjs';
import {Backups} from '../src/backups.mjs';
import {createDashboard,applyDashboardPatch} from '../src/dashboard.mjs';
import {loginDashboard} from './helpers/dashboard-login.mjs';
import {runInNewContext} from 'node:vm';
import {readMessages} from '../vendor/newjo/im-send.mjs';

const OWNER='MS4wLjABAAAA_FRIEND_OWNER',A='MS4wLjABAAAA_FRIEND_A',B='MS4wLjABAAAA_FRIEND_B',S='MS4wLjABAAAA_STRANGER';
const raw=(sec_uid,nickname='同名好友')=>({uid:'100000001',sec_uid,nickname,follow_status:2,follower_status:1,is_block:false,is_blocked:false});
function setup(t){
 const home=mkdtempSync(join(tmpdir(),'dy-friends-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const cfg=defaultConfig();cfg.account={secUid:OWNER,douyinId:'fixture'};cfg.reply.audience='friends';cfg.reply.friends.enabledAt=new Date(Date.now()-60000).toISOString();cfg.reply.routing.enabled=true;cfg.deepseek.enabled=true;cfg.browse.enabled=false;cfg.monitor.enabled=false;cfg.reply.media.enabled=false;cfg.memory.enabled=false;
 const people=new Map([[A,raw(A)],[B,raw(B)],[S,{...raw(S),follow_status:1,follower_status:0}]]),calls=[];
 const dy={checkAccount:async()=>{},fetchInPage:async path=>{const u=new URL(path,'https://www.douyin.com');calls.push(u);
   if(u.pathname.endsWith('/profile/self/'))return {user:{uid:'10000001',sec_uid:OWNER,unique_id:'fixture'}};
   if(u.pathname.endsWith('/following/list/'))return {followings:[...people.values()],has_more:false,myself_user_id:'10000001'};
   if(u.pathname.endsWith('/profile/other/'))throw Object.assign(new Error('联系人资料 HTTP200 空返'),{code:'REMOTE_READ_EMPTY'});throw new Error('未预期接口');}};
 const directory=new Friends(home,cfg,dy),store=new Store(home),messages=new Map([A,B,S].map(id=>[id,[{id:'old-'+id,from:'them',text:'旧消息',serverConfirmed:true,createdAt:new Date(Date.now()-86400000).toISOString()}]]));
 const state={reads:[],sends:[],modelCalls:[],recent:[{sec_uid:A},{sec_uid:B},{sec_uid:S},{sec_uid:'',is_group:true}]};
 const messenger={contacts:async()=>state.recent,read:async c=>{state.reads.push(c.secUid);return structuredClone(messages.get(c.secUid)||[]);},send:async(c,text)=>{const id='7700000000000000'+String(100+state.sends.length);state.sends.push({id,contact:c.secUid,text});messages.get(c.secUid).push({id,from:'me',text,serverConfirmed:true});return {messageId:id};}};
 const model=p=>({config:{model:'fixture-'+p},reply:async input=>{state.modelCalls.push({provider:p,contact:input.contact.secUid,incoming:input.incoming,history:input.history,memory:input.memory});return {shouldReply:true,text:'收到啦。',reason:'回复新来信'};}});
 const gpt=model('openai'),ds=model('deepseek'),engine=new Engine({home,cfg,store,gpt,models:{deepseek:ds},dy,messenger,live:true,log:()=>{}});
 atomicJson(join(home,'config.json'),cfg);return {home,cfg,people,calls,dy,directory,store,messages,state,messenger,gpt,ds,engine};
}
test('只有当前互关个人账号可自动加入，单向关注、粉丝、拉黑和自身不加入',()=>{
 assert.ok(mutualFriend(raw(A),{secUid:OWNER}));
 for(const u of [{...raw(A),follow_status:1},{...raw(A),follower_status:0},{...raw(A),is_block:true},{...raw(A),is_blocked:true},raw(OWNER),{...raw(A),sec_uid:''}])assert.equal(mutualFriend(u,{secUid:OWNER}),null);
});
test('联系人资料持续空返时，每次授权仍用实时完整名单，不使用 HTTP 缓存或周期内旧名单',async t=>{
 const h=setup(t),fetch=h.dy.fetchInPage;h.dy.fetchInPage=async(path,options)=>{assert.equal(options?.noCache,true);return fetch(path);};
 await h.directory.sync({force:true});const contact=replyContacts(h.home,h.cfg).find(c=>c.secUid===A);
 for(let check=0;check<2;check++){
   const before=h.calls.filter(u=>u.pathname.endsWith('/following/list/')).length;
   assert.equal(await h.directory.verify(contact),true);
   assert.equal(h.calls.filter(u=>u.pathname.endsWith('/following/list/')).length,before+1);
   assert.equal(replyContacts(h.home,h.cfg).find(c=>c.secUid===A).membershipId,contact.membershipId);
 }
 assert.ok(!h.calls.some(u=>u.pathname.endsWith('/profile/other/')));
});
test('刚同步过也重新读取全部分页，同名但稳定 ID 不匹配的对象不授权',async t=>{
 const h=setup(t);await h.directory.sync({force:true});const a=replyContacts(h.home,h.cfg).find(c=>c.secUid===A),b=replyContacts(h.home,h.cfg).find(c=>c.secUid===B),fetch=h.dy.fetchInPage;let pages=0;
 h.dy.fetchInPage=async path=>path.includes('/following/list/')?(++pages%2?{followings:[raw(B)],has_more:true,min_time:100,offset:20}:{followings:[{...raw(A),follow_status:1}],has_more:false}):fetch(path);
 assert.equal(await h.directory.verify(a),false);assert.equal(pages,2);
 assert.equal(await h.directory.verify(b),true);assert.equal(pages,4);
 assert.equal(await h.directory.verify({secUid:S,label:b.label}),false);
});
test('实时移除后重新互关生成新 membershipId，旧授权批次不能因重新入名单而继续',async t=>{
 const h=setup(t);await h.directory.sync({force:true});const old=replyContacts(h.home,h.cfg).find(c=>c.secUid===A);
 h.people.delete(A);assert.equal(await h.directory.verify(old),false);
 h.people.set(A,raw(A));assert.equal(await h.directory.verify(old),false);
 const fresh=replyContacts(h.home,h.cfg).find(c=>c.secUid===A);assert.notEqual(fresh.membershipId,old.membershipId);assert.equal(await h.directory.verify(fresh),true);
});
test('实时核验遇到后续分页失败时，不以第一页或上次完整名单授权',async t=>{
 const h=setup(t);await h.directory.sync({force:true});const contact=replyContacts(h.home,h.cfg).find(c=>c.secUid===A),fetch=h.dy.fetchInPage;let pages=0;
 const error=Object.assign(new Error('分页暂未返回'),{code:'REMOTE_READ_EMPTY'});
 h.dy.fetchInPage=async path=>{if(!path.includes('/following/list/'))return fetch(path);if(++pages===1)return {followings:[raw(A)],has_more:true,min_time:100,offset:20};throw error;};
 await assert.rejects(h.directory.verify(contact),e=>e===error);assert.equal(pages,2);assert.equal(friendSnapshot(h.home,h.cfg).ready,false);assert.deepEqual(replyContacts(h.home,h.cfg),[]);
});
for(const [label,endpoint,error] of [
 ['账号资料空返','/profile/self/',Object.assign(new Error('empty self'),{code:'REMOTE_READ_EMPTY'})],
 ['完整名单空返','/following/list/',Object.assign(new Error('empty roster'),{code:'REMOTE_READ_EMPTY'})],
 ['HTTP403','/following/list/',new StopRequired('HTTP403','PLATFORM_VERIFICATION')],
 ['验证码','/profile/self/',new StopRequired('验证码','PLATFORM_VERIFICATION')],
 ['登录失效','/profile/self/',new StopRequired('登录失效','AUTH_REQUIRED')],
])test('实时名单核验保留'+label+'拦截，不回退有效期内旧名单',async t=>{
 const h=setup(t);await h.directory.sync({force:true});const contact=replyContacts(h.home,h.cfg).find(c=>c.secUid===A),fetch=h.dy.fetchInPage;
 h.dy.fetchInPage=async path=>{if(path.includes(endpoint))throw error;return fetch(path);};
 await assert.rejects(h.directory.verify(contact),e=>e===error);assert.equal(friendSnapshot(h.home,h.cfg).status,'error');assert.deepEqual(replyContacts(h.home,h.cfg),[]);
});
test('指定名单模式不引入好友网络依赖，停用仍拦截',async t=>{
 const h=setup(t);h.cfg.reply.audience='allowlist';h.cfg.reply.contacts=[{secUid:A,label:'允许对象',enabled:true}];
 assert.equal(await h.directory.verify({secUid:A}),true);assert.equal(await h.directory.verify({secUid:B}),false);assert.equal(h.calls.length,0);
 h.cfg.reply.contacts[0].enabled=false;assert.equal(await h.directory.verify({secUid:A}),false);
});
test('实时列表请求期间个人停用也优先生效，配置停用和 overrides 均不可扩大',async t=>{
 const h=setup(t);await h.directory.sync({force:true});const contact=replyContacts(h.home,h.cfg).find(c=>c.secUid===A),fetch=h.dy.fetchInPage;
 h.dy.fetchInPage=async path=>{const result=await fetch(path);if(path.includes('/following/list/'))h.cfg.reply.friends.overrides=[{secUid:A,enabled:false}];return result;};
 assert.equal(await h.directory.verify(contact),false);
 h.dy.fetchInPage=fetch;h.cfg.reply.friends.overrides=[{secUid:A,enabled:true}];h.cfg.reply.contacts=[{secUid:A,label:'原允许对象',enabled:false}];assert.equal(await h.directory.verify(contact),false);
});
test('生成或读取较慢使好友缓存过期时重新核对，不把仍互关的联系人误判为未授权',async t=>{
 const h=setup(t);await h.directory.sync({force:true});const contact=replyContacts(h.home,h.cfg).find(c=>c.secUid===A),state=friendSnapshot(h.home,h.cfg);state.checkedAt=new Date(Date.now()-180000).toISOString();state.attemptedAt=new Date().toISOString();atomicJson(join(h.home,'friends.json'),state);
 assert.equal(await h.directory.verify(contact),true);assert.equal(friendSnapshot(h.home,h.cfg).ready,true);assert.equal(replyContacts(h.home,h.cfg).find(c=>c.secUid===A).membershipId,contact.membershipId);
});
test('缓存过期后的刷新仍尊重取消互关与个人停用，不借刷新扩大权限',async t=>{
 const h=setup(t);await h.directory.sync({force:true});const contact=replyContacts(h.home,h.cfg).find(c=>c.secUid===A);h.people.set(A,{...raw(A),follow_status:1});const state=friendSnapshot(h.home,h.cfg);state.checkedAt=new Date(Date.now()-180000).toISOString();atomicJson(join(h.home,'friends.json'),state);assert.equal(await h.directory.verify(contact),false);
 h.people.set(A,raw(A));await h.directory.sync({force:true});assert.equal(await h.directory.verify(contact),false);const current=replyContacts(h.home,h.cfg).find(c=>c.secUid===A);h.cfg.reply.friends.overrides=[{secUid:A,enabled:false}];assert.equal(await h.directory.verify(current),false);
});
test('旧配置保持指定名单；好友模式启用时间由后台生成且不能注入好友名单',()=>{
 const c=defaultConfig();delete c.reply.audience;delete c.reply.friends;validateConfig(c);assert.equal(c.reply.audience,'allowlist');
 const next=applyDashboardPatch(c,{reply:{audience:'friends'}});assert.ok(Date.parse(next.reply.friends.enabledAt));assert.equal(c.reply.audience,'allowlist');
 for(const friends of [{enabledAt:'2000-01-01'},{overrides:[]},{syncSeconds:1}])assert.throws(()=>applyDashboardPatch(c,{reply:{friends}}));
 assert.throws(()=>validateConfig({...c,reply:{...c.reply,audience:'all'}}));
});
test('实际关注列表分页完成后才原子保存好友，同名好友使用稳定 ID 分开',async t=>{
 const h=setup(t);let page=0;const original=h.dy.fetchInPage;h.dy.fetchInPage=async path=>path.includes('/following/list/')?(++page===1?{followings:[raw(A)],has_more:true,min_time:100,offset:20}:{followings:[raw(B)],has_more:false}):original(path);
 await h.directory.sync({force:true});const contacts=replyContacts(h.home,h.cfg);assert.deepEqual(contacts.map(c=>c.secUid),[A,B]);assert.equal(contacts[0].label,contacts[1].label);assert.notEqual(contacts[0].membershipId,contacts[1].membershipId);
});
test('分页失败、停滞、截断或账号错配时不使用部分授权名单',async t=>{
 const h=setup(t);await h.directory.sync({force:true});const original=h.dy.fetchInPage;
 h.dy.fetchInPage=async path=>path.includes('/following/list/')?{followings:[raw(A)],has_more:true,min_time:10}:original(path);
 await assert.rejects(h.directory.sync({force:true,maxPages:1}),/核对范围/);assert.equal(replyContacts(h.home,h.cfg).length,0);
 await assert.rejects(h.directory.sync({force:true}),/翻页停滞/);assert.equal(friendSnapshot(h.home,h.cfg).ready,false);
 h.dy.fetchInPage=async()=>({user:{uid:'10000001',sec_uid:A,unique_id:'fixture'}});await assert.rejects(h.directory.sync({force:true}),/账号/);assert.equal(replyContacts(h.home,h.cfg).length,0);
});
test('过期名单和其他账号缓存不会授予任何好友权限',async t=>{
 const h=setup(t);await h.directory.sync({force:true});assert.equal(replyContacts(h.home,h.cfg,{now:Date.now()+130000}).length,0);
 const file=join(h.home,'friends.json'),x=JSON.parse(readFileSync(file));x.accountHash=accountFingerprint({secUid:A});atomicJson(file,x);assert.equal(replyContacts(h.home,h.cfg).length,0);
});
test('好友首次旧消息只建基线；之后各自按新来信路由，不读群聊与陌生人',async t=>{
 const h=setup(t);await h.engine.pollReplies();assert.equal(h.state.modelCalls.length,0);assert.deepEqual(new Set(h.state.reads),new Set([A,B]));
 h.messages.get(A).push({id:'a-new',from:'them',text:'大肥鱼在吗'});h.messages.get(B).push({id:'b-new',from:'them',text:'你好'});
 await h.engine.pollReplies();assert.equal(h.state.sends.length,2);assert.deepEqual(h.state.modelCalls.map(c=>[c.contact,c.provider]),[[A,'deepseek'],[B,'openai']]);
 assert.ok(h.state.modelCalls.every(c=>c.history.every(m=>!m.id.includes(c.contact===A?B:A))));await h.engine.pollReplies();assert.equal(h.state.sends.length,2);
});
test('新好友第一次出现的可靠新来信可以回复，不丢掉启用后的第一条',async t=>{
 const h=setup(t);h.messages.get(A).push({id:'first-new',from:'them',text:'第一次发新消息',serverConfirmed:true,createdAt:new Date().toISOString()});await h.engine.pollReplies();assert.equal(h.state.sends.length,1);assert.equal(h.state.sends[0].contact,A);
});
test('未知时间或未确认服务器 ID 的历史首批不猜成新消息',async t=>{
 const h=setup(t);h.messages.set(A,[{id:'unknown-time',from:'them',text:'不能判断时间'},{id:'local',from:'them',text:'本地消息',createdAt:new Date().toISOString()}]);await h.engine.pollReplies();assert.equal(h.state.sends.length,0);
});
test('现有允许联系人切换好友模式保留已建立基线，不漏掉其正常新来信',async t=>{
 const h=setup(t);h.cfg.reply.contacts=[{secUid:A,label:'旧允许对象',enabled:true}];h.store.baseline(A,h.messages.get(A));h.messages.get(A).push({id:'known-new',from:'them',text:'新来信'});await h.engine.pollReplies();assert.equal(h.state.sends[0].contact,A);
});
test('生成期间取消互关时不落入发送器，移除的好友不会继续读取',async t=>{
 const h=setup(t);await h.engine.pollReplies();h.messages.get(A).push({id:'new',from:'them',text:'你好'});const reply=h.gpt.reply;h.gpt.reply=async input=>{const result=await reply(input);h.people.get(A).follow_status=1;return result;};
 await h.engine.pollReplies();assert.equal(h.state.sends.length,0);assert.equal(replyContacts(h.home,h.cfg).some(c=>c.secUid===A),false);h.state.reads=[];await h.engine.pollReplies();assert.ok(!h.state.reads.includes(A));
});
test('媒体处理期间取消互关时，模型生成前再次核验，不调用模型',async t=>{
 const h=setup(t);await h.engine.pollReplies();h.messages.get(A).push({id:'new-media',from:'them',text:'看这张图',mediaAvailable:true});
 h.engine.messageMedia={enrich:async(_c,messages)=>{h.people.get(A).follow_status=1;return {messages,images:[]};}};
 await h.engine.pollReplies();assert.equal(h.state.modelCalls.length,0);assert.equal(h.state.sends.length,0);
});
test('生成后读取的会话有变化时，实时互关授权不能复活旧草稿',async t=>{
 const h=setup(t);await h.engine.pollReplies();h.messages.get(A).push({id:'new-input',from:'them',text:'你好'});const reply=h.gpt.reply;
 h.gpt.reply=async input=>{const result=await reply(input);h.messages.get(A).push({id:'later-input',from:'them',text:'先等一下'});return result;};
 await h.engine.pollReplies();assert.equal(h.state.sends.length,0);assert.equal(h.store.data.outbox[0].status,'superseded');
});
test('发送前最终账号核对期间取消互关时，不进入文字发送器',async t=>{
 const h=setup(t);await h.engine.pollReplies();h.messages.get(A).push({id:'new-input',from:'them',text:'你好'});
 h.dy.checkAccount=async()=>{if(h.state.modelCalls.length)h.people.get(A).follow_status=1;};
 await h.engine.pollReplies();assert.equal(h.state.modelCalls.length,1);assert.equal(h.state.sends.length,0);assert.equal(h.store.data.outbox[0].status,'superseded');
});
test('好友个人停用、人工接管、记忆和表情均使用同一好友权限范围',async t=>{
 const h=setup(t);await h.directory.sync({force:true});assert.equal(new Takeover(h.home,h.cfg).allowed(A),true);assert.equal(new ConversationMemory(h.home,h.cfg).allowed(A),true);assert.notEqual(new StickerLibrary(h.home,h.cfg).status([],A).reason,'not_allowed');
 h.cfg.reply.friends.overrides=[{secUid:A,enabled:false}];assert.equal(new Takeover(h.home,h.cfg).allowed(A),false);assert.equal(new ConversationMemory(h.home,h.cfg).allowed(A),false);h.cfg.reply.stickers.enabled=true;assert.equal(new StickerLibrary(h.home,h.cfg).status([],A).reason,'not_allowed');
});
test('组合回复每一步前都复核好友关系；第一步后取消互关不发第二步',async t=>{
 const h=setup(t);await h.directory.sync({force:true});const c=replyContacts(h.home,h.cfg).find(c=>c.secUid===A),before=structuredClone(h.messages.get(A));
 const plan={baseMessages:snapshotMessages(before),steps:[{kind:'text',text:'第一步'},{kind:'text',text:'第二步'}]},item=h.store.draft(c,[before[0]],'组合测试','测试',{plan});const send=h.messenger.send;
 h.messenger.send=async(...args)=>{const result=await send(...args);h.people.get(A).follow_status=1;return result;};
 const delivery=new PrivateDelivery({home:h.home,cfg:h.cfg,store:h.store,messenger:h.messenger,dy:h.dy,authorize:c=>h.directory.verify(c)});await delivery.execute(c,item);assert.equal(h.state.sends.length,1);assert.equal(item.status,'partial_cancelled');
});
test('好友取消后重新加入生成新授权批次，旧会话不会补发',async t=>{
 const h=setup(t);await h.engine.pollReplies();const oldId=replyContacts(h.home,h.cfg).find(c=>c.secUid===A).membershipId;
 h.people.get(A).follow_status=1;await h.directory.sync({force:true});h.messages.get(A).push({id:'during-gap',from:'them',text:'离开好友期间的历史'});h.people.get(A).follow_status=2;await h.directory.sync({force:true});assert.notEqual(replyContacts(h.home,h.cfg).find(c=>c.secUid===A).membershipId,oldId);await h.engine.pollReplies();assert.equal(h.state.sends.length,0);
});
test('恢复备份保留当前好友范围与单独停用状态，不复活旧权限',t=>{
 const h=setup(t),b=new Backups(h.home);const saved=b.create();h.cfg.reply.audience='allowlist';h.cfg.reply.friends.overrides=[{secUid:A,enabled:false}];atomicJson(join(h.home,'config.json'),h.cfg);const plan=b.proof(saved.id);b.restore(saved.id,plan.proof);const current=JSON.parse(readFileSync(join(h.home,'config.json')));assert.equal(current.reply.audience,'allowlist');assert.equal(current.reply.friends.overrides[0].enabled,false);
});
test('后台可设置新好友偏好和停用，陌生 ID、群聊与名单注入均拒绝',async t=>{
 const h=setup(t);await h.directory.sync({force:true});const app=createDashboard(h.home,{port:0}),addr=await app.listen();t.after(()=>new Promise(r=>app.server.close(r)));const base='http://127.0.0.1:'+addr.port,cookie=await loginDashboard(base,h.home),headers={cookie,'content-type':'application/json'};
 const post=(path,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
 const dto=await(await fetch(base+'/api/state',{headers})).json();assert.equal(dto.friendAudience.verifiedCount,2);assert.equal(dto.contacts.length,2);
 assert.equal((await post('/api/contact',{contactId:A,preferences:{tone:'gentle'}})).status,200);assert.equal(JSON.parse(readFileSync(join(h.home,'config.json'))).reply.friends.overrides[0].preferences.tone,'gentle');
 assert.equal((await post('/api/contact',{contactId:A,enabled:false})).status,200);assert.equal((await post('/api/contact',{contactId:A,preferences:{tone:'casual'}})).status,400);assert.equal((await post('/api/contact',{contactId:A,enabled:true})).status,200);
 assert.equal((await post('/api/contact',{contactId:S,preferences:{tone:'gentle'}})).status,400);assert.equal((await post('/api/config',{reply:{friends:{overrides:[{secUid:S,enabled:true}]}}})).status,400);
 assert.equal((await fetch(base+'/api/friends/sync',{method:'POST'})).status,401);
});
test('原生消息的服务器创建时间可以来自 SDK 的 Date getter',async()=>{
 const created=new Date(Date.now()-1000),m=Object.create({createdAt:created,serverId:'7700000000000000123',type:1});m.parsedContent={text:'测试消息'};
 const avatar={getBoundingClientRect:()=>({left:100,width:36,height:36,top:100})},n={__reactFiber$fixture:{memoizedProps:{message:m}},getBoundingClientRect:()=>({top:90,bottom:150}),querySelectorAll:()=>[avatar]},document={querySelector:()=>({getBoundingClientRect:()=>({left:0,width:1000})}),querySelectorAll:()=>[n]};
 const rows=await readMessages(expression=>runInNewContext(expression,{document}));assert.equal(rows[0].createdAt,created.toISOString());assert.equal(rows[0].serverConfirmed,true);
});
