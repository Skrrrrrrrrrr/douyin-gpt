import {readFileSync,openSync,closeSync} from 'node:fs';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {spawn,execFileSync} from 'node:child_process';
import {ROOT,loadEnv,homePath,readConfig} from '../src/config.mjs';import {sleep} from '../src/browser.mjs';
import {setDesired,serviceDesired} from '../src/service-control.mjs';
loadEnv();const home=homePath(),cfg=readConfig(home),file=join(home,'dashboard-runtime.json'),action=process.argv[2]||'status';let meta;try{meta=JSON.parse(readFileSync(file,'utf8'));}catch{}
function alive(m){try{process.kill(m.pid,0);const c=execFileSync('/bin/ps',['-p',String(m.pid),'-o','command='],{encoding:'utf8'});return c.includes(join(ROOT,'src/dashboard.mjs'))&&c.includes(m.runtimeId);}catch{return false;}}
if(['start','stop'].includes(action)&&!process.argv.includes('--maintenance'))setDesired(home,'dashboard',action==='start');
const address=m=>m.url||`http://127.0.0.1:${m.port}`;
if(action==='status')console.log(JSON.stringify({running:alive(meta),url:alive(meta)?address(meta):null,...(meta?.host?{host:meta.host}:{})}));
else if(action==='stop'){if(alive(meta)){process.kill(meta.pid,'SIGTERM');console.log('已停止控制台服务');}else console.log('控制台没有运行');}
else if(action==='start'){
 if(alive(meta))console.log(`控制台已运行：${address(meta)}`);
 else{const id=randomUUID(),fd=openSync(join(home,'dashboard.log'),'a',0o600),child=spawn(process.execPath,[join(ROOT,'src/dashboard.mjs'),id],{cwd:ROOT,detached:true,env:{...process.env,DOUYIN_GPT_HOME:home},stdio:['ignore',fd,fd]});closeSync(fd);child.unref();let ready=false;
 for(let i=0;i<50;i++){try{meta=JSON.parse(readFileSync(file,'utf8'));if(meta.runtimeId===id&&alive(meta)){ready=true;break;}}catch{}await sleep(100);}
 if(!ready)throw new Error('控制台未启动，请检查 dashboard.log');console.log(`控制台已启动：${address(meta)}`);}
}else throw new Error('用法：dashboard.mjs start|stop|status');
