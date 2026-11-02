import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,existsSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConfig} from '../src/config.mjs';
import {atomicJson} from '../src/store.mjs';
import {containerConfig,rebasePaths,stopContainerWorker} from '../docker/runtime.mjs';
import {importRuntime} from '../docker/import.mjs';

function fixture(t){const base=mkdtempSync(join(tmpdir(),'dy-container-'));t.after(()=>rmSync(base,{recursive:true,force:true}));const source=join(base,'source'),home=join(base,'target');mkdirSync(source);const cfg=defaultConfig();cfg.account.secUid='fixture-account';cfg.video.outputDir=join(base,'old-videos');cfg.journal.outputDir=join(base,'old-logs');cfg.reply.usageContext={enabled:true,audience:'allowlist',contacts:['MS4wLjABAAAA_TEST_OWNER'],groups:false};atomicJson(join(source,'config.json'),cfg);return {base,source,home,cfg};}
test('容器配置只调整运行路径、后台显示和管理端口，保留账号、模型策略及发送范围',()=>{
 const cfg=defaultConfig();cfg.account.secUid='owner';cfg.deepseek.enabled=true;cfg.videoAnalysis.enabled=true;cfg.reply.usageContext={enabled:true,audience:'allowlist',contacts:['MS4wLjABAAAA_TEST_OWNER'],groups:false};const result=containerConfig(cfg);
 assert.deepEqual(result.account,cfg.account);assert.deepEqual(result.reply,cfg.reply);assert.deepEqual(result.budget,cfg.budget);assert.deepEqual(result.deepseek,cfg.deepseek);assert.equal(result.videoAnalysis.enabled,true);assert.equal(result.videoAnalysis.command,'/usr/local/bin/codex');assert.equal(result.dashboard.port,3147);assert.equal(result.dashboard.host,'0.0.0.0');assert.equal(result.browser.headless,false);assert.equal(result.browser.background,true);assert.equal(cfg.dashboard.port,3146);assert.equal(cfg.dashboard.host,'127.0.0.1');
});
test('路径迁移只处理媒体路径字段，不改私信正文、记忆或API凭证',()=>{
 const value={text:'/old/home/private sentence',facts:[{text:'/old/home/quoted fact'}],path:'/old/home/media/a.png',frames:['/old/home/media/b.png'],nested:{file:'/old/videos/show.mp4'},apiKey:'fixture-secret'};
 const result=rebasePaths(value,[['/old/home','/data'],['/old/videos','/data/video-output']]);assert.equal(result.text,value.text);assert.deepEqual(result.facts,value.facts);assert.equal(result.apiKey,value.apiKey);assert.equal(result.path,'/data/media/a.png');assert.equal(result.frames[0],'/data/media/b.png');assert.equal(result.nested.file,'/data/video-output/show.mp4');
});
test('迁移完整记忆、费用、发送账本，跳过Mac浏览器和旧进程锁，默认暂停自动执行',t=>{
 const h=fixture(t);for(const name of ['memory.json','usage.json','state.json','comments.json','dashboard-auth.json','openai.json','deepseek.json'])atomicJson(join(h.source,name),{version:1,fixture:name});mkdirSync(join(h.source,'browser'));writeFileSync(join(h.source,'browser','Cookies'),'mac-only');atomicJson(join(h.source,'process.lock'),{pid:123});atomicJson(join(h.source,'daemon.json'),{pid:123});const original=readFileSync(join(h.source,'config.json'),'utf8');
 const proof=importRuntime(h);assert.equal(proof.activation,'paused');assert.equal(proof.liveCutoverComplete,false);assert.equal(proof.browserLoginRequired,true);assert.equal(existsSync(join(h.home,'browser')),false);assert.equal(existsSync(join(h.home,'process.lock')),false);assert.equal(existsSync(join(h.home,'daemon.json')),false);for(const name of ['memory.json','usage.json','state.json','comments.json','dashboard-auth.json','openai.json','deepseek.json'])assert.equal(JSON.parse(readFileSync(join(h.home,name))).fixture,name);
 assert.equal(JSON.parse(readFileSync(join(h.home,'service-desired.json'))).worker,false);assert.equal(readFileSync(join(h.source,'config.json'),'utf8'),original);assert.deepEqual(JSON.parse(readFileSync(join(h.home,'config.json'))).reply.usageContext,h.cfg.reply.usageContext);
});
test('导入只允许空数据卷，拒绝覆盖已有消息、跟随软链接或导入回原目录',t=>{
 const h=fixture(t);assert.throws(()=>importRuntime({...h,home:h.source}),/empty/);mkdirSync(h.home);atomicJson(join(h.home,'config.json'),h.cfg);assert.throws(()=>importRuntime(h),/empty/);rmSync(h.home,{recursive:true});symlinkSync(join(h.source,'config.json'),join(h.source,'linked.json'));assert.throws(()=>importRuntime(h),/symbolic/);
});
test('旧Mac加密备份单独归档，不会出现在容器当前备份恢复列表',t=>{
 const h=fixture(t);mkdirSync(join(h.source,'backups'));writeFileSync(join(h.source,'backups','old.dybackup'),'encrypted-fixture');importRuntime(h);assert.equal(existsSync(join(h.home,'backups','old.dybackup')),false);assert.equal(readFileSync(join(h.home,'imported-macos-backups','old.dybackup'),'utf8'),'encrypted-fixture');
});
test('缺配置但已有发送账本的目标仍拒绝覆盖',t=>{
 const h=fixture(t);mkdirSync(h.home);writeFileSync(join(h.home,'state.json'),'preserve-existing');assert.throws(()=>importRuntime(h),/empty/);assert.equal(readFileSync(join(h.home,'state.json'),'utf8'),'preserve-existing');
});
test('源JSON损坏时清理临时导入，不留下可误启用的半套账号配置',t=>{
 const h=fixture(t);writeFileSync(join(h.source,'state.json'),'broken-json');assert.throws(()=>importRuntime(h));assert.equal(existsSync(join(h.home,'config.json')),false);assert.equal(existsSync(join(h.home,'.import.lock')),false);assert.equal(readFileSync(join(h.source,'state.json'),'utf8'),'broken-json');
});
test('重启容器保留人工暂停，不因内部stop维护命令偷偷打开自动发送',t=>{
 const h=fixture(t);mkdirSync(h.home);const file=join(h.home,'service-desired.json');atomicJson(file,{version:1,worker:false,dashboard:true,maintenanceUntil:0});let calls=0;assert.equal(stopContainerWorker(h.home,()=>calls++),false);assert.equal(calls,0);assert.equal(JSON.parse(readFileSync(file)).worker,false);
 atomicJson(file,{version:1,worker:true,dashboard:true,maintenanceUntil:0});assert.equal(stopContainerWorker(h.home,()=>{calls++;atomicJson(file,{version:1,worker:true,dashboard:true,maintenanceUntil:Date.now()+600000});}),true);assert.equal(JSON.parse(readFileSync(file)).worker,true);assert.equal(JSON.parse(readFileSync(file)).maintenanceUntil,0);
});
