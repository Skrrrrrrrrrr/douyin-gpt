import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,appendFileSync,readFileSync,renameSync,symlinkSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ServiceLogs,HttpRequestLogs,redactLog,logQuery} from '../src/service-logs.mjs';
import {createDashboard} from '../src/dashboard.mjs';import {defaultConfig} from '../src/config.mjs';import {Store,atomicJson} from '../src/store.mjs';
import {setDashboardOrigins} from '../src/dashboard-origins.mjs';
import {dashboardAccess} from './helpers/dashboard-access.mjs';

function fixture(t){const home=mkdtempSync(join(tmpdir(),'liuzuo-logs-'));t.after(()=>rmSync(home,{recursive:true,force:true}));return home;}
const lines=amount=>Array.from({length:amount},(_,index)=>`[18:00:00] 记录 ${String(index).padStart(4,'0')} 中文`).join('\n')+'\n';

test('增量读取与向前分页不重复、不跳过 UTF-8 记录，未完成的行在换行后读取',t=>{
  const home=fixture(t),file=join(home,'dashboard.log');writeFileSync(file,lines(30));const logs=new ServiceLogs(home),tail=logs.read({limit:5});
  assert.deepEqual(tail.entries.map(row=>row.message.match(/记录 (\d+)/)[1]),['0025','0026','0027','0028','0029']);
  const previous=logs.read({before:tail.startCursor,limit:5});assert.deepEqual(previous.entries.map(row=>row.message.match(/记录 (\d+)/)[1]),['0020','0021','0022','0023','0024']);
  assert.equal(logs.read({after:tail.endCursor}).entries.length,0);
  const pending=Buffer.from('[18:00:01] 新消息完整中文\n');appendFileSync(file,pending.subarray(0,pending.length-2));
  const partial=logs.read({after:tail.endCursor});assert.equal(partial.entries.length,0);
  appendFileSync(file,pending.subarray(pending.length-2));const next=logs.read({after:partial.endCursor});assert.equal(next.entries.length,1);assert.match(next.entries[0].message,/完整中文/);assert.doesNotMatch(next.entries[0].message,/�/);assert.equal(logs.read({after:next.endCursor}).entries.length,0);
});

test('等级、关键词和堆栈行保持含义；结构化请求字段按北京时间显示',t=>{
  const home=fixture(t);writeFileSync(join(home,'assistant.log'),'[18:00:00] 正常工作\nError: request failed\n    at execute (worker.mjs:10:4)\n[18:00:02] warning retry\n'+JSON.stringify({time:'2026-10-30T10:01:02Z',level:'error',message:'中文失败测试'})+'\n');
  const logs=new ServiceLogs(home),errors=logs.read({source:'assistant',level:'error'});assert.equal(errors.entries.length,3);assert.equal(errors.entries[1].level,'error');assert.equal(errors.entries.at(-1).time,'18:01:02');assert.equal(errors.entries.at(-1).levelSource,'structured');
  assert.equal(logs.read({source:'assistant',level:'warn',q:'RETRY'}).entries.length,1);assert.equal(logs.read({source:'assistant',q:'不存在'}).entries.length,0);
});

test('读取和下载一致脱敏：密钥、Bearer、Cookie、密码、查询参数及本机路径',t=>{
  const home=fixture(t),secret='custom-credential-secret-2026',key='sk-proj-'+('a'.repeat(50)),session='f'.repeat(64);atomicJson(join(home,'openai.json'),{apiKey:secret});
  const original=`custom=${secret} key=${key} Bearer ${session}\n{"password":"my-private-password","clientSecret":"private-app-secret","cookie":"sid=abc; token=xyz"}\n初始密码：another-private-password\nhttps://user:pass@example.com/api?api_key=url-secret&value=private-value\n${home}/config.json ${['','Users','private-user','project','file.mjs'].join('/')}\n`;
  writeFileSync(join(home,'dashboard.log'),original);const logs=new ServiceLogs(home),view=JSON.stringify(logs.read()),download=logs.download().text;
  for(const value of [secret,key,session,'my-private-password','private-app-secret','sid=abc','another-private-password','url-secret','private-value',home,'private-user']){assert.ok(!view.includes(value),value);assert.ok(!download.includes(value),value);}
  assert.match(download,/已隐藏/);assert.match(download,/example.com\/api/);assert.ok(!redactLog('\x1b[31mError\x1b[0m').includes('\x1b'));
});

