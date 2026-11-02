import {spawn,execFileSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,lstatSync,unlinkSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Browser,sleep,probe} from '../src/browser.mjs';
import {atomicJson} from '../src/store.mjs';
import {prepareHome,stopContainerWorker} from './runtime.mjs';

const home='/data',children=[];let stopping=false,supervisor;
function child(name,command,args,options={}){
 const fd=openSync(join(home,name+'.log'),'a',0o600);let p;
 try{p=spawn(command,args,{cwd:'/app',env:process.env,stdio:['ignore',fd,fd],...options});}finally{closeSync(fd);}
 children.push(p);p.on('error',error=>{console.error(name+': '+error.message);shutdown(1);});p.on('exit',()=>{if(!stopping){console.error(name+' exited; restarting container');shutdown(1);}});return p;
}
async function shutdown(code=0){
 if(stopping)return;stopping=true;clearInterval(heartbeat);
 try{supervisor?.kill('SIGTERM');}catch{}
 try{stopContainerWorker(home,()=>execFileSync(process.execPath,['scripts/background.mjs','stop','--maintenance','--keep-browser'],{cwd:'/app',timeout:32000,stdio:'ignore'}));}catch{}
 for(const p of [...children].reverse())try{p.kill('SIGTERM');}catch{}
 setTimeout(()=>process.exit(code),1000);
}
const heartbeat=setInterval(()=>atomicJson(join(home,'container-runtime.json'),{version:1,pid:process.pid,checkedAt:new Date().toISOString(),state:stopping?'stopping':'ready'}),15000);
process.on('SIGTERM',()=>shutdown());process.on('SIGINT',()=>shutdown());
try{
 const cfg=prepareHome(home),desktop=join(home,'desktop');
 child('virtual-display','Xvfb',[':99','-screen','0','1440x1000x24','-nolisten','tcp']);
 let ready=false;for(let n=0;n<40;n++){try{execFileSync('xdpyinfo',[],{stdio:'ignore',timeout:1000});ready=true;break;}catch{await sleep(250);}}
 if(!ready)throw new Error('Virtual display did not become ready');
 child('window-manager','openbox',[]);
 const passwordFile=join(desktop,'vnc-password.txt'),auth=join(desktop,'vnc-auth');
 if(!existsSync(passwordFile))writeFileSync(passwordFile,randomBytes(4).toString('hex')+'\n',{mode:0o600});
 execFileSync('x11vnc',['-storepasswd',readFileSync(passwordFile,'utf8').trim(),auth],{stdio:'ignore'});
 child('browser-desktop','x11vnc',['-display',':99','-rfbauth',auth,'-localhost','-rfbport','5900','-forever','-shared','-noxdamage']);
 child('browser-web','websockify',['--web=/usr/share/novnc/','0.0.0.0:6080','127.0.0.1:5900']);
 // Node listens on the configured interface directly. Published ports and the
 // configured public URL define access; administrator and origin checks remain.
 // Only the container's virtual desktop is opened. No macOS browser is controlled.
 const runtimeFile=join(home,'browser-runtime.json');let existing;
 try{existing=JSON.parse(readFileSync(runtimeFile,'utf8'));}catch{}
 if(!existing||!await probe(existing.port))for(const name of ['SingletonLock','SingletonSocket','SingletonCookie']){const file=join(home,'browser',name);try{if(lstatSync(file).isSymbolicLink())unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}}
 const browser=new Browser(home,{headless:false,background:false});try{await browser.start({initialUrl:'https://www.douyin.com/user/self'});}finally{browser.disconnect();}
 supervisor=child('container-supervisor',process.execPath,['scripts/supervisor.mjs','run']);
 atomicJson(join(home,'container-runtime.json'),{version:1,pid:process.pid,checkedAt:new Date().toISOString(),state:'ready',workerStartsPaused:true});
 console.log('Dashboard: http://127.0.0.1:3147');console.log('Browser desktop: http://127.0.0.1:6080/vnc.html');console.log('Browser desktop password: /data/desktop/vnc-password.txt');console.log('Automatic worker remains paused until an explicit cutover.');
}catch(error){console.error(error.message);await shutdown(1);}
