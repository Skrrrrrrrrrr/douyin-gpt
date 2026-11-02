import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDashboard} from '../src/dashboard.mjs';
import {DashboardAuth,provisionDashboardAuth} from '../src/dashboard-auth.mjs';
import {defaultConfig} from '../src/config.mjs';
import {Store,atomicJson} from '../src/store.mjs';
import {initialPassword,loginDashboard} from './helpers/dashboard-login.mjs';

function homeFor(t) {
  const home=mkdtempSync(join(tmpdir(),'dy-dashboard-auth-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  new Store(home);atomicJson(join(home,'config.json'),defaultConfig());
  return home;
}
async function start(t,options={}) {
  const home=homeFor(t),app=createDashboard(home,{port:0,...options}),address=await app.listen();
  t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  return {home,app,base:`http://127.0.0.1:${address.port}`};
}
const post=(base,path,body,cookie='',extra={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie}:{}),...extra},body:JSON.stringify(body)});
const cookieOf=response=>response.headers.get('set-cookie').split(';')[0];
async function initialLogin(base,home) {
  const response=await post(base,'/api/auth/login',{username:'admin',password:initialPassword(home)});
  assert.equal(response.status,200);
  return response;
}

test('未登录首页跳转登录页且不发会话，所有管理数据、文件及操作均不能绕过',async t=>{
  const {base}=await start(t);
  const root=await fetch(base,{redirect:'manual'});
  assert.equal(root.status,303);assert.equal(root.headers.get('location'),'/login');assert.equal(root.headers.get('set-cookie'),null);
  for(const path of ['/login','/login.js','/login.css','/fonts/dm-sans-400.ttf'])assert.equal((await fetch(base+path)).status,200,path);
  const page=await fetch(base+'/login');assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(await page.text(),/登录后台管理/);
  const paths=['/api/state','/api/media?kind=voice&id=D','/api/media?kind=sticker&id=gpt-ack','/api/backup-key','/api/backup-file?id=anything','/host/gpt.png','/modern.js','/features.js','/app.js','/index.html','/dashboard-auth.json','/dashboard-initial-password.txt'];
  for(const path of paths){const r=await fetch(base+path);assert.equal(r.status,401,path);assert.equal((await r.json()).code,'AUTH_REQUIRED');}
  for(const path of ['/api/config','/api/daemon','/api/backup','/api/reviews','/api/official','/api/preview'])assert.equal((await post(base,path,{})).status,401,path);
  const status=await(await fetch(base+'/api/auth/session')).json();assert.deepEqual(status,{authenticated:false,username:'',mustChangePassword:false,expiresAt:null});
});

test('初始密码只保存在私有本机文件，初次登录必须改密后才能访问后台',async t=>{
  const {home,base}=await start(t),password=initialPassword(home),file=join(home,'dashboard-auth.json');
  const raw=readFileSync(file,'utf8');assert.ok(!raw.includes(password));assert.equal(statSync(file).mode&0o777,0o600);assert.equal(statSync(join(home,'dashboard-initial-password.txt')).mode&0o777,0o600);
  const login=await initialLogin(base,home),initialCookie=cookieOf(login);assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800/);
  assert.equal((await login.json()).mustChangePassword,true);
  assert.equal((await fetch(base+'/api/state',{headers:{cookie:initialCookie}})).status,401);
  assert.equal((await fetch(base,{headers:{cookie:initialCookie},redirect:'manual'})).status,303);
  const rejected=await post(base,'/api/auth/password',{currentPassword:password,newPassword:'short'},initialCookie);assert.equal(rejected.status,400);
  const changed=await post(base,'/api/auth/password',{currentPassword:password,newPassword:'my-new-secure-password-2026'},initialCookie);
  assert.equal(changed.status,200);const cookie=cookieOf(changed);assert.notEqual(cookie,initialCookie);assert.equal((await changed.json()).mustChangePassword,false);
  assert.equal(existsSync(join(home,'dashboard-initial-password.txt')),false);assert.ok(!readFileSync(file,'utf8').includes('my-new-secure-password-2026'));
  assert.equal((await fetch(base+'/api/state',{headers:{cookie}})).status,200);
  assert.equal((await fetch(base+'/api/state',{headers:{cookie:initialCookie}})).status,401);
  assert.equal((await fetch(base+'/login',{headers:{cookie},redirect:'manual'})).status,303);
  assert.equal((await fetch(base+'/login?password=change',{headers:{cookie}})).status,200);
});

