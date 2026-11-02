import {sleep} from './browser.mjs';
import {groupDomInPage} from './group-dom.mjs';
import {validGroup,groupWindowCompatible,groupReceipt} from './group-policy.mjs';
const fail=(message,attempted=false,code='')=>Object.assign(new Error(message),{sendAttempted:attempted,code});
export class GroupMessenger {
 constructor(home,browser,dy){Object.assign(this,{home,browser,dy});this.wait=sleep;}
 async page(){return this.browser.page('chat','https://www.douyin.com/chat');}
 async inspect(op,options={}){const p=await this.page();return p.ev(`(${groupDomInPage.toString()})(${JSON.stringify({op,...options})})`);}
 async list(){return (await this.inspect('list')).filter(validGroup);}
 async click(point){if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))throw fail('群控件无法定位');if(this.signal?.aborted)throw fail('群操作已停止');const p=await this.page();for(const type of ['mousePressed','mouseReleased'])await p.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});}
 async current(group){const c=await this.inspect('current');return validGroup(c)&&c.id===group.id&&c.shortId===group.shortId;}
 async open(group){
  if(!validGroup(group))throw fail('群稳定身份或成员资格不可验证');
  if(await this.current(group))return;
  if((await this.inspect('editor')).hasDraft)throw fail('当前聊天有未发送草稿，已保留');
  await this.click(await this.inspect('row',group));
  for(let i=0;i<40;i++){if(this.signal?.aborted)throw fail('群操作已停止');if(await this.current(group))return;await this.wait(150);}
  throw fail('打开群后稳定身份未匹配，已停止');
 }
 async read(group,account){await this.open(group);const data=await this.inspect('messages',{...group,ownUid:account.uid,ownSecUid:account.secUid});if(!data.verified)throw fail('群会话身份已变化');return data.messages;}
 async clearOwnDraft(group,text){if(!await this.current(group))return;const s=await this.inspect('editor');if(s.text!==text.trim()||!s.editor)return;const p=await this.page();for(const type of ['mousePressed','mouseReleased'])await p.send('Input.dispatchMouseEvent',{type,...s.editor,button:'left',clickCount:1});const check=await this.inspect('editor');if(!await this.current(group)||check.text!==text.trim())return;for(const type of ['rawKeyDown','keyUp'])await p.send('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',modifiers:process.platform==='darwin'?4:2,windowsVirtualKeyCode:65});for(const type of ['rawKeyDown','keyUp'])await p.send('Input.dispatchKeyEvent',{type,key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});}
 async send(group,text,expected,triggerIds,account){
  let attempted=false,typed=false;const p=await this.page();
  try{
   if(typeof text!=='string'||!text.trim()||[...text].length>500)throw fail('群回复文字无效');
   await this.dy.checkAccount(account);await this.open(group);
   const before=await this.read(group,account);if(!groupWindowCompatible(before,expected,triggerIds,account))throw fail('群里出现新点名或人工回复，本次旧草稿取消');
   let state=await this.inspect('editor');if(state.hasDraft)throw fail('群输入框已有草稿，已保留');
   if(!state.editor)throw fail('群输入框不可用，请核对群发言权限');
   await this.click(state.editor);await this.wait(100);
   if(!await this.current(group))throw fail('输入前群身份发生变化');
   typed=true;await p.send('Input.insertText',{text});await this.wait(200);
   state=await this.inspect('editor');if(state.text!==text.trim())throw fail('群输入框文字与计划不一致');
   await this.dy.checkAccount(account);const fresh=await this.read(group,account);
   if(!groupWindowCompatible(fresh,expected,triggerIds,account))throw fail('发送前群里出现新点名或人工回复，旧回复取消');
   if(!await this.current(group)||this.signal?.aborted)throw fail('群身份或运行状态已变化');
   const oldIds=new Set(before.map(m=>m.id));attempted=true;
   for(const type of ['rawKeyDown','keyUp'])await p.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
   for(let i=0;i<50;i++){
    await this.wait(250);if(!await this.current(group))throw fail('提交后群会话发生变化，结果待核对',true);
    const rows=await this.read(group,account),hits=rows.filter(m=>m.from==='me'&&!oldIds.has(m.id)&&m.text.trim()===text.trim());
    if(hits.length>1)throw fail('出现多条相同群回复，无法唯一确认',true);
    if(hits.length===1){const result=groupReceipt(hits[0]);if(result.code!==null&&!result.accepted)throw fail(result.reason,true,'group_rejected_'+result.code);if(result.accepted)return {...result,via:'native-group-editor+server-callback',groupId:group.id,groupShortId:group.shortId};}
    const s=await this.inspect('editor');if(/禁言|发送失败|安全验证|验证码/.test(s.alerts))throw fail('平台提示群消息未完成，请核对',true);
   }
   throw fail('群消息未收到可靠平台回执，已停止自动重发',true,'group_receipt_unknown');
  }catch(error){error.sendAttempted??=attempted;if(!attempted&&typed)try{await this.clearOwnDraft(group,text);}catch{}throw error;}
 }
}
