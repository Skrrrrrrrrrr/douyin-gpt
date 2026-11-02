import {NativeStickerSender} from './native-stickers.mjs';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {sameMessageWindow} from './message-snapshot.mjs';
import {Douyin} from './douyin.mjs';
import {sleep} from './browser.mjs';
import {currentConvId,readMessages} from '../vendor/newjo/im-send.mjs';
import {stickerUploadStateInPage} from './sticker-dom.mjs';
const ev=(page,fn)=>fn(expression=>page.ev(expression));
export class StickerSender{
 constructor({home,browser,messenger,account,guard=()=>false,signal}){Object.assign(this,{home,browser,messenger,account,guard,signal});}
 async send(contact,asset,expected){
  if(asset.transport==='douyin_sticker')return new NativeStickerSender(this).send(contact,asset,expected);
  let attempted=false,clicked=false;const fail=message=>{throw new Error(message);};
  try{
   if(!contact.enabled||!Array.isArray(expected)||!expected.length||!asset.available)fail('发送表情缺少授权对象或可靠快照');
   const file=readFileSync(asset.file);if(createHash('sha256').update(file).digest('hex')!==asset.sha256)fail('表情文件在选用后发生变化');
   await new Douyin(this.home,this.browser).checkAccount(this.account);
   const before=await this.messenger.read(contact);if(!sameMessageWindow(before,expected))fail('准备表情期间会话有新消息或本人已回复');
   const page=await this.browser.page('chat','https://www.douyin.com/chat');if(this.browser.headless)await page.send('Page.bringToFront');
   const verify=async()=>{if(this.signal?.aborted||this.guard())fail('本人已接管或程序已停止');if(await ev(page,currentConvId)!==contact.secUid)fail('表情发送前联系人稳定 ID 不匹配');};
   await verify();let state=await page.ev(`(${stickerUploadStateInPage.toString()})(${JSON.stringify({sha256:asset.sha256,maxBytes:asset.bytes})})`);
   if(!state.ready||state.editorText||state.mediaDraft||state.preview.length)fail('聊天已有草稿或其他弹窗，未上传表情');
   const expectedKind=asset.mediaKind||(asset.format==='mp4'?'video':'image');const extension=asset.format==='jpeg'?'.jpg':'.'+asset.format;if(!state.accept.includes(extension))fail('网页版当前不接受这类表情图片');
   const {root}=await page.send('DOM.getDocument',{depth:0});const {nodeIds}=await page.send('DOM.querySelectorAll',{nodeId:root.nodeId,selector:'[class*="componentsRightPanel"] input[type="file"].semi-upload-hidden-input'});if(nodeIds.length!==1)fail('不能唯一定位当前会话的图片上传入口');
   const justBefore=await ev(page,readMessages);if(!sameMessageWindow(justBefore.slice().reverse().slice(-60),expected))fail('上传前会话已变化');
   await verify();attempted=true;
   await page.send('DOM.setFileInputFiles',{nodeId:nodeIds[0],files:[asset.file]});
   const ids=new Set(before.map(m=>m.id));
   for(let i=0;i<90;i++){
    await sleep(350);if(this.signal?.aborted)fail('表情发送期间停止，结果需核对');
    if(await ev(page,currentConvId)!==contact.secUid)fail('上传后会话发生切换，结果需核对');
    const messages=await ev(page,readMessages),fresh=messages.filter(m=>m.from==='me'&&!ids.has(m.id)&&m.mediaKind===expectedKind&&m.serverConfirmed);
    if(fresh.length===1)return {sent:true,readback:true,messageId:fresh[0].id,kind:expectedKind==='video'?'voice_card':'sticker',assetId:asset.id,sha256:asset.sha256,verifiedBy:'approved-file-selection+new-own-server-'+expectedKind+'-id'};
    if(fresh.length>1)fail('出现多条新图片，无法唯一确认本次表情');
    state=await page.ev(`(${stickerUploadStateInPage.toString()})(${JSON.stringify({sha256:asset.sha256,maxBytes:asset.bytes})})`);
    if(/上传失败|发送失败|文件过大|超过.{0,8}(?:大小|限制)|格式不支持|安全验证|验证码/.test(state.alerts+state.title))fail('平台未完成图片发送，请核对聊天页提示');
    if(!clicked&&state.preview.length){const modal=state.preview.length===1?state.preview[0]:null,selected=state.selected.some(f=>f.name===asset.filename&&f.size===asset.bytes),owned=modal&&modal.images+(modal.videos||0)>0&&(modal.fileMatched||modal.text.includes(asset.filename)||selected);
     if(state.preview.length>1)fail('出现多个图片预览，保留待处理');if(!owned||!modal.button)continue;
     await new Douyin(this.home,this.browser).checkAccount(this.account);await verify();const latest=await ev(page,readMessages);if(!sameMessageWindow(latest.slice().reverse().slice(-60),expected))fail('点击图片发送前出现新消息或人工回复');
     clicked=true;for(const type of ['mousePressed','mouseReleased'])await page.send('Input.dispatchMouseEvent',{type,...modal.button,button:'left',clickCount:1});
    }
   }
   fail('未在本人消息中回读到唯一的服务器图片 ID，暂停该会话核对');
  }catch(error){error.sendAttempted=attempted;throw error;}
 }
}
