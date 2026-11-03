import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {dashboardNetwork,dashboardPublicUrl,dashboardRequestOrigin} from '../src/dashboard-network.mjs';
import {defaultConfig,validateConfig} from '../src/config.mjs';
import {createDashboard} from '../src/dashboard.mjs';
import {Store,atomicJson} from '../src/store.mjs';
import {createBackendClient} from '../web/connection.js';

function storage(){const map=new Map();return {getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};}
async function start(t,options={}){const home=mkdtempSync(join(tmpdir(),'dy-network-'));t.after(()=>rmSync(home,{recursive:true,force:true}));new Store(home);const cfg=defaultConfig();cfg.monitor.notify=false;atomicJson(join(home,'config.json'),cfg);const app=createDashboard(home,{port:0,...options}),address=await app.listen();t.after(()=>new Promise(resolve=>app.server.close(resolve)));return {home,app,port:address.port};}
function request(h,path,{host='assistant.example.test',origin='https://assistant.example.test',cookie,body,extra={}}={}){return new Promise((resolve,reject)=>{const req=httpRequest({hostname:'127.0.0.1',port:h.port,path,method:body?'POST':'GET',headers:{host,...(origin?{origin}:{}),...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{}),...extra}},res=>{let raw='';res.on('data',b=>raw+=b);res.on('end',()=>{let data;try{data=JSON.parse(raw);}catch{data=raw;}resolve({status:res.statusCode,headers:res.headers,data});});});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();});}

test('管理服务地址可配置域名、IP和IPv6，拒绝URL凭证、路径和非法协议',()=>{
 for(const value of ['https://assistant.example.test','http://192.168.1.20:3147','http://[fd00::1]:3147'])assert.equal(dashboardPublicUrl(value+'/'),value);
 for(const host of ['127.0.0.1','0.0.0.0','::','localhost','assistant.example.test'])assert.equal(dashboardNetwork({host}).host,host);
 for(const value of ['ftp://example.com','https://user:pass@example.com','https://example.com/path','https://example.com/?token=x','https://*.example.com'])assert.throws(()=>dashboardPublicUrl(value));
 for(const host of ['*','http://localhost','localhost:3146','user@host',''])assert.throws(()=>dashboardNetwork({host}));
 const cfg=defaultConfig();cfg.dashboard.host='0.0.0.0';cfg.dashboard.publicUrl='https://assistant.example.test';assert.equal(validateConfig(cfg).dashboard.publicUrl,cfg.dashboard.publicUrl);
});
test('请求Host支持明确公开域名和IP映射，不能只凭转发头或任意DNS地址放行',()=>{
 const net=dashboardNetwork({host:'0.0.0.0',publicUrl:'https://assistant.example.test'}),req=host=>({url:'/api/state',headers:{host,'x-forwarded-host':'assistant.example.test','x-forwarded-proto':'https'}});
 assert.equal(dashboardRequestOrigin(req('assistant.example.test'),3147,net),'https://assistant.example.test');assert.equal(dashboardRequestOrigin(req('192.168.1.20:3147'),3147,net),'http://192.168.1.20:3147');assert.equal(dashboardRequestOrigin(req('[fd00::1]:3147'),3147,net),'http://[fd00::1]:3147');
 assert.equal(dashboardRequestOrigin(req('unconfigured.example.test'),3147,net),null);assert.equal(dashboardRequestOrigin(req('127.0.0.1:9999'),3147,net),null);assert.equal(dashboardRequestOrigin({...req('assistant.example.test'),url:'//foreign.example/api/state'},3147,net),null);
});
test('域名和局域网直接打开工作台，Host和跨站来源限制继续生效',async t=>{
 const h=await start(t,{host:'0.0.0.0',publicUrl:'https://assistant.example.test'});assert.equal((await request(h,'/')).status,200);assert.equal((await request(h,'/api/state')).status,200);assert.equal((await request(h,'/api/state',{origin:'https://foreign.example.test'})).status,403);assert.equal((await request(h,'/api/state',{host:'unconfigured.example.test'})).status,403);
 const host='192.168.1.20:'+h.port,origin='http://'+host;assert.equal((await request(h,'/api/state',{host,origin})).status,200);const old=await request(h,'/login',{host,origin});assert.equal(old.status,303);assert.equal(old.headers.location,'/');
});
test('同域客户端使用当前部署地址，不回到旧的3146端口',async()=>{
 for(const pageUrl of ['http://192.168.1.20:3147/','https://assistant.example.test/','http://[fd00::1]:3147/']){const calls=[],client=createBackendClient({pageUrl,storage:storage(),sessionStorage:storage(),fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json({});}});await client.request('/api/state');assert.equal(calls[0].url,new URL('/api/state',pageUrl).href);assert.equal(calls[0].options.credentials,'omit');assert.equal(client.appUrl(),new URL('/',pageUrl).href);}
});
test('浏览器全局初始化不会把局域网或域名的Node页面误判为独立静态页',async t=>{
 const old={window:globalThis.window,document:globalThis.document,location:globalThis.location};t.after(()=>{for(const [key,value]of Object.entries(old))value===undefined?delete globalThis[key]:globalThis[key]=value;});
 globalThis.window={localStorage:storage(),sessionStorage:storage(),addEventListener:()=>{}};globalThis.document={documentElement:{dataset:{}},querySelector:()=>null};globalThis.location=new URL('https://assistant.example.test/');
 const module=await import('../web/connection.js?domain-fixture');assert.equal(module.isHosted,false);assert.equal(module.backendApiUrl('/api/state'),'https://assistant.example.test/api/state');assert.equal(module.appUrl(),'https://assistant.example.test/');
});
test('独立界面只持久化服务地址，不发送遗留会话或密码',async()=>{
 const calls=[],preferences=storage(),session=storage();session.setItem('liuzuo:/:session:https://api.example.test','b'.repeat(64));
 const client=createBackendClient({pageUrl:'https://dashboard.example.test/',hosted:true,backendUrl:'https://api.example.test',storage:preferences,sessionStorage:session,fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json({});}});
 await client.request('/api/state',{headers:{authorization:'Bearer stale'}});assert.equal(calls.at(-1).options.headers.get('authorization'),null);client.setBase('http://192.168.1.20:3147');await client.request('/api/state');assert.equal(calls.at(-1).url,'http://192.168.1.20:3147/api/state');assert.equal(calls.at(-1).options.credentials,'omit');
});
