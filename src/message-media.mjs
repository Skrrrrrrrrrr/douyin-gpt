import {allowedReplyContact} from './reply-audience.mjs';
import {mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {VideoUnderstanding} from './understanding.mjs';
import {atomicJson} from './store.mjs';
export function mediaUrl(value){try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||!['douyin.com','douyincdn.com','douyinstatic.com','douyinpic.com','byteimg.com','bytecdn.cn','amemv.com','ibytedtos.com','bytecdn.com'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))return '';return u.href;}catch{return '';}}
// Called only inside an already verified, allowlisted conversation.
export function messageMediaInPage({id}){
 const nodes=[...document.querySelectorAll('[class*="messageMessageBox"]')];
 for(const node of nodes){const key=Object.keys(node).find(k=>k.startsWith('__reactFiber$'));let fiber=key&&node[key],message;
  for(let i=0;fiber&&i<24;i++,fiber=fiber.return)if(fiber.memoizedProps?.message?.parsedContent){message=fiber.memoizedProps.message;break;}
  const raw=message&&(message.serverId||message.serverMessageId||message.server_id||message.messageId||message.message_id||message.clientMessageId||message.clientId||message.id);
  if(String(raw)!==id)continue;
  const pc=message.parsedContent||{},items=[];if(pc.itemId)return [];
  for(const audio of node.querySelectorAll('audio'))if(audio.currentSrc||audio.src)items.push({kind:'audio',url:audio.currentSrc||audio.src,seconds:Number.isFinite(audio.duration)?audio.duration:0});
  if(message.type===17&&pc.resource_url&&Array.isArray(pc.resource_url.url_list)&&typeof pc.resource_url.url_list[0]==='string')items.push({kind:'audio',url:pc.resource_url.url_list[0],seconds:Math.max(0,Number(pc.duration)||0)/1000});
  const voice=pc.audio||pc.voice||pc.audioInfo||pc.voiceInfo;const voiceUrl=voice&&(voice.url||voice.url_list?.[0]||voice.urlList?.[0]||voice.audioUrl||voice.audio_url||voice.playUrl);if(voiceUrl)items.push({kind:'audio',url:voiceUrl,seconds:Number(voice.durationMs||voice.duration_ms||0)/1000});
  for(const image of node.querySelectorAll('img')){const r=image.getBoundingClientRect(),src=image.currentSrc||image.src;if(r.width>=70&&r.height>=70&&src&&!/avatar/i.test(image.className+' '+image.alt))items.push({kind:'image',url:src});}
  return items.filter((v,i,a)=>a.findIndex(x=>x.url===v.url)===i).slice(0,3);
 }
 return [];
}
export function messageImageClipInPage({id,url}){for(const node of document.querySelectorAll('[class*="messageMessageBox"]')){const key=Object.keys(node).find(k=>k.startsWith('__reactFiber$'));let f=key&&node[key],message;for(let i=0;f&&i<24;i++,f=f.return)if(f.memoizedProps?.message?.parsedContent){message=f.memoizedProps.message;break;}const raw=message&&(message.serverId||message.serverMessageId||message.server_id||message.messageId||message.message_id||message.clientMessageId||message.clientId||message.id);if(String(raw)!==id)continue;for(const im of node.querySelectorAll('img'))if((im.currentSrc||im.src)===url){const r=im.getBoundingClientRect();if(r.width>=70&&r.height>=70&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight)return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1};}}return null;}
export async function fetchMessageAssetInPage({url,maxBytes}){
 const u=new URL(url);if(!(url.startsWith('blob:https://www.douyin.com/')||u.protocol==='https:'&&!u.username&&!u.password&&['douyin.com','douyincdn.com','douyinstatic.com','douyinpic.com','byteimg.com','bytecdn.cn','amemv.com','ibytedtos.com','bytecdn.com'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h))))throw new Error('媒体地址不属于抖音资源域');
 const response=await fetch(url,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error('私信媒体暂不可读取');if(Number(response.headers.get('content-length'))>maxBytes)throw new Error('私信媒体超过大小限制');
 const reader=response.body.getReader(),chunks=[];let total=0;while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>maxBytes){await reader.cancel();throw new Error('私信媒体超过大小限制');}chunks.push(value);}
 const blob=new Blob(chunks,{type:response.headers.get('content-type')||''});return {mime:blob.type,data:await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=reject;r.readAsDataURL(blob);})};
}
export class MessageMedia {
 constructor(home,cfg,messenger,{transcriber}={}){Object.assign(this,{home,cfg,messenger});this.transcriber=transcriber||new VideoUnderstanding(home,cfg);mkdirSync(join(home,'message-media'),{recursive:true,mode:0o700});}
 async enrich(contact,incoming,signal){
  if(!this.cfg.reply.media.enabled)return {messages:incoming,images:[]};
  if(!Boolean(allowedReplyContact(this.home,this.cfg,contact.secUid)))throw new Error('媒体联系人未授权');
  const messages=[],images=[];
  for(const m of incoming){
   if(signal?.aborted)throw new Error('媒体读取已停止');
   if(!m.mediaAvailable){messages.push(m);continue;}
   const key=createHash('sha256').update(contact.secUid+'\0'+m.id).digest('hex'),file=join(this.home,'message-media',key+'.json'),failureFile=file+'.failure.json';
   if(existsSync(failureFile)){const failure=JSON.parse(readFileSync(failureFile,'utf8'));if(failure.retryAt>Date.now())throw new Error('媒体上次未能识别，五分钟后再试；原消息保留待处理');}
   let evidence=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
   try{
    const assets=await this.messenger.media(contact,m.id);
    if(!assets.length)throw new Error('本条媒体暂未取得可靠资源，保留待处理');
    if(!evidence){
     evidence={id:m.id,text:'',images:[]};
     for(let i=0;i<assets.length;i++){
      const asset=assets[i],url=mediaUrl(asset.url)||(String(asset.url).startsWith('blob:https://www.douyin.com/')?asset.url:'');
      if(!url||!['image','audio'].includes(asset.kind))throw new Error('媒体地址或类型未通过核对');
      const content=await this.messenger.mediaBytes(contact,{url,maxBytes:this.cfg.reply.media.maxBytes,kind:asset.kind,messageId:m.id}),bytes=Buffer.from(content.data,'base64');
      if(!bytes.length||bytes.length>this.cfg.reply.media.maxBytes)throw new Error('媒体为空或超过大小限制');
      if(asset.kind==='image'){
       if(!/^image\/(png|jpeg|webp)(?:;|$)/i.test(content.mime))throw new Error('私信图片格式暂不支持');
       evidence.images.push(`data:${content.mime.split(';')[0]};base64,${content.data}`);evidence.text+=content.sampledFrame?'[联系人图片的网页抽样画面，仅代表当前一帧，内容见随附图片]':'[联系人发送了一张图片，内容见随附图片]';
      }else{
       if(!/^(audio\/|video\/webm|application\/octet-stream)/i.test(content.mime))throw new Error('私信音频格式无法核对');
       const audio=join(this.home,'message-media',`${key}-${i}.webm`);writeFileSync(audio,bytes,{mode:0o600});
       const result=await this.transcriber.transcribe(audio,{signal,seconds:asset.seconds,mime:content.mime});
       if(!result.text.trim())throw new Error('语音没有可靠转写，保留待处理');
       evidence.text+='[语音转写，可能有识别误差] '+result.text;
      }
     }
     atomicJson(file,evidence);
    }
   }catch(error){atomicJson(failureFile,{retryAt:Date.now()+300000,reason:error.message});throw error;}
   images.push(...evidence.images);messages.push({...m,text:(m.text+' '+evidence.text).trim(),mediaProcessed:true});
  }
  return {messages,images:images.slice(0,3)};
 }
}
