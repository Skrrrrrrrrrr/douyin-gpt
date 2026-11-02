import {useEffect,useRef,useState} from 'react';
import {Button,Input,Modal} from './ui';
import {time} from './lib/format';
import {apiFetch} from '../../connection.js';
import type {PageProps,Row} from './types';

const stages:Record<string,string>={reading:'读取中',pending:'待处理',generating:'生成回复',sending:'提交并核对',replied:'已回复',idle:'没有新消息',quiet:'静默时段',takeover:'本人接管',review:'等待审核',limited:'今日次数已满',retrying:'等待重试',blocked:'需处理',skipped:'已处理',finished:'步骤已结束'};
export function RecoveryPanel({data,command,refresh}:PageProps){
 const status=data.recovery as Row|undefined;
 const [open,setOpen]=useState(false),[login,setLogin]=useState<Row>({}),[image,setImage]=useState(''),[phone,setPhone]=useState(''),[code,setCode]=useState(''),[working,setWorking]=useState(''),[notice,setNotice]=useState(''),[clock,setClock]=useState(Date.now());
 const active=useRef(false),imageUrl=useRef('');
 const removeImage=()=>{if(imageUrl.current)URL.revokeObjectURL(imageUrl.current);imageUrl.current='';setImage('');};
 const act=async(action:string,quiet=false)=>{
  if(active.current)return;active.current=true;setWorking(action);
  try{
   const result=await command('login-recovery','/api/recovery/login',{action,...(action==='sms'?{phone}:{}),...(action==='submit'?{code}:{})},'');
   if(!result)return;setLogin(result);
   if(result.ready){removeImage();setNotice(data.service?.desired?.worker?'原账号已验证，守护会自动恢复后台。':'原账号已验证；你之前的暂停仍然保留。');await refresh();return;}
   if(!quiet)setNotice(result.message||result.action||'请用抖音扫码，或获取短信验证码。完成登录后会自动检查原账号。');
   if(result.hasImage&&['prepare','refresh'].includes(action)){
    const response=await apiFetch('/api/recovery/image',{cache:'no-store'});if(response.ok){const blob=await response.blob();removeImage();imageUrl.current=URL.createObjectURL(blob);setImage(imageUrl.current);}
   }
   if(action==='sms'&&result.smsRequested){setPhone('');removeImage();}
  }catch{setNotice('登录图片暂未加载，请点击刷新二维码。');}finally{if(action==='submit')setCode('');active.current=false;setWorking('');}
 };
 useEffect(()=>{if(!open)return;const timer=setInterval(()=>{setClock(Date.now());},1000);const check=setInterval(()=>{void act('check',true);},10000);return()=>{clearInterval(timer);clearInterval(check);};},[open]);
 useEffect(()=>()=>{if(imageUrl.current)URL.revokeObjectURL(imageUrl.current);},[]);
 if(!status)return null;
 const close=()=>{setOpen(false);setPhone('');setCode('');removeImage();setNotice('');};
 const wait=Math.max(0,Math.ceil(((login.nextSmsAt||0)-clock)/1000)),expired=!!login.expiresAt&&clock>=login.expiresAt;
 return <>
  <section className={'recovery-strip '+(status.code==='READY'&&!status.channels?.length?'':'needs-attention')} aria-label="回复通道状态">
   <div><strong>{status.title}</strong><span>{status.channels?.length?`${status.channels.length} 项任务暂缓${status.channels.some((c:Row)=>c.longPaused)?'，含长期暂停':''} · `:''}{status.pending?`${status.pending} 条新消息待处理`:'最近扫描 '+time(status.lastScanAt)}</span></div>
   <Button variant="ghost" onClick={()=>{setOpen(true);void act('check',true);}}>{status.needsLogin?'处理登录':'运行诊断'}</Button>
  </section>
  <Modal open={open} onClose={close} title="登录与回复" className="recovery-dialog">
   <div className="recovery-summary"><strong>{status.title}</strong><p>{status.action}</p><p>账号核对 {time(status.verifiedAt)} · 消息扫描 {time(status.lastScanAt)}</p></div>
   <div className="recovery-actions"><Button disabled={!!working} isLoading={working==='check'} onClick={()=>void act('check')}>检查连接</Button>{(status.needsLogin||login.code==='AUTH_REQUIRED')&&<Button disabled={!!working} isLoading={['prepare','refresh'].includes(working)} onClick={()=>void act(image?'refresh':'prepare')}>{image?'刷新二维码':'显示登录二维码'}</Button>}<a href="#logs" onClick={close}>查看日志</a><a href="#costs" onClick={close}>用量与预算</a></div>
   {notice&&<p className="recovery-notice" role="status">{notice}</p>}
   {status.channels?.length>0&&<div className="recovery-contacts" aria-label="暂缓任务">{status.channels.map((channel:Row)=><div key={channel.key}><span>{channel.label}</span><strong>{channel.longPaused?'已长期暂停':channel.requiresUser?'等待本人验证':'等待重试'}</strong><small>{channel.elapsedMinutes!==undefined?`已暂停 ${channel.elapsedMinutes} 分钟 · `:''}{channel.lastCheck?.message||channel.action}</small><Button disabled={!!working} onClick={async()=>{const result=await command('channel-recovery','/api/recovery/channel',{key:channel.key},'');if(result)setNotice(result.ready?'页面已核对，后台会继续该任务。':result.message);}}>验证后检查</Button></div>)}</div>}
   {(image||login.code==='AUTH_REQUIRED')&&<div className="recovery-login">
    <div className="recovery-qr">{image&&!expired?<img src={image} alt="专用抖音窗口的登录二维码"/>:<p>{expired?'二维码展示已过期，请刷新后再扫。':'点击显示登录二维码后，可用抖音扫码登录。'}</p>}{image&&<p>{expired?'二维码已过期':'二维码仅临时显示，过期可直接刷新。'}</p>}</div>
    <form autoComplete="off" onSubmit={e=>{e.preventDefault();void act('submit');}}>
     <label htmlFor="recovery-phone">手机号</label><Input id="recovery-phone" type="tel" inputMode="tel" maxLength={11} value={phone} onChange={e=>setPhone(e.target.value.replace(/\D/g,''))} autoComplete="off" placeholder="11 位手机号"/>
     <Button type="button" disabled={!!working||wait>0||phone.length!==11} onClick={()=>void act('sms')}>{wait>0?`${wait} 秒后可重发`:'获取验证码'}</Button>
     <label htmlFor="recovery-code">短信验证码</label><Input id="recovery-code" type="text" inputMode="numeric" maxLength={6} value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,''))} autoComplete="one-time-code" placeholder="6 位验证码"/>
     <Button type="submit" disabled={!!working||code.length!==6} isLoading={working==='submit'}>登录并核对账号</Button><p>验证码只用于本次登录。平台要求滑块或安全验证时，请在专用窗口完成。</p>
    </form>
   </div>}
   {status.contacts?.length>0&&<div className="recovery-contacts" aria-label="最近私信处理步骤">{status.contacts.map((row:Row,i:number)=><div key={i}><span>{row.label}</span><strong>{stages[row.stage]||row.stage}</strong><small>{row.pending?`${row.pending} 条待处理 · `:''}{row.retryAt?'下次检查 '+time(row.retryAt):time(row.updatedAt)}</small></div>)}</div>}
  </Modal>
 </>;
}
