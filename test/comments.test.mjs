import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommentStore } from '../src/comment-store.mjs';
import { CommentAutomation } from '../src/comment-automation.mjs';
import { numericId,normalizeNotice,normalizeComment,commentVideoIdFromUrl } from '../src/comments.mjs';
import { defaultConfig,validateConfig } from '../src/config.mjs';

const V='7400000000000000001',ROOT='7400000000000000002',CID='7400000000000000003';
const account={secUid:'MS4wLjABAAAA_OWNER'},video={id:V,desc:'手工挂件',url:`https://www.douyin.com/video/${V}`};
const target={id:CID,videoId:V,rootId:ROOT,text:'怎么做的？',authorSecUid:'MS4wLjABAAAA_PEER',createTime:100};
const event={id:`31:${V}:${CID}`,type:31,video,target,parentText:'挂件细节做得挺有意思',createdAt:100};
const decision={shouldPost:true,text:'这个挂件是用什么材料做的？',reason:'具体提问',confidence:0.9};
function harness(t){
  const home=mkdtempSync(join(tmpdir(),'dy-comments-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const cfg=defaultConfig();cfg.account=account;cfg.engagement.enabled=true;
  const state={sends:[],calls:0,events:[],context:[target]};
  const gpt={publicComment:async()=>{state.calls++;return {...decision};}};
  const comments={read:async()=>state.context,notices:async()=>state.events,send:async input=>{state.sends.push(input);return {accepted:true,id:'7400000000000000004',verified:true};}};
  const dy={checkAccount:async()=>({}),detail:async()=>video};
  const service=new CommentAutomation({home,cfg,gpt,comments,dy,store:{data:{videos:[]}},live:true,log:()=>{}});
  return {home,cfg,state,gpt,comments,dy,service};
}
test('旧配置自动补齐关闭的评论功能；拒绝负配额和过密轮询',()=>{
  const cfg=defaultConfig();delete cfg.engagement;validateConfig(cfg);assert.equal(cfg.engagement.enabled,false);
  cfg.engagement.commentsPerDay=-1;assert.throws(()=>validateConfig(cfg));
  cfg.engagement.commentsPerDay=3;cfg.engagement.pollSeconds=1;assert.throws(()=>validateConfig(cfg));
});
test('评论 ID 必须无损，拒绝超出安全范围的数值',()=>{assert.equal(numericId(9007199254740994),'');assert.equal(numericId(CID),CID);});
test('评论弹层的视频 ID 优先于背景页，禁止把回复发到连播切换后的视频',()=>{
  assert.equal(commentVideoIdFromUrl(`https://www.douyin.com/video/${V}?modal_id=${ROOT}`),ROOT);
  assert.equal(commentVideoIdFromUrl(`https://www.douyin.com/video/${V}`),V);
  assert.equal(commentVideoIdFromUrl(`https://example.com/video/${V}`),'');
});
test('回复通知保留楼根，使用 cid 构成稳定去重键',()=>{
  const raw={nid:7674225455733474000,type:31,comment:{aweme_id:V,parent_id:ROOT,comment:{cid:CID,text:target.text,user:{sec_uid:target.authorSecUid}},reply_comment:{cid:ROOT,user:{sec_uid:account.secUid}}}};
  const item=normalizeNotice(raw,account);assert.equal(item.target.rootId,ROOT);assert.equal(item.target.id,CID);assert.equal(item.id,`31:${V}:${CID}`);
});
test('点赞通知、自发评论、不明确的回复楼根不进入自动回复',()=>{
  assert.equal(normalizeNotice({type:41},account),null);
  assert.equal(normalizeNotice({type:31,comment:{aweme_id:V,comment:{cid:CID,user:{sec_uid:target.authorSecUid}}}},account),null);
  assert.equal(normalizeNotice({type:35,comment:{aweme_id:V,comment:{cid:CID,user:{sec_uid:account.secUid}}}},account),null);
});
test('评论区提及通知缺少楼根时保持未知，必须由页面解析而非猜成顶楼',()=>{
  const item=normalizeNotice({type:45,create_time:123,at:{aweme_id:V,comment_id:CID,user_info:{sec_uid:target.authorSecUid}}},account);
  assert.equal(item.target.rootId,'');assert.equal(item.target.createTime,123);
});
test('顶层和楼中楼评论分别保留正确 rootId',()=>{
  assert.equal(normalizeComment({cid:CID,reply_id:'0'},V).rootId,CID);
  assert.equal(normalizeComment({cid:CID,reply_id:ROOT},V).rootId,ROOT);
});
test('同一视频只评论一次，重启后也不重复',async t=>{
  const h=harness(t);await h.service.onVideo(video,{});await h.service.onVideo(video,{});
  h.service.ledger=new CommentStore(h.home);await h.service.onVideo(video,{});
  assert.equal(h.state.sends.length,1);assert.equal(h.service.ledger.count('comment'),1);
});
test('拒绝评论的决定不会反复调用模型，也不占发送配额',async t=>{
  const h=harness(t);h.gpt.publicComment=async()=>{h.state.calls++;return {...decision,shouldPost:false,text:''};};
  await h.service.onVideo(video,{});await h.service.onVideo(video,{});
  assert.equal(h.state.calls,1);assert.equal(h.state.sends.length,0);assert.equal(h.service.ledger.count('comment'),0);
});
test('零评论配额、禁用开关和停止信号都不发送',async t=>{
  const h=harness(t);h.cfg.engagement.commentsPerDay=0;await h.service.onVideo(video,{});
  h.cfg.engagement.commentsPerDay=3;h.cfg.engagement.enabled=false;await h.service.onVideo(video,{});
  h.cfg.engagement.enabled=true;const c=new AbortController();c.abort();await h.service.onVideo(video,{},c.signal);
  assert.equal(h.state.calls,0);assert.equal(h.state.sends.length,0);
});
test('评论冷却期间不对其他视频继续评论',async t=>{
  const h=harness(t);await h.service.onVideo(video,{});await h.service.onVideo({...video,id:'7400000000000000008'},{});assert.equal(h.state.sends.length,1);
});
test('公开发送结果不明时暂停该通道，不重复发',async t=>{
  const h=harness(t);h.comments.send=async()=>{h.state.sends.push({});throw Object.assign(new Error('回执超时'),{sendAttempted:true});};
  await h.service.onVideo(video,{});await h.service.onVideo({...video,id:'7400000000000000009'},{});
  assert.equal(h.state.sends.length,1);assert.equal(h.service.ledger.data.actions[0].status,'uncertain');assert.ok(h.service.ledger.data.halted);
});
test('发送前已有草稿，不算作发送成功或占用配额',async t=>{
  const h=harness(t);h.comments.send=async()=>{throw Object.assign(new Error('已有草稿'),{sendAttempted:false});};
  await h.service.onVideo(video,{});assert.equal(h.service.ledger.data.actions[0].status,'not_sent');assert.equal(h.service.ledger.count('comment'),0);
});
test('崩溃遗留 sending 评论按不确定处理，不能自动重发',t=>{
  const h=harness(t),a=h.service.ledger.draft('comment',video,null,decision);h.service.ledger.transition(a,'sending');
  const ledger=new CommentStore(h.home);ledger.recover();assert.equal(ledger.data.actions[0].status,'uncertain');assert.ok(ledger.data.halted);
});
test('首次只记录评论通知基线，不补回历史通知',async t=>{
  const h=harness(t);h.state.events=[event];await h.service.poll(undefined,{force:true});assert.equal(h.state.calls,0);assert.ok(h.service.ledger.data.seen.includes(event.id));
});
test('新通知回复正确 cid 和楼根，之后不重复',async t=>{
  const h=harness(t);h.service.ledger.baseline([]);h.state.events=[event];
  await h.service.poll(undefined,{force:true});await h.service.poll(undefined,{force:true});
  assert.equal(h.state.sends.length,1);assert.equal(h.state.sends[0].target.id,CID);assert.equal(h.state.sends[0].target.rootId,ROOT);assert.equal(h.service.ledger.count('reply'),1);
});
test('目标评论正文或身份变了，不生成也不发送回复',async t=>{
  const h=harness(t);h.service.ledger.baseline([]);h.state.events=[event];h.state.context=[{...target,authorSecUid:'someone-else'}];
  await h.service.poll(undefined,{force:true});assert.equal(h.state.calls,0);assert.equal(h.state.sends.length,0);assert.equal(h.service.ledger.data.seen.includes(event.id),false);
});
test('提及通知的未知楼根与正文从同一作者的真实 DOM 评论解析',async t=>{
  const h=harness(t);h.service.ledger.baseline([]);h.state.events=[{...event,type:45,target:{...target,rootId:'',text:''}}];
  await h.service.poll(undefined,{force:true});assert.equal(h.state.sends.length,1);assert.equal(h.state.sends[0].target.rootId,ROOT);assert.equal(h.state.sends[0].target.text,target.text);
});
test('自己已经在该楼回复过，不再插入重复回复',async t=>{
  const h=harness(t);h.service.ledger.baseline([]);const top={...target,id:ROOT,rootId:ROOT};h.state.events=[{...event,target:top}];h.state.context=[top,{id:CID,rootId:ROOT,authorSecUid:account.secUid,createTime:101}];
  await h.service.poll(undefined,{force:true});assert.equal(h.state.sends.length,0);assert.equal(h.state.calls,0);
});
test('通知读取失败不建立空基线，不影响现有消息记录',async t=>{
  const h=harness(t);h.comments.notices=async()=>{throw new Error('网络失败');};await h.service.poll(undefined,{force:true});assert.equal(h.service.ledger.data.initialized,false);
});
test('评论预览不发消息，也不写发送去重记录',async t=>{
  const h=harness(t);h.service.live=false;await h.service.onVideo(video,{});assert.equal(h.state.sends.length,0);assert.equal(h.service.ledger.data.actions.length,0);assert.equal(h.service.previews.length,1);
});
test('直接调用提交入口也必须受预览、开关和模型决定约束',async t=>{
  const h=harness(t);h.service.live=false;await h.service.submit('comment',video,null,decision);
  h.service.live=true;h.cfg.engagement.enabled=false;await h.service.submit('comment',video,null,decision);
  h.cfg.engagement.enabled=true;await h.service.submit('comment',video,null,{...decision,shouldPost:false});
  assert.equal(h.state.sends.length,0);assert.equal(h.service.ledger.data.actions.length,0);
});
test('评论状态损坏不会静默归零',t=>{const h=harness(t);writeFileSync(join(h.home,'comments.json'),'{bad');assert.throws(()=>new CommentStore(h.home));});
