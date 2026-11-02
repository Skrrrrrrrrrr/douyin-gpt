import {existsSync,readFileSync,lstatSync,readdirSync} from 'node:fs';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {Worker,MessageChannel,receiveMessageOnPort} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {businessKey,senderKey} from './storage-keys.mjs';
export {businessKey,senderKey};

const revisionSymbol=Symbol('business-state-revision'),bindings=new Map();
const fail=(code,message)=>Object.assign(new Error(message),{code,status:code==='STORAGE_CONFLICT'||code==='STATE_BUSY'?409:503});
const digest=text=>createHash('sha256').update(text).digest('hex');
export const storageFault=error=>/^STORAGE_(UNAVAILABLE|LEASE_LOST|CORRUPT|CONFIG_INVALID|ACCOUNT_MISMATCH)$/.test(error?.code||'');
export class PostgresStore{
 constructor({connectionFile,namespace,accountHash,requiredKeys=[]}){
  if(!isAbsolute(connectionFile)||!/^[-a-zA-Z0-9_]{1,120}$/.test(namespace)||!/^[a-f0-9]{64}$/.test(accountHash))throw fail('STORAGE_CONFIG_INVALID','数据库绑定配置无效');
  const stat=lstatSync(connectionFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077)throw fail('STORAGE_CONFIG_INVALID','数据库连接文件必须是私有普通文件');
  if(!Array.isArray(requiredKeys)||requiredKeys.some(key=>!businessKey(key)))throw fail('STORAGE_CONFIG_INVALID','数据库业务目录无效');this.requiredKeys=new Set(requiredKeys);
  const channel=new MessageChannel();this.signal=new Int32Array(new SharedArrayBuffer(4));this.port=channel.port1;this.worker=new Worker(new URL('./storage-worker.mjs',import.meta.url),{workerData:{port:channel.port2,signal:this.signal.buffer,connectionFile,namespace,accountHash},transferList:[channel.port2],execArgv:[]});this.worker.on('error',()=>{});this.worker.unref();this.port.unref();this.next=0;this.observed=new Map();this.namespace=namespace;
 }
 call(op,args={}){
  if(this.failed)throw fail('STORAGE_UNAVAILABLE','数据库连接已失效，请重新启动当前服务');
  const id=++this.next,deadline=Date.now()+10000;this.port.postMessage({id,op,args});
  while(Date.now()<deadline){const count=Atomics.load(this.signal,0),message=receiveMessageOnPort(this.port)?.message;if(message){if(message.id!==id)continue;if(message.error)throw fail(message.error.code,message.error.message);return message.result;}Atomics.wait(this.signal,0,count,Math.max(1,deadline-Date.now()));}
  this.failed=true;void this.worker.terminate();throw fail('STORAGE_UNAVAILABLE','等待数据库超时，已停止当前服务的数据提交');
 }
 get(key){const record=this.call('get',{key});if(!record&&this.requiredKeys.has(key))throw fail('STORAGE_CORRUPT','迁移后的业务账本缺失，已停止读取');if(record&&(!Number.isSafeInteger(record.revision)||record.revision<1||digest(record.text)!==record.checksum))throw fail('STORAGE_CORRUPT','业务记录校验失败，已停止读取');this.observed.set(key,record?.revision||0);return record;}
 value(key,initial){const row=this.get(key);return this.stamp(row?JSON.parse(row.text):structuredClone(initial),key,row?.revision||0);}
 stamp(value,key,revision){if(value&&typeof value==='object')Object.defineProperty(value,revisionSymbol,{value:{namespace:this.namespace,key,revision},writable:true,enumerable:true,configurable:true});return value;}
 put(key,value){const meta=value?.[revisionSymbol];let expected=meta?.namespace===this.namespace&&meta.key===key?meta.revision:this.observed.get(key);if(expected===undefined){if(senderKey(key))throw fail('STORAGE_CONFLICT','发送账本未先读取，拒绝覆盖');expected=this.get(key)?.revision||0;}const result=this.call('put',{key,text:JSON.stringify(value,null,2)+'\n',expected});this.observed.set(key,result.revision);this.stamp(value,key,result.revision);return result;}
 update(key,initial,change){const begun=this.call('begin',{key,initial:JSON.stringify(initial,null,2)+'\n'});let committed=false;try{const data=JSON.parse(begun.text),result=change(data);if(result&&typeof result.then==='function')throw new Error('记录提交不能等待网络请求');const saved=this.call('commit',{token:begun.token,text:JSON.stringify(data,null,2)+'\n'});committed=true;this.observed.set(key,saved.revision);this.stamp(data,key,saved.revision);return result;}finally{if(!committed)try{this.call('rollback',{token:begun.token});}catch{}}}
 acquire(){const result=this.call('acquire');this.leaseBackendPid=result.backendPid;return result;}
 release(){return this.call('release');}
 close(){this.port.close();return this.worker.terminate();}
}
function load(home){
 const file=join(home,'storage.json');if(!existsSync(file)){if(bindings.has(home)||existsSync(join(home,'storage-migration.json')))throw fail('STORAGE_CONFIG_INVALID','数据库绑定文件已移除，拒绝回退本机旧记录');return null;}
 const text=readFileSync(file,'utf8'),cached=bindings.get(home);if(cached){if(cached.text!==text)throw fail('STORAGE_CONFIG_INVALID','数据库绑定已变化，请重新启动服务');return cached;}
 let config;try{config=JSON.parse(text);}catch{throw fail('STORAGE_CONFIG_INVALID','数据库绑定文件损坏，拒绝回退本机记录');}
 if(config.version!==1||config.backend!=='postgres')throw fail('STORAGE_CONFIG_INVALID','数据库绑定格式无效');
 const binding={home,text,config,store:new PostgresStore(config)};bindings.set(home,binding);return binding;
}
export function storageBinding(home){return load(resolve(home));}
function locate(file){
 const absolute=resolve(file);let home=dirname(absolute);
 while(true){if(bindings.has(home)||existsSync(join(home,'storage.json'))||existsSync(join(home,'storage-migration.json'))){const key=relative(home,absolute).split('\\').join('/');return businessKey(key)?{...load(home),key}:null;}const parent=dirname(home);if(parent===home)return null;home=parent;}
}
export function storedJson(file,initial){const binding=locate(file);if(binding)return binding.store.value(binding.key,initial);if(!existsSync(file))return structuredClone(initial);return JSON.parse(readFileSync(file,'utf8'));}
export function storedText(file){const binding=locate(file);if(binding)return binding.store.get(binding.key)?.text??null;try{return readFileSync(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function virtualDirectory(dir){let home=resolve(dir);while(true){if(bindings.has(home)||existsSync(join(home,'storage.json'))||existsSync(join(home,'storage-migration.json'))){const key=relative(home,resolve(dir)).split('\\').join('/');return /^(reports|video(?:\/\d{4}-\d{2}-\d{2})?)$/.test(key)?{...load(home),prefix:key+'/'}:null;}const parent=dirname(home);if(parent===home)return null;home=parent;}}
export function storedExists(file){const binding=locate(file);if(binding)return !!binding.store.get(binding.key);const dir=virtualDirectory(file);return existsSync(file)||!!dir?.store.call('list',{prefix:dir.prefix}).length;}
export function readStoredFile(file,options){const binding=locate(file);if(!binding)return readFileSync(file,options);const text=binding.store.get(binding.key)?.text;if(text===undefined)throw Object.assign(new Error('业务记录不存在'),{code:'ENOENT'});const encoding=typeof options==='string'?options:options?.encoding;return encoding?Buffer.from(text).toString(encoding):Buffer.from(text);}
export function storedReadDir(dir,options){const virtual=virtualDirectory(dir);if(!virtual)return readdirSync(dir,options);const local=existsSync(dir)?readdirSync(dir,options):[],withTypes=typeof options==='object'&&options.withFileTypes,names=new Set(local.map(e=>withTypes?e.name:e));for(const key of virtual.store.call('list',{prefix:virtual.prefix})){const rest=key.slice(virtual.prefix.length),name=rest.split('/')[0];if(!name||names.has(name))continue;names.add(name);const directory=rest.includes('/');local.push(withTypes?{name,isDirectory:()=>directory,isFile:()=>!directory,isSymbolicLink:()=>false}:name);}return local;}
export function writeStored(file,value){const binding=locate(file);if(!binding)return false;binding.store.put(binding.key,value);return true;}
export function updateStored(home,name,initial,change){const binding=locate(join(home,name));return binding?{handled:true,result:binding.store.update(binding.key,initial,change)}:{handled:false};}
export function storedKeys(home,prefix=''){
 const binding=storageBinding(home);if(binding)return binding.store.call('list',{prefix});const keys=[];
 function walk(dir,base=''){if(!existsSync(dir))return;for(const entry of readdirSync(dir,{withFileTypes:true})){const key=base+entry.name;if(entry.isDirectory()&&['video','reports'].includes(key))walk(join(dir,entry.name),key+'/');else if(entry.isDirectory()&&/^video\/\d{4}-\d{2}-\d{2}$/.test(key))walk(join(dir,entry.name),key+'/');else if(entry.isFile()&&businessKey(key))keys.push(key);}}
 walk(home);return keys.filter(key=>key.startsWith(prefix)).sort();
}
export function acquireStorageLease(home){const binding=storageBinding(home);if(!binding)return ()=>{};const cfg=JSON.parse(readFileSync(join(home,'config.json'),'utf8'));if(digest(String(cfg.account?.secUid||''))!==binding.config.accountHash)throw fail('STORAGE_ACCOUNT_MISMATCH','数据库空间与当前绑定账号不一致');binding.store.acquire();return ()=>binding.store.release();}
export function storageStatus(home){const binding=storageBinding(home);if(!binding)return {backend:'files',ready:true};const status=binding.store.call('ping'),keys=binding.store.call('list');if([...binding.store.requiredKeys].some(key=>!keys.includes(key)))throw fail('STORAGE_CORRUPT','数据库关键业务记录缺失，已停止运行');return {backend:'postgres',...status,records:keys.length};}
