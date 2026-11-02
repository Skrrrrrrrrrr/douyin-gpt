import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {createDashboard} from '../src/dashboard.mjs';
import {defaultConfig} from '../src/config.mjs';
import {Store,atomicJson} from '../src/store.mjs';
import {dashboardOrigin,setDashboardOrigins} from '../src/dashboard-origins.mjs';
import {initialPassword} from './helpers/dashboard-login.mjs';

const origin='https://example.github.io',password='test-only-pages-password-2026';
async function start(t,allowed=true){
  const home=mkdtempSync(join(tmpdir(),'dy-pages-'));t.after(()=>rmSync(home,{recursive:true,force:true}));new Store(home);
  const cfg=defaultConfig();cfg.monitor.notify=false;cfg.video.outputDir=join(home,'output');atomicJson(join(home,'config.json'),cfg);
  if(allowed)setDashboardOrigins(home,[origin]);
  const app=createDashboard(home,{port:0}),address=await app.listen();t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  return {home,base:`http://127.0.0.1:${address.port}`};
}
const headers=token=>({origin,'sec-fetch-site':'cross-site',...(token?{authorization:'Bearer '+token}:{})});
const post=(base,path,body,token,extra={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...headers(token),...extra},body:JSON.stringify(body)});
async function login(base,home){
  const response=await post(base,'/api/auth/login',{username:'admin',password:initialPassword(home)});assert.equal(response.status,200);assert.equal(response.headers.get('set-cookie'),null);
  const initial=await response.json();assert.match(initial.accessToken,/^[a-f0-9]{64}$/);
  const changed=await post(base,'/api/auth/password',{currentPassword:initialPassword(home),newPassword:password},initial.accessToken);assert.equal(changed.status,200);
  return {token:(await changed.json()).accessToken,initial:initial.accessToken};
}
test('网页来源默认关闭，只为明确来源提供预检，不允许通配符或其他协议',async t=>{
  const {home,base}=await start(t,false);
  assert.equal((await post(base,'/api/auth/login',{username:'admin',password:'not-sent'})).status,403);
  setDashboardOrigins(home,[origin]);
  const response=await fetch(base+'/api/auth/login',{method:'OPTIONS',headers:{...headers(),'access-control-request-method':'POST','access-control-request-headers':'authorization, content-type','access-control-request-private-network':'true'}});
  assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),origin);assert.equal(response.headers.get('access-control-allow-credentials'),null);assert.equal(response.headers.get('access-control-allow-private-network'),'true');
  for(const value of ['*','https://*.github.io','file:///tmp/file','https://user:pass@example.com','https://example.com/path','null'])assert.throws(()=>dashboardOrigin(value));
  assert.equal(dashboardOrigin('https://EXAMPLE.github.io/'),origin);
  assert.equal(dashboardOrigin('http://192.168.1.20:8080/'),'http://192.168.1.20:8080');
  assert.equal((await fetch(base+'/api/state',{method:'OPTIONS',headers:{...headers(),'access-control-request-method':'DELETE'}})).status,403);
});
test('受信网页使用 Bearer 登录和改密，本机 cookie 不会自动授权跨站请求',async t=>{
  const {home,base}=await start(t),{token,initial}=await login(base,home);
  assert.equal((await fetch(base+'/api/state',{headers:headers(initial)})).status,401);
  const state=await fetch(base+'/api/state',{headers:headers(token)});assert.equal(state.status,200);assert.equal(state.headers.get('access-control-allow-origin'),origin);assert.equal((await state.json()).account,'');
  const local=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password})});assert.equal(local.status,200);
  const cookie=local.headers.get('set-cookie').split(';')[0];assert.equal((await local.json()).accessToken,undefined);
  assert.equal((await fetch(base+'/api/state',{headers:{...headers(),cookie}})).status,401);
  assert.equal((await fetch(base+'/api/state',{headers:{...headers(token),origin:'https://evil.example'}})).status,403);
  const spoofed=await new Promise((resolve,reject)=>{const req=httpRequest(base+'/api/state',{headers:{...headers(token),host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(spoofed,403);
  assert.equal((await post(base,'/api/auth/logout',{},token)).status,200);
  assert.equal((await fetch(base+'/api/state',{headers:headers(token)})).status,401);
  assert.equal((await fetch(base+'/api/state',{headers:{cookie}})).status,200);
});
test('认证媒体支持跨站请求与范围读取，不接受 URL 查询参数里的会话令牌',async t=>{
  const {home,base}=await start(t),{token}=await login(base,home),folder=join(home,'output','voice-samples');mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'D.wav'),'RIFF-test-wave');
  const response=await fetch(base+'/api/media?kind=voice&id=D',{headers:{...headers(token),range:'bytes=0-3'}});
  assert.equal(response.status,206);assert.equal(await response.text(),'RIFF');assert.equal(response.headers.get('access-control-allow-origin'),origin);
  assert.equal((await fetch(base+'/api/media?kind=voice&id=D&token='+token,{headers:headers()})).status,401);
  assert.equal((await fetch(base+'/api/backup-key',{headers:headers()})).status,401);
});
