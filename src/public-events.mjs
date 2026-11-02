import {readFileSync,existsSync} from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {ROOT,dayKey} from './config.mjs';import {readState,updateState} from './state-file.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex'),empty={version:1,events:[]};
// These are project changes that may be described publicly. Private sends, chat
// failures, contact memory, browser state and machine configuration are excluded.
export const PUBLIC_CAPABILITIES={
 'native-sticker-separation':{title:'把图片和原生表情分清楚',happened:'早期把角色图片也称作表情，容易让人误会成抖音原生表情。',handled:'程序增加原生面板发送路径，把角色图片素材另列。',changed:'两类内容现在分开处理，代码检查也通过了；结论只限于这套检查。',scope:'项目代码与自动化用例；不据此声称任何真实私信发送或对方接收',files:['src/native-stickers.mjs','test/native-stickers.test.mjs'],test:'test/native-stickers.test.mjs'}
};
export function capabilityDigest(key){const c=PUBLIC_CAPABILITIES[key];if(!c)throw new Error('公开能力项目不存在');return hash(c.files.map(f=>readFileSync(join(ROOT,f))).map(b=>hash(b)).join(':'));}
export class PublicEvents{
 constructor(home){this.home=home;}
 list(){return readState(this.home,'public-events.json',empty).events.map(e=>({...e,current:e.kind==='capability'&&PUBLIC_CAPABILITIES[e.capability]?e.digest===capabilityDigest(e.capability):false}));}
 recordVerified(capability,{passed,failed,exitCode,startedAt,finishedAt,digest}){const card=PUBLIC_CAPABILITIES[capability];if(!card||exitCode!==0||failed!==0||!Number.isSafeInteger(passed)||passed<1||digest!==capabilityDigest(capability)||!Number.isFinite(Date.parse(finishedAt)))throw new Error('只有当前代码的成功检查可登记公开能力记录');
  return updateState(this.home,'public-events.json',empty,d=>{const id='capability:'+capability+':'+digest.slice(0,20),old=d.events.find(e=>e.id===id);if(old){Object.assign(old,{title:card.title,happened:card.happened,handled:card.handled,changed:card.changed,scope:card.scope});old.verification={...old.verification,passed,failed,startedAt,finishedAt};old.lastCheckedAt=finishedAt;return old;}const event={id,kind:'capability',capability,digest,day:dayKey(new Date(finishedAt)),...card,files:undefined,test:undefined,visibility:'public',enabled:true,createdAt:finishedAt,verification:{kind:'automated-tests',passed,failed,startedAt,finishedAt,scope:card.scope}};d.events.push(event);return event;});
 }
 setEnabled(id,enabled){if(typeof enabled!=='boolean')throw new Error('公开分享开关无效');return updateState(this.home,'public-events.json',empty,d=>{const e=d.events.find(e=>e.id===id);if(!e)throw new Error('公开成长记录不存在');e.enabled=enabled;return e;});}
}