test('退出立即撤销会话，打开首页、伪造旧 cookie 和重复 cookie 不会重新获得权限',async t=>{
  const {home,base}=await start(t),cookie=await loginDashboard(base,home);
  assert.equal((await fetch(base+'/api/state',{headers:{cookie}})).status,200);
  assert.equal((await fetch(base+'/api/state',{headers:{cookie:cookie+'; '+cookie}})).status,401);
  const logout=await post(base,'/api/auth/logout',{},cookie);assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await fetch(base+'/api/state',{headers:{cookie}})).status,401);
  assert.equal((await fetch(base,{headers:{cookie},redirect:'manual'})).headers.get('set-cookie'),null);
  assert.equal((await fetch(base+'/api/state',{headers:{cookie:cookie.split('=')[0]+'='+'a'.repeat(64)}})).status,401);
});

test('闲置超时及绝对超时由服务端执行，轮询不能延长绝对期限',async t=>{
  let now=100000;
  const {home,base}=await start(t,{authOptions:{now:()=>now,idleTtlMs:1000,sessionTtlMs:3000}}),cookie=await loginDashboard(base,home);
  now+=1001;assert.equal((await fetch(base+'/api/state',{headers:{cookie}})).status,401);
  const login=await post(base,'/api/auth/login',{username:'admin',password:'test-only-dashboard-password-42'}),fresh=cookieOf(login);
  for(let i=0;i<3;i++){now+=900;assert.equal((await fetch(base+'/api/auth/session',{headers:{cookie:fresh}})).status,200);}
  now+=301;assert.equal((await fetch(base+'/api/state',{headers:{cookie:fresh}})).status,401);
});

test('密码错误与账号错误使用相同结果，连续尝试触发限制并给出等待时间',async t=>{
  let now=100000;const {home,base}=await start(t,{authOptions:{now:()=>now,attemptWindowMs:10000}});
  for(let i=0;i<5;i++){const r=await post(base,'/api/auth/login',{username:i%2?'someone':'admin',password:'wrong-password-2026'});assert.equal(r.status,401);assert.equal((await r.json()).error,'账号或密码不正确');}
  const limited=await post(base,'/api/auth/login',{username:'admin',password:initialPassword(home)});assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'10');
  now+=10001;assert.equal((await initialLogin(base,home)).status,200);
});

test('跨站登录、跨站登出、表单请求和过大请求均拒绝，错误不会泄漏密码',async t=>{
  const {home,base}=await start(t),password=initialPassword(home);
  assert.equal((await post(base,'/api/auth/login',{username:'admin',password},'',{origin:'https://evil.example'})).status,403);
  assert.equal((await post(base,'/api/auth/login',{username:'admin',password},'',{'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'username=admin'})).status,415);
  assert.equal((await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:'['})).status,400);
  assert.equal((await post(base,'/api/auth/login',{username:'admin',password:'x'.repeat(5000)})).status,413);
  const cookie=await loginDashboard(base,home);
  assert.equal((await post(base,'/api/auth/logout',{},cookie,{origin:'https://evil.example'})).status,403);
  assert.equal((await fetch(base+'/api/state',{headers:{cookie}})).status,200);
});

test('修改密码撤销其他会话；认证重建后密码持久化、浏览器会话不持久化',async t=>{
  const home=homeFor(t),auth=new DashboardAuth(home),password=initialPassword(home);
  await auth.login('admin',password);const original=await auth.changePassword(password,'persistent-password-2026');
  const second=await auth.login('admin','persistent-password-2026'),req=token=>({headers:{cookie:auth.cookieName(3146)+'='+token}});
  const changed=await auth.changePassword('persistent-password-2026','another-secure-password-2026');
  assert.equal(auth.session(req(original.token),3146),null);assert.equal(auth.session(req(second.token),3146),null);assert.ok(auth.session(req(changed.token),3146));
  const restarted=new DashboardAuth(home);assert.equal(restarted.session(req(changed.token),3146),null);
  await assert.rejects(restarted.login('admin','persistent-password-2026'),/账号或密码不正确/);
  assert.equal((await restarted.login('admin','another-secure-password-2026')).mustChangePassword,false);
});

test('凭证损坏时关闭入口，不重新生成绕过；显式本机重置撤销现有会话',async t=>{
  const home=homeFor(t),auth=new DashboardAuth(home),password=initialPassword(home);
  const session=await auth.changePassword(password,'a-strong-private-password-2026'),req={headers:{cookie:auth.cookieName(3146)+'='+session.token}};
  provisionDashboardAuth(home,{reset:true});assert.equal(auth.session(req,3146),null);assert.equal((await auth.login('admin',initialPassword(home))).mustChangePassword,true);
  const file=join(home,'dashboard-auth.json');writeFileSync(file,'BROKEN');assert.throws(()=>new DashboardAuth(home),/无法读取/);assert.equal(readFileSync(file,'utf8'),'BROKEN');
});
