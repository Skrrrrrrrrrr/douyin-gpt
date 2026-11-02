import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Comments} from '../src/comments.mjs';import {CommentAutomation} from '../src/comment-automation.mjs';import {CommentStore} from '../src/comment-store.mjs';import {defaultConfig} from '../src/config.mjs';
import {commentRequest,publishReceipt,matchesPublishedComment,accountConfirmation} from '../src/comment-confirmation.mjs';import {sendInfo} from '../src/send-diagnostics.mjs';
const V='7400000000000000001',ROOT='7400000000000000002',CID='7400000000000000003',PEER='7400000000000000004';
const video={id:V,url:'https://www.douyin.com/video/'+V},account={secUid:'owner'},target={id:ROOT,rootId:ROOT,videoId:V,authorSecUid:'peer',text:'@测试账号'},text='看到你啦。';
function validReceipt(){return {request:{at:Date.now(),videoId:V,rootId:ROOT,replyToId:'',text},at:Date.now(),statusCode:0,comment:{cid:CID,aweme_id:V,text,user:{sec_uid:'owner'}}};}
function transport({ack='none'}={}){
 const c=new Comments('/unused',{});let typed=false,clicked=false,waits=0,sends=0;
 c.dy.checkAccount=async()=>account;c.open=async()=>[target];c.checkVideo=async()=>{};c.holdVideos=async()=>{};c.prepareEditor=async()=>{};
 c.editorState=async()=>({editor:{x:1,y:1},text:typed?text:'',draftCount:typed?1:0,replyTargetKnown:true,replyTarget:ROOT});
 c.page={send:async method=>{assert.equal(method,'Input.insertText');typed=true;},ev:async expression=>expression.includes('function readCommentsInPage')?[target,...(clicked?[{id:CID,videoId:V,rootId:ROOT,authorSecUid:'owner',text,createTime:Math.floor(Date.now()/1000)}]:[])]:{x:expression.includes('"kind":"send"')?2:1,y:1}};
 c.click=async point=>{if(point.x===2){clicked=true;sends++;}};
 c.wait=async ms=>{if(ms!==250)return;waits++;if(waits===2&&ack!=='none'){const receipt=validReceipt();if(ack==='reject')receipt.statusCode=7523;if(ack==='wrong-thread')receipt.request.rootId=PEER;if(ack==='wrong-owner')receipt.comment.user.sec_uid='stranger';c.receipts.push(receipt);}};
 return {c,counts:()=>({sends,waits})};
}
test('URL参数、表单、JSON三种发布请求都能关联正文和楼层，凭据不进入回执元数据',()=>{
 const data={aweme_id:V,reply_id:ROOT,reply_to_reply_id:PEER,text},base='https://www.douyin.com/aweme/v1/web/comment/publish/';
 for(const request of [{url:base+'?'+new URLSearchParams({...data,msToken:'SECRET'}),headers:{Cookie:'SECRET'}},{url:base,postData:new URLSearchParams(data).toString()},{url:base,postData:JSON.stringify(data)}]){
  const parsed=commentRequest(request,10);assert.equal(parsed.videoId,V);assert.equal(parsed.rootId,ROOT);assert.equal(parsed.replyToId,PEER);assert.equal(parsed.text,text);assert.doesNotMatch(JSON.stringify(parsed),/SECRET|msToken|Cookie/);
 }
 assert.equal(commentRequest({url:'https://other.example/aweme/v1/web/comment/publish/'}),null);
});
test('页面先回显、平台随后拒绝时，不能提前报成功，也不能再次点击发送',async()=>{
 const {c,counts}=transport({ack:'reject'});await assert.rejects(c.send({video,target,text,account}),e=>e.code==='server_rejected'&&e.sendAttempted===true&&e.receipt?.verified===false);assert.equal(counts().sends,1);assert.equal(counts().waits,2);
});
test('只有即时回显而无平台回执时保留待复核候选，不能当作已接受或已回读',async()=>{
 const {c,counts}=transport();await assert.rejects(c.send({video,target,text,account}),e=>e.code==='receipt_unconfirmed'&&e.receipt?.id===CID&&e.receipt.accepted===false&&e.receipt.verified===false);assert.equal(counts().sends,1);assert.equal(counts().waits,40);
});
test('成功平台回执只表示已接收，必须等待独立重新读取才能升级状态',async()=>{
 const {c,counts}=transport({ack:'success'}),receipt=await c.send({video,target,text,account});assert.equal(receipt.accepted,true);assert.equal(receipt.verified,false);assert.equal(receipt.confirmation.accountVisible,null);assert.equal(receipt.confirmation.recipientVisible,null);assert.equal(counts().sends,1);assert.equal(counts().waits,2);
});
test('其他楼层和其他账号的回执不能确认当前发送',async()=>{
 for(const [ack,code]of [['wrong-thread','wrong_thread'],['wrong-owner','receipt_identity_mismatch']]){const {c}=transport({ack});await assert.rejects(c.send({video,target,text,account}),e=>e.code===code);}
 const receipt=validReceipt();receipt.request.at=1;assert.equal(publishReceipt(receipt,{video,target,text,account,start:10}),null);
 const wrong=validReceipt();wrong.comment.reply_id=PEER;assert.throws(()=>publishReceipt(wrong,{video,target,text,account,start:0}),e=>e.code==='wrong_thread');
 const top=validReceipt();top.request.rootId='';top.comment.reply_id=0;top.comment.reply_to_reply_id='0';assert.equal(publishReceipt(top,{video,target:null,text,account,start:0}).accepted,true);
});
test('重新读取需同时匹配评论ID、视频、楼根、作者与正文，同作者其他楼中楼也不行',()=>{
 const action={videoId:V,rootId:ROOT,targetId:ROOT,text,receipt:{id:CID}},row={id:CID,videoId:V,rootId:ROOT,authorSecUid:'owner',text};assert.equal(matchesPublishedComment(row,action,account),true);
 for(const patch of [{id:PEER},{videoId:PEER},{rootId:PEER},{authorSecUid:'stranger'},{text:'another'}])assert.equal(matchesPublishedComment({...row,...patch},action,account),false);
 assert.equal(matchesPublishedComment({...row,replyToSecUid:'peer',replyToId:ROOT},{...action,targetId:PEER,targetAuthor:'peer'},account),false);
});
test('刷新前发现真实草稿时延后复核，不刷新页面或抹掉草稿',async()=>{
 const c=new Comments('/unused',{});let reloads=0;c.dy.checkAccount=async()=>account;c.readApi=async()=>[];c.page={send:async()=>{reloads++;}};c.attach=async()=>c.page;c.editorState=async()=>({text:'手动草稿',anyDraftPresent:true});
 const result=await c.verifyDelivery({videoId:V,rootId:ROOT,text,receipt:{id:CID}},account);assert.equal(result.accountVisible,null);assert.equal(result.method,'deferred_draft');assert.equal(reloads,0);
});
test('刷新前的即时回显不能代替刷新后缺失的评论',async()=>{
 const c=new Comments('/unused',{});let reloads=0;c.dy.checkAccount=async()=>account;c.readApi=async()=>[];c.page={send:async method=>{assert.equal(method,'Page.reload');reloads++;},ev:async()=>null};c.attach=async()=>c.page;c.editorState=async()=>({text:'',anyDraftPresent:false});c.wait=async()=>{};c.open=async()=>[];
 const result=await c.verifyDelivery({videoId:V,rootId:ROOT,targetId:ROOT,text,receipt:{id:CID}},account);assert.equal(result.accountVisible,null);assert.equal(result.recipientVisible,null);assert.equal(reloads,1);
});
test('服务端重新读取确认后仍不能宣布收件人可见',async()=>{
 const c=new Comments('/unused',{});c.dy.checkAccount=async()=>account;c.readApi=async()=>[{id:CID,videoId:V,rootId:ROOT,authorSecUid:'owner',text}];const result=await c.verifyDelivery({videoId:V,rootId:ROOT,targetId:ROOT,text,receipt:{id:CID}},account);assert.equal(result.accountVisible,true);assert.equal(result.recipientVisible,null);assert.equal(result.method,'fresh_api');
});
function fixture(t){const home=mkdtempSync(join(tmpdir(),'dy-confirm-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const cfg=defaultConfig();cfg.account=account;cfg.engagement.enabled=true;let sends=0;const comments={send:async()=>{sends++;return {version:2,accepted:true,verified:false,id:CID};},verifyDelivery:async()=>accountConfirmation(true,'fresh_api'),notices:async()=>[]};const service=new CommentAutomation({home,cfg,gpt:{config:{model:'fixture'}},comments,dy:{checkAccount:async()=>account},store:{data:{videos:[]}},live:true,log:()=>{}});return {home,service,comments,sends:()=>sends};}
test('自动复核只读取既有提交，升级后仍保留去重与原配额，绝不再次发送',async t=>{
 const h=fixture(t),a=h.service.ledger.draft('reply',video,target,{text,reason:'fixture',confidence:1});h.service.ledger.transition(a,'uncertain','即时回显',{version:2,accepted:false,verified:false,id:CID});assert.ok(h.service.ledger.data.halted);
 await h.service.reconcileDeliveries();await h.service.reconcileDeliveries();assert.equal(h.sends(),0);assert.equal(a.status,'sent');assert.equal(a.confirmation.accountVisible,true);assert.equal(a.confirmation.recipientVisible,null);assert.equal(h.service.ledger.data.halted,'');assert.equal(h.service.ledger.count('reply'),1);
 const row=new CommentStore(h.home).data.actions[0],info=sendInfo(row);assert.match(info.confirmation.note,/尚未确认对方可见/);
});
test('复核不可读时保留已接收，记录下次检查时间，不因读取超时重发',async t=>{
 const h=fixture(t);h.comments.verifyDelivery=async()=>{throw new Error('timeout');};const a=await h.service.submit('reply',video,target,{text,shouldPost:true,reason:'fixture',confidence:1});assert.equal(a.status,'accepted');assert.equal(h.sends(),1);assert.equal(a.confirmation.accountVisible,null);assert.ok(a.confirmation.nextCheckAt>Date.now());await h.service.reconcileDeliveries();assert.equal(h.sends(),1);assert.equal(a.confirmation.attempts,1);
});
test('发送账号复核不得覆盖对方明确反馈的不可见记录',t=>{
 const h=fixture(t),a=h.service.ledger.draft('reply',video,target,{text,reason:'fixture',confidence:1});h.service.ledger.transition(a,'accepted','',{version:2,accepted:true,id:CID});a.confirmation={recipientVisible:false,recipientEvidence:'user_report'};h.service.ledger.confirm(a,accountConfirmation(true,'fresh_api'));assert.equal(a.confirmation.recipientVisible,false);assert.match(sendInfo(a).confirmation.note,/对方反馈尚不可见/);
});
