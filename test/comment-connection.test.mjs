import test from 'node:test';
import assert from 'node:assert/strict';
import {Comments} from '../src/comments.mjs';

const V='7400000000000000001',CID='7400000000000000002',video={id:V},account={secUid:'fixture-owner'};
function page(){
 const listeners=new Map(),calls=[];
 const p={ws:{readyState:1},calls,listeners,on(name,fn){listeners.set(name,fn);return()=>{if(listeners.get(name)===fn)listeners.delete(name);};},send:async(method)=>{calls.push(method);if(p.ws.readyState!==1)throw new Error('浏览器连接不可用');return {};},ev:async()=>({text:'',anyDraftPresent:false}),close(){p.ws.readyState=3;}};
 return p;
}
function fixture(){
 const first=page(),second=page();let current=first,connections=0,navigations=0;
 const browser={page:async()=>{connections++;return current;},navigate:async()=>{navigations++;throw new Error('本回归不得导航');}};
 const comments=new Comments('/fixture',browser);
 return {comments,browser,first,second,switchPage(){first.close();current=second;},counts:()=>({connections,navigations})};
}
test('评论页连接断开后重新取得浏览器的当前页面，不再复用失效对象',async()=>{
 const h=fixture();assert.equal(await h.comments.attach(),h.first);h.comments.requests.set('old',{});h.comments.receipts.push({old:true});h.comments.cache.set('old',{});
 h.switchPage();assert.equal(await h.comments.attach(),h.second);assert.equal(h.comments.page,h.second);assert.equal(h.first.listeners.size,0);assert.equal(h.second.listeners.size,2);assert.equal(h.comments.requests.size,0);assert.equal(h.comments.receipts.length,0);assert.equal(h.comments.cache.size,0);
});
test('健康连接复用时不重复安装回执监听器或启用Network',async()=>{
 const h=fixture();await h.comments.attach();await h.comments.attach();await h.comments.attach();assert.equal(h.first.listeners.size,2);assert.deepEqual(h.first.calls,['Network.enable']);assert.equal(h.counts().connections,3);
});
test('并发取得评论页共用一次初始化，不产生重复监听',async()=>{
 const h=fixture();const pages=await Promise.all([h.comments.attach(),h.comments.attach(),h.comments.attach()]);assert.ok(pages.every(p=>p===h.first));assert.equal(h.counts().connections,1);assert.deepEqual(h.first.calls,['Network.enable']);assert.equal(h.first.listeners.size,2);
});
test('初始化失败的页面不会被缓存，下次可以重新连接',async()=>{
 const h=fixture();h.first.send=async()=>{throw new Error('connection closed during initialization');};await assert.rejects(h.comments.attach(),/initialization/);assert.equal(h.comments.page,null);assert.equal(h.comments.attaching,null);assert.equal(h.first.ws.readyState,3);
 h.switchPage();assert.equal(await h.comments.attach(),h.second);assert.equal(h.second.listeners.size,2);
});
test('重连后忽略旧页面迟到的回执，不污染新页面的请求或确认',async()=>{
 const h=fixture();await h.comments.attach();const request={url:'https://www.douyin.com/aweme/v1/web/comment/publish/?'+new URLSearchParams({aweme_id:V,text:'fixture comment'})},oldRequest=h.first.listeners.get('Network.requestWillBeSent'),oldFinished=h.first.listeners.get('Network.loadingFinished');
 let finish;h.first.send=async()=>new Promise(resolve=>finish=resolve);oldRequest({requestId:'same-id',request});const pending=oldFinished({requestId:'same-id'});
 h.switchPage();await h.comments.attach();h.second.listeners.get('Network.requestWillBeSent')({requestId:'same-id',request});oldRequest({requestId:'late-old',request});finish({body:JSON.stringify({status_code:0,comment:{cid:CID},comments:[{cid:CID,aweme_id:V}]})});await pending;
 assert.equal(h.comments.receipts.length,0);assert.equal(h.comments.cache.size,0);assert.ok(h.comments.requests.has('same-id'));assert.equal(h.comments.requests.has('late-old'),false);
});
test('重新连接后仍先保留现有草稿，不导航或输入新评论',async()=>{
 const h=fixture();await h.comments.attach();h.switchPage();h.second.ev=async()=>({text:'用户未发送草稿',anyDraftPresent:true});await assert.rejects(h.comments.open(video),e=>e.code==='existing_draft'&&e.sendAttempted===false);
 assert.equal(h.counts().navigations,0);assert.deepEqual(h.second.calls,['Network.enable']);assert.equal(h.comments.lastEditorState.text,'用户未发送草稿');
});
function sender(){
 const h=fixture(),c=h.comments;let typed=false,clicks=0;c.dy.checkAccount=async()=>account;c.open=async()=>{await c.attach();return [];};c.checkVideo=async()=>{};c.prepareEditor=async()=>{};c.holdVideos=async()=>{};
 c.editorState=async()=>({editor:{x:1,y:1},text:typed?'fixture comment':'',draftCount:typed?1:0,replyTargetKnown:true,replyTarget:''});
 h.first.send=async method=>{h.first.calls.push(method);if(h.first.ws.readyState!==1)throw new Error('浏览器连接不可用');if(method==='Input.insertText')typed=true;return {};};
 h.first.ev=async()=>({x:1,y:1});c.click=async()=>{clicks++;h.first.close();};c.wait=async()=>{throw new Error('浏览器连接不可用');};
 return {...h,typed:()=>typed,clicks:()=>clicks};
}
test('填写前断线仍明确记为未发送，不在同次发送中重连重试',async()=>{
 const h=sender();h.comments.prepareEditor=async()=>{h.first.close();throw new Error('浏览器连接不可用');};await assert.rejects(h.comments.send({video,text:'fixture comment',account}),e=>e.sendAttempted===false);assert.equal(h.typed(),false);assert.equal(h.clicks(),0);assert.equal(h.counts().connections,1);
});
test('点击发送后断线保持不确定，不重连或再次点击发送',async()=>{
 const h=sender();await assert.rejects(h.comments.send({video,text:'fixture comment',account}),e=>e.sendAttempted===true&&e.diagnostic.stage==='receipt');assert.equal(h.typed(),true);assert.equal(h.clicks(),1);assert.equal(h.counts().connections,1);
});
test('浏览器窗口关闭时遵守原停止规则，不从评论组件另开浏览器',async()=>{
 const error=Object.assign(new Error('专用窗口已关闭'),{name:'StopRequired'}),comments=new Comments('/fixture',{page:async()=>{throw error;}});await assert.rejects(comments.attach(),e=>e===error);assert.equal(comments.page,null);assert.equal(comments.attaching,null);
});
