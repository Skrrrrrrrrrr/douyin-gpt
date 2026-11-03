import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Comments} from '../src/comments.mjs';
import {CommentStore} from '../src/comment-store.mjs';
import {commentDiagnostic,sendInfo} from '../src/send-diagnostics.mjs';
import {createDashboard} from '../src/dashboard.mjs';
import {defaultConfig} from '../src/config.mjs';
import {Store,atomicJson} from '../src/store.mjs';
import {dashboardAccess} from './helpers/dashboard-access.mjs';

const V='7400000000000000001',CID='7400000000000000003';
const empty={exists:true,text:'',editor:null,editorCount:0,visibleEditorCount:0,containerCount:1,draftCount:0,anyDraftPresent:false,replyTarget:'',replyTargetKnown:true,editorFocused:false,placeholderPresent:true};
const ready={...empty,editor:{x:20,y:20},editorCount:1,visibleEditorCount:1,editorFocused:true,placeholderPresent:false};
function harness(states) {
  const c=new Comments('/unused',{}),calls={clicks:0,waits:0,checks:0};let i=0;
  c.page={ev:async()=>({x:20,y:20})};
  c.editorState=async()=>c.lastEditorState=states[Math.min(i++,states.length-1)];
  c.checkVideo=async id=>{assert.equal(id,V);calls.checks++;};c.click=async()=>{calls.clicks++;};c.wait=async()=>{calls.waits++;};
  return {c,calls};
}
test('懒加载编辑器超过旧等待窗口时，有限等待后才交还输入权限',async()=>{
  const {c,calls}=harness([...Array(12).fill(empty),ready]);
  const result=await c.prepareEditor(V);assert.equal(result,ready);assert.equal(calls.waits,12);assert.equal(calls.clicks,2);
});
test('发现真实草稿立即停止；不会点击、清空草稿或重试发送',async()=>{
  const {c,calls}=harness([{...ready,text:'用户草稿',anyDraftPresent:true,draftCount:1}]);
  await assert.rejects(c.prepareEditor(V),e=>e.code==='existing_draft'&&e.sendAttempted===false);assert.equal(calls.clicks,0);assert.equal(calls.waits,0);
});
test('占位点击后出现草稿也停止，不能再次点击另一评论区',async()=>{
  const {c,calls}=harness([empty,{...empty,anyDraftPresent:true,draftCount:1}]);
  await assert.rejects(c.prepareEditor(V),e=>e.code==='existing_draft');assert.equal(calls.clicks,1);
});
test('缺少编辑器、编辑器未获焦点、回复对象未知分别给出原因',async()=>{
  for(const [state,code]of [[empty,'editor_missing'],[{...ready,editorFocused:false},'editor_unfocused'],[{...ready,replyTargetKnown:false},'reply_target_unknown'],[{...ready,replyTarget:CID},'reply_target_changed']]){
    const {c}=harness([state]);await assert.rejects(c.prepareEditor(V,'',{attempts:2}),e=>e.code===code&&e.sendAttempted===false);
  }
});
test('回复对象异步更新期间不提前输入，须目标 cid 与焦点同时一致',async()=>{
  const {c,calls}=harness([ready,{...ready,replyTargetKnown:false},{...ready,replyTarget:CID,editorFocused:false},{...ready,replyTarget:CID}]);
  assert.equal((await c.prepareEditor(V,CID)).replyTarget,CID);assert.equal(calls.waits,3);
});
test('等待期间换片或停止信号立即终止，不触碰发送按钮',async()=>{
  const {c,calls}=harness([empty]);c.checkVideo=async()=>{throw Object.assign(new Error('视频变化'),{code:'video_changed',sendAttempted:false});};
  await assert.rejects(c.prepareEditor(V),e=>e.code==='video_changed');assert.equal(calls.clicks,0);
  const controller=new AbortController();controller.abort();c.signal=controller.signal;await assert.rejects(c.prepareEditor(V),e=>e.code==='stopped');
});
test('提交前正文、楼层及其他评论框草稿再次核对，不把已有输入覆盖掉',()=>{
  const {c}=harness([ready]);assert.doesNotThrow(()=>c.assertComposed({...ready,text:'测试',draftCount:1},'测试',''));
  assert.throws(()=>c.assertComposed({...ready,text:'别人改了'},'测试',''),e=>e.code==='text_changed');
  assert.throws(()=>c.assertComposed({...ready,text:'测试',replyTarget:CID},'测试',''),e=>e.code==='reply_target_changed');
  assert.throws(()=>c.assertComposed({...ready,text:'测试',draftCount:2},'测试',''),e=>e.code==='existing_draft');
});
test('错误诊断仅留结构计数；真实草稿、DOM、账号 ID 和凭证不落诊断',()=>{
  const d=commentDiagnostic({...ready,text:'SECRET_DRAFT',html:'SECRET_HTML',replyTarget:'SECRET_CID',token:'SECRET_TOKEN'},{code:'editor_missing',stage:'editor'});
  assert.equal(d.draftCount,0);assert.equal(d.stage,'editor');assert.doesNotMatch(JSON.stringify(d),/SECRET/);
  assert.equal(commentDiagnostic({}, {code:'sk-secret',stage:'SECRET'}).code,'comment_pre_send_failed');
});
test('诊断持久化后重启仍可查，未发送仍去重且不占发送配额',t=>{
  const home=mkdtempSync(join(tmpdir(),'dy-send-diagnostics-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const ledger=new CommentStore(home),a=ledger.draft('comment',{id:V},null,{text:'公开测试',reason:'test',confidence:1});
  ledger.transition(a,'not_sent','编辑器尚未出现',undefined,commentDiagnostic(empty,{code:'editor_missing',stage:'editor'}));
  const next=new CommentStore(home);assert.equal(next.data.actions[0].diagnostic.code,'editor_missing');assert.equal(next.count('comment'),0);assert.equal(next.has('comment',V),true);
  assert.equal(sendInfo(next.data.actions[0]).terminal,true);
});
test('旧合并错误保持未知；私信取消及组合步骤显示实际原因与不补发状态',()=>{
  const old=sendInfo({status:'not_sent',note:'评论输入框未就绪或已有草稿'});assert.equal(old.legacyAmbiguous,true);assert.match(old.detail,/无法区分/);assert.equal(old.diagnostic,null);
  assert.match(sendInfo({status:'not_sent',note:'上传前会话已变化'}).reason,/会话已变化/);
  const combo=sendInfo({status:'superseded',note:'后续已取消',steps:[{status:'not_sent',note:'实际对象变化'}]});assert.equal(combo.reason,'实际对象变化');assert.match(combo.disposition,/不会自动补发/);
  assert.doesNotMatch(sendInfo({status:'uncertain',note:'sk-secret '+['','Users','somewhere','a'].join('/')}).reason,/sk-secret|\x2fUsers/);
});
test('真正发送路径在最后账号核对期间发生人工改稿时不点击提交',async()=>{
  const {c}=harness([ready]);let typed=false,changed=false,checks=0,submits=0;
  c.dy.checkAccount=async()=>{if(++checks===2)changed=true;};c.open=async()=>[];c.holdVideos=async()=>{};
  c.editorState=async()=>c.lastEditorState={...ready,text:changed?'人工修改':typed?'公开测试':'',draftCount:typed?1:0};
  c.page.send=async method=>{assert.equal(method,'Input.insertText');typed=true;};c.page.ev=async()=>{submits++;return{x:1,y:1};};
  await assert.rejects(c.send({video:{id:V},text:'公开测试',account:{secUid:'fixture'}}),e=>e.sendAttempted===false&&e.diagnostic.code==='text_changed'&&e.diagnostic.stage==='submit');
  assert.equal(typed,true);assert.equal(submits,0);
});
test('后台 API 展示历史具体原因和结构诊断，私信步骤原因不会漏掉',async t=>{
  const home=mkdtempSync(join(tmpdir(),'dy-diagnostic-dashboard-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const cfg=defaultConfig(),store=new Store(home);atomicJson(join(home,'config.json'),cfg);
  store.data.outbox.push({id:'private',status:'not_sent',kind:'sticker',note:'上传前会话已变化',createdAt:new Date().toISOString()});store.save();
  const ledger=new CommentStore(home),a=ledger.draft('comment',{id:V},null,{text:'隔离界面测试',reason:'fixture',confidence:1});
  ledger.transition(a,'not_sent','已点击占位区，但编辑器未出现',undefined,commentDiagnostic({...empty,text:'SECRET_DRAFT',replyTarget:'SECRET_ID'},{code:'editor_missing',stage:'editor'}));
  const app=createDashboard(home,{port:0}),addr=await app.listen();t.after(()=>new Promise(r=>app.server.close(r)));const base='http://127.0.0.1:'+addr.port,cookie=await dashboardAccess(base,home);
  const dto=await(await fetch(base+'/api/state',{headers:{cookie}})).json();
  assert.equal(dto.comments[0].sendInfo.diagnostic.draftCount,0);assert.match(dto.comments[0].sendInfo.stageLabel,/输入框/);assert.equal(dto.comments[0].sendInfo.terminal,true);
  assert.equal(dto.replies[0].sendInfo.reason,'上传前会话已变化');assert.doesNotMatch(JSON.stringify(dto),/SECRET_DRAFT|SECRET_ID/);
});
test('按精确 CID 回读新顶层评论，不依赖它是否进入热门分页',async()=>{
  const c=new Comments('/unused',{});let mainPages=0;c.dy.fetchInPage=async path=>{
    const u=new URL(path,'https://www.douyin.com');
    if(u.pathname.includes('/list/reply/'))return {comments:[],has_more:0};
    mainPages++;
    assert.equal(u.searchParams.get('insert_ids'),CID);assert.equal(u.searchParams.get('insert_way'),'0');
    assert.equal(u.searchParams.get('count'),'20');assert.equal(u.searchParams.has('item_type'),false);
    return {comments:[{cid:CID,aweme_id:V,reply_id:'0',text:'真实新评论',user:{sec_uid:'owner'}}],has_more:1,cursor:50};
  };
  const rows=await c.readApi({id:V},{id:CID,rootId:CID});assert.equal(rows.find(x=>x.id===CID).text,'真实新评论');assert.equal(mainPages,1);
  c.dy.fetchInPage=async path=>{assert.ok(!path.includes('/list/reply/'));return {comments:[{cid:CID,text:'精确回读'}],has_more:0};};
  assert.equal((await c.readApi({id:V},{id:CID,rootId:CID},{includeReplies:false}))[0].text,'精确回读');
});
