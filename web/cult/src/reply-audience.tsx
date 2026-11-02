import {Badge,Button,ConfigPanel,Field,Select} from './ui';
import {dateTime} from './lib/format';
import type {PageProps,Row} from './types';

export function ReplyAudiencePanel({data:d,perform,busy}:PageProps) {
 const f=d.friendAudience;
 if(!f)return null;
 return <ConfigPanel id="reply-audience" title="谁可以收到自动回复" description="好友指互相关注的个人账号。好友增加后自动同步；单向粉丝和陌生人不纳入好友范围，群聊使用单独设置。原有关键词路由、人工接管及私信额度继续生效。" initial={{audience:d.settings.reply.audience||'allowlist'}} buildPatch={x=>({reply:{audience:x.audience}})} perform={perform} busy={busy}>
  {(x,set)=><><Field label="回复范围"><Select label="自动回复范围" value={x.audience} onChange={v=>set('audience',v)} options={[["allowlist","仅指定联系人"],["friends","所有互关好友"]]}/></Field>
   <div className="friend-sync-info"><div><Badge text={f.ready?'好友身份已核对':'好友名单待核对'}/><p>{f.ready?`已核对 ${f.verifiedCount} 位好友 · 最近同步 ${dateTime(f.checkedAt)}`:f.error||'尚未同步好友名单'}</p><p>启用前的历史消息不会补发；新增好友的新来信按服务器时间识别。</p></div><Button isLoading={busy['friends-sync']} loadingText="同步中…" onClick={()=>perform('friends-sync','/api/friends/sync',{},'好友名单已核对')}>同步好友名单</Button></div>
   {f.mode==='friends'&&f.excluded?.length>0&&<div className="friend-excluded"><p>已单独暂停 {f.excluded.length} 位好友</p>{f.excluded.map((c:Row)=><div key={c.id}><span>{c.label}</span><Button variant="ghost" isLoading={busy['resume-friend:'+c.id]} onClick={()=>perform('resume-friend:'+c.id,'/api/contact',{contactId:c.id,enabled:true},'这位好友已恢复自动回复')}>恢复这位好友</Button></div>)}</div>}
  </>}
 </ConfigPanel>;
}
