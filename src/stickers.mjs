import {allowedReplyContact} from './reply-audience.mjs';
import {NativeStickerLibrary} from './native-stickers.mjs';
import {readFileSync,existsSync,statSync,realpathSync} from 'node:fs';
import {join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {outgoingParts} from './delivery-state.mjs';
import {preferences} from './conversation-policy.mjs';
import {ROOT,dayKey} from './config.mjs';
const counted=new Set(['sending','sent','uncertain']);
export function stickerFormat(data){if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';if(['GIF87a','GIF89a'].includes(data.toString('ascii',0,6)))return 'gif';if(data[0]===255&&data[1]===216&&data[2]===255)return 'jpeg';return '';}
export class StickerLibrary{
 constructor(home,cfg,{root=join(ROOT,'assets','stickers')}={}){Object.assign(this,{home,cfg,root});}
 settings(id){const c=allowedReplyContact(this.home,this.cfg,id),p=preferences(this.cfg,c||{}),base=this.cfg.reply.stickers;return {...base,perContactPerDay:p.stickerLimit??base.perContactPerDay,cooldownMinutes:p.stickerCooldownMinutes??base.cooldownMinutes};}
 status(outbox,contactId,now=Date.now()){
  const s=this.settings(contactId),history=outgoingParts(outbox).filter(o=>o.kind==='sticker'&&o.contactId===contactId&&counted.has(o.status));
  const used=history.filter(o=>o.day===dayKey(new Date(now))).length,last=history.at(-1),unlimited=s.unlimited===true;
  const nextAt=unlimited?0:last?Date.parse(last.updatedAt||last.createdAt)+s.cooldownMinutes*60000:0;
  return {enabled:s.enabled,unlimited,used,limit:unlimited?null:s.perContactPerDay,remaining:unlimited?null:Math.max(0,s.perContactPerDay-used),nextAt,
   reason:!s.enabled?'disabled':!Boolean(allowedReplyContact(this.home,this.cfg,contactId))?'not_allowed':!unlimited&&used>=s.perContactPerDay?'daily_limit':nextAt>now?'cooldown':'ready'};
 }
 images(){if(!existsSync(join(this.root,'catalog.json')))return [];const source=JSON.parse(readFileSync(join(this.root,'catalog.json'),'utf8'));if(source.version!==1||!Array.isArray(source.items))throw new Error('表情库目录格式无效');const ids=new Set();return source.items.map(item=>{if(!/^[a-z0-9-]{1,60}$/.test(item.id)||ids.has(item.id)||!['openai','deepseek'].includes(item.provider)||typeof item.label!=='string'||item.label.length>30||!['ack','happy','comfort','confused','goodnight','cheer'].includes(item.emotion)||typeof item.file!=='string'||basename(item.file)!==item.file||!/^[a-z0-9-]+\.(png|gif|jpe?g)$/.test(item.file))throw new Error('表情库条目无效');ids.add(item.id);const file=join(this.root,item.file);if(!existsSync(file))return {...item,available:false};if(!realpathSync(file).startsWith(realpathSync(this.root)+'/'))throw new Error('表情文件不在表情库目录');const data=readFileSync(file),format=stickerFormat(data),max=this.cfg.reply.stickers.maxBytes;if(!format||!(format==='jpeg'?/\.jpe?g$/.test(item.file):item.file.endsWith('.'+format))||data.length>max) return {...item,available:false};return {...item,file,filename:item.file,format,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),available:true};});}
 all(){return [...this.images().map(i=>({...i,transport:'image_upload'})),...new NativeStickerLibrary(this.home,this.cfg).all()];}
 available(provider,outbox,contactId,now=Date.now()){
  if(this.status(outbox,contactId,now).reason!=='ready')return [];
  if(this.cfg.reply.stickers.mode!=='image')return new NativeStickerLibrary(this.home,this.cfg).all().filter(i=>i.available).map(i=>({...i,provider}));
  return this.images().filter(i=>i.available&&i.provider===provider).map(i=>({...i,transport:'image_upload'}));
 }
 offered(provider,outbox,contactId,now){return this.available(provider,outbox,contactId,now).map(({id,label,emotion,format,transport})=>({id,label:label.slice(0,30),emotion,format,transport}));}
 choose(id,provider,outbox,contactId){return this.available(provider,outbox,contactId).find(i=>i.id===id)||null;}
}
