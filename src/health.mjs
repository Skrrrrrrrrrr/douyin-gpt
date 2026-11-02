import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {atomicJson} from './store.mjs';
import {updateState} from './state-file.mjs';
export class Health {
 constructor(home,{notify=false}={}){this.home=home;this.file=join(home,'health.json');this.notify=notify;}
 read(){try{const d=JSON.parse(readFileSync(this.file,'utf8'));if(d.version===1&&Array.isArray(d.alerts))return d;}catch{}return {version:1,alerts:[],lastHeartbeatAt:0,maintenanceUntil:0};}
 change(fn){try{return updateState(this.home,'health.json',{version:1,alerts:[],lastHeartbeatAt:0,maintenanceUntil:0},fn);}catch{return null;}}
 heartbeat(extra={}){this.change(d=>Object.assign(d,extra,{lastHeartbeatAt:Date.now()}));}
 maintenance(ms=600000){this.change(d=>{d.maintenanceUntil=Date.now()+ms;});}
 alert(key,title,message,{severity='warning',persistent=false,remindAfterMs=0}={}){
  let notify=false;const item=this.change(d=>{const now=new Date().toISOString(),existing=d.alerts.find(a=>a.key===key&&!a.resolvedAt);
  if(existing){const escalated=existing.severity!==severity&&severity==='error';notify=escalated||remindAfterMs>0&&Date.now()-Date.parse(existing.lastNotifiedAt||existing.createdAt)>=remindAfterMs;Object.assign(existing,{title,message,severity,lastSeenAt:now,occurrences:existing.occurrences+1,persistent:existing.persistent||persistent});if(notify&&this.notify)existing.lastNotifiedAt=now;return existing;}
  const next={id:randomUUID(),key,title,message,severity,createdAt:now,lastSeenAt:now,occurrences:1,...(persistent?{persistent:true}:{})};if(this.notify)next.lastNotifiedAt=now;d.alerts.push(next);
  const pinned=d.alerts.filter(a=>a.persistent&&!a.resolvedAt),history=d.alerts.filter(a=>!a.persistent||a.resolvedAt);d.alerts=[...history.slice(-Math.max(0,100-pinned.length)),...pinned].slice(-100);notify=true;return next;});
  if(notify&&this.notify&&process.platform==='darwin')execFile('/usr/bin/osascript',['-e','on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run',title,message],{timeout:5000},()=>{});
  return item;
 }
 resolve(key){this.change(d=>{for(const a of d.alerts)if((a.key===key||a.id===key)&&!a.resolvedAt)a.resolvedAt=new Date().toISOString();});}
}
