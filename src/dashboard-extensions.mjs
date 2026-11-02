import {storyStudio} from './story-studio.mjs';
import {replyContacts,friendSummary} from './reply-audience.mjs';
import {join} from 'node:path';
import {Reviews} from './reviews.mjs';import {preferences,validatePreferences} from './conversation-policy.mjs';import {Backups} from './backups.mjs';import {serviceStatus} from './service-control.mjs';import {officialDiagnosis} from './official.mjs';import {readState} from './state-file.mjs';
export function applyContactPatch(cfg,body,home=''){
 if(Object.keys(body).some(k=>!['contactId','preferences','enabled'].includes(k))||body.enabled!==undefined&&typeof body.enabled!=='boolean')throw new Error('联系人设置字段无效');
 const next=structuredClone(cfg),friend=next.reply.audience==='friends',contact=replyContacts(home,next,{includeDisabled:body.enabled!==undefined}).find(c=>c.secUid===body.contactId);if(!contact)throw new Error('只能设置已获准联系人');
 if(body.preferences===undefined&&body.enabled===undefined)throw new Error('缺少联系人设置');
 const p=body.preferences===undefined?null:validatePreferences(body.preferences,next);
 let target=next.reply.contacts.find(c=>c.secUid===body.contactId);
 if(friend){target=next.reply.friends.overrides.find(c=>c.secUid===body.contactId);if(!target){target={secUid:body.contactId,enabled:contact.enabled};next.reply.friends.overrides.push(target);}}
 if(p)target.preferences=p;
 if(body.enabled!==undefined){target.enabled=body.enabled;if(friend){const original=next.reply.contacts.find(c=>c.secUid===body.contactId);if(original)original.enabled=body.enabled;}}
 return next;
}
export async function modernDashboardState(home,cfg){return {
 storyStudio:storyStudio(home,cfg),
 friendAudience:friendSummary(home,cfg),
 contacts:replyContacts(home,cfg).map(c=>({id:c.secUid,label:c.label,source:c.source||'allowlist',preferences:preferences(cfg,c)})),
 reviews:new Reviews(home).list().slice(-100).reverse().map(r=>({id:r.id,kind:r.kind,revision:r.revision,hash:r.hash,status:r.status,createdAt:r.createdAt,expiresAt:r.expiresAt,note:r.note||'',text:r.payload.text,label:r.payload.label||r.payload.title||(r.payload.kind==='reply'?'回复评论':'主动评论'),provider:r.payload.provider||'',day:r.payload.day,requiresRender:!!r.payload.requiresRender,media:(r.payload.plan?.steps||[]).filter(s=>s.kind!=='text').map(s=>({kind:s.kind,id:s.sticker?.id||s.card?.id||'',label:s.sticker?.label||'角色语音卡'}))})),
 service:await serviceStatus(home),supervisor:readState(home,'supervisor-runtime.json',{version:1}),backups:new Backups(home).list(),official:officialDiagnosis(home,cfg)
};}
