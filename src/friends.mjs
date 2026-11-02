import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson} from './store.mjs';
import {accountFingerprint,friendSnapshot,mutualFriend,allowedReplyContact} from './reply-audience.mjs';

const id=v=>typeof v==='string'&&/^\d{5,25}$/.test(v)?v:'';
export class Friends {
  constructor(home,cfg,dy){Object.assign(this,{home,cfg,dy});this.file=join(home,'friends.json');}
  async sync({force=false,maxPages=500}={}) {
    const prior=friendSnapshot(this.home,this.cfg),now=Date.now(),interval=prior.status==='error'?30000:(this.cfg.reply.friends?.syncSeconds||60)*1000;
    if(!force&&now-Date.parse(prior.attemptedAt||'')<interval)return prior;
    const attemptedAt=new Date(now).toISOString();
    try{
      const json=await this.dy.fetchInPage('/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383',{noCache:true}),owner=json.user;
      if(owner?.sec_uid!==this.cfg.account.secUid||!id(owner.uid)||(this.cfg.account.douyinId&&String(owner.unique_id||owner.short_id||'')!==this.cfg.account.douyinId))throw new Error('好友同步账号与绑定账号不一致');
      const found=new Map(),seenUsers=new Set();let cursor='0',offset=0,complete=false;const cursors=new Set();
      for(let page=0;page<maxPages;page++){
        const query=new URLSearchParams({device_platform:'webapp',aid:'6383',channel:'channel_pc_web',user_id:owner.uid,sec_user_id:this.cfg.account.secUid,count:'20',max_time:cursor,min_time:'0',offset:String(offset)});
        const result=await this.dy.fetchInPage('/aweme/v1/web/user/following/list/?'+query,{noCache:true});
        if(!Array.isArray(result.followings)||![false,true,0,1].includes(result.has_more))throw new Error('关注列表不完整，未更新好友授权');
        if(result.myself_user_id!==undefined&&String(result.myself_user_id)!==owner.uid)throw new Error('关注列表所属账号不一致');
        let added=0;for(const raw of result.followings){if(typeof raw.sec_uid==='string'&&!seenUsers.has(raw.sec_uid)){added++;seenUsers.add(raw.sec_uid);}const f=mutualFriend(raw,this.cfg.account);if(f)found.set(f.secUid,f);}
        if(!result.has_more){complete=true;break;}
        const next=String(result.min_time||result.max_time||''),nextOffset=Number(result.offset);
        const marker=next+':'+(Number.isSafeInteger(nextOffset)&&nextOffset>offset?nextOffset:offset+result.followings.length);
        if(!added||!result.followings.length||!/^\d+$/.test(next)||next==='0'||cursors.has(marker))throw new Error('关注列表翻页停滞，未授予部分名单权限');
        cursors.add(marker);cursor=next;offset=Number.isSafeInteger(nextOffset)&&nextOffset>offset?nextOffset:offset+result.followings.length;
      }
      if(!complete)throw new Error('关注列表超过核对范围，未授予部分名单权限');
      const friends=[...found.values()].map(f=>{const old=prior.friends.find(c=>c.secUid===f.secUid);return {...f,membershipId:old?.membershipId||randomUUID(),since:old?.since||attemptedAt};});
      const state={version:1,status:'ready',accountHash:accountFingerprint(this.cfg.account),checkedAt:new Date().toISOString(),attemptedAt,error:'',friends};atomicJson(this.file,state);return {...state,ready:true};
    }catch(error){
      const state={version:1,status:'error',accountHash:accountFingerprint(this.cfg.account),checkedAt:prior.checkedAt||null,attemptedAt,error:'好友关系暂未核对成功，请检查登录和网络',friends:prior.friends||[]};atomicJson(this.file,state);throw error;
    }
  }
  async verify(contact) {
    if(this.cfg.reply.audience!=='friends')return !!allowedReplyContact(this.home,this.cfg,contact.secUid);
    // Every authorization boundary needs a new complete roster, even within the
    // periodic sync interval. Never fall back to an older snapshot on read errors.
    await this.sync({force:true});
    const fresh=allowedReplyContact(this.home,this.cfg,contact.secUid);
    return Boolean(fresh&&(!contact.membershipId||fresh.membershipId===contact.membershipId));
  }
}
