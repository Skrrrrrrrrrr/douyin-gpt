import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, writePrivate } from './config.mjs';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {snapshotMessages} from './message-snapshot.mjs';
import {StickerSender} from './sticker-sender.mjs';
import {messageMediaInPage,fetchMessageAssetInPage,messageImageClipInPage} from './message-media.mjs';

export class Messenger {
  constructor(home, browser) { this.home = home; this.browser = browser; }
  async call(args) {
    const chat=await this.browser.page('chat', 'https://www.douyin.com/chat');
    if(this.browser.headless)await chat.send('Page.bringToFront');
    const raw = await new Promise((resolve, reject) => {
      execFile(process.execPath, [join(ROOT, 'vendor/newjo/im-send.mjs'), ...args], {
        env: { ...process.env, DOUYIN_GPT_HOME: this.home },
        encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
        signal: this.signal,
      }, (error, stdout) => {
        if (stdout) resolve(stdout);
        else reject(new Error(error?.killed ? '私信读取/发送超时' : '私信适配器未返回结果'));
      });
    });
    let result;
    try { result = JSON.parse(raw); } catch { throw new Error('私信适配器返回无效 JSON'); }
    if (!result.ok) throw Object.assign(new Error(result.error || '私信操作失败'),{sendAttempted:typeof result.send_attempted==='boolean'?result.send_attempted:undefined,ownDraftTyped:result.typed_by_adapter===true});
    return result;
  }
  async contacts() { return (await this.call(['--list'])).people || []; }
  async composePreflight(contact){
    const {currentConvId}=await import('../vendor/newjo/im-send.mjs');const page=await this.browser.page('chat','https://www.douyin.com/chat');
    if(await currentConvId(e=>page.ev(e))!==contact.secUid)throw Object.assign(new Error('私信会话已变化，等待下一轮重新读取'),{code:'COMPOSE_CHANGED',sendAttempted:false});
    const state=await page.ev(`(()=>{const panel=document.querySelector('[class*=componentsRightPanel]');const editors=[...(panel?.querySelectorAll('[contenteditable=true],textarea')||[])].filter(n=>{const r=n.getBoundingClientRect();return r.width>80&&r.height>10});return {ready:editors.length===1,draft:editors.some(n=>!!String(n.innerText||n.value||'').replace(/[\\u200b\\u2060\\ufeff\\r]/g,'').trim()||!!n.querySelector('img,video,[data-entity-type="IMAGE"]'))};})()`);
    if(!state.ready||state.draft)throw Object.assign(new Error(state.draft?'私信框已有草稿，保留原样并等待处理':'私信输入框尚未就绪，等待下一轮'),{code:state.draft?'COMPOSE_DRAFT':'COMPOSE_NOT_READY',sendAttempted:false});return true;
  }
  async read(contact) {
    const result = await this.call(['--read', '--to-id', contact.secUid, '--to', contact.label]);
    if (result.to_sec_uid !== contact.secUid || !result.verified_open) throw new Error('聊天会话身份无法核对');
    return result.messages || [];
  }
  async media(contact,id){const current=await this.call(['--read','--to-id',contact.secUid,'--to',contact.label]);if(!current.verified_open||current.to_sec_uid!==contact.secUid||!current.messages?.some(m=>m.id===id&&m.from==='them'))throw new Error('媒体消息身份无法核对');const page=await this.browser.page('chat','https://www.douyin.com/chat');return page.ev(`(${messageMediaInPage.toString()})(${JSON.stringify({id})})`);}
  async mediaBytes(contact,options){if(!contact.enabled)throw new Error('联系人未授权');const page=await this.browser.page('chat','https://www.douyin.com/chat');try{const result=await page.ev(`(${fetchMessageAssetInPage.toString()})(${JSON.stringify(options)})`);if(options.kind==='image'&&!/^image\/(png|jpeg|webp)(?:;|$)/i.test(result.mime))throw new Error('需要读取浏览器中的图片抽样帧');return result;}catch(error){if(options.kind!=='image')throw error;const clip=await page.ev(`(${messageImageClipInPage.toString()})(${JSON.stringify({id:options.messageId,url:options.url})})`);if(!clip)throw new Error('图片暂不可读取，保留消息待处理');const result=await page.send('Page.captureScreenshot',{format:'png',clip,captureBeyondViewport:false});return {mime:'image/png',data:result.data,sampledFrame:true};}}
  async sendSticker(contact,asset,expectedMessages,options={}){return new StickerSender({home:this.home,browser:this.browser,messenger:this,signal:this.signal,...options}).send(contact,asset,expectedMessages);}
  async clearOwnDraft(contact,text){
    const {currentConvId,normalizeEditorText}=await import('../vendor/newjo/im-send.mjs');const page=await this.browser.page('chat','https://www.douyin.com/chat');if(await currentConvId(e=>page.ev(e))!==contact.secUid)throw new Error('草稿联系人无法核对');
    const draft=await page.ev(`(()=>{const panel=document.querySelector('[class*=componentsRightPanel]'),es=[...(panel?.querySelectorAll('[contenteditable=true],textarea')||[])];const e=es.find(n=>n.getBoundingClientRect().width>80&&n.getBoundingClientRect().height>10);if(!e)return null;const r=e.getBoundingClientRect();return {text:e.innerText||e.value||'',x:r.x+r.width/2,y:r.y+r.height/2};})()`);if(!draft||normalizeEditorText(draft.text)!==normalizeEditorText(text))throw new Error('草稿不属于本次未发送回复，保留原样');
    for(const type of ['mousePressed','mouseReleased'])await page.send('Input.dispatchMouseEvent',{type,x:draft.x,y:draft.y,button:'left',clickCount:1});
    for(const type of ['rawKeyDown','keyUp'])await page.send('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',modifiers:process.platform==='darwin'?4:2,windowsVirtualKeyCode:65});
    for(const type of ['rawKeyDown','keyUp'])await page.send('Input.dispatchKeyEvent',{type,key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
    const left=await page.ev(`(()=>{const e=document.querySelector('[class*=componentsRightPanel] [contenteditable=true],[class*=componentsRightPanel] textarea');return e?.innerText||e?.value||''})()`);if(normalizeEditorText(left))throw new Error('草稿尚未清空');return true;
  }
  async send(contact, text, expectedMessages) {
    if (!Array.isArray(expectedMessages) || !expectedMessages.length) throw new Error('发送缺少待回复会话快照');
    // 正文不进进程参数列表；临时文件权限为 0600。
    const file = join(this.home, `outgoing-${randomUUID()}.txt`);
    const expectedFile = file + '.json';
    writePrivate(file, text);
    try {
      writePrivate(expectedFile, JSON.stringify(snapshotMessages(expectedMessages)));
      const result = await this.call(['--to-id', contact.secUid, '--to', contact.label, '--file', file, '--expected-file', expectedFile]);
      if (!result.sent || !result.readback || result.to_sec_uid !== contact.secUid) throw new Error('未确认发出的消息');
      return result;
    } catch(error){if(error.sendAttempted===true){const norm=x=>String(x||'').replace(/\s+/g,' ').trim(),oldIds=new Set(expectedMessages.flatMap(m=>[m.id,...(m.aliases||[])]));for(let i=0;i<5;i++){try{const messages=await this.read(contact),matches=messages.filter(m=>m.from==='me'&&m.serverConfirmed&&!oldIds.has(m.id)&&norm(m.text)===norm(text));if(matches.length===1)return {sent:true,readback:true,messageId:matches[0].id,serverConfirmed:true,verifiedBy:'fresh-native-server-id-after-delayed-confirmation'};if(matches.length>1)break;}catch{break;}await new Promise(r=>setTimeout(r,1000));}}if(error.sendAttempted===false&&error.ownDraftTyped)try{await this.clearOwnDraft(contact,text);}catch{error.message+='；本任务草稿尚需核对';}throw error;
    } finally { for (const path of [file, expectedFile]) { try { unlinkSync(path); } catch {} } }
  }
}
