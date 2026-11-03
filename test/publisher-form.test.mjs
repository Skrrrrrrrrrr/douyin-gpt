import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {Publisher,publisherSnapshotInPage,publisherControlInPage} from '../src/publisher.mjs';
import {defaultConfig} from '../src/config.mjs';

const titleSelector='input[placeholder="填写作品标题，为作品获得更多流量"]';
const post='https://creator.douyin.com/creator-micro/content/post/video';
function element({value='',text='',shown=true,disabled=false,readOnly=false}={}){
 return {value,innerText:text,disabled,readOnly,shown,scrollIntoView(){},getBoundingClientRect:()=>({x:0,y:0,width:shown?100:0,height:shown?30:0})};
}
function inPage(fn,{titles=[],editors=[],title='抖音创作者中心'}={},arg){
 const document={title,body:{innerText:'重新上传'},querySelector:()=>null,querySelectorAll:selector=>selector===titleSelector?titles:selector==='[contenteditable=true]'?editors:[]};
 return runInNewContext('('+fn.toString()+')('+JSON.stringify(arg)+')',{document,location:{href:post},getComputedStyle:()=>({display:'block',visibility:'visible'})});
}
test('发布快照使用唯一可见字段，隐藏的旧字段不能冒充当前标题',()=>{
 const view=inPage(publisherSnapshotInPage,{titles:[element({value:'隐藏旧稿',shown:false}),element({value:'本期标题'})],editors:[element({text:'本期描述'})]});
 assert.equal(view.formReady,true);assert.equal(view.title,'本期标题');assert.equal(view.description,'本期描述');assert.equal(view.titleCandidates,1);
});
test('重复、只读、禁用或尚未挂载的字段均不能判为发布表单就绪',()=>{
 for(const fields of [
  {titles:[],editors:[element()]},
  {titles:[element(),element()],editors:[element()]},
  {titles:[element()],editors:[element(),element()]},
  {titles:[element({disabled:true})],editors:[element()]},
  {titles:[element()],editors:[element({readOnly:true})]},
 ])assert.equal(inPage(publisherSnapshotInPage,fields).formReady,false);
});
test('填写定位拒绝多个可见控件和不可编辑字段，不能选第一个猜测',()=>{
 for(const titles of [[element(),element()],[element({readOnly:true})],[element({disabled:true})]])assert.equal(inPage(publisherControlInPage,{titles},{selector:titleSelector}),null);
 assert.ok(inPage(publisherControlInPage,{titles:[element({shown:false}),element()]},{selector:titleSelector}));
});
function fixture({existing=false,readyAfter=2,foreign=false,challenge=false}={}){
 const cfg=defaultConfig(),state={day:'2026-11-03',status:'rendered',fingerprint:'fixture',videoPath:'/fixture/video.mp4',title:'本期标题',description:'本期公开描述'};
 let phase=existing?'post':'upload',ticks=0,title='',description='',navigations=0,uploads=0;const fills=[],saved=[];
 const publisher=new Publisher('/fixture',cfg,{navigate:async()=>{navigations++;phase='upload';}},{wait:async()=>{ticks++;},formTimeoutMs:750,formPollMs:250,log:()=>{}});
 publisher.dy.checkAccount=async()=>{};
 const page={ev:async()=>true,send:async method=>{if(method==='DOM.getDocument')return {root:{nodeId:1}};if(method==='DOM.querySelector')return {nodeId:2};if(method==='DOM.setFileInputFiles'){uploads++;phase='post';}return {};}};
 publisher.attach=async()=>page;
 publisher.snapshot=async()=>({url:phase==='post'?post:'https://creator.douyin.com/creator-micro/content/upload',formReady:phase==='post'&&ticks>=readyAfter,requiresUser:challenge,title:foreign&&ticks>=readyAfter?'其他人的草稿':title,description,aiDeclared:true,text:'重新上传\n作者声明：内容由AI生成',checks:[{label:'公开',checked:true},{label:'立即发布',checked:true}],publishEnabled:true,scheduled:'',links:[]});
 publisher.fill=async(selector,value)=>{assert.ok(ticks>=readyAfter,'字段就绪之前不得输入');fills.push(selector);if(selector===titleSelector)title=value;else description=value;};
 publisher.click=async()=>{throw new Error('本回归不得点击任何发布控件');};
 publisher.save=state=>saved.push(structuredClone(state));
 return {publisher,state,fills,saved,counts:()=>({ticks,navigations,uploads})};
}
test('上传后仅URL变化和发布按钮出现不足以继续，等待标题与描述挂载后再填写',async()=>{
 const h=fixture();await h.publisher.prepare(h.state);assert.equal(h.counts().ticks,2);assert.equal(h.counts().uploads,1);assert.equal(h.fills.length,2);assert.deepEqual(h.saved.map(s=>s.status),['uploading','prepared']);
});
test('表单始终未就绪时有限等待，保留已上传状态，不输入或点击发布',async()=>{
 const h=fixture({readyAfter:Infinity});await assert.rejects(h.publisher.prepare(h.state),e=>e.code==='PUBLISH_FORM_NOT_READY');assert.equal(h.counts().ticks,2);assert.equal(h.fills.length,0);assert.deepEqual(h.saved.map(s=>s.status),['uploading']);
});
test('已有发布页慢加载时先核对旧稿，不因初始空DOM而覆盖或重新上传',async()=>{
 const h=fixture({existing:true,foreign:true});await assert.rejects(h.publisher.prepare(h.state),/不会覆盖/);assert.equal(h.counts().navigations,0);assert.equal(h.counts().uploads,0);assert.equal(h.fills.length,0);assert.equal(h.saved.length,0);
});
test('复用上传也要等待读取旧标题，其他标题的草稿不能复用',async()=>{
 const h=fixture({existing:true,foreign:true});await assert.rejects(h.publisher.prepare(h.state,{reuseUpload:true}),/标题不匹配/);assert.equal(h.counts().uploads,0);assert.equal(h.fills.length,0);
});
test('验证码即使与可见字段同时出现也先拦截，不等待或填写',async()=>{
 const h=fixture({existing:true,challenge:true,readyAfter:0});await assert.rejects(h.publisher.prepare(h.state),e=>e.code==='PLATFORM_VERIFICATION');assert.equal(h.counts().ticks,0);assert.equal(h.fills.length,0);assert.equal(h.counts().navigations,0);
});
test('非创作者中心页面不能因伪装表单就绪而通过',async()=>{
 const h=fixture();h.publisher.snapshot=async()=>({url:'https://foreign.example/creator-micro/content/post/video',formReady:true});await assert.rejects(h.publisher.waitForForm(),e=>e.code==='PUBLISH_FORM_NOT_READY');assert.equal(h.fills.length,0);
});
