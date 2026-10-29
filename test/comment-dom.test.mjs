import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readCommentsInPage,editorStateInPage,commentControlInPage,noticeControlInPage } from '../src/comment-dom.mjs';

const V='7400000000000000001',ROOT='7400000000000000002',CID='7400000000000000003';
function row(id,parent='0'){
  return {__reactFiber$fixture:{memoizedProps:{commentInfo:{cid:id,replyId:parent,text:'评论',user:{secUid:'peer'}},awemeInfo:{awemeId:V}}},querySelectorAll:()=>[]};
}
const evaluate=(fn,document,arg)=>runInNewContext(`(${fn.toString()})(${arg?JSON.stringify(arg):''})`,{document});
test('同时存在背景评论区和通知弹层时，能读到弹层中的新楼根及回复',()=>{
  const background={querySelectorAll:()=>[row('7400000000000000009')]};
  const modal={querySelectorAll:()=>[row(ROOT),row(CID,ROOT)]};
  const comments=evaluate(readCommentsInPage,{querySelectorAll:()=>[background,modal]});
  assert.equal(comments.find(c=>c.id===CID).rootId,ROOT);
  assert.equal(comments.find(c=>c.id===CID).videoId,V);
});
test('DOM 中的非安全整数 CID 或楼根不能用于发送',()=>{
  const scope={querySelectorAll:()=>[row(9007199254740994),row(CID,9007199254740994)]};
  const comments=evaluate(readCommentsInPage,{querySelectorAll:()=>[scope]});assert.equal(comments.length,0);
});
function editorContainer(text,replyTarget,front){
  const editor={tagName:'DIV',innerText:text,classList:{contains:()=>true},getBoundingClientRect:()=>({x:10,y:10,width:100,height:30})};
  const container={__reactFiber$fixture:{memoizedProps:{value:{currentReplyCid:replyTarget}}},parentElement:null,front,
    contains:hit=>hit===container,querySelectorAll:()=>[editor],getBoundingClientRect:()=>({x:front?100:0,y:0,width:100,height:50})};
  return container;
}
test('使用前景弹层编辑器和回复 cid，同时保留背景的真实草稿保护',()=>{
  const back=editorContainer('用户未发送草稿','',false),front=editorContainer('\u200b',CID,true);
  const document={querySelectorAll:()=>[back,front],elementFromPoint:x=>x>100?front:front};
  const state=evaluate(editorStateInPage,document);
  assert.equal(state.replyTarget,CID);assert.equal(state.text,'');assert.equal(state.anyDraftPresent,true);
});
test('评论框占位点击选择最小的实际文字控件，避免点到外层空白',()=>{
  const rect=(x,width)=>({x,y:0,width,height:20});
  const small={innerText:'留下你的精彩评论吧',getBoundingClientRect:()=>rect(100,120),scrollIntoView(){},contains:hit=>hit===small};
  const wrapper={innerText:small.innerText,getBoundingClientRect:()=>rect(100,700),scrollIntoView(){},contains:hit=>hit===small};
  const container={getBoundingClientRect:()=>rect(100,800),contains:hit=>hit===small,querySelector:()=>null,querySelectorAll:()=>[wrapper,small]};
  const document={querySelectorAll:()=>[container],elementFromPoint:()=>small};
  const point=evaluate(commentControlInPage,document,{kind:'editor'});assert.equal(point.x,160);
});
test('通知入口按稳定评论 cid 定位，不用相同正文误认另一条通知',()=>{
  const element=id=>({innerText:'1',__reactFiber$fixture:{memoizedProps:{noticeInfo:{comment:{cid:id}}}},getBoundingClientRect:()=>({x:id===CID?100:0,y:0,width:20,height:20}),scrollIntoView(){}});
  const document={querySelectorAll:()=>[element('7400000000000000008'),element(CID)]};
  const point=evaluate(noticeControlInPage,document,{kind:'item',targetId:CID,text:'1'});assert.equal(point.x,110);
});
test('数字留言优先点实际正文，不能误点同一通知中的“1分钟前”',()=>{
  const element=(text,x,width)=>({innerText:text,__reactFiber$fixture:{memoizedProps:{noticeInfo:{comment:{cid:CID}}}},getBoundingClientRect:()=>({x,y:0,width,height:20}),scrollIntoView(){}});
  const document={querySelectorAll:()=>[element('1分钟前',0,30),element('1',100,200)]};
  const point=evaluate(noticeControlInPage,document,{kind:'item',targetId:CID,text:'1'});assert.equal(point.x,200);
});
