import {readFileSync,writeFileSync,renameSync,existsSync,copyFileSync} from 'node:fs';import{fileURLToPath}from'node:url';import{join}from'node:path';
const root=fileURLToPath(new URL('..',import.meta.url)),target=join(root,'..','index.html'),source=join(root,'dist','index.html'),html=readFileSync(source,'utf8');
if(!html.includes('id="root"')||html.includes('src="/src/'))throw new Error('请先构建完整的单文件控制台');
if(!existsSync(join(root,'legacy-index.html')))copyFileSync(target,join(root,'legacy-index.html'));
const tmp=target+'.cult.tmp';writeFileSync(tmp,html);renameSync(tmp,target);console.log('已更新 web/index.html；现有本机服务刷新后生效。');
