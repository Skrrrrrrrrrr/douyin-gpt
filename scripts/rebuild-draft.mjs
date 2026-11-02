import {readStoredFile as readFileSync, storedReadDir as readdirSync, storedExists as existsSync} from '../src/storage.mjs';
import {join} from 'node:path';import {mkdirSync, copyFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {loadEnv,homePath,readConfig,ROOT} from '../src/config.mjs';import {Reviews} from '../src/reviews.mjs';import {VoiceCards} from '../src/voice-cards.mjs';import {renderEpisode} from '../src/broadcast.mjs';import {mediaHash,episodeText} from '../src/episode-review.mjs';import {atomicJson,takeLock} from '../src/store.mjs';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {serviceDesired,endMaintenance} from '../src/service-control.mjs';
const exec=promisify(execFile);loadEnv();const home=homePath(),cfg=readConfig(home),id=process.argv[2],queue=new Reviews(home),entry=queue.list().find(r=>r.id===id);let release,running=false;
const bg=async a=>exec(process.execPath,[join(ROOT,'scripts/background.mjs'),a,'--maintenance','--keep-browser'],{env:{...process.env,DOUYIN_GPT_HOME:home},timeout:65000});
try{
 if(!entry||entry.status!=='pending'||!entry.payload.requiresRender)throw new Error('没有需要重新制作的待审媒体');running=JSON.parse((await bg('status')).stdout).running;if(running)await bg('stop');release=takeLock(home);
 if(entry.kind==='private'){const cards=new VoiceCards(home,cfg),card=await cards.build(entry.payload.provider,entry.payload.text);queue.updateMedia(id,entry.revision,p=>{for(const step of p.plan.steps)if(step.kind==='voice_card')step.card={id:card.id,sha256:card.sha256};});}
 else if(entry.kind==='episode'){
  const day=entry.payload.day,file=join(home,'video',day,'episode.json'),old=JSON.parse(readFileSync(file));if(!['rendered','scripted','audio_ready'].includes(old.status))throw new Error('本日视频已上传或发布，不能替换已提交版本');
  const temp=join(home,'review-render',id),dir=join(temp,'video',day);mkdirSync(dir,{recursive:true,mode:0o700});for(const name of readdirSync(join(home,'video',day)))if(/^voice-[a-f0-9]+\.wav(?:\.json)?$/.test(name))copyFileSync(join(home,'video',day,name),join(dir,name));
  const fingerprint=createHash('sha256').update(JSON.stringify({source:old.fingerprint,turns:entry.payload.turns,voices:cfg.video.voiceProfiles})).digest('hex'),state=await renderEpisode({home:temp,cfg,state:{...old,turns:entry.payload.turns,narrativeEdited:!!old.show?.narrative,show:old.show?{...old.show,turns:entry.payload.turns}:null,fingerprint,status:'scripted'}});
  queue.updateMedia(id,entry.revision,p=>{p.fingerprint=state.fingerprint;p.sha256=mediaHash(state.videoPath);p.text=episodeText(state.turns);});atomicJson(file,state);
 }else throw new Error('该草稿没有可重做的媒体');console.log('媒体已重新制作，请预览当前版本后批准。');
}catch(error){console.error(error.message);process.exitCode=1;}finally{release?.();if(running&&serviceDesired(home).worker)try{await bg('start');}catch{console.error('后台尚未恢复，请查看控制台。');}else endMaintenance(home);}
