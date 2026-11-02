import {workerData} from 'node:worker_threads';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
import {businessKey,senderKey} from './storage-keys.mjs';

const {port,signal,connectionFile,namespace,accountHash}=workerData,notification=new Int32Array(signal);
const config=JSON.parse(readFileSync(connectionFile,'utf8'));
const pool=new pg.Pool({...config,max:3,connectionTimeoutMillis:2000,query_timeout:3500,statement_timeout:3000,lock_timeout:1500,idle_in_transaction_session_timeout:10000,application_name:'douyin-local-state'});
pool.on('error',()=>{});
const digest=text=>createHash('sha256').update(text).digest('hex');
const error=(code,message)=>Object.assign(new Error(message),{code});
let leaseClient=null,leaseLost=false,transaction=null;
const row=value=>value?{text:value.text,revision:Number(value.revision),checksum:value.checksum}:null;
function validateKey(key){if(!businessKey(key))throw error('STORAGE_KEY_INVALID','该记录不属于可迁移的业务数据');}
function requireSender(key){if(senderKey(key)&&(!leaseClient||leaseLost))throw error('STORAGE_LEASE_LOST','当前进程没有数据库发送锁，已停止提交');}
async function select(client,key,lock=false){const r=await client.query('SELECT data::text AS text, revision::text, checksum FROM assistant_documents WHERE namespace=$1 AND record_key=$2'+(lock?' FOR UPDATE':''),[namespace,key]);if(!r.rowCount){const expected=await client.query('SELECT 1 FROM assistant_record_catalog WHERE namespace=$1 AND record_key=$2',[namespace,key]);if(expected.rowCount)throw error('STORAGE_CORRUPT','业务记录缺失，已停止读取');}return row(r.rows[0]);}
async function put(client,key,text,expected){
 JSON.parse(text);const checksum=digest(text);let result;
 if(expected===0){await client.query('INSERT INTO assistant_record_catalog(namespace,record_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[namespace,key]);result=await client.query('INSERT INTO assistant_documents(namespace,record_key,revision,data,checksum) VALUES($1,$2,1,$3::json,$4) ON CONFLICT DO NOTHING RETURNING revision::text',[namespace,key,text,checksum]);}
 else result=await client.query('UPDATE assistant_documents SET data=$3::json,checksum=$4,revision=revision+1,updated_at=clock_timestamp() WHERE namespace=$1 AND record_key=$2 AND revision=$5 RETURNING revision::text',[namespace,key,text,checksum,expected]);
 if(!result.rowCount)throw error('STORAGE_CONFLICT','业务记录已由其他操作更新，本次变更未提交');
 return {revision:Number(result.rows[0].revision),checksum};
}
async function schema(){await pool.query(`
 CREATE TABLE IF NOT EXISTS assistant_documents(namespace text NOT NULL,record_key text NOT NULL,revision bigint NOT NULL CHECK(revision>0),data json NOT NULL,checksum text NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(namespace,record_key));
 CREATE TABLE IF NOT EXISTS assistant_record_catalog(namespace text NOT NULL,record_key text NOT NULL,PRIMARY KEY(namespace,record_key));
 CREATE TABLE IF NOT EXISTS assistant_migrations(namespace text PRIMARY KEY,migration_id text NOT NULL,manifest json NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());`);return {ready:true};}
async function dispatch(op,args={}){
 if(op==='init')return schema();
 if(op==='ping'){const result=await pool.query("WITH k AS (SELECT hashtextextended($1,0) AS n) SELECT EXISTS(SELECT 1 FROM pg_locks l,k WHERE l.locktype='advisory' AND l.granted AND l.objsubid=1 AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND l.classid::bigint=((k.n>>32)&4294967295) AND l.objid::bigint=(k.n&4294967295)) AS writer",['douyin-sender:'+accountHash]);return {ready:true,lease:!!leaseClient&&!leaseLost,writerPresent:result.rows[0].writer};}
 if(op==='acquire'){
  if(leaseClient&&!leaseLost)throw error('STORAGE_WRITER_BUSY','当前进程已经持有数据库发送锁');
  const client=await pool.connect();try{const r=await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",['douyin-sender:'+accountHash]);if(!r.rows[0].locked)throw error('STORAGE_WRITER_BUSY','另一个发送实例已持有数据库执行锁');leaseClient=client;leaseLost=false;client.on('error',()=>{leaseLost=true;});return {held:true,backendPid:client.processID};}catch(e){client.release(true);throw e;}
 }
 if(op==='release'){if(!leaseClient)return {held:false};const client=leaseClient;leaseClient=null;try{if(!leaseLost)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['douyin-sender:'+accountHash]);}finally{client.release(leaseLost);leaseLost=false;}return {held:false};}
 if(op==='list'){const result=await pool.query('SELECT record_key FROM assistant_documents WHERE namespace=$1 ORDER BY record_key',[namespace]);return result.rows.map(r=>r.record_key).filter(key=>key.startsWith(args.prefix||''));}
 if(op==='get'){validateKey(args.key);return select(pool,args.key);}
 if(op==='put'){validateKey(args.key);requireSender(args.key);const shared=senderKey(args.key),client=shared?leaseClient:await pool.connect();try{await client.query('BEGIN');const result=await put(client,args.key,args.text,args.expected);await client.query('COMMIT');return result;}catch(e){try{await client.query('ROLLBACK');}catch{}throw e;}finally{if(!shared)client.release();}}
 if(op==='snapshot'){const result=await pool.query('SELECT record_key AS key,data::text AS text,revision::text,checksum FROM assistant_documents WHERE namespace=$1 ORDER BY record_key',[namespace]);return result.rows.map(r=>({...r,revision:Number(r.revision)}));}
 if(op==='begin'){
  validateKey(args.key);requireSender(args.key);if(transaction)throw error('STATE_BUSY','数据库提交正在进行');
  const shared=senderKey(args.key),client=shared?leaseClient:await pool.connect();
  try{await client.query('BEGIN');await select(client,args.key);await client.query('INSERT INTO assistant_record_catalog(namespace,record_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[namespace,args.key]);await client.query('INSERT INTO assistant_documents(namespace,record_key,revision,data,checksum) VALUES($1,$2,1,$3::json,$4) ON CONFLICT DO NOTHING',[namespace,args.key,args.initial,digest(args.initial)]);const value=await select(client,args.key,true),token=randomUUID();transaction={client,shared,key:args.key,token};return {...value,token};}
  catch(e){try{await client.query('ROLLBACK');}catch{}if(!shared)client.release();throw e;}
 }
 if(op==='commit'||op==='rollback'){
  const tx=transaction;if(!tx||tx.token!==args.token)throw error('STORAGE_TRANSACTION_INVALID','数据库提交已失效');transaction=null;
  try{if(op==='rollback'){await tx.client.query('ROLLBACK');return {rolledBack:true};}const before=await select(tx.client,tx.key),result=await put(tx.client,tx.key,args.text,before.revision);await tx.client.query('COMMIT');return result;}
  catch(e){try{await tx.client.query('ROLLBACK');}catch{}throw e;}finally{if(!tx.shared)tx.client.release();}
 }
 if(op==='import'){
  if(!leaseClient||leaseLost)throw error('STORAGE_LEASE_LOST','迁移前需要独占数据库执行锁');
  const client=leaseClient;await client.query('BEGIN');
  try{
   const previous=await client.query('SELECT migration_id,manifest::text AS manifest FROM assistant_migrations WHERE namespace=$1',[namespace]);
   if(previous.rowCount){if(previous.rows[0].migration_id!==args.id)throw error('STORAGE_IMPORT_EXISTS','这个业务空间已有迁移记录，拒绝覆盖');await client.query('ROLLBACK');return {recovered:true,manifest:JSON.parse(previous.rows[0].manifest)};}
   const count=await client.query('SELECT count(*)::int AS count FROM assistant_documents WHERE namespace=$1',[namespace]);if(count.rows[0].count)throw error('STORAGE_IMPORT_EXISTS','目标业务空间不是空的，拒绝覆盖');
   const manifest=[];for(const doc of args.documents){validateKey(doc.key);await put(client,doc.key,doc.text,0);manifest.push({key:doc.key,checksum:digest(doc.text)});}
   await client.query('INSERT INTO assistant_migrations(namespace,migration_id,manifest) VALUES($1,$2,$3::json)',[namespace,args.id,JSON.stringify(manifest)]);await client.query('COMMIT');return {recovered:false,manifest};
  }catch(e){try{await client.query('ROLLBACK');}catch{}throw e;}
 }
 throw error('STORAGE_OPERATION_INVALID','数据操作无效');
}
let queue=Promise.resolve();
port.on('message',message=>{queue=queue.then(async()=>{let response;try{response={id:message.id,result:await dispatch(message.op,message.args)};}catch(e){const known=/^(STORAGE_|STATE_BUSY)/.test(e.code||'');response={id:message.id,error:{code:known?e.code:['55P03','40001','40P01'].includes(e.code)?'STATE_BUSY':'STORAGE_UNAVAILABLE',message:known?e.message:'数据库服务暂不可用，当前操作没有得到确认'}};}port.postMessage(response);Atomics.add(notification,0,1);Atomics.notify(notification,0);});});
