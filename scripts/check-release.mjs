import {execFileSync} from 'node:child_process';

// Inspect the committed tree, rather than private files in a running checkout.
// --ref validates only the candidate and its ancestry before it is published.
const args=process.argv.slice(2);
if(args.length&&!(args.length===2&&args[0]==='--ref'))throw new Error('用法：check-release.mjs [--ref <commit>]');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:64*1024*1024});
const commit=git('rev-parse','--verify',(args[1]||'HEAD')+'^{commit}').trim();
const pkg=JSON.parse(git('show',commit+':package.json'));
if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(pkg.version))throw new Error('package.json 需要有效版本号，例如 0.12.0');

const files=git('ls-tree','-r','--name-only','-z',commit).split('\0').filter(Boolean);
const blocked=new Set(['.data','.git','node_modules','__pycache__','browser','runtime','reports','frames','openai.json','deepseek.json','state.json','comments.json','Cookies','Login Data','storage.json','storage-plan.json','storage-connection.json','storage-migration.json','database-password.txt','dashboard-auth.json','dashboard-initial-password.txt','official.json','official-oauth.json']);
const publicCharacters=new Set(['assets/characters/openai.json','assets/characters/deepseek.json']);
const problems=[];
for(const file of files){
  const parts=file.split('/'),name=parts.at(-1);
  const envFile=name==='.env'||name.startsWith('.env.')&&!name.endsWith('.example')&&!name.endsWith('.sample');
  const publicAsset=publicCharacters.has(file)||/^assets\/stickers\/frames\/(?:PROMPTS\.md|(?:gpt|deepseek)-(?:nod|laugh|wave)\.png)$/.test(file);
  if(envFile||file==='config.json'||!publicAsset&&parts.some(part=>blocked.has(part))||/\.(?:log|zip|tgz|pem|key|p12|pfx)$/.test(name)){
    problems.push(`${file}: 私有数据或运行产物`);continue;
  }
  const data=git('show',commit+':'+file);
  if(/(?:^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{24,}/.test(data)||/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/.test(data)||/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(data))problems.push(`${file}: 疑似 API 密钥`);
  if(/\/Users\/[^/\s]+/.test(data))problems.push(`${file}: 本机用户绝对路径`);
}
const identities=git('log',...(args.length?[commit]:['--all']),'--no-use-mailmap','--format=%H%x00%ae%x00%ce').trim().split('\n').filter(Boolean);
for(const row of identities){
  const [hash,...emails]=row.split('\0');
  if(emails.some(email=>!email.endsWith('@users.noreply.github.com')&&email!=='noreply@github.com'))problems.push(`${hash.slice(0,12)}: 提交身份包含个人邮箱，请使用 GitHub noreply 邮箱`);
}
if(problems.length){console.error(problems.join('\n'));process.exitCode=1;}
else console.log(`✓ v${pkg.version}，${files.length} 个已提交文件及 ${identities.length} 个提交身份通过发布检查`);
