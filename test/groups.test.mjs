import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {defaultConfig,validateConfig} from '../src/config.mjs';
import {Store,atomicJson} from '../src/store.mjs';
import {GroupChats,groupSummary,applyGroupAction} from '../src/group-chats.mjs';
import {GroupMessenger} from '../src/group-messenger.mjs';
import {groupCalled,groupKey,groupReceipt,groupWindowCompatible,validGroup,groupReplyProvider,groupRoutingText} from '../src/group-policy.mjs';
import {groupDomInPage} from '../src/group-dom.mjs';
import {applyDashboardPatch,createDashboard} from '../src/dashboard.mjs';
import {dashboardAccess} from './helpers/dashboard-access.mjs';
import {accountFingerprint} from '../src/reply-audience.mjs';
import {Gpt} from '../src/openai.mjs';

const owner={secUid:'MS4wLjABAAAA_GROUP_OWNER',douyinId:'fixture',uid:'10000001',nickname:'蓝色大肥鱼和GPT'};
const G={id:'0:2:7400000000000000001',shortId:'7400000000000000001',label:'同名测试群',isMember:true,participantCount:4};
const H={...G,id:'0:2:7400000000000000002',shortId:'7400000000000000002'};
const incoming=(id,text,extra={})=>({id,text,from:'them',senderUid:'10000002',senderSecUid:'',createdAt:new Date().toISOString(),mentionIds:[],callbackCodes:[0],...extra});
function setup(t){
 const home=mkdtempSync(join(tmpdir(),'dy-groups-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const cfg=defaultConfig();cfg.account={secUid:owner.secUid,douyinId:owner.douyinId};cfg.reply.groups.enabled=true;cfg.reply.groups.enabledAt=new Date(Date.now()-60000).toISOString();cfg.reply.routing.enabled=true;cfg.deepseek.enabled=true;
 const store=new Store(home),state={models:[],sends:[],groups:[G,H],data:new Map([[G.id,[incoming('old-g','GPT旧消息',{createdAt:new Date(Date.now()-86400000).toISOString()})]],[H.id,[incoming('old-h','普通旧消息',{createdAt:new Date(Date.now()-86400000).toISOString()})]]])};
 const messenger={list:async()=>state.groups,read:async g=>structuredClone(state.data.get(g.id)||[]),send:async(g,text)=>{const id='7700000000000000'+String(100+state.sends.length);state.sends.push({group:g.id,text});state.data.get(g.id).push(incoming(id,text,{from:'me',senderUid:owner.uid}));return {accepted:true,id,verified:true,deliveryToOthers:null};}};
 const model=p=>({config:{model:'fixture-'+p},groupReply:async x=>{state.models.push({provider:p,...x});return {shouldReply:true,text:'收到，群里可以聊。',reason:'被点名'};}}),models={openai:model('openai'),deepseek:model('deepseek')};
 const dy={checkAccount:async()=>{},fetchInPage:async()=>({user:{uid:owner.uid,sec_uid:owner.secUid,nickname:owner.nickname}})};
 const groups=new GroupChats({home,cfg,store,models,dy,messenger,live:true});atomicJson(join(home,'config.json'),cfg);
 return {home,cfg,store,state,messenger,models,dy,groups};
}
test('只有稳定群ID和明确成员资格才是群，重名不影响身份键',()=>{
 assert.ok(validGroup(G));assert.notEqual(groupKey(G),groupKey(H));assert.equal(validGroup({...G,isMember:false}),false);assert.equal(validGroup({...G,shortId:9007199254740994}),false);
});
test('群聊的空白本人消息和旧历史不触发新的接管，未来时间的@也不处理',async t=>{
 const h=setup(t);h.cfg.reply.takeover.enabled=true;await h.groups.poll();h.state.data.get(G.id).push(incoming('blank','',{from:'me',createdAt:new Date().toISOString()}),incoming('old-mine','旧人工回复',{from:'me',createdAt:new Date(Date.now()-3600000).toISOString()}),incoming('future','GPT你好',{createdAt:new Date(Date.now()+3600000).toISOString()}),incoming('fresh-call','GPT你好'));
 await h.groups.poll();assert.equal(h.state.sends.length,1);assert.equal(h.store.data.groupChats[groupKey(G)].pausedUntil,0);assert.deepEqual(h.state.models[0].incoming.map(m=>m.id),['fresh-call']);
});
test('新来信只认真实@或直接点名；普通讨论、引用、@全体与其他同名成员不触发',()=>{
 for(const text of ['GPT，你怎么看','大肥鱼说句话','gpt你好','GPT群聊测试','@蓝色大肥鱼和GPT 你好'])assert.equal(groupCalled(incoming('x',text),owner),true,text);
 assert.equal(groupCalled(incoming('x','问题',{mentionIds:[owner.uid]}),owner),true);
 assert.equal(groupCalled(incoming('x','GPT群聊教程视频',{type:8}),owner),false);
 assert.equal(groupCalled(incoming('x','',{type:8,mentionIds:[owner.uid]}),owner),true);
 for(const m of [incoming('x','大家觉得GPT怎么样'),incoming('x','> GPT 你怎么看'),incoming('x','@所有人 看公告'),incoming('x','@GPT 你好',{mentionIds:['10000009']}),incoming('x','GPT你好',{from:'me'})])assert.equal(groupCalled(m,owner),false);
});
test('群上下文可追加普通聊天；新点名、作者变更和人工回复会取消旧草稿',()=>{
 const before=[incoming('a','GPT你好')];assert.equal(groupWindowCompatible([...before,incoming('b','同问')],before,['a'],owner),true);
 for(const rows of [[...before,incoming('b','大肥鱼说句话')],[{...before[0],senderUid:'10000009'}],[...before,incoming('mine','人工回复',{from:'me'})],[]])assert.equal(groupWindowCompatible(rows,before,['a'],owner),false);
});
test('@账号显示名中的大肥鱼不干扰路由，只看去掉显示名后的本轮正文',()=>{
 const routing={enabled:true,deepseekKeyword:'大肥鱼'};
 const gpt=incoming('g','@蓝色大肥鱼和GPT GPT，群聊测试',{mentionIds:[owner.uid]});assert.equal(groupRoutingText(gpt,owner),'GPT，群聊测试');assert.equal(groupReplyProvider([gpt],routing,owner),'openai');
 assert.equal(groupReplyProvider([incoming('d','@蓝色大肥鱼和GPT 大肥鱼你说句话')],routing,owner),'deepseek');
 assert.equal(groupReplyProvider([incoming('p','GPT你好')],routing,owner),'openai');
});
test('群回执必须有服务器消息ID和明确成功码；本地回显与7523不能冒充成功',()=>{
 assert.equal(groupReceipt({id:'7700000000000000001',callbackCodes:[0]}).accepted,true);assert.equal(groupReceipt({id:'7700000000000000001',callbackCodes:[]}).accepted,false);assert.equal(groupReceipt({id:'local-uuid',callbackCodes:[0]}).accepted,false);assert.equal(groupReceipt({id:'7700000000000000001',callbackCodes:[7523]}).accepted,false);
});
test('默认关闭群聊；后台开启时记录时间，不能注入旧时间或任意群名单',()=>{
 const cfg=defaultConfig();assert.equal(cfg.reply.groups.enabled,false);const next=applyDashboardPatch(cfg,{reply:{groups:{enabled:true}}});assert.ok(Date.parse(next.reply.groups.enabledAt));assert.equal(cfg.reply.groups.enabled,false);
 for(const groups of [{enabledAt:'2000-01-01'},{ids:['any']},{cooldownSeconds:0}])assert.throws(()=>applyDashboardPatch(cfg,{reply:{groups}}));
 const old=defaultConfig();delete old.reply.groups;validateConfig(old);assert.equal(old.reply.groups.enabled,false);
});
test('旧群历史只建基线；新点名分别路由并且各群独立，不读私信',async t=>{
 const h=setup(t);h.store.data.contacts={PRIVATE_SECRET:{history:[{text:'PRIVATE_SECRET_TEXT'}]}};await h.groups.poll();assert.equal(h.state.models.length,0);
 h.state.data.get(G.id).push(incoming('g-new','GPT，你好'));h.state.data.get(H.id).push(incoming('h-new','大肥鱼，聊聊'));await h.groups.poll();assert.equal(h.state.sends.length,2);assert.deepEqual(h.state.models.map(m=>m.provider),['openai','deepseek']);assert.doesNotMatch(JSON.stringify(h.state.models),/PRIVATE_SECRET/);assert.ok(h.state.models[0].history.every(m=>m.id!=='h-new'));
 await h.groups.poll();assert.equal(h.state.sends.length,2);
});
test('首次启用后的新@可直接回复，普通消息不调用模型',async t=>{
 const h=setup(t);h.state.data.get(G.id).push(incoming('new','想请教',{mentionIds:[owner.secUid]}));h.state.data.get(H.id).push(incoming('normal','大家晚上好'));await h.groups.poll();assert.equal(h.state.sends.length,1);assert.equal(h.state.models.length,1);
});
test('共享总发送额度包含好友私信和平台已接收的群消息',async t=>{
 const h=setup(t);h.cfg.reply.totalPerDay=1;h.state.data.get(G.id).push(incoming('new','GPT你好'));await h.groups.poll();assert.equal(h.store.data.outbox[0].status,'accepted');assert.equal(h.store.quota('MS4wLjABAAAA_PERSON',h.cfg.reply),0);h.state.data.get(H.id).push(incoming('new-2','GPT你好'));await h.groups.poll();assert.equal(h.state.sends.length,1);
});
test('群发送结果未知后不重发；其他群继续工作，核对恢复只处理后续新点名',async t=>{
 const h=setup(t);await h.groups.poll();let count=0;h.messenger.send=async()=>{count++;throw Object.assign(new Error('平台未确认'),{sendAttempted:true,code:'group_rejected_7523'});};h.state.data.get(G.id).push(incoming('new','GPT你好'));await h.groups.poll();await h.groups.poll();assert.equal(count,1);assert.equal(h.store.data.outbox[0].failureCode,'group_rejected_7523');
 applyGroupAction(h.home,h.cfg,h.store,{id:groupKey(G),action:'resume'});await h.groups.poll();assert.equal(count,1);h.state.data.get(G.id).push(incoming('after-resume','GPT你在吗',{createdAt:new Date(Date.now()+5).toISOString()}));await h.groups.poll();assert.equal(count,2);
});
test('取消成员资格后不读取或发言，未知时间与过期点名不追补',async t=>{
 const h=setup(t);h.state.groups=[{...G,isMember:false},H];h.state.data.get(G.id).push(incoming('new','GPT你好'));h.state.data.get(H.id).push(incoming('stale','GPT你好',{createdAt:new Date(Date.now()-3600000).toISOString()}),incoming('unknown','GPT你好',{createdAt:''}));await h.groups.poll();assert.equal(h.state.sends.length,0);
});
test('没有应答需要时只记已处理；禁用模型不偷偷切换服务',async t=>{
 const h=setup(t);await h.groups.poll();h.models.openai.groupReply=async()=>({shouldReply:false,text:'',reason:'无需回复'});h.state.data.get(G.id).push(incoming('new','GPT知道啦'));await h.groups.poll();assert.equal(h.state.sends.length,0);h.cfg.deepseek.enabled=false;h.state.data.get(H.id).push(incoming('ds','大肥鱼在吗'));await h.groups.poll();assert.equal(h.state.models.length,0);
});
function senderHarness(){const group={...G,key:groupKey(G)},messages=[incoming('input','GPT你好')],calls=[];let text='',code=0,switched=false;const p={send:async(method,args)=>{calls.push(method);if(method==='Input.insertText')text=args.text;if(method==='Input.dispatchKeyEvent'&&args.type==='keyUp'&&args.key==='Enter'){messages.push(incoming('7700000000000000100',text,{from:'me',senderUid:owner.uid,callbackCodes:code===null?[]:[code]}));text='';}}};const sender=new GroupMessenger('/unused',{page:async()=>p},{checkAccount:async()=>{}});sender.wait=async()=>{};sender.current=async()=>!switched;sender.open=async()=>{};sender.read=async()=>structuredClone(messages);sender.inspect=async()=>({group,text,hasDraft:!!text,editor:{x:1,y:1},alerts:''});return {sender,group,messages,calls,get text(){return text;},set text(v){text=v;},set code(v){code=v;},set switched(v){switched=v;}};}
test('原生群发送器只按一次发送，真实成功码才返回接收',async()=>{
 const h=senderHarness();const r=await h.sender.send(h.group,'回复',[...h.messages],['input'],owner);assert.equal(r.accepted,true);assert.equal(h.calls.filter(x=>x==='Input.insertText').length,1);assert.equal(r.deliveryToOthers,null);
});
test('已有草稿、切群和新人工回复都不能按发送；拒绝或未知回执只发送一次',async()=>{
 const draft=senderHarness();draft.text='手动草稿';await assert.rejects(draft.sender.send(draft.group,'回复',[...draft.messages],['input'],owner),e=>e.sendAttempted===false);assert.equal(draft.calls.length,0);
 for(const code of [7523,null]){const h=senderHarness();h.code=code;await assert.rejects(h.sender.send(h.group,'回复',[...h.messages],['input'],owner),e=>e.sendAttempted===true);assert.equal(h.calls.filter(x=>x==='Input.insertText').length,1);}
});
test('模型请求仅含当前群短上下文，保持多作者标识，不借用私信人设与记忆',async()=>{
 const gpt=new Gpt({provider:'openai',label:'GPT',baseUrl:'https://api.openai.com/v1',model:'fixture',apiKey:'fixture'});let payload;gpt.request=async(_name,_schema,_instructions,p)=>{payload=p;return {shouldReply:true,text:'你好',reason:'点名'};};await gpt.groupReply({group:G,history:[incoming('x','GPT你好')],incoming:[incoming('x','GPT你好')]});assert.equal(payload.history[0].sender,'10000002');assert.doesNotMatch(JSON.stringify(payload),/private|memory|contacts/);
});
test('私信角色如实知道群聊入口已启用，但不能承诺跨会话代发',()=>{
 const gpt=new Gpt({provider:'openai',label:'GPT',baseUrl:'https://api.openai.com/v1',model:'fixture',apiKey:'fixture'});assert.ok(!gpt.persona.includes('本账号已启用群聊文字回复'));gpt.setCharacter({reply:{groups:{enabled:true}}});assert.ok(gpt.persona.includes('不能直接将私信转发进群'));
});
test('SDK 群ID、成员资格与发送者来自同一原生消息对象，不以群名或头像猜身份',()=>{
 const c=Object.create({id:G.id,shortId:G.shortId,type:2,isMember:true,participantCount:4,coreInfo:{name:G.label}}),m=Object.create({serverId:'7700000000000000011',conversationId:G.id,conversationShortId:G.shortId,sender:'10000002',secSender:'MS4wLjABAAAA_MEMBER',createdAt:new Date(),type:7,ext:{'s:im_callback_status_code':'0'}});m.parsedContent={text:'GPT你好',at_user_ids:[owner.uid]};
 const n={__reactFiber$fixture:{memoizedProps:{message:m,conversation:c}},getBoundingClientRect:()=>({width:100,height:30,x:0,y:0})},row={__reactFiber$fixture:{memoizedProps:{conversation:c}}},panel={querySelectorAll:()=>[n,n]},document={querySelector:()=>panel,querySelectorAll:()=>[row]};
 const ev=a=>runInNewContext(`(${groupDomInPage.toString()})(${JSON.stringify(a)})`,{document});assert.equal(ev({op:'list'})[0].id,G.id);const read=ev({op:'messages',id:G.id,shortId:G.shortId,ownUid:owner.uid});assert.equal(read.verified,true);assert.equal(read.messages.length,1);assert.equal(read.messages[0].senderUid,'10000002');assert.equal(read.messages[0].mentionIds[0],owner.uid);assert.equal(read.messages[0].callbackCodes[0],0);
 c.isMember=false;assert.equal(ev({op:'messages',id:G.id,shortId:G.shortId,ownUid:owner.uid}).verified,false);
});
test('后台群回复独立于私信，操作需本机认证和已核对群身份',async t=>{
 const h=setup(t);await h.groups.sync();const g={...G,key:groupKey(G)},action=h.store.groupDraft(g,[incoming('x','GPT你好')],'群回复','点名');action.receipt={id:'7700000000000000011'};h.store.transition(action,'accepted');const app=createDashboard(h.home,{port:0}),a=await app.listen();t.after(()=>new Promise(r=>app.server.close(r)));const base='http://127.0.0.1:'+a.port,cookie=await dashboardAccess(base,h.home),headers={cookie,'content-type':'application/json'};
 const dto=await(await fetch(base+'/api/state',{headers})).json();assert.equal(dto.replies.length,0);assert.equal(dto.groupReplies.length,1);assert.equal(dto.groupChats.groups.length,2);assert.doesNotMatch(JSON.stringify(dto.groupReplies),/groupShortId|senderUid/);
 assert.equal((await fetch(base+'/api/groups',{method:'POST',headers:{origin:'https://evil.example'},body:'{}'})).status,403);
 const post=b=>fetch(base+'/api/groups',{method:'POST',headers,body:JSON.stringify(b)});assert.equal((await post({id:groupKey(G),action:'pause'})).status,200);assert.equal((await post({id:'group:fake',action:'resume'})).status,400);assert.equal((await post({id:groupKey(G),action:'resume'})).status,200);
});
