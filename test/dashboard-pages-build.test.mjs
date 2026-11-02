import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ROOT} from '../src/config.mjs';
import {assemblePages} from '../scripts/build-pages.mjs';

test('历史静态构建只收集界面，允许配置HTTP/HTTPS服务并保留子目录资源地址',t=>{
  const out=mkdtempSync(join(tmpdir(),'dy-pages-build-'));t.after(()=>rmSync(out,{recursive:true,force:true}));
  const bundle='<!doctype html><html lang="zh-CN"><head><link href="/brand/logo.png"><script>window.fixture=true;</script></head><body><div id="root"></div></body></html>';
  const result=assemblePages(ROOT,bundle,out),login=readFileSync(join(out,'login.html'),'utf8'),index=readFileSync(join(out,'index.html'),'utf8');
  assert.ok(result.files>5);assert.match(index,/data-hosted-dashboard="true"/);assert.match(index,/href="\.\/brand\/logo.png"/);assert.match(index,/script-src 'self' 'sha256-/);
  assert.match(login,/action="\/api\/auth\/login"/);assert.match(login,/form-action 'self' http: https:/);assert.doesNotMatch(login,/127\.0\.0\.1:3146/);assert.match(login,/src="\.\/pages-login.js"/);assert.match(login,/href="\.\/login.css"/);assert.match(login,/id="backend-url"/);
  const names=[];const walk=(folder,prefix='')=>{for(const e of readdirSync(folder,{withFileTypes:true})){const name=prefix+e.name;if(e.isDirectory())walk(join(folder,e.name),name+'/');else names.push(name);}};walk(out);
  assert.ok(!/url\(["']?\/fonts\//.test(readFileSync(join(out,'login.css'),'utf8')));
  for(const name of names)assert.ok(!/(?:^|\/)(?:\.env|config\.json|state\.json|comments\.json|dashboard-auth\.json|dashboard-initial-password\.txt|node_modules|reports|browser)(?:\/|$)/.test(name),name);
  assert.throws(()=>assemblePages(ROOT,bundle,out),/不是空目录/);
});
