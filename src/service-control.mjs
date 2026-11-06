import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {join,dirname,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {ROOT} from './config.mjs';
import {atomicJson} from './store.mjs';
const exec=promisify(execFile),initial={version:1,worker:true,dashboard:true,maintenanceUntil:0};
export function serviceDesired(home){const file=join(home,'service-desired.json');if(!existsSync(file))return {...initial};try{const d=JSON.parse(readFileSync(file));if(d.version!==1||typeof d.worker!=='boolean'||typeof d.dashboard!=='boolean'||!Number.isSafeInteger(d.maintenanceUntil)||d.maintenanceUntil<0)throw new Error();return {...initial,...d};}catch{return {...initial,worker:false,dashboard:false,corrupt:true};}}
export function setDesired(home,key,value,{maintenance=false}={}){if(!['worker','dashboard'].includes(key)||typeof value!=='boolean')throw new Error('运行目标无效');const d=serviceDesired(home);if(d.corrupt){if(maintenance)throw new Error('运行目标记录损坏，保持暂停；请在控制台明确选择启动或停止');delete d.corrupt;}if(maintenance)d.maintenanceUntil=Date.now()+10*60000;else{d[key]=value;if(value)d.maintenanceUntil=0;}atomicJson(join(home,'service-desired.json'),d);return d;}
export function endMaintenance(home){const d=serviceDesired(home);if(d.corrupt)return;d.maintenanceUntil=0;atomicJson(join(home,'service-desired.json'),d);}
export function serviceIdentity(home){return 'com.douyin.gpt.'+createHash('sha256').update(home).digest('hex').slice(0,12);}
const xml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
// launchctl can acknowledge bootout before the registration has finished disappearing.
export async function bootstrapWithRetry(bootstrap,{loaded,wait=ms=>new Promise(r=>setTimeout(r,ms))}){
 let failure;for(let i=0;i<4;i++){try{await bootstrap();return;}catch(error){failure=error;if(await loaded())return;if(i<3)await wait(500*2**i);}}
 throw failure;
}
// launchd does not inherit the user's interactive shell PATH. Include both
// Homebrew layouts and Docker Desktop's bundled CLI for every spawned child.
export function servicePath(node=process.execPath){
 return [...new Set([dirname(node),'/opt/homebrew/bin','/opt/homebrew/sbin','/usr/local/bin','/usr/local/sbin',join(homedir(),'.local','bin'),'/Applications/Docker.app/Contents/Resources/bin','/usr/bin','/bin','/usr/sbin','/sbin'])].filter(path=>isAbsolute(path)&&!path.includes(':')).join(':');
}
export function servicePlist(home,node=process.execPath){const label=serviceIdentity(home);return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(join(ROOT,'scripts/supervisor.mjs'))}</string><string>run</string></array><key>WorkingDirectory</key><string>${xml(ROOT)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(servicePath(node))}</string><key>DOUYIN_GPT_HOME</key><string>${xml(home)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key><string>${xml(join(home,'supervisor.log'))}</string><key>StandardErrorPath</key><string>${xml(join(home,'supervisor.log'))}</string></dict></plist>`;}
export async function serviceStatus(home){const label=serviceIdentity(home),file=join(homedir(),'Library','LaunchAgents',label+'.plist');let loaded=false;try{await exec('/bin/launchctl',['print',`gui/${process.getuid()}/${label}`],{timeout:5000});loaded=true;}catch{}return {label,installed:existsSync(file),loaded,desired:serviceDesired(home)};}
export async function installService(home){if(process.platform!=='darwin')throw new Error('登录启动当前支持 macOS');const label=serviceIdentity(home),dir=join(homedir(),'Library','LaunchAgents'),file=join(dir,label+'.plist');mkdirSync(dir,{recursive:true});if(existsSync(file)&&!readFileSync(file,'utf8').includes(xml(join(ROOT,'scripts/supervisor.mjs'))))throw new Error('同名启动项不属于当前项目，未覆盖');if(existsSync(file))try{await exec('/bin/launchctl',['bootout',`gui/${process.getuid()}/${label}`],{timeout:5000});}catch{}
 for(let i=0;i<20&&(await serviceStatus(home)).loaded;i++)await new Promise(r=>setTimeout(r,250));
 if((await serviceStatus(home)).loaded)throw new Error('旧守护尚未退出，已保留启动项，请稍后重试');
 writeFileSync(file,servicePlist(home),{mode:0o600});await bootstrapWithRetry(()=>exec('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,file],{timeout:10000}),{loaded:async()=>(await serviceStatus(home)).loaded});return serviceStatus(home);}
export async function uninstallService(home){const label=serviceIdentity(home),file=join(homedir(),'Library','LaunchAgents',label+'.plist');if(existsSync(file)&&!readFileSync(file,'utf8').includes(xml(join(ROOT,'scripts/supervisor.mjs'))))throw new Error('启动项不属于当前项目');try{await exec('/bin/launchctl',['bootout',`gui/${process.getuid()}/${label}`],{timeout:5000});}catch{}if(existsSync(file)){const archive=join(home,'service-archives');mkdirSync(archive,{recursive:true,mode:0o700});renameSync(file,join(archive,Date.now()+'.plist'));}return serviceStatus(home);}
