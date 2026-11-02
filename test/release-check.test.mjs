import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';

const checker=fileURLToPath(new URL('../scripts/check-release.mjs',import.meta.url));
function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'dy-release-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const env={...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@users.noreply.github.com',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@users.noreply.github.com'};
  const git=(...args)=>execFileSync('git',args,{cwd:home,env,encoding:'utf8'}).trim();
  const write=(name,data)=>{mkdirSync(dirname(join(home,name)),{recursive:true});writeFileSync(join(home,name),data);};
  const commit=()=>{git('add','.');return git('commit','-qm','fixture')||git('rev-parse','HEAD');};
  const check=(...args)=>spawnSync(process.execPath,[checker,...args],{cwd:home,env,encoding:'utf8'});
  git('init','-q','-b','main');write('package.json',JSON.stringify({version:'0.12.0'}));commit();
  return {home,env,git,write,commit,check};
}
test('发布检查读取已提交树，允许精确公开角色配置，不读取本机未提交配置',t=>{
  const h=fixture(t);for(const name of ['openai','deepseek'])h.write('assets/characters/'+name+'.json',JSON.stringify({name,public:true}));h.write('assets/stickers/frames/gpt-wave.png','public sprite fixture');h.commit();
  h.write('.env','OPENAI_API_KEY=sk-'+('x'.repeat(40)));h.write('package.json','BROKEN LOCAL CONFIG');
  const result=h.check();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/通过发布检查/);
});
test('公开角色文件例外不放宽其他私有配置、密钥或本机路径',t=>{
  for(const [name,data] of [
    ['private/openai.json','{}'],['storage.json','{}'],['dashboard-auth.json','{}'],['runtime/friends.json','{}'],['assets/stickers/frames/private.json','{}'],
    ['key.txt','sk-'+('a'.repeat(40))],['local.txt',['','Users','fixture-owner','secret'].join('/')],
  ]){
    const h=fixture(t);h.write(name,data);h.commit();const result=h.check();assert.equal(result.status,1,name);assert.ok(result.stderr.includes(name));
  }
});
test('候选发布只继承指定提交历史，本机无关分支不进入候选；默认仍检查所有引用的邮箱',t=>{
  const h=fixture(t),candidate=h.git('rev-parse','HEAD'),tree=h.git('rev-parse','HEAD^{tree}');
  const legacy=execFileSync('git',['commit-tree',tree,'-m','private local history'],{cwd:h.home,env:{...h.env,GIT_AUTHOR_EMAIL:'owner@example.invalid',GIT_COMMITTER_EMAIL:'owner@example.invalid'},encoding:'utf8'}).trim();
  h.git('update-ref','refs/heads/local-only',legacy);
  assert.equal(h.check().status,1);assert.equal(h.check('--ref',candidate).status,0);
  const badChild=h.git('commit-tree',tree,'-p',legacy,'-m','child');assert.equal(h.check('--ref',badChild).status,1);
});