test('查询拒绝任意路径、未知来源、非法筛选、伪造游标及跨来源游标',t=>{
  const home=fixture(t);writeFileSync(join(home,'dashboard.log'),lines(3));const logs=new ServiceLogs(home),snapshot=logs.read();
  for(const query of ['file=../../.env','source=../.env','source=toString','source=constructor','archive=1','source=http&archive=9','level=secret','limit=5000','q='+('a'.repeat(201)),'source=dashboard&source=assistant'])assert.throws(()=>logQuery(new URLSearchParams(query)),/无效/);
  assert.throws(()=>logs.read({after:snapshot.endCursor,source:'assistant'}),/游标无效/);
  const [payload,mac]=snapshot.endCursor.split('.'),data=JSON.parse(Buffer.from(payload,'base64url'));data.offset=1;const forged=Buffer.from(JSON.stringify(data)).toString('base64url')+'.'+mac;assert.throws(()=>logs.read({after:forged}),/游标无效/);
  assert.throws(()=>logs.read({after:snapshot.endCursor+'a'}),/游标无效/);
});

test('日志缺失为空；截短和替换文件返回 reset，并继续读取新文件',t=>{
  const home=fixture(t),logs=new ServiceLogs(home),file=join(home,'dashboard.log');assert.equal(logs.read().source.exists,false);
  writeFileSync(file,lines(40));const initial=logs.read();writeFileSync(file,'[18:10:00] 已重建\n');const truncated=logs.read({after:initial.endCursor});assert.equal(truncated.reset,true);assert.match(truncated.entries[0].message,/已重建/);
  renameSync(file,file+'.old');writeFileSync(file,'[18:11:00] 新文件\n');const rotated=logs.read({after:truncated.endCursor});assert.equal(rotated.reset,true);assert.match(rotated.entries[0].message,/新文件/);
});

test('符号链接不能读取或写入；其他来源不受影响',t=>{
  const home=fixture(t),secret=join(home,'credential.json');writeFileSync(secret,'sensitive-fixture');symlinkSync(secret,join(home,'dashboard.log'));
  const logs=new ServiceLogs(home);assert.throws(()=>logs.read(),/普通文件/);assert.throws(()=>logs.download(),/普通文件/);assert.equal(logs.read({source:'assistant'}).source.exists,false);
  symlinkSync(secret,join(home,'http-requests.log'));let errors=0;const writer=new HttpRequestLogs(home,{onError:()=>errors++});writer.write({message:'should-not-write'});assert.equal(readFileSync(secret,'utf8'),'sensitive-fixture');assert.equal(errors,1);assert.equal(writer.dropped,1);
});

test('读取量受限，增量读取遇到过长行仍可前进，下载有明确范围提示',t=>{
  const home=fixture(t),file=join(home,'dashboard.log');writeFileSync(file,lines(2000));const logs=new ServiceLogs(home,{maxReadBytes:1024,maxDownloadBytes:1024}),snapshot=logs.read();assert.ok(snapshot.scannedBytes<=1024);assert.ok(snapshot.entries.length<100);assert.match(logs.download().text,/仅导出最近/);
  writeFileSync(file,'begin\n');const initial=logs.read();appendFileSync(file,'a'.repeat(6000));let cursor=initial.endCursor;for(let i=0;i<7;i++)cursor=logs.read({after:cursor}).endCursor;
  appendFileSync(file,'\n[18:12:00] after giant line\n');const next=logs.read({after:cursor});assert.ok(next.entries.some(row=>row.message.includes('after giant line')));
});

