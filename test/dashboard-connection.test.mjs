import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackendClient,normalizeBackendUrl} from '../web/connection.js';
const pageUrl='https://example.github.io/douyin-gpt/index.html';
function storage(){const values=new Map();return {values,getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};}
function setup(){const calls=[],session=storage(),preferences=storage(),revoked=[];session.setItem('liuzuo:/douyin-gpt/:session:http://127.0.0.1:3146','a'.repeat(64));let id=0;const client=createBackendClient({pageUrl,hosted:true,backendUrl:'http://127.0.0.1:3146',storage:preferences,sessionStorage:session,createUrl:()=>`blob:fixture-${++id}`,revokeUrl:value=>revoked.push(value),fetchImpl:async(url,options)=>{calls.push({url,options});if(url.includes('/api/media?'))return new Response('private-local-image',{headers:{'content-type':'image/png'}});return Response.json({ok:true});}});return {client,calls,session,preferences,revoked};}
test('连接支持明确域名和IP，不读取或发送历史令牌，地址和接口仍受校验',async()=>{
 const h=setup();for(const value of ['javascript:alert(1)','file:///tmp/file','http://user:pass@localhost','http://localhost/path','http://localhost/?token=x'])assert.throws(()=>normalizeBackendUrl(value));
 for(const value of ['http://localhost:3146','https://assistant.example.com','http://192.168.1.20:3147','http://[fd00::1]:3147'])assert.equal(normalizeBackendUrl(value+'/'),value);
 await h.client.request('/api/state',{headers:{authorization:'Bearer obsolete'}});assert.equal(h.calls[0].url,'http://127.0.0.1:3146/api/state');assert.equal(h.calls[0].options.credentials,'omit');assert.equal(h.calls[0].options.headers.get('authorization'),null);assert.deepEqual([...h.preferences.values],[]);assert.equal(h.client.appUrl(),pageUrl);assert.equal(h.client.assetUrl('/host/gpt.png'),'https://example.github.io/douyin-gpt/host/gpt.png');await assert.rejects(h.client.request('https://evil.example/api/state'),/路径无效/);
});
test('媒体直接fetch至内存Blob，预览变化和切换服务清理缓存',async()=>{
 const h=setup();let changed=0;h.client.subscribe(()=>changed++);assert.equal(h.client.resource('/api/media?kind=preview'),undefined);await new Promise(r=>setImmediate(r));assert.equal(h.client.resource('/api/media?kind=preview'),'blob:fixture-1');assert.equal(h.calls.at(-1).options.headers.get('authorization'),null);assert.ok(changed>0);
 h.client.setRevision('new-preview');assert.deepEqual(h.revoked,['blob:fixture-1']);h.client.resource('/api/media?kind=preview');await new Promise(r=>setImmediate(r));h.client.setBase('http://localhost:4000');assert.deepEqual(h.revoked,['blob:fixture-1','blob:fixture-2']);assert.equal(h.client.getBase(),'http://localhost:4000');assert.ok([...h.preferences.values.values()].every(v=>!v.includes('a'.repeat(64))));
});
test('服务切换期间迟到的旧媒体不会出现在新服务，下载只允许指定接口',async()=>{
 let finish;const client=createBackendClient({pageUrl,hosted:true,storage:storage(),fetchImpl:()=>new Promise(r=>finish=r),createUrl:()=>{throw new Error('stale result');}});client.resource('/api/media?kind=preview');client.setBase('http://localhost:4000');finish(new Response('old image'));await new Promise(r=>setImmediate(r));await assert.rejects(client.download('/api/state'),/不允许/);
});
test('点击后才下载日志，无Cookie或Bearer，服务错误保留给界面处理',async()=>{
 const calls=[];let failed=false;const client=createBackendClient({pageUrl,hosted:true,backendUrl:'http://localhost:3146',storage:storage(),fetchImpl:async(url,options)=>{calls.push({url,options});return failed?Response.json({error:'日志暂时不可用'},{status:503}):new Response('sanitized service output',{headers:{'content-disposition':'attachment; filename="liuzuo-http.log"'}});}});
 assert.equal(calls.length,0);const r=await client.download('/api/logs/download?source=http');assert.equal(r.filename,'liuzuo-http.log');assert.equal(await r.blob.text(),'sanitized service output');assert.equal(calls[0].options.headers.get('authorization'),null);assert.equal(calls[0].options.credentials,'omit');failed=true;await assert.rejects(client.download('/api/logs/download?source=http'),e=>e.status===503);
});
