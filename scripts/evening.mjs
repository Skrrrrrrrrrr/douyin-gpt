import {storedExists as existsSync, readStoredFile as readFileSync} from '../src/storage.mjs';
import {programmeConfig} from '../src/programme-config.mjs';
import {Storylines} from '../src/storylines.mjs';
import {PublicEvents,PUBLIC_CAPABILITIES} from '../src/public-events.mjs';
// 每日入口：锁住本程序，生成并发布一条，随后恢复原来的浏览/回复后台。
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';

import {ROOT,loadEnv,homePath,readConfig,modelConfig,dayKey} from '../src/config.mjs';
import {takeLock} from '../src/store.mjs';
import {Browser,sleep,probe} from '../src/browser.mjs';
import {Gpt} from '../src/openai.mjs';
import {buildEpisode} from '../src/broadcast.mjs';
import {queueEpisodeReview} from '../src/episode-review.mjs';
import {serviceDesired,endMaintenance} from '../src/service-control.mjs';
import {Publisher} from '../src/publisher.mjs';
const exec=promisify(execFile);loadEnv();
const bg=async(command,keep=false)=>(await exec(process.execPath,[join(ROOT,'scripts/background.mjs'),command,...(keep?['--keep-browser']:[]),'--maintenance'],{cwd:ROOT,timeout:65000})).stdout;
async function main(){
 const home=homePath(),cfg=programmeConfig(home,readConfig(home)),day=dayKey(),live=process.argv.includes('--live'),schedule=process.argv.includes('--schedule'),readyOnly=process.argv.includes('--ready-only');
 if(!cfg.video.enabled)throw new Error('每晚视频功能未启用');
 const record=join(home,'video',day,'episode.json');
 if(existsSync(record)){const old=JSON.parse(readFileSync(record,'utf8'));if(['published','scheduled','submitted'].includes(old.status)){console.log(JSON.stringify({status:old.status,day,title:old.title,scheduledAt:old.scheduledAt,note:'本日已有视频，不重复发布'}));return;}if(['publishing','uncertain'].includes(old.status))throw new Error('本日发布结果待核对，不自动重发');}
 const pendingPlan=readyOnly&&existsSync(join(home,'video',day,'replacement-plan.json'))?JSON.parse(readFileSync(join(home,'video',day,'replacement-plan.json'),'utf8')):null;
 const targetTime=pendingPlan?.originalScheduledAt?.slice(11);const targetMinutes=targetTime?Number(targetTime.slice(0,2))*60+Number(targetTime.slice(3)):cfg.video.hour*60+cfg.video.minute;
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()).split(':').map(Number);
 if(live&&!schedule&&parts[0]*60+parts[1]<targetMinutes)throw new Error('尚未到配置的晚报发布时间，未发布');
 const running=JSON.parse(await bg('status')).running;let release,browser;
 try{
  if(running){console.log((await bg('stop',true)).trim());await sleep(300);}
  release=takeLock(home);
  let state;
  if(readyOnly){state=JSON.parse(readFileSync(record,'utf8'));if(state.status!=='rendered'||!existsSync(state.videoPath))throw new Error('没有可以直接提交的已完成视频');if(!['openai','deepseek'].every(p=>state.voiceProfiles?.[p]===(pendingPlan?.voices||cfg.video.voiceProfiles)?.[p]))throw new Error('成片音色与当前选择不一致，停止提交');}
  else{if(cfg.video.narrative.enabled&&cfg.video.narrative.followups){const pending=new Storylines(home,cfg).read().threads.filter(t=>t.state==='open'&&t.selector.kind==='capability');for(const key of new Set(pending.map(t=>t.selector.capability))){if(!PUBLIC_CAPABILITIES[key])continue;const entry=new PublicEvents(home).list().find(e=>e.capability===key&&e.enabled);if(entry&&pending.some(t=>t.selector.capability===key&&Date.parse(entry.verification.finishedAt)<=Date.parse(t.activatedAt)))await exec(process.execPath,[join(ROOT,'scripts/public-events.mjs'),key],{cwd:ROOT,timeout:90000,env:{...process.env,DOUYIN_GPT_HOME:home}});}}const models={openai:new Gpt(modelConfig()),deepseek:new Gpt(modelConfig('deepseek'))};state=await buildEpisode({home,cfg,models,day});}
  if(cfg.review.videos==='review'&&state.status==='rendered')queueEpisodeReview(home,state);
  if(live){browser=new Browser(home,cfg.browser);await browser.start();state=await new Publisher(home,cfg,browser).publish(day,{live:true,at:schedule?`${day} ${String(cfg.video.hour).padStart(2,'0')}:${String(cfg.video.minute).padStart(2,'0')}`:undefined});}
  console.log(JSON.stringify({day,status:state.status,title:state.title,videoPath:state.videoPath,platformUrl:state.platformUrl,scheduledAt:state.scheduledAt},null,2));
 }finally{browser?.disconnect();release?.();if(running&&serviceDesired(home).worker)console.log((await bg('start')).trim());else endMaintenance(home);}
}
main().catch(error=>{console.error(`晚报未完成：${error.message}`);process.exitCode=1;});
