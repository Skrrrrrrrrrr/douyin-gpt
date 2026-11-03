import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDashboard} from '../src/dashboard.mjs';
import {defaultConfig} from '../src/config.mjs';
import {Store,atomicJson} from '../src/store.mjs';

async function start(t,{legacy=false}={}){
 const home=mkdtempSync(join(tmpdir(),'dy-dashboard-access-'));t.after(()=>rmSync(home,{recursive:true,force:true}));new Store(home);writeFileSync(join(home,'dashboard.log'),'fixture startup\n');const cfg=defaultConfig();cfg.monitor.notify=false;atomicJson(join(home,'config.json'),cfg);
 if(legacy){writeFileSync(join(home,'dashboard-auth.json'),'legacy credential remains private');writeFileSync(join(home,'dashboard-initial-password.txt'),'unused old password');}
 const app=createDashboard(home,{port:0}),addr=await app.listen();t.after(()=>new Promise(r=>app.server.close(r)));return {home,base:'http://127.0.0.1:'+addr.port};
}
test('工作台、状态和日志无需登录，也不生成密码、Cookie或令牌',async t=>{
 const {home,base}=await start(t);for(const path of ['/','/api/state','/api/logs','/api/logs/download']){const response=await fetch(base+path,{redirect:'manual'});assert.equal(response.status,200,path);assert.equal(response.headers.get('set-cookie'),null);}
 for(const file of ['dashboard-auth.json','dashboard-initial-password.txt'])assert.equal(existsSync(join(home,file)),false);
});
test('旧凭证损坏或遗留密码不会阻止启动，也不改写或重新启用旧登录',async t=>{
 const {home,base}=await start(t,{legacy:true});assert.equal((await fetch(base+'/api/state')).status,200);assert.equal(readFileSync(join(home,'dashboard-auth.json'),'utf8'),'legacy credential remains private');assert.equal(readFileSync(join(home,'dashboard-initial-password.txt'),'utf8'),'unused old password');
});
test('旧登录地址统一回工作台，登录、改密、登出和会话接口明确退役',async t=>{
 const {base}=await start(t);for(const path of ['/login','/login.html','/login?password=change']){const r=await fetch(base+path,{redirect:'manual'});assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/');}
 for(const path of ['/api/auth/session','/api/auth/login','/api/auth/password','/api/auth/logout']){const r=await fetch(base+path,{method:path.endsWith('session')?'GET':'POST',headers:{'content-type':'application/json'},...(path.endsWith('session')?{}:{body:'{}'})});assert.equal(r.status,410);assert.equal((await r.json()).code,'AUTH_REMOVED');assert.equal(r.headers.get('set-cookie'),null);}
 for(const path of ['/login.js','/login.css'])assert.equal((await fetch(base+path)).status,404);
});
test('历史Cookie和Bearer不再决定访问，跨站来源依旧不能操作管理接口',async t=>{
 const {base}=await start(t);for(const headers of [{cookie:'old=invalid'},{authorization:'Bearer old-session'},{cookie:'old=one; old=two'}])assert.equal((await fetch(base+'/api/state',{headers})).status,200);
 for(const headers of [{origin:'https://evil.example'},{'sec-fetch-site':'cross-site'}])for(const path of ['/api/state','/api/backup-key'])assert.equal((await fetch(base+path,{headers})).status,403);
 const rejected=await fetch(base+'/api/config',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:'{"memory":{"enabled":true}}'});assert.equal(rejected.status,403);
});
test('同源设置可直接保存，API仍拒绝无效字段并保留文件路径边界',async t=>{
 const {base}=await start(t);const changed=await fetch(base+'/api/config',{method:'POST',headers:{'content-type':'application/json'},body:'{"memory":{"enabled":true}}'});assert.equal(changed.status,200);
 const invalid=await fetch(base+'/api/config',{method:'POST',headers:{'content-type':'application/json'},body:'{"account":{"secUid":"injected"}}'});assert.equal(invalid.status,400);
 assert.equal((await fetch(base+'/api/media?kind=voice&id=../../.env')).status,400);
});
