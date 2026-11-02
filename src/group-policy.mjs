import {createHash} from 'node:crypto';
export const groupKey=g=>'group:'+createHash('sha256').update(g.id+'\0'+g.shortId).digest('hex').slice(0,32);
export function validGroup(g){return g&&typeof g.id==='string'&&/^[A-Za-z0-9:_-]{1,200}$/.test(g.id)&&typeof g.shortId==='string'&&/^\d{5,25}$/.test(g.shortId)&&g.isMember===true;}
export function groupCalled(message,account) {
 if(message.from!=='them'||!message.id)return false;
 const mentions=message.mentionIds||[];
 if(mentions.includes(account.uid)||mentions.includes(account.secUid))return true;
 if(message.type!==undefined&&![1,7].includes(message.type))return false;
 const text=String(message.text||'').trim();if(!text||/^(?:>|引用|转发|【引用)/.test(text))return false;
 // A mention of another member named GPT is not a mention of this account.
 if(text.startsWith('@')&&mentions.length)return false;
 const name=String(account.nickname||'').trim(),at=name?text.indexOf('@'+name):-1;
 if(at>=0&&/^(?:$|[\s，,、:：?？!！])/.test(text.slice(at+name.length+1)))return true;
 return /^(?:@\s*)?(?:GPT|ChatGPT|大肥鱼|DeepSeek|DS)(?=$|[\s，,、:：?？!！]|[你您帮来在请说给讲聊今这怎为能看测群])/i.test(text);
}
const signature=m=>JSON.stringify([m.id,m.senderUid||'',m.senderSecUid||'',m.from,m.text||'']);
export function groupWindowCompatible(actual,expected,triggerIds,account) {
 const byId=new Map(actual.map(m=>[m.id,m]));
 if(!triggerIds.length||triggerIds.some(id=>!byId.has(id)))return false;
 for(const old of expected){const now=byId.get(old.id);if(now&&signature(now)!==signature(old))return false;}
 const oldIds=new Set(expected.map(m=>m.id)),fresh=actual.filter(m=>!oldIds.has(m.id));
 return !fresh.some(m=>m.from==='me'||groupCalled(m,account));
}
export function groupReceipt(message) {
 const codes=message.callbackCodes||[];
 if(codes.some(c=>c!==0))return {accepted:false,code:codes.find(c=>c!==0),reason:'平台未接受群消息，已暂停此群发言'};
 if(codes.includes(0)&&/^\d{15,25}$/.test(message.id))return {accepted:true,id:message.id,verified:true,callbackCode:0,deliveryToOthers:null};
 return {accepted:false,code:null,reason:'群消息缺少可靠平台回执，需核对后恢复'};
}
export function groupRoutingText(message,account){
 const text=String(message.text||'').replace(/[\u200b\ufeff]/g,''),name=String(account.nickname||'').trim();
 if(!name)return text.trim();const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return text.replace(new RegExp('@'+escaped+'(?=$|[\\s，,、:：?？!！])','g'),'').trim();
}
export function groupReplyProvider(messages,routing,account){return routing?.enabled&&messages.some(m=>groupRoutingText(m,account).includes(routing.deepseekKeyword))?'deepseek':'openai';}
