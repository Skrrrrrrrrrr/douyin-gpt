import {existsSync,readFileSync,writeFileSync,mkdirSync,chmodSync,copyFileSync,renameSync,lstatSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT,loadEnv,homePath,readConfig,writePrivate} from '../src/config.mjs';
import {takeLock} from '../src/store.mjs';
import {PostgresStore,storedKeys,storageBinding,storageStatus} from '../src/storage.mjs';

const exec=promisify(execFile),hash=text=>createHash('sha256').update(text).digest('hex');
function privateJson(file,value){mkdirSync(dirname(file),{recursive:true,mode:0o700});writePrivate(file,JSON.stringify(value,null,2)+'\n');}
export function prepareStorage(home,{port=15432}={}){
 const cfg=readConfig(home);if(!cfg.account.secUid)throw new Error('需要先绑定原抖音账号');
 if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('数据库本机端口无效');
 const accountHash=hash(cfg.account.secUid),connectionFile=join(home,'storage-connection.json'),passwordFile=join(home,'database-password.txt');
 if(!existsSync(connectionFile)){const password=randomBytes(32).toString('base64url');writePrivate(passwordFile,password+'\n');privateJson(connectionFile,{host:'127.0.0.1',port,user:'douyin_assistant',password,database:'douyin_assistant'});}
 let connection;try{connection=JSON.parse(readFileSync(connectionFile,'utf8'));}catch{throw new Error('数据库连接配置无法读取，请检查本机私有配置文件');}if(!existsSync(passwordFile)||readFileSync(passwordFile,'utf8').trim()!==connection.password)throw new Error('数据库连接凭证与本机密码文件不一致，已停止');
 chmodSync(connectionFile,0o600);chmodSync(passwordFile,0o600);
 const plan={version:1,backend:'postgres',namespace:'assistant_'+accountHash,accountHash,connectionFile,passwordFile,port:connection.port};privateJson(join(home,'storage-plan.json'),plan);return plan;
}
export async function startDatabase(plan){return exec('docker',['compose','-f',join(ROOT,'compose.yaml'),'up','-d','--wait','database'],{cwd:ROOT,env:{...process.env,DOUYIN_DATABASE_PASSWORD_FILE:plan.passwordFile,DOUYIN_DATABASE_PORT:String(plan.port)},timeout:180000,maxBuffer:2e6});}
export function migrateStorage(home,plan){
 if(existsSync(join(home,'storage.json')))throw new Error('这个运行目录已经绑定数据库，拒绝重复迁移');
 for(const file of ['dashboard-runtime.json','supervisor-runtime.json'])if(existsSync(join(home,file))){const meta=JSON.parse(readFileSync(join(home,file),'utf8'));if(Number.isSafeInteger(meta.pid)){try{process.kill(meta.pid,0);throw new Error('迁移前需要暂停管理服务与守护：'+file);}catch(e){if(e.code!=='ESRCH')throw e;}}}
 const release=takeLock(home),store=new PostgresStore(plan);let leased=false;
 try{
  store.call('init');store.acquire();leased=true;
  const pendingFile=join(home,'storage-migration-pending.json'),pending=existsSync(pendingFile)?JSON.parse(readFileSync(pendingFile,'utf8')):null;if(pending&&pending.namespace!==plan.namespace)throw new Error('先前迁移空间不一致，拒绝覆盖');const id=pending?.id||randomUUID(),keys=storedKeys(home),documents=keys.map(key=>{const file=join(home,key);if(lstatSync(file).isSymbolicLink())throw new Error('业务记录不能是符号链接');const text=readFileSync(file,'utf8');JSON.parse(text);return {key,text};});
  if(!keys.includes('state.json')||!keys.includes('comments.json')||!keys.includes('usage.json'))throw new Error('关键发送或费用账本缺失，拒绝迁移');
  if(pending&&(pending.manifest.length!==documents.length||documents.some(doc=>pending.manifest.find(m=>m.key===doc.key)?.checksum!==hash(doc.text))))throw new Error('先前迁移后来源已变化，保留已有数据库记录并停止');const backup=join(home,'storage-backups',id);mkdirSync(backup,{recursive:true,mode:0o700});for(const doc of documents){const file=join(backup,doc.key);mkdirSync(dirname(file),{recursive:true,mode:0o700});copyFileSync(join(home,doc.key),file);chmodSync(file,0o600);}
  privateJson(pendingFile,{id,namespace:plan.namespace,backup,manifest:documents.map(d=>({key:d.key,checksum:hash(d.text)}))});
  const result=store.call('import',{id,documents});for(const doc of documents){const row=store.get(doc.key);if(row?.checksum!==hash(doc.text)||readFileSync(join(home,doc.key),'utf8')!==doc.text)throw new Error('迁移前后记录不一致，未切换数据源');}
  const binding={version:1,backend:'postgres',namespace:plan.namespace,accountHash:plan.accountHash,connectionFile:plan.connectionFile,requiredKeys:keys,migratedAt:new Date().toISOString(),migrationId:id};privateJson(join(home,'storage.json'),binding);
  const legacy=join(home,'storage-legacy',id);for(const doc of documents){const file=join(legacy,doc.key);mkdirSync(dirname(file),{recursive:true,mode:0o700});renameSync(join(home,doc.key),file);}
  const proof={version:1,id,at:new Date().toISOString(),backend:'postgres',records:documents.length,checksumsVerified:result.manifest.length,backup,legacy,credentialsRemainLocal:true,mediaRemainLocal:true};privateJson(join(home,'storage-migration.json'),proof);return proof;
 }finally{if(leased)try{store.release();}catch{}store.close();release();}
}
export function exportStorage(home,out){const binding=storageBinding(home);if(!binding)throw new Error('当前数据源不是数据库');const target=resolve(out);if(existsSync(target))throw new Error('导出目录必须是新目录');mkdirSync(target,{recursive:true,mode:0o700});const records=binding.store.call('snapshot');for(const record of records){const file=join(target,record.key);mkdirSync(dirname(file),{recursive:true,mode:0o700});writePrivate(file,record.text);}privateJson(join(target,'storage-export.json'),{version:1,at:new Date().toISOString(),accountHash:binding.config.accountHash,records:records.map(({key,checksum})=>({key,checksum}))});return {out:target,records:records.length};}
async function main(){loadEnv();const home=homePath(),command=process.argv[2]||'status';if(command==='setup'){const plan=prepareStorage(home,{port:Number(process.env.DOUYIN_DATABASE_PORT||15432)});const started=await startDatabase(plan);const store=new PostgresStore(plan);try{store.call('init');console.log(JSON.stringify({prepared:true,backend:'postgres',port:plan.port,active:false}));}finally{store.close();}return;}
 if(command==='migrate'){console.log(JSON.stringify(migrateStorage(home,JSON.parse(readFileSync(join(home,'storage-plan.json'),'utf8')))));return;}
 if(command==='export'){const out=process.argv[3];if(!out)throw new Error('请提供新的导出目录');console.log(JSON.stringify(exportStorage(home,out)));return;}
 if(command==='status'){console.log(JSON.stringify(storageStatus(home)));return;}
 throw new Error('用法：storage.mjs setup|migrate|status|export <新目录>');}
if(process.argv[1]===new URL(import.meta.url).pathname)main().catch(e=>{console.error(JSON.stringify({code:e.code||'STORAGE_SETUP_FAILED',message:e.message}));process.exitCode=1;});
