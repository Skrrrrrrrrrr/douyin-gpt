// 每日入口：锁住本程序，生成并发布一条，随后恢复原来的浏览/回复后台。
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
import {ROOT,loadEnv,homePath,readConfig,modelConfig,dayKey} from '../src/config.mjs';
import {takeLock} from '../src/store.mjs';
import {Browser} from '../src/browser.mjs';
import {Gpt} from '../src/openai.mjs';
import {buildEpisode} from '../src/broadcast.mjs';
import {Publisher} from '../src/publisher.mjs';
const exec=promisify(execFile);loadEnv();
const bg=async command=>(await exec(process.execPath,[join(ROOT,'scripts/background.mjs'),command],{cwd:ROOT,timeout:65000})).stdout;
async function main(){
 const home=homePath(),cfg=readConfig(home),day=dayKey(),live=process.argv.includes('--live'),schedule=process.argv.includes('--schedule');
 if(!cfg.video.enabled)throw new Error('每晚视频功能未启用');
 const record=join(home,'video',day,'episode.json');
 if(existsSync(record)){const old=JSON.parse(readFileSync(record,'utf8'));if(['published','scheduled','submitted'].includes(old.status)){console.log(JSON.stringify({status:old.status,day,title:old.title,scheduledAt:old.scheduledAt,note:'本日已有视频，不重复发布'}));return;}if(['publishing','uncertain'].includes(old.status))throw new Error('本日发布结果待核对，不自动重发');}
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()).split(':').map(Number);
 if(live&&!schedule&&parts[0]*60+parts[1]<cfg.video.hour*60+cfg.video.minute)throw new Error('尚未到配置的晚报发布时间，未发布');
 const running=JSON.parse(await bg('status')).running;let release,browser;
 try{
  if(running)console.log((await bg('stop')).trim());
  release=takeLock(home);
  const models={openai:new Gpt(modelConfig()),deepseek:new Gpt(modelConfig('deepseek'))};
  let state=await buildEpisode({home,cfg,models,day});
  if(live){browser=new Browser(home);await browser.start();state=await new Publisher(home,cfg,browser).publish(day,{live:true,at:schedule?`${day} ${String(cfg.video.hour).padStart(2,'0')}:${String(cfg.video.minute).padStart(2,'0')}`:undefined});}
  console.log(JSON.stringify({day,status:state.status,title:state.title,videoPath:state.videoPath,platformUrl:state.platformUrl,scheduledAt:state.scheduledAt},null,2));
 }finally{browser?.disconnect();release?.();if(running)console.log((await bg('start')).trim());}
}
main().catch(error=>{console.error(`晚报未完成：${error.message}`);process.exitCode=1;});
