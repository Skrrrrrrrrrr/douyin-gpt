import {sameMessageWindow} from './message-snapshot.mjs';
import {stampMessages,preferences,quietNow} from './conversation-policy.mjs';
import {Takeover} from './takeover.mjs';
import {StickerLibrary} from './stickers.mjs';
import {allowedReplyContact} from './reply-audience.mjs';
export class PrivateDelivery{
 constructor({home,cfg,store,messenger,dy,mediaResolver,authorize,signal,log=()=>{}}){Object.assign(this,{home,cfg,store,messenger,dy,mediaResolver,authorize,signal,log});this.takeover=new Takeover(home,cfg);this.stickers=new StickerLibrary(home,cfg);}
 async execute(contact,item){
  if(this.signal?.aborted)return item;
  if(this.authorize&&!await this.authorize(contact)){this.store.cancelPending(item,'联系人授权或好友关系已变化，未发送');return item;}
  if(!allowedReplyContact(this.home,this.cfg,contact.secUid)){this.store.cancelPending(item,'联系人已停用或好友关系未核对');return item;}
  if(Date.now()-Date.parse(item.createdAt)>this.cfg.reply.delivery.continueMinutes*60000){this.store.cancelPending(item,'组合回复已超过续发时间');return item;}
  for(let index=0;index<item.steps.length;index++){
   const step=item.steps[index];if(step.status!=='pending')continue;
   if(this.signal?.aborted)return item;
   if(this.authorize&&!await this.authorize(contact)){this.store.cancelPending(item,'联系人授权或好友关系已变化，未发送');return item;}
   if(this.takeover.get(contact.secUid).active||quietNow(preferences(this.cfg,contact)))return item;
   const fresh=await this.messenger.read(contact),ownIds=new Set(item.steps.filter(s=>s.status==='sent').map(s=>s.receipt?.messageId).filter(Boolean));
   if(item.baseMessages?!sameMessageWindow(fresh.filter(m=>!ownIds.has(m.id)),item.baseMessages):stampMessages(fresh.filter(m=>!ownIds.has(m.id)))!==item.baseStamp){this.store.cancelPending(item,'会话有新消息或人工回复，后续步骤已取消');return item;}
   if(this.store.quota(contact.secUid,this.cfg.reply)<=0)return item;
   let asset=null;
   if(step.kind==='sticker'){asset=this.stickers.choose(step.sticker.id,item.provider,this.store.data.outbox,contact.secUid);if(!asset||asset.sha256!==step.sticker.sha256){this.store.cancelPending(item,'表情已变化或触发限频');return item;}}
   if(step.kind==='voice_card'){asset=await this.mediaResolver(step.card.id);if(!asset||asset.sha256!==step.card.sha256){this.store.cancelPending(item,'语音卡文件与已选版本不一致');return item;}}
   await this.dy.checkAccount(this.cfg.account);
   if(this.authorize&&!await this.authorize(contact)){this.store.cancelPending(item,'好友关系已变化，后续回复已取消');return item;}
   if(this.signal?.aborted||this.takeover.get(contact.secUid).active)return item;
   this.store.step(item,index,'sending');
   try{
    let receipt;
    if(step.kind==='text')receipt=await this.messenger.send(contact,step.text,fresh);
    else receipt=await this.messenger.sendSticker(contact,asset,fresh,{account:this.cfg.account,guard:()=>this.takeover.get(contact.secUid).active});
    this.store.step(item,index,'sent',receipt||{});
    this.log(`已回复 ${contact.label}（步骤 ${index+1}/${item.steps.length}）`);
   }catch(error){
    if(error.sendAttempted===false){this.store.step(item,index,'not_sent',null,error.message);this.store.cancelPending(item,'发送前被拦截，后续已取消');}
    else this.store.step(item,index,'uncertain',null,error.message);
    return item;
   }
  }
  return item;
 }
}
export function textPlan(text,messages){return {baseStamp:stampMessages(messages),steps:[{kind:'text',text}]};}
