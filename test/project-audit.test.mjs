import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {promisify} from 'node:util';import {execFile} from 'node:child_process';
import {atomicJson} from '../src/store.mjs';import {updateState} from '../src/state-file.mjs';import {supervisePending} from '../src/supervised-task.mjs';import {PublicationReview} from '../src/publication-review.mjs';import {Cdp} from '../src/browser.mjs';import {UsageMeter} from '../src/usage.mjs';import {Gpt} from '../src/openai.mjs';import {defaultConfig} from '../src/config.mjs';import {Backups} from '../src/backups.mjs';
const exec=promisify(execFile),empty={version:1,value:0};
function fixture(t){const home=mkdtempSync(join(tmpdir(),'dy-audit-'));t.after(()=>rmSync(home,{recursive:true,force:true}));return home;}
test('进程在状态事务中退出后可恢复，未提交的内存变更不会被写入',async t=>{
 const home=fixture(t),module=new URL('../src/state-file.mjs',import.meta.url).href;atomicJson(join(home,'counter.json'),empty);
 const code=`import {updateState} from ${JSON.stringify(module)};updateState(process.argv[1],'counter.json',{version:1,value:0},d=>{d.value=999;process.exit(13)});`;
 await assert.rejects(exec(process.execPath,['--input-type=module','-e',code,home]),e=>e.code===13);
 updateState(home,'counter.json',empty,d=>{d.value++;});assert.equal(JSON.parse(readFileSync(join(home,'counter.json'))).value,1);assert.equal(existsSync(join(home,'counter.json.lock')),false);assert.ok(readdirSync(home).some(n=>n.includes('.guard.dead-')));
});
test('并发恢复同一把旧锁时不能删除新锁或丢掉其他进程的更新',async t=>{
 const home=fixture(t),module=new URL('../src/state-file.mjs',import.meta.url).href;atomicJson(join(home,'counter.json'),empty);atomicJson(join(home,'counter.json.lock'),{pid:2147483647,token:'dead-fixture'});
 const code=`import {updateState} from ${JSON.stringify(module)};for(let n=0,tries=0;n<25;tries++){if(tries>5000)throw new Error('lock did not recover');try{updateState(process.argv[1],'counter.json',{version:1,value:0},d=>{d.value++;});n++;}catch(e){if(e.code!=='STATE_BUSY')throw e;await new Promise(r=>setTimeout(r,1));}}`;
 await Promise.all(Array.from({length:3},()=>exec(process.execPath,['--input-type=module','-e',code,home],{timeout:15000})));assert.equal(JSON.parse(readFileSync(join(home,'counter.json'))).value,75);
});
test('活进程持有的锁和无法核对的锁保持原样，不能当死锁删除',t=>{
 const home=fixture(t),path=join(home,'counter.json.lock');atomicJson(path,{pid:process.pid,token:'live-fixture'});assert.throws(()=>updateState(home,'counter.json',empty,d=>d.value++),e=>e.code==='STATE_BUSY');assert.equal(JSON.parse(readFileSync(path)).token,'live-fixture');writeFileSync(path,'corrupt-lock');assert.throws(()=>updateState(home,'counter.json',empty,d=>d.value++),e=>e.code==='STATE_BUSY');assert.equal(readFileSync(path,'utf8'),'corrupt-lock');
});
test('长任务期间持续执行守护检查，检查失败不重复启动原任务',async()=>{
 let starts=0,ticks=0,errors=0;const result=await supervisePending(async()=>{starts++;await new Promise(r=>setTimeout(r,35));return 'rendered';},async()=>{ticks++;if(ticks===1)throw new Error('temporary status failure');},{intervalMs:5,onTickError:()=>errors++});assert.equal(result,'rendered');assert.equal(starts,1);assert.ok(ticks>=2);assert.equal(errors,1);
});
test('长任务真实失败会传播，不能误记完成或自行重跑',async()=>{let calls=0;await assert.rejects(supervisePending(async()=>{calls++;throw new Error('render failed');},async()=>{}, {intervalMs:5}),/render failed/);assert.equal(calls,1);});
test('游客作品复核创建后台标签并回收独立上下文，不发激活窗口指令',async t=>{
 const home=fixture(t),oldFetch=globalThis.fetch,oldConnect=Cdp.connect,calls=[];t.after(()=>{globalThis.fetch=oldFetch;Cdp.connect=oldConnect;});
 const page={send:async method=>calls.push(method),ev:async()=>({ready:true}),close(){}};Cdp.connect=async()=>page;globalThis.fetch=async()=>({json:async()=>[{id:'target',webSocketDebuggerUrl:'ws://127.0.0.1/fixture'}]});
 const browser={runtime:{port:1},cdp:{send:async(method,args)=>{calls.push(method);if(method==='Target.createBrowserContext')return {browserContextId:'fixture'};if(method==='Target.createTarget'){assert.equal(args.background,true);return {targetId:'target'};}return {};}}};
 const result=await new PublicationReview(home,defaultConfig(),browser).publicProbe('7400000000000000001');assert.equal(result.visible,true);assert.equal(page.background,true);assert.ok(calls.includes('Target.disposeBrowserContext'));assert.ok(!calls.includes('Page.bringToFront'));assert.ok(!calls.includes('Target.activateTarget'));
});
test('模型5xx与请求超时保留未知费用，明确401拒绝才释放预留',async t=>{
 for(const status of [500,503,408,401]){const home=fixture(t),meter=new UsageMeter(home,{settings:{enabled:true,limitsUSD:{openai:3}}}),model=new Gpt({apiKey:'fixture',baseUrl:'https://api.openai.com/v1',model:'gpt-6-luna'},{fetchImpl:async()=>new Response('{}',{status})});model.meter=meter;
  await assert.rejects(model.request('fixture',{type:'object'},'test',{}),/HTTP/);const r=meter.read().records[0];assert.equal(r.status,status===401?'failed':'unknown');assert.equal(r.usd,status===401?0:null);assert.equal(meter.summary().providers[0].reservedUSD>0,status!==401);
 }
});
test('恢复旧备份仍保留当前专用浏览器后台策略，避免隐式切换或抢焦点',t=>{
 const home=fixture(t),cfg=defaultConfig();cfg.account.secUid='MS4wLjABAAAA_AUDIT_OWNER';cfg.browser={headless:true,background:false};atomicJson(join(home,'config.json'),cfg);const b=new Backups(home),backup=b.create();cfg.browser={headless:false,background:true};atomicJson(join(home,'config.json'),cfg);const plan=b.proof(backup.id);b.restore(backup.id,plan.proof);assert.deepEqual(JSON.parse(readFileSync(join(home,'config.json'))).browser,cfg.browser);assert.ok(plan.preserves.some(s=>s.includes('浏览器')));
});
