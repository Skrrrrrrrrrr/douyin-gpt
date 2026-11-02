import {storedExists as existsSync, readStoredFile as readFileSync} from './storage.mjs';
import {mkdirSync, writeFileSync, realpathSync} from 'node:fs';
import {join} from 'node:path';import {createHash} from 'node:crypto';
import {atomicJson} from './store.mjs';import {sleep} from './browser.mjs';
import {Douyin} from './douyin.mjs';import {sameMessageWindow} from './message-snapshot.mjs';
import {readMessages,currentConvId} from '../vendor/newjo/im-send.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex'),ev=(page,fn)=>fn(e=>page.ev(e));
// Read only the actual Douyin picker. An item is selected later by its complete
// resource identity, never by its screen index or an image-upload substitute.
export function nativePickerInPage({scrollTo=''}={}){
 const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).display!=='none';};
 const point=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};};
 const resource=v=>{if(v&&typeof v==='object')v=v.uri||v.url_list?.[0]||v.urlList?.[0];if(typeof v!=='string')return '';try{return decodeURIComponent(new URL(v).pathname).replace(/^\/obj\//,'');}catch{return v.replace(/^\/obj\//,'');}};
 const roots=[...document.querySelectorAll('.componentsemojiim-saas-modal .semi-modal-content')].filter(visible),root=roots.length===1?roots[0]:null,panel=document.querySelector('[class*=componentsRightPanel]');
 const editor=panel&&[...panel.querySelectorAll('[contenteditable=true],textarea')].find(visible),files=panel?[...panel.querySelectorAll('input[type=file]')].some(n=>n.files?.length):false;
 const toolbar=panel?[...panel.querySelectorAll('svg.messageMsgInputiconAction')].filter(visible):[],tabs=root?[...root.querySelectorAll('.emojiEmojisModalTabsubTab')].slice(0,4):[];
 const items=[];
 for(const node of root?.querySelectorAll('.emojiEmojiItememojiItem')||[]){
  let f=node[Object.keys(node).find(k=>k.startsWith('__reactFiber$'))],sticker,props;
  for(let i=0;f&&i<12;i++,f=f.return)if(f.memoizedProps?.sticker){props=f.memoizedProps;sticker=props.sticker;break;}
  if(!sticker||typeof sticker.display_name!=='string')continue;
  let extra=sticker.extra;try{if(typeof extra==='string')extra=JSON.parse(extra);}catch{continue;}
  if(extra?.light_interaction||/骰子|猜拳/.test(sticker.display_name))continue;
  const native={label:sticker.display_name,resourceType:String(sticker.resource_type??''),version:String(sticker.version??''),staticResource:resource(sticker.static_url),animateResource:resource(sticker.animate_url),width:Number(sticker.width||props.width)||0,height:Number(sticker.height||props.height)||0};
  if(!native.staticResource&&!native.animateResource)continue;const identity=JSON.stringify(native);
  if(scrollTo===identity)node.scrollIntoView({block:'nearest',behavior:'instant'});
  const image=node.querySelector('img'),box=node.querySelector('.emojiEmojiItemimgBox'),r=image?.getBoundingClientRect(),rr=root.getBoundingClientRect();
  const onScreen=!!r&&r.width>0&&r.height>0&&r.x>=rr.x&&r.y>=rr.y&&r.right<=Math.min(rr.right,innerWidth)&&r.bottom<=Math.min(rr.bottom,innerHeight);
  const click=point(box),hit=click&&document.elementFromPoint(click.x,click.y),uncovered=!!hit&&node.contains(hit);
  items.push({native,identity,ready:!!image?.complete&&image.naturalWidth>0,point:onScreen&&uncovered?click:null,clip:onScreen?{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}:null});
 }
 const otherModal=[...document.querySelectorAll('.semi-modal-content,[role=dialog]')].filter(visible).some(n=>!root?.contains(n)&&!n.contains(root));
 return {open:!!root,ambiguous:roots.length>1,toolbar:toolbar.length===1?point(toolbar[0]):null,tabs:tabs.map((n,index)=>({index,selected:/active/.test(n.className),point:point(n)})),items,editorText:String(editor?.innerText||editor?.value||'').replace(/[\u200b\ufeff\r]/g,'').trim(),mediaDraft:files||!!editor?.querySelector('img,video,audio'),otherModal};
}
export function nativeEvidenceInPage(){
 const out=[],seen=new WeakSet(),resource=v=>{try{return decodeURIComponent(new URL(v).pathname).replace(/^\/obj\//,'');}catch{return String(v).replace(/^\/obj\//,'');}};
 for(const node of document.querySelectorAll('[class*=messageMessageBox]')){let f=node[Object.keys(node).find(k=>k.startsWith('__reactFiber$'))],message;
  for(let i=0;f&&i<24;i++,f=f.return)if(f.memoizedProps?.message?.parsedContent){message=f.memoizedProps.message;break;}
  if(!message||seen.has(message))continue;seen.add(message);const id=message.serverId||message.serverMessageId||message.server_id;if(typeof id!=='string'||!/^\d{15,25}$/.test(id))continue;
  const resources=new Set(),visited=new WeakSet();function walk(v,key='',depth=0){if(depth>6||v==null)return;if(typeof v==='string'){if(/uri|url|path|resource|image/i.test(key))resources.add(resource(v));return;}if(typeof v!=='object'||visited.has(v))return;visited.add(v);for(const [k,x]of Object.entries(v))walk(x,key+'.'+k,depth+1);}
  walk(message.parsedContent);out.push({id,type:String(message.type??''),keys:Object.keys(message.parsedContent),resources:[...resources]});
 }
 return out;
}
const emotion=s=>/抱|安慰/.test(s)?'comfort':/晚|睡/.test(s)?'goodnight':/问|疑|麻/.test(s)?'confused':/加油|鼓掌|赞/.test(s)?'cheer':/收到|已阅|好|OK|欧克/i.test(s)?'ack':'happy';
export class NativeStickerLibrary{
 constructor(home,cfg){Object.assign(this,{home,cfg});this.base=join(home,'native-stickers');}
 all(){const file=join(this.home,'native-stickers.json');if(!existsSync(file))return [];const data=JSON.parse(readFileSync(file,'utf8'));if(data.version!==1||data.accountHash!==hash(this.cfg.account.secUid)||!Array.isArray(data.items))return [];
  return data.items.map(v=>{if(v.id!=='dy-'+hash(v.identity).slice(0,32)||JSON.stringify(v.native)!==v.identity)throw new Error('原生表情记录身份不一致');const path=join(this.base,v.id+'.png');if(!existsSync(path))return {...v,available:false};if(!realpathSync(path).startsWith(realpathSync(this.base)+'/'))throw new Error('原生表情缩略图越界');const bytes=readFileSync(path);return {...v,provider:'shared',shared:true,transport:'douyin_sticker',format:'native',label:v.native.label,emotion:emotion(v.native.label),sha256:hash(v.identity),file:path,filename:v.id+'.png',bytes:bytes.length,available:hash(bytes)===v.previewHash};});
 }
}
export class NativeStickerSender{
 constructor({home,browser,messenger,account,guard=()=>false,signal}){Object.assign(this,{home,browser,messenger,account,guard,signal});}
 state(page,options={}){return page.ev(`(${nativePickerInPage.toString()})(${JSON.stringify(options)})`);}
 async click(page,point){if(!point)throw new Error('原生表情控件不可定位');for(const type of ['mousePressed','mouseReleased'])await page.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});}
 async open(page){let state=await this.state(page);if(state.editorText||state.mediaDraft||state.otherModal||state.ambiguous)throw new Error('聊天已有草稿或其他弹窗，未打开原生表情');if(!state.open){await this.click(page,state.toolbar);for(let i=0;i<20;i++){await sleep(100);state=await this.state(page);if(state.open)break;}}if(!state.open)throw new Error('抖音原生表情面板未就绪');return state;}
 async close(page){const state=await this.state(page);if(state.open)await this.click(page,state.toolbar);}
 async send(contact,asset,expected){let attempted=false;const page=await this.browser.page('chat','https://www.douyin.com/chat');
  const verify=async()=>{if(this.signal?.aborted||this.guard())throw new Error('本人已接管或程序停止');if(await ev(page,currentConvId)!==contact.secUid)throw new Error('原生表情联系人稳定 ID 不匹配');};
  try{if(!contact.enabled||asset.transport!=='douyin_sticker'||!asset.available||hash(asset.identity)!==asset.sha256)throw new Error('缺少获准的原生表情');await new Douyin(this.home,this.browser).checkAccount(this.account);const before=await this.messenger.read(contact);if(!sameMessageWindow(before,expected))throw new Error('会话已变化，未选择原生表情');await verify();let state=await this.open(page);
   const tab=state.tabs.find(t=>t.index===asset.category);if(!tab)throw new Error('原生表情分类已变化');if(!tab.selected){await this.click(page,tab.point);await sleep(180);}
   state=await this.state(page,{scrollTo:asset.identity});for(let i=0;i<20&&!state.items.find(v=>v.identity===asset.identity)?.ready;i++){await sleep(100);state=await this.state(page,{scrollTo:asset.identity});}
   const matches=state.items.filter(v=>v.identity===asset.identity);if(matches.length!==1||!matches[0].ready||!matches[0].point||state.editorText||state.mediaDraft)throw new Error('原生表情资源不唯一或尚未加载');
   const fresh=(await ev(page,readMessages)).reverse().slice(-60);if(!sameMessageWindow(fresh,expected))throw new Error('选择原生表情前收到新消息或本人已回复');await verify();attempted=true;await this.click(page,matches[0].point);
   const ids=new Set(before.flatMap(m=>[m.id,...(m.aliases||[])]));
   for(let i=0;i<100;i++){await sleep(300);await verify();const messages=await ev(page,readMessages),own=new Set(messages.filter(m=>m.from==='me'&&m.serverConfirmed&&!ids.has(m.id)).map(m=>m.id)),evidence=await page.ev(`(${nativeEvidenceInPage.toString()})()`),found=evidence.filter(e=>own.has(e.id)&&e.type!=='7'&&[asset.native.staticResource,asset.native.animateResource].filter(Boolean).some(r=>e.resources.includes(r)));
    if(found.length===1)return {sent:true,readback:true,messageId:found[0].id,kind:'sticker',transport:'douyin_sticker',nativeMessageType:found[0].type,resourceFingerprint:asset.sha256,verifiedBy:'native-picker-selection+matching-message-resource+own-server-id'};
    if(found.length>1)throw new Error('有多条相同原生表情回执，需核对');
   }throw new Error('原生表情已选择，但尚无唯一服务器回读，不重发');
  }catch(error){error.sendAttempted=attempted;throw error;}finally{try{await this.close(page);}catch{}}
 }
}
export async function syncNativeStickers({home,cfg,browser,messenger,contact}){
 await new Douyin(home,browser).checkAccount(cfg.account);await messenger.read(contact);const page=await browser.page('chat','https://www.douyin.com/chat'),sender=new NativeStickerSender({home,browser,messenger,account:cfg.account}),items=[];mkdirSync(join(home,'native-stickers'),{recursive:true,mode:0o700});
 try{await sender.open(page);for(const category of [0,2]){let state=await sender.state(page);await sender.click(page,state.tabs.find(t=>t.index===category)?.point);await sleep(200);state=await sender.state(page);
   for(const entry of state.items){const id='dy-'+hash(entry.identity).slice(0,32);if(items.some(i=>i.id===id))continue;let current;for(let i=0;i<15;i++){const next=await sender.state(page,{scrollTo:entry.identity});current=next.items.find(v=>v.identity===entry.identity);if(current?.ready&&current.clip)break;await sleep(100);}if(!current?.ready||!current.clip)continue;
    const shot=await page.send('Page.captureScreenshot',{format:'png',clip:current.clip}),bytes=Buffer.from(shot.data,'base64');writeFileSync(join(home,'native-stickers',id+'.png'),bytes,{mode:0o600});items.push({id,identity:entry.identity,native:entry.native,category,previewHash:hash(bytes)});
   }
  }atomicJson(join(home,'native-stickers.json'),{version:1,accountHash:hash(cfg.account.secUid),syncedAt:new Date().toISOString(),items});return items.map(v=>({id:v.id,label:v.native.label,category:v.category}));
 }finally{await sender.close(page);}
}
