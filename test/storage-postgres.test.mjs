import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import pg from 'pg';
import {defaultConfig,writePrivate} from '../src/config.mjs';import {Store,atomicJson,takeLock} from '../src/store.mjs';import {readState,updateState} from '../src/state-file.mjs';
import {PostgresStore,storageBinding,storedJson,storedExists,storedKeys} from '../src/storage.mjs';import {Reviews,reviewHash} from '../src/reviews.mjs';import {CommentStore} from '../src/comment-store.mjs';import {ConversationMemory} from '../src/memory.mjs';import {UsageMeter} from '../src/usage.mjs';import {Backups} from '../src/backups.mjs';import {migrateStorage,exportStorage} from '../scripts/storage.mjs';
import {Engine} from '../src/engine.mjs';
const exec=promisify(execFile),connectionFile=process.env.DOUYIN_STORAGE_TEST_CONNECTION_FILE,hash=x=>createHash('sha256').update(x).digest('hex');
function json(file,data){writePrivate(file,JSON.stringify(data,null,2)+'\n');}
async function fixture(t,{bind=true,lease=false}={}){
 const home=mkdtempSync(join(tmpdir(),'dy-pg-state-')),id=randomUUID(),cfg=defaultConfig();cfg.account.secUid='fixture-'+id;cfg.monitor.notify=false;cfg.reply.contacts=[{secUid:'MS4wLjABAAAA_STORAGE_PEER',label:'测试联系人',enabled:true}];cfg.reply.enabled=true;cfg.memory.enabled=true;cfg.budget={enabled:true,limitsUSD:{openai:3,deepseek:1.5}};json(join(home,'config.json'),cfg);
 const config={version:1,backend:'postgres',namespace:'test_'+id.replaceAll('-','_'),accountHash:hash(cfg.account.secUid),connectionFile};const direct=new PostgresStore(config);direct.call('init');if(bind)json(join(home,'storage.json'),config);
 const store=bind?storageBinding(home).store:direct;let release=lease?takeLock(home):null;
 t.after(async()=>{try{release?.();}catch{}try{store.release();}catch{}await store.close();if(direct!==store)await direct.close();const client=new pg.Client(JSON.parse(readFileSync(connectionFile,'utf8')));await client.connect();try{for(const table of ['assistant_migrations','assistant_documents','assistant_record_catalog'])await client.query('DELETE FROM '+table+' WHERE namespace=$1',[config.namespace]);}finally{await client.end();}rmSync(home,{recursive:true,force:true});});
 return {home,cfg,config,store,direct,release:()=>{release?.();release=null;}};
}
if(!connectionFile)test('PostgreSQL集成需要明确的隔离测试连接配置',{skip:true},()=>{});
else{
test('真实数据库保存业务账本，主目录不写业务JSON，密钥仍留本机',async t=>{
 const h=await fixture(t,{lease:true}),s=new Store(h.home);s.save();const file=join(h.home,'state.json');assert.equal(existsSync(file),false);assert.equal(storedExists(file),true);assert.equal(storedJson(file).version,1);atomicJson(join(h.home,'openai.json'),{apiKey:'fixture-private-key'});assert.equal(existsSync(join(h.home,'openai.json')),true);assert.ok(!h.store.call('list').includes('openai.json'));
});
test('事务回调异常或返回Promise时回滚，不能提交半条更新',async t=>{
 const h=await fixture(t);updateState(h.home,'analytics.json',{version:1,count:0},d=>d.count++);assert.throws(()=>updateState(h.home,'analytics.json',{version:1},d=>{d.count=99;throw new Error('fixture cancellation');}));assert.throws(()=>updateState(h.home,'analytics.json',{version:1},async d=>{d.count=100;}),/等待网络/);assert.equal(readState(h.home,'analytics.json',{}).count,1);
});
test('多进程并发更新通过数据库行锁串行，重启读取不会丢计数',async t=>{
 const h=await fixture(t),module=new URL('../src/state-file.mjs',import.meta.url).href;const code=`import {updateState} from ${JSON.stringify(module)};for(let n=0;n<15;n++)updateState(process.argv[1],'analytics.json',{version:1,count:0},d=>d.count++);`;
 await Promise.all([0,1,2].map(()=>exec(process.execPath,['--input-type=module','-e',code,h.home],{timeout:20000})));assert.equal(readState(h.home,'analytics.json',{}).count,45);
});
test('旧实例写入会触发版本冲突，不能覆盖新发送记录',async t=>{
 const h=await fixture(t,{lease:true}),first=new Store(h.home);first.save();const old=new Store(h.home),fresh=new Store(h.home);fresh.data.marker='new';fresh.save();old.data.marker='stale';assert.throws(()=>old.save(),e=>e.code==='STORAGE_CONFLICT');assert.equal(new Store(h.home).data.marker,'new');assert.equal(old.data.marker,'new');
});
test('原始JSON字段顺序和审批哈希保留，跨实例记忆删除立即可见',async t=>{
 const h=await fixture(t),reviews=new Reviews(h.home),item=reviews.add('private','fixture',{z:'last',a:'first',text:'普通草稿'}),loaded=reviews.list()[0];assert.equal(reviewHash(loaded),item.hash);assert.equal(reviews.approve(item.id,item.hash).status,'approved');
 const contact=h.cfg.reply.contacts[0],m=new ConversationMemory(h.home,h.cfg);await m.observe(contact,[{id:'incoming-fixture',from:'them',text:'我喜欢烤鱼。'}],{extractMemory:async()=>({facts:[{kind:'preference',text:'我喜欢烤鱼。',sourceIds:['incoming-fixture']}]})});const other=new ConversationMemory(h.home,h.cfg);assert.equal(other.facts(contact.secUid).length,1);other.forget(contact.secUid,other.facts(contact.secUid)[0].id);assert.equal(m.facts(contact.secUid).length,0);
});
test('费用预留、实际用量与未确认结果在数据库中仍受原预算约束',async t=>{
 const h=await fixture(t),meter=new UsageMeter(h.home),request={model:'gpt-6-luna',input:[{role:'user',content:[{type:'input_text',text:'fixture'}]}],max_output_tokens:800},id=meter.begin('openai','chat_reply','gpt-6-luna',{request});meter.finish(id,{status:'unknown'});const after=new UsageMeter(h.home).summary().providers[0];assert.equal(after.unknown,1);assert.ok(after.reservedUSD>0);assert.equal(after.blockingUnknown,0);assert.doesNotThrow(()=>meter.assertAvailable('openai','gpt-6-luna'));
});
test('另一个目录和进程不能同时获得同账号发送锁，重启只将sending改为uncertain',async t=>{
 const h=await fixture(t,{lease:true}),s=new Store(h.home),action=s.draft(h.cfg.reply.contacts[0],[{id:'input-unique'}],'fixture reply','fixture');s.transition(action,'sending');const alias=join(h.home,'second-runtime');mkdirSync(alias);json(join(alias,'config.json'),h.cfg);json(join(alias,'storage.json'),h.config);const module=new URL('../src/store.mjs',import.meta.url).href;
 const busy=`import {takeLock} from ${JSON.stringify(module)};try{const release=takeLock(process.argv[1]);release();process.exitCode=9;}catch(e){if(e.code!=='STORAGE_WRITER_BUSY')throw e;console.log('writer-blocked');}`;const result=await exec(process.execPath,['--input-type=module','-e',busy,alias]);assert.match(result.stdout,/writer-blocked/);assert.equal(existsSync(join(alias,'process.lock')),false);
 h.release();const recover=`import {takeLock,Store} from ${JSON.stringify(module)};const release=takeLock(process.argv[1]);try{const s=new Store(process.argv[1]);s.recover();console.log(s.data.outbox[0].status);}finally{release();}`;assert.match((await exec(process.execPath,['--input-type=module','-e',recover,alias])).stdout,/uncertain/);assert.equal(new Store(h.home).data.outbox.length,1);
});
test('失去数据库执行锁后即便普通连接恢复也不能继续提交发送状态',async t=>{
 const h=await fixture(t,{lease:true}),s=new Store(h.home);s.save();const pid=h.store.leaseBackendPid,client=new pg.Client(JSON.parse(readFileSync(connectionFile,'utf8')));await client.connect();try{await client.query('SELECT pg_terminate_backend($1)',[pid]);}finally{await client.end();}
 assert.throws(()=>s.save(),e=>['STORAGE_LEASE_LOST','STORAGE_UNAVAILABLE'].includes(e.code));
});
test('业务数据库执行锁失效会退出回复流程，新来信不被消费且不调用模型或发送',async t=>{
 const h=await fixture(t,{lease:true});h.cfg.memory.enabled=false;h.cfg.monitor.enabled=false;h.cfg.reply.media.enabled=false;h.cfg.reply.takeover.enabled=false;const s=new Store(h.home),contact=h.cfg.reply.contacts[0],old={id:'old',from:'them',text:'baseline'};s.baseline(contact.secUid,[old]);let generated=0,sent=0;
 const engine=new Engine({...h,store:s,gpt:{config:{model:'fixture'},reply:async()=>{generated++;return {shouldReply:true,text:'fixture'};}},messenger:{read:async()=>[old,{id:'new-unconsumed',from:'them',text:'hello'}],send:async()=>{sent++;}},dy:{checkAccount:async()=>h.cfg.account},live:true,log:()=>{}});
 const client=new pg.Client(JSON.parse(readFileSync(connectionFile,'utf8')));await client.connect();try{await client.query('SELECT pg_terminate_backend($1)',[h.store.leaseBackendPid]);}finally{await client.end();}
 await assert.rejects(engine.pollReplies(),e=>['STORAGE_LEASE_LOST','STORAGE_UNAVAILABLE'].includes(e.code));assert.equal(generated,0);assert.equal(sent,0);assert.ok(!new Store(h.home).contact(contact.secUid).seen.includes('new-unconsumed'));
});
test('连接中断或记录被删时不会读本机旧副本，也不会默认为空账本',async t=>{
 const h=await fixture(t,{lease:true}),s=new Store(h.home);s.save();writeFileSync(join(h.home,'state.json'),JSON.stringify({version:1,contacts:{},outbox:[],videos:[],stale:true}));const client=new pg.Client(JSON.parse(readFileSync(connectionFile,'utf8')));await client.connect();try{await client.query('DELETE FROM assistant_documents WHERE namespace=$1 AND record_key=$2',[h.config.namespace,'state.json']);}finally{await client.end();}assert.throws(()=>new Store(h.home),e=>e.code==='STORAGE_CORRUPT');
 const bad=join(h.home,'offline');mkdirSync(bad);const connection=JSON.parse(readFileSync(connectionFile,'utf8'));json(join(bad,'connection.json'),{...connection,port:1});json(join(bad,'storage.json'),{...h.config,connectionFile:join(bad,'connection.json')});writeFileSync(join(bad,'state.json'),JSON.stringify({stale:true}));assert.throws(()=>storedJson(join(bad,'state.json')),e=>e.code==='STORAGE_UNAVAILABLE');await storageBinding(bad).store.close();
});
test('迁移一次性保留发送、评论与发布状态，导出与加密备份覆盖数据库',async t=>{
 const h=await fixture(t,{bind:false}),original={version:1,contacts:{},outbox:[{id:'sent-id',status:'sent',inputIds:['seen']},{id:'unknown-id',status:'uncertain',inputIds:['unknown-input']}],videos:[],apiUsage:[],lastBrowseAt:1};json(join(h.home,'state.json'),original);json(join(h.home,'comments.json'),{version:1,initialized:true,seen:[],actions:[{id:'accepted-comment',status:'accepted'}],lastPollAt:0,halted:''});json(join(h.home,'usage.json'),{version:1,startedAt:'',records:[]});const day=join(h.home,'video','2026-11-02');mkdirSync(day,{recursive:true});json(join(day,'episode.json'),{status:'publishing',day:'2026-11-02'});const proof=migrateStorage(h.home,h.config);assert.equal(proof.records,4);assert.equal(existsSync(join(h.home,'state.json')),false);assert.equal(storedJson(join(h.home,'state.json')).outbox[1].status,'uncertain');assert.equal(storedJson(join(day,'episode.json')).status,'publishing');assert.equal(storedKeys(h.home,'video/').length,1);
 const out=join(h.home,'export');assert.equal(exportStorage(h.home,out).records,4);assert.equal(JSON.parse(readFileSync(join(out,'state.json'))).outbox[0].id,'sent-id');const b=new Backups(h.home),backup=b.create(),snapshot=b.decode(backup.id).files.find(f=>f.name==='database-state.json');assert.ok(snapshot);assert.equal(JSON.parse(Buffer.from(snapshot.data,'base64')).records.length,4);assert.throws(()=>migrateStorage(h.home,h.config),/重复迁移/);await storageBinding(h.home).store.close();
});
test('导入失败整体回滚，已确认的同一迁移可恢复，另一迁移不能覆盖',async t=>{
 const h=await fixture(t,{bind:false});h.store.acquire();assert.throws(()=>h.store.call('import',{id:'failed',documents:[{key:'usage.json',text:'{"version":1}'},{key:'openai.json',text:'{}'}]}),e=>e.code==='STORAGE_KEY_INVALID');assert.deepEqual(h.store.call('snapshot'),[]);
 const docs=[{key:'usage.json',text:'{"version":1,"records":[]}\n'}];assert.equal(h.store.call('import',{id:'same',documents:docs}).recovered,false);assert.equal(h.store.call('import',{id:'same',documents:docs}).recovered,true);assert.throws(()=>h.store.call('import',{id:'another',documents:docs}),e=>e.code==='STORAGE_IMPORT_EXISTS');assert.equal(h.store.get('usage.json').text,docs[0].text);
});
}
