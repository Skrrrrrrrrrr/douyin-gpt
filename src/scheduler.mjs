import {dayKey} from './config.mjs';
export function scheduleAction(cfg,state,{now=new Date(),approved=false}={}){
 if(!cfg.service.enabled||!cfg.video.enabled)return null;const day=dayKey(now),minutes=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hour12:false}).format(now))*60+Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',minute:'2-digit'}).format(now)),due=cfg.video.hour*60+cfg.video.minute,prep=cfg.service.prepHour*60+cfg.service.prepMinute;
 if(state&&state.day!==day)return null;
 if(['published','scheduled','submitted','publishing','uncertain','prepared','uploading'].includes(state?.status))return null;
 if(minutes<Math.min(prep,due-10))return null;
 if(minutes>due+cfg.service.lateGraceMinutes)return {kind:'missed',day,key:day+':missed',args:[]};
 if(state?.status==='rendered'){
  if(cfg.review.videos==='review'&&!approved)return null;
  if(minutes<=due-140)return {kind:'schedule',day,key:day+':schedule:'+state.fingerprint,args:['--live','--ready-only','--schedule']};
  if(minutes>=due)return {kind:'publish',day,key:day+':publish:'+state.fingerprint,args:['--live','--ready-only']};return null;
 }
 const scheduled=minutes<=due-140&&cfg.review.videos!=='review';return {kind:'build',day,key:day+':build',args:scheduled?['--live','--schedule']:[]};
}
