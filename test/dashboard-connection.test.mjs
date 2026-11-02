import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackendClient,normalizeBackendUrl} from '../web/connection.js';

const token='a'.repeat(64),pageUrl='https://example.github.io/douyin-gpt/index.html';
function storage(){const values=new Map();return {values,getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};}
function setup(){const calls=[],session=storage(),preferences=storage(),revoked=[];let id=0;const client=createBackendClient({pageUrl,hosted:true,backendUrl:'http://127.0.0.1:3146',storage:preferences,sessionStorage:session,createUrl:()=>`blob:fixture-${++id}`,revokeUrl:value=>revoked.push(value),fetchImpl:async(url,options)=>{calls.push({url,options});if(url.endsWith('/api/auth/login'))return Response.json({accessToken:token});if(url.includes('/api/media?'))return new Response('private-local-image',{headers:{'content-type':'image/png'}});return Response.json({ok:true});}});return {client,calls,session,preferences,revoked};}
test('连接支持明确的域名和IP，登录凭证仅发往所选服务，地址和路径不带会话令牌',async()=>{
  const h=setup();for(const value of ['javascript:alert(1)','file:///tmp/file','http://user:pass@localhost','http://localhost/path','http://localhost/?token=x'])assert.throws(()=>normalizeBackendUrl(value));
  assert.equal(normalizeBackendUrl('http://localhost:3146/'),'http://localhost:3146');
  assert.equal(normalizeBackendUrl('https://assistant.example.com/'),'https://assistant.example.com');assert.equal(normalizeBackendUrl('http://192.168.1.20:3147/'),'http://192.168.1.20:3147');assert.equal(normalizeBackendUrl('http://[fd00::1]:3147/'),'http://[fd00::1]:3147');
  await h.client.request('/api/auth/login',{method:'POST',body:JSON.stringify({password:'fixture-private-password'})});
  await h.client.request('/api/state');
  assert.equal(h.calls[0].url,'http://127.0.0.1:3146/api/auth/login');assert.equal(h.calls[0].options.credentials,'omit');assert.equal(h.calls[1].options.headers.get('authorization'),'Bearer '+token);
  assert.ok(!h.calls[1].url.includes(token));assert.ok(!JSON.stringify([...h.session.values]).includes('fixture-private-password'));assert.deepEqual([...h.preferences.values],[]);
  assert.equal(h.client.loginUrl(),'https://example.github.io/douyin-gpt/login.html');assert.equal(h.client.assetUrl('/host/gpt.png'),'https://example.github.io/douyin-gpt/host/gpt.png');
  await assert.rejects(h.client.request('https://evil.example/api/state'),/路径无效/);
});
test('私有媒体使用认证 fetch 和内存 Blob，预览更新与退出会清理缓存',async()=>{
  const h=setup();await h.client.request('/api/auth/login');let changed=0;h.client.subscribe(()=>changed++);
  assert.equal(h.client.resource('/api/media?kind=preview'),undefined);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.client.resource('/api/media?kind=preview'),'blob:fixture-1');assert.equal(h.calls.at(-1).options.headers.get('authorization'),'Bearer '+token);assert.ok(changed>0);
  h.client.setRevision('new-preview');assert.deepEqual(h.revoked,['blob:fixture-1']);assert.equal(h.client.resource('/api/media?kind=preview'),undefined);await new Promise(resolve=>setImmediate(resolve));
  await h.client.request('/api/auth/logout',{method:'POST'});assert.equal(h.client.hasSession(),false);assert.equal(h.client.resource('/api/media?kind=preview'),undefined);
});
test('切换本机地址会取消旧媒体结果，下载只在明确请求时发生',async()=>{
  const h=setup();await h.client.request('/api/auth/login');const before=h.calls.length;
  assert.equal(before,1);h.client.setBase('http://localhost:4000');assert.equal(h.client.hasSession(),false);assert.equal(h.client.getBase(),'http://localhost:4000');
  assert.ok([...h.preferences.values.values()].every(value=>!value.includes(token)));
  await assert.rejects(h.client.download('/api/state'),/不允许/);
});

test('服务日志下载在点击后使用认证请求，文件和过期会话不进入公共链接',async()=>{
  const calls=[];let expired=false;const client=createBackendClient({pageUrl,hosted:true,storage:storage(),sessionStorage:storage(),fetchImpl:async(url,options)=>{
    calls.push({url,options});if(url.endsWith('/api/auth/login'))return Response.json({accessToken:token});
    if(expired)return Response.json({error:'请先登录'},{status:401});
    return new Response('sanitized service output',{headers:{'content-type':'text/plain','content-disposition':'attachment; filename="liuzuo-http.log"'}});
  }});
  await client.request('/api/auth/login');assert.equal(calls.length,1);
  const result=await client.download('/api/logs/download?source=http&level=error');assert.equal(result.filename,'liuzuo-http.log');assert.equal(await result.blob.text(),'sanitized service output');assert.equal(calls.at(-1).options.headers.get('authorization'),'Bearer '+token);assert.equal(calls.at(-1).options.credentials,'omit');assert.ok(!calls.at(-1).url.includes(token));
  expired=true;await assert.rejects(client.download('/api/logs/download?source=http'),error=>error.status===401);assert.equal(client.hasSession(),false);
});
