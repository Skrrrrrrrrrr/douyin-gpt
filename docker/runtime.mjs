import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {defaultConfig,validateConfig} from '../src/config.mjs';
import {atomicJson} from '../src/store.mjs';
import {serviceDesired} from '../src/service-control.mjs';

export const CONTAINER_PORT=3147;
export function stopContainerWorker(home,stop){
 const before=serviceDesired(home);if(before.corrupt||!before.worker)return false;
 try{stop();}finally{const after=serviceDesired(home);if(!after.corrupt)atomicJson(join(home,'service-desired.json'),{...after,worker:before.worker&&after.worker,maintenanceUntil:0});}
 return true;
}
export function containerConfig(config){
 const cfg=structuredClone(config);
 cfg.browser={...cfg.browser,headless:false,background:true};
 cfg.dashboard={...cfg.dashboard,port:CONTAINER_PORT,host:'0.0.0.0'};
 cfg.video.python='/opt/venv/bin/python';cfg.video.outputDir='/data/video-output';
 cfg.videoAnalysis.python='/opt/venv/bin/python';cfg.videoAnalysis.command='/usr/local/bin/codex';
 cfg.journal.outputDir='/data/daily-logs';cfg.monitor.notify=false;
 return validateConfig(cfg);
}
export function rebasePaths(value,mappings,key=''){
 if(typeof value==='string'){
  if(/(?:path|file|dir|folder|assets|frames|images|output)$/i.test(key))for(const [from,to] of [...mappings].filter(([from])=>from).sort((a,b)=>b[0].length-a[0].length))if(value===from||value.startsWith(from+'/'))return to+value.slice(from.length);
  return value;
 }
 if(Array.isArray(value))return value.map(item=>rebasePaths(item,mappings,key));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,rebasePaths(item,mappings,key)]));
 return value;
}
export function prepareHome(home){
 if(home!=='/data')throw new Error('Container runtime must use its dedicated /data volume');
 for(const dir of [home,join(home,'desktop'),join(home,'codex'),join(home,'video-output'),join(home,'daily-logs')])mkdirSync(dir,{recursive:true,mode:0o700});
 const file=join(home,'config.json'),fresh=!existsSync(file),cfg=containerConfig(fresh?defaultConfig():JSON.parse(readFileSync(file,'utf8')));atomicJson(file,cfg);
 if(fresh||!existsSync(join(home,'service-desired.json')))atomicJson(join(home,'service-desired.json'),{version:1,worker:false,dashboard:true,maintenanceUntil:0});
 const authConfig=join(home,'codex','config.toml');if(!existsSync(authConfig))writeFileSync(authConfig,'cli_auth_credentials_store = "file"\n',{mode:0o600});
 return cfg;
}