test('请求日志自动轮换并可查看归档，磁盘写入失败不影响服务',t=>{
  const home=fixture(t),writer=new HttpRequestLogs(home,{maxBytes:512,keep:3});for(let i=0;i<15;i++)writer.write({time:'2026-10-30T10:00:00Z',level:'info',event:'http.request',requestId:'request-'+i,method:'GET',path:'/api/state',status:200,durationMs:1});
  for(const suffix of ['', '.1','.2','.3']){assert.ok(existsSync(writer.file+suffix));assert.ok(statSync(writer.file+suffix).size<=512);assert.equal(statSync(writer.file+suffix).mode&0o777,0o600);}
  assert.equal(existsSync(writer.file+'.4'),false);assert.ok(new ServiceLogs(home).read({source:'http',archive:1}).entries.length>0);
});

test('免登录 API 接入日志、增量、筛选与下载；HTTP 记录不包含输入、查询或凭证',async t=>{
  const home=fixture(t);new Store(home);const cfg=defaultConfig();cfg.monitor.notify=false;atomicJson(join(home,'config.json'),cfg);writeFileSync(join(home,'dashboard.log'),'[18:00:00] started\nError: fixture failure\n');
  const app=createDashboard(home,{port:0}),address=await app.listen();t.after(()=>new Promise(resolve=>app.server.close(resolve)));const base=`http://127.0.0.1:${address.port}`;
  for(const path of ['/api/logs','/api/logs/download'])assert.equal((await fetch(base+path)).status,200);
  const cookie=await dashboardAccess(base,home),headers={cookie};const response=await fetch(base+'/api/logs',{headers});assert.equal(response.status,200);const snapshot=await response.json();assert.equal(snapshot.entries.length,2);
  const httpBefore=readFileSync(join(home,'http-requests.log'),'utf8');await fetch(base+'/api/logs?after='+encodeURIComponent(snapshot.endCursor),{headers});assert.equal(readFileSync(join(home,'http-requests.log'),'utf8'),httpBefore,'成功读取日志不写入自己的轮询记录');
  assert.equal((await fetch(base+'/api/state?token=PRIVATE_QUERY_CONTENT',{headers:{cookie}})).status,200);await fetch(base+'/api/state',{headers:{authorization:'Bearer PRIVATE_HEADER_CONTENT'}});await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'PRIVATE_BODY_CONTENT'})});
  const recorded=readFileSync(join(home,'http-requests.log'),'utf8');for(const secret of ['PRIVATE_QUERY_CONTENT','PRIVATE_HEADER_CONTENT','PRIVATE_BODY_CONTENT'])assert.ok(!recorded.includes(secret),secret);
  const httpRows=recorded.trim().split('\n').map(line=>JSON.parse(line));assert.ok(httpRows.some(row=>row.path==='/api/state'&&row.status===200));assert.ok(httpRows.some(row=>row.status===410&&row.level==='warn'));
  const filtered=await(await fetch(base+'/api/logs?level=error&q=fixture',{headers})).json();assert.equal(filtered.entries.length,1);
  const output=await fetch(base+'/api/logs/download?level=error',{headers});assert.equal(output.status,200);assert.match(output.headers.get('content-disposition'),/attachment/);assert.match(await output.text(),/fixture failure/);
  assert.equal((await fetch(base+'/api/logs?file=../../.env',{headers})).status,400);
  const origin='https://logs-fixture.github.io';setDashboardOrigins(home,[origin]);const remote={origin,'sec-fetch-site':'cross-site'};assert.equal((await fetch(base+'/api/logs',{headers:remote})).status,200);assert.equal((await fetch(base+'/api/logs/download',{headers:remote})).status,200);
});
