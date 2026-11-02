import http from 'node:http';
import {readFileSync,existsSync} from 'node:fs';import {join} from 'node:path';
import {homePath,loadEnv,readConfig} from '../src/config.mjs';import {OfficialClient,OfficialInbox,officialDiagnosis} from '../src/official.mjs';
loadEnv();const home=homePath(),cfg=readConfig(home),command=process.argv[2]||'doctor',client=new OfficialClient(home,cfg);
try{
 if(command==='doctor')console.log(JSON.stringify(officialDiagnosis(home,cfg),null,2));
 else if(command==='authorize')console.log(JSON.stringify(client.authorize(),null,2));
 else if(command==='exchange'){const file=process.argv[3];if(!file||!existsSync(file))throw new Error('提供本机回调 URL 文本文件路径，避免授权 code 出现在进程参数中');console.log(JSON.stringify(await client.exchange(readFileSync(file,'utf8').trim())));}
 else if(command==='refresh')console.log(JSON.stringify(await client.refresh()));
 else if(command==='webhook'){const inbox=new OfficialInbox(home),server=http.createServer(async(req,res)=>{try{if(req.method!=='POST'||req.url!=='/douyin/webhook'){res.writeHead(404);res.end();return;}const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>1048576)throw Object.assign(new Error('请求过大'),{status:413});chunks.push(b);}const result=inbox.accept(Buffer.concat(chunks),req.headers);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));}catch(error){res.writeHead(error.status||400);res.end(JSON.stringify({error:'事件未接收'}));}});server.listen(3147,'127.0.0.1',()=>console.log('独立 Webhook 接收器 http://127.0.0.1:3147/douyin/webhook；需单独 HTTPS 反向代理，不要暴露控制台端口。'));}
 else throw new Error('用法：official.mjs doctor|authorize|exchange 文件路径|refresh|webhook');
}catch(error){console.error(error.message);process.exitCode=1;}
