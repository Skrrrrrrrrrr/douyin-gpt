// Read only the current joined group and its own SDK message objects; never match recipients by name.
export function groupDomInPage({op='list',id='',shortId='',ownUid='',ownSecUid=''}={}) {
 const scalar=v=>typeof v==='string'?v:typeof v==='number'&&Number.isSafeInteger(v)?String(v):v&&typeof v==='object'&&/^\d+$/.test(String(v))?String(v):'';
 const digits=v=>{const s=scalar(v);return /^\d{5,25}$/.test(s)?s:'';};
 const identity=c=>{
  if(!c||Number(c.type)!==2||typeof c.id!=='string'||!/^[A-Za-z0-9:_-]{1,200}$/.test(c.id)||!digits(c.shortId))return null;
  return {id:c.id,shortId:digits(c.shortId),label:String(c.coreInfo?.name||'群聊').slice(0,100),isMember:c.isMember===true,participantCount:Number(c.participantCount)||0};
 };
 const propsOf=(node,key)=>{const k=Object.keys(node).find(k=>k.startsWith('__reactFiber$'));let f=k&&node[k];for(let i=0;f&&i<32;i++,f=f.return){const p=f.memoizedProps||{};if(key==='message'&&p.message?.parsedContent)return p.message;if(key==='conversation'){const c=p.curConversation||p.conversation||p.msgConfig?.conversation||p.message?.msgConfig?.conversation;if(c)return c;}}return null;};
 const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
 const point=e=>{if(!e)return null;const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return visible(e)&&hit&&e.contains(hit)?{x:r.x+r.width/2,y:r.y+r.height/2}:null;};
 const panel=document.querySelector('[class*="componentsRightPanel"]');
 const current=()=>{
  if(!panel)return null;
  const nodes=[...panel.querySelectorAll('[class*="messageMessageBox"],[contenteditable="true"],textarea')].filter(visible).slice(0,12);nodes.push(panel);
  const values=nodes.map(n=>identity(propsOf(n,'conversation'))).filter(Boolean),keys=new Set(values.map(x=>x.id+':'+x.shortId));return keys.size===1?values[0]:null;
 };
 const rows=[...document.querySelectorAll('[data-e2e="conversation-item"]')];
 if(op==='list'){const found=new Map();for(const n of rows){const c=identity(propsOf(n,'conversation'));if(c)found.set(c.id,c);}return [...found.values()];}
 if(op==='row'){const hits=rows.filter(n=>{const c=identity(propsOf(n,'conversation'));return c?.id===id&&c.shortId===shortId&&c.isMember;});if(hits.length!==1)return null;hits[0].scrollIntoView({block:'center',behavior:'instant'});return point(hits[0]);}
 if(op==='current')return current();
 if(op==='editor'){
  const editors=[...(panel?.querySelectorAll('[contenteditable="true"],textarea')||[])].filter(visible),e=editors.find(e=>e.getBoundingClientRect().width>80&&e.getBoundingClientRect().height>10),text=String(e?.tagName==='TEXTAREA'?e.value:e?.innerText||'').replace(/[\u200b\ufeff\r]/g,'').trim();
  return {group:current(),text,hasDraft:editors.some(e=>String(e.tagName==='TEXTAREA'?e.value:e.innerText||'').replace(/[\u200b\ufeff\r]/g,'').trim()),editor:e&&!e.disabled&&!e.readOnly?point(e):null,focused:!!e&&(document.activeElement===e||e.contains(document.activeElement)),alerts:[...document.querySelectorAll('[role="alert"],.semi-toast-content')].map(e=>e.innerText||'').join(' ').slice(0,500)};
 }
 if(op!=='messages')throw new Error('Unknown group inspection');
 const group=current();if(!group||group.id!==id||group.shortId!==shortId||!group.isMember)return {verified:false,messages:[]};
 const seen=new WeakSet(),messages=[];
 for(const n of panel.querySelectorAll('[class*="messageMessageBox"]')){
  const m=propsOf(n,'message');if(!m||seen.has(m))continue;seen.add(m);
  if(String(m.conversationId||'')!==id||digits(m.conversationShortId)!==shortId)continue;
  const mid=digits(m.serverId),pc=m.parsedContent||{},uid=digits(m.sender),sec=typeof m.secSender==='string'?m.secSender:'',stamp=Number(m.createdAt);
  if(!mid)continue;
  const ext=m.ext||{},codes=Object.entries(ext).filter(([k])=>/(?:im_callback_status_code|callback_status_code)$/.test(k)).map(([,v])=>Number(v)).filter(Number.isSafeInteger);
  let mentions=[];for(const [k,v]of Object.entries(pc)){if(!/^(?:mentioned_users|mentionedUsers|at_user_ids|atUserIds|mentions)$/.test(k))continue;let a=v;try{if(typeof v==='string')a=JSON.parse(v);}catch{a=[];}if(Array.isArray(a))mentions.push(...a.map(x=>typeof x==='object'?scalar(x.uid||x.user_id||x.sec_uid):scalar(x)));}
  messages.push({id:mid,from:uid&&uid===ownUid||sec&&sec===ownSecUid?'me':uid||sec?'them':'unknown',senderUid:uid,senderSecUid:sec,
   text:String(pc.text||'').slice(0,2000),createdAt:Number.isSafeInteger(stamp)&&stamp>946684800000&&stamp<=Date.now()+30000?new Date(stamp).toISOString():'',type:Number(m.type),mentionIds:[...new Set(mentions.filter(Boolean))],callbackCodes:codes,
   serverStatus:typeof m.serverStatus==='number'?m.serverStatus:null,flightStatus:typeof m.flightStatus==='number'?m.flightStatus:null});
 }
 return {verified:true,group,messages:messages.reverse().slice(-60)};
}
