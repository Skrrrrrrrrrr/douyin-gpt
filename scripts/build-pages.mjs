import {existsSync,readFileSync,writeFileSync,mkdirSync,readdirSync,copyFileSync,mkdtempSync,rmSync,statSync} from 'node:fs';
import {resolve,join,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sha=data=>createHash('sha256').update(data).digest('hex');
const relativeAssets=html=>html.replace(/(["'`])\/(brand|fonts|host)\//g,'$1./$2/').replace(/url\(\/(fonts|brand)\//g,'url(./$1/');
function policy(html){
  const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].filter(m=>m[1].trim()).map(m=>`'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  const local="'self' http: https:";
  const value=`default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self' ${[...new Set(scripts)].join(' ')}; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' blob: data:; media-src 'self' blob:; connect-src ${local}; form-action ${local}`;
  return `<meta http-equiv="Content-Security-Policy" content="${value}"><meta name="referrer" content="no-referrer">`;
}
function hosted(html){html=relativeAssets(html).replace('<html ','<html data-hosted-dashboard="true" ');const meta=policy(html),charset=/<meta\s+charset=[^>]+>/i;return charset.test(html)?html.replace(charset,match=>match+meta):html.replace('<head>','<head><meta charset="utf-8">'+meta);}
export function assemblePages(root,bundle,out){
  if(existsSync(out)&&readdirSync(out).length)throw new Error('输出目录不是空目录，请使用新的 --out 目录');
  mkdirSync(out,{recursive:true});
  const write=(name,data)=>{const target=join(out,name);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,data);};
  if(!bundle.includes('id="root"')||bundle.includes('src="/src/'))throw new Error('工作台还没有完成静态构建');
  write('index.html',hosted(bundle));
  write('login.html',hosted('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>进入工作台</title><meta http-equiv="refresh" content="0;url=./index.html"></head><body><a href="./index.html">进入工作台</a></body></html>'));
  copyFileSync(join(root,'web/connection.js'),join(out,'connection.js'));
  const copyAssets=(folder,prefix,extensions)=>{
    for(const entry of readdirSync(folder,{withFileTypes:true})){
      const source=join(folder,entry.name),name=prefix+'/'+entry.name;
      if(entry.isDirectory())copyAssets(source,name,extensions);
      else if(entry.isFile()&&extensions.includes(extname(entry.name).toLowerCase())){mkdirSync(dirname(join(out,name)),{recursive:true});if(extname(entry.name).toLowerCase()==='.txt')write(name,readFileSync(source,'utf8').replace(/[\t ]+$/gm,''));else copyFileSync(source,join(out,name));}
    }
  };
  copyAssets(join(root,'web/brand'),'brand',['.png','.svg','.jpg','.jpeg','.webp']);
  copyAssets(join(root,'web/fonts'),'fonts',['.ttf','.woff','.woff2','.txt']);
  for(const name of ['gpt.png','deepseek.png']){mkdirSync(join(out,'host'),{recursive:true});copyFileSync(join(root,'assets/hosts',name),join(out,'host',name));}
  write('.nojekyll','');
  write('HOSTING.md','这是独立静态管理界面，不会部署 GitHub Pages 或启动 Node 服务。后端地址由工作台的连接设置配置，支持 HTTP/HTTPS 域名与 IP，跨域来源须在服务端明确允许；管理页面无需账号密码。建议直接使用本机或 Docker 提供的同域管理页面。此目录不包含账号凭证、模型密钥、运行状态或聊天记录。\n');
  const files=[];const walk=(folder,prefix='')=>{for(const entry of readdirSync(folder,{withFileTypes:true})){const name=prefix+entry.name,target=join(folder,entry.name);if(entry.isDirectory())walk(target,name+'/');else files.push({path:name,bytes:statSync(target).size,sha256:sha(readFileSync(target))});}};walk(out);
  const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  write('build-info.json',JSON.stringify({kind:'douyin-dashboard-static',version:pkg.version,files},null,2)+'\n');
  return {directory:out,files:files.length+1,version:pkg.version};
}
function main(){
  const args=process.argv.slice(2),i=args.indexOf('--out'),out=resolve(i>=0?args[i+1]:join(ROOT,'.pages-dist'));
  if(existsSync(out)&&readdirSync(out).length)throw new Error('输出目录不是空目录，请使用新的 --out 目录');
  const frontend=join(ROOT,'web/cult');if(!existsSync(join(frontend,'node_modules')))throw new Error('请先运行 npm --prefix web/cult ci 安装界面构建依赖');
  mkdirSync(dirname(out),{recursive:true});const build=mkdtempSync(join(dirname(out),'.pages-build-'));
  try{
    for(const cmd of [['npm',['run','check']],['npm',['exec','vite','build','--','--outDir',build,'--emptyOutDir']]]){const result=spawnSync(cmd[0],cmd[1],{cwd:frontend,stdio:'inherit'});if(result.status!==0)throw new Error('管理界面构建未通过');}
    console.log(JSON.stringify(assemblePages(ROOT,readFileSync(join(build,'index.html'),'utf8'),out),null,2));
  }finally{rmSync(build,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
