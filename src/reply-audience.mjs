import {readStoredFile as readFileSync, storedExists as existsSync} from './storage.mjs';

import {join} from 'node:path';
import {createHash} from 'node:crypto';

export const accountFingerprint=account=>createHash('sha256').update(String(account?.secUid||'')).digest('hex');
export const validPeerId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{10,200}$/.test(id);
export function mutualFriend(user,account) {
  if(!validPeerId(user?.sec_uid)||user.sec_uid===account?.secUid||!['2',2].includes(user.follow_status)||!['1',1].includes(user.follower_status))return null;
  if([user.is_block,user.is_blocked].some(v=>v===true||v===1||v==='1'))return null;
  return {secUid:user.sec_uid,label:String(user.nickname||'好友').slice(0,80)};
}
export function friendSnapshot(home,cfg,now=Date.now()) {
  const empty={version:1,status:'missing',friends:[],ready:false,error:'尚未同步好友名单'};
  const file=join(home,'friends.json');if(!existsSync(file))return empty;
  try{
    const x=JSON.parse(readFileSync(file,'utf8')),ids=new Set();
    if(x.version!==1||x.accountHash!==accountFingerprint(cfg.account)||!Array.isArray(x.friends))throw new Error('好友名单与绑定账号不一致或格式无效');
    for(const f of x.friends){if(!validPeerId(f.secUid)||f.secUid===cfg.account?.secUid||ids.has(f.secUid)||typeof f.label!=='string'||typeof f.membershipId!=='string'||!Number.isFinite(Date.parse(f.since)))throw new Error('好友身份记录无效');ids.add(f.secUid);}
    const age=now-Date.parse(x.checkedAt),ttl=Math.max(120,cfg.reply?.friends?.syncSeconds*2||120)*1000;
    const ready=x.status==='ready'&&Number.isFinite(age)&&age>=-30000&&age<=ttl;
    return {...x,ready,error:ready?'':x.error||'好友名单已过期，等待重新核对'};
  }catch{return {...empty,status:'error',error:'好友名单不可验证，已停止自动授权好友'};}
}
export function replyContacts(home,cfg,{includeDisabled=false,now=Date.now()}={}) {
  const configured=cfg.reply?.contacts||[];
  if(cfg.reply?.audience!=='friends')return configured.filter(c=>includeDisabled||c.enabled);
  const roster=friendSnapshot(home,cfg,now);if(!roster.ready)return [];
  return roster.friends.map(f=>{
    const original=configured.find(c=>c.secUid===f.secUid),override=cfg.reply.friends?.overrides?.find(c=>c.secUid===f.secUid);
    const enabled=original?.enabled!==false&&override?.enabled!==false;
    const p={...original?.preferences,...override?.preferences};
    if(original?.preferences?.quiet||override?.preferences?.quiet)p.quiet={...original?.preferences?.quiet,...override?.preferences?.quiet};
    return {...f,label:original?.label||f.label,source:'friend',enabled,preferences:p};
  }).filter(c=>includeDisabled||c.enabled);
}
export const allowedReplyContact=(home,cfg,id)=>replyContacts(home,cfg).find(c=>c.secUid===id)||null;
export function friendSummary(home,cfg) {
  const s=friendSnapshot(home,cfg),all=replyContacts(home,cfg,{includeDisabled:true});
  return {mode:cfg.reply.audience||'allowlist',status:s.ready?'ready':s.status,ready:s.ready,checkedAt:s.checkedAt||null,attemptedAt:s.attemptedAt||null,error:s.error||'',verifiedCount:s.ready?s.friends.length:0,activeCount:all.filter(c=>c.enabled).length,syncSeconds:cfg.reply.friends?.syncSeconds||60,excluded:all.filter(c=>!c.enabled).map(c=>({id:c.secUid,label:c.label}))};
}
