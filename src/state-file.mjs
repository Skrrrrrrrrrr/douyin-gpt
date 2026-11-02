import {readFileSync,openSync,writeFileSync,closeSync,unlinkSync,lstatSync,existsSync,mkdirSync,renameSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson} from './store.mjs';
import {storedJson,updateStored} from './storage.mjs';
export function readState(home,name,initial){let data;try{data=storedJson(join(home,name),initial);}catch(error){if(error.code?.startsWith('STORAGE_'))throw error;throw new Error(`${name} 无法读取，已保留原记录`);}if(data?.version!==1)throw new Error(`${name} 版本无效`);return data;}
const busy=()=>Object.assign(new Error('记录正在更新，请稍后重试'),{code:'STATE_BUSY'});
const ownerValid=o=>Number.isSafeInteger(o?.pid)&&o.pid>0&&typeof o.token==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(o.token);
function dead(owner){if(!ownerValid(owner))return false;try{process.kill(owner.pid,0);return false;}catch(e){return e.code==='ESRCH';}}
function recoveryGuard(file){
 const guard=file+'.guard',token=randomUUID();let acquired=false;
 for(let attempt=0;attempt<2;attempt++){
  try{mkdirSync(guard,{mode:0o700});writeFileSync(join(guard,'owner.json'),JSON.stringify({pid:process.pid,token}),{flag:'wx',mode:0o600});acquired=true;break;}
  catch(error){
   if(error.code!=='EEXIST')throw error;if(attempt)throw busy();
   try{
    const stat=lstatSync(guard),owner=JSON.parse(readFileSync(join(guard,'owner.json'),'utf8'));
    if(!stat.isDirectory()||stat.isSymbolicLink()||!dead(owner))throw busy();
    const now=lstatSync(guard),current=JSON.parse(readFileSync(join(guard,'owner.json'),'utf8'));
    if(stat.ino!==now.ino||stat.dev!==now.dev||owner.token!==current.token)throw busy();
    // Keep a nonempty tombstone: concurrent reclaimers of this token cannot replace a new live guard.
    renameSync(guard,guard+'.dead-'+owner.token);
   }catch{throw busy();}
  }
 }
 if(!acquired)throw busy();
 return ()=>{try{const owner=JSON.parse(readFileSync(join(guard,'owner.json'),'utf8'));if(owner.token!==token)return;const released=guard+'.released-'+token;renameSync(guard,released);rmSync(released,{recursive:true,force:true});}catch{}};
}
function lock(file){
 const releaseGuard=recoveryGuard(file),token=randomUUID();let fd,identity;
 try{
  for(let attempt=0;attempt<2;attempt++){
   try{fd=openSync(file,'wx',0o600);break;}catch(error){
    if(error.code!=='EEXIST')throw error;if(attempt)throw busy();
    const stat=lstatSync(file);let prior;try{prior=JSON.parse(readFileSync(file,'utf8'));}catch{throw busy();}
    if(!stat.isFile()||stat.isSymbolicLink()||!dead(prior))throw busy();
    // All new reclaimers hold the guard; legacy writers still honor this wx file.
    unlinkSync(file);
   }
  }
  identity=lstatSync(file);try{writeFileSync(fd,JSON.stringify({pid:process.pid,token}));}finally{closeSync(fd);fd=undefined;}
 }catch(error){if(fd!==undefined)closeSync(fd);releaseGuard();throw error;}
 return ()=>{try{const now=lstatSync(file),owner=JSON.parse(readFileSync(file,'utf8'));if(now.ino===identity.ino&&now.dev===identity.dev&&owner.token===token)unlinkSync(file);}catch{}finally{releaseGuard();}};
}
export function updateState(home,name,initial,change){const stored=updateStored(home,name,initial,change);if(stored.handled)return stored.result;const release=lock(join(home,name+'.lock'));try{const data=readState(home,name,initial);const result=change(data);if(result&&typeof result.then==='function')throw new Error('记录提交不能等待网络请求');atomicJson(join(home,name),data);return result;}finally{release();}}
