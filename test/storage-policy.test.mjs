import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {businessKey,storedJson,storedExists,PostgresStore} from '../src/storage.mjs';
import {atomicJson} from '../src/store.mjs';
test('只有明确业务记录进入数据库，密钥、登录资料、进程信息和媒体留在本机',()=>{
 for(const key of ['state.json','comments.json','memory.json','usage.json','reviews.json','video/2026-11-02/episode.json','reports/2026-11-02.videos.json'])assert.equal(businessKey(key),true,key);
 for(const key of ['config.json','openai.json','deepseek.json','dashboard-auth.json','official-oauth.json','browser/Cookies','process.lock','health.json','message-media/image.json','video/2026-11-02/render.json','../state.json'])assert.equal(businessKey(key),false,key);
});
test('没有数据库绑定时兼容原文件模式，绑定损坏时不能回退到旧副本',t=>{
 const home=mkdtempSync(join(tmpdir(),'dy-storage-policy-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const file=join(home,'state.json');atomicJson(file,{version:1,preserved:true});assert.equal(storedJson(file).preserved,true);assert.equal(storedExists(file),true);
 writeFileSync(join(home,'storage.json'),'broken',{mode:0o600});assert.throws(()=>storedJson(file),e=>e.code==='STORAGE_CONFIG_INVALID');assert.equal(JSON.parse(readFileSync(file,'utf8')).preserved,true);
});
test('数据库连接文件须为私有普通文件，绑定空间与账号标识严格校验',t=>{
 const home=mkdtempSync(join(tmpdir(),'dy-storage-mode-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const file=join(home,'connection.json');writeFileSync(file,'{}',{mode:0o644});assert.throws(()=>new PostgresStore({connectionFile:file,namespace:'valid',accountHash:'a'.repeat(64)}),e=>e.code==='STORAGE_CONFIG_INVALID');assert.throws(()=>new PostgresStore({connectionFile:file,namespace:'invalid space',accountHash:'not-a-hash'}),e=>e.code==='STORAGE_CONFIG_INVALID');
});
test('已迁移目录丢失绑定文件时，新进程也不能启用旧文件或空账本',t=>{
 const home=mkdtempSync(join(tmpdir(),'dy-storage-missing-'));t.after(()=>rmSync(home,{recursive:true,force:true}));writeFileSync(join(home,'storage-migration.json'),JSON.stringify({version:1,backend:'postgres'}),{mode:0o600});writeFileSync(join(home,'state.json'),JSON.stringify({version:1,stale:true}),{mode:0o600});assert.throws(()=>storedJson(join(home,'state.json')),e=>e.code==='STORAGE_CONFIG_INVALID');assert.throws(()=>storedExists(join(home,'state.json')),e=>e.code==='STORAGE_CONFIG_INVALID');
});
