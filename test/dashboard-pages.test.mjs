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

const origin='https://example.github.io';
async function start(t,allowed=true){
  const home=mkdtempSync(join(tmpdir(),'dy-pages-'));t.after(()=>rmSync(home,{recursive:true,force:true}));new Store(home);
  const cfg=defaultConfig();cfg.monitor.notify=false;cfg.video.outputDir=join(home,'output');atomicJson(join(home,'config.json'),cfg);
  if(allowed)setDashboardOrigins(home,[origin]);
  const app=createDashboard(home,{port:0}),address=await app.listen();t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  return {home,base:`http://127.0.0.1:${address.port}`};
}
const headers=token=>({origin,'sec-fetch-site':'cross-site',...(token?{authorization:'Bearer '+token}:{})});
const post=(base,path,body,token,extra={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...headers(token),...extra},body:JSON.stringify(body)});
test('网页来源默认关闭，只为明确来源提供预检，不允许通配符或其他协议',async t=>{
  const {home,base}=await start(t,false);
  assert.equal((await post(base,'/api/config',{})).status,403);
  setDashboardOrigins(home,[origin]);
  const response=await fetch(base+'/api/config',{method:'OPTIONS',headers:{...headers(),'access-control-request-method':'POST','access-control-request-headers':'authorization, content-type','access-control-request-private-network':'true'}});
  assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),origin);assert.equal(response.headers.get('access-control-allow-credentials'),null);assert.equal(response.headers.get('access-control-allow-private-network'),'true');
  for(const value of ['*','https://*.github.io','file:///tmp/file','https://user:pass@example.com','https://example.com/path','null'])assert.throws(()=>dashboardOrigin(value));
  assert.equal(dashboardOrigin('https://EXAMPLE.github.io/'),origin);
  assert.equal(dashboardOrigin('http://192.168.1.20:8080/'),'http://192.168.1.20:8080');
  assert.equal((await fetch(base+'/api/state',{method:'OPTIONS',headers:{...headers(),'access-control-request-method':'DELETE'}})).status,403);
});
test('明确允许的独立界面直接读取和操作，未授权来源与Host仍拒绝',async t=>{
 const {base}=await start(t);const state=await fetch(base+'/api/state',{headers:headers()});assert.equal(state.status,200);assert.equal(state.headers.get('access-control-allow-origin'),origin);assert.equal((await state.json()).account,'');assert.equal(state.headers.get('set-cookie'),null);
 assert.equal((await fetch(base+'/api/state',{headers:{...headers(),origin:'https://evil.example'}})).status,403);
 const spoofed=await new Promise((resolve,reject)=>{const req=httpRequest(base+'/api/state',{headers:{...headers(),host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(spoofed,403);
});
test('允许的界面无需令牌读取媒体和范围，文件目录限制不变',async t=>{
 const {home,base}=await start(t),folder=join(home,'output','voice-samples');mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'D.wav'),'RIFF-test-wave');
 const r=await fetch(base+'/api/media?kind=voice&id=D',{headers:{...headers(),range:'bytes=0-3'}});assert.equal(r.status,206);assert.equal(await r.text(),'RIFF');assert.equal(r.headers.get('access-control-allow-origin'),origin);assert.equal((await fetch(base+'/api/media?kind=voice&id=../../.env',{headers:headers()})).status,400);assert.equal((await fetch(base+'/api/backup-key',{headers:headers()})).status,200);
});
