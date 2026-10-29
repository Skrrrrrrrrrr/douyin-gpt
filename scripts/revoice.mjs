// 只制作换声版本；此入口不改动已发布/已定时的日账和远端作品。
import {readFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT,loadEnv,homePath,readConfig,dayKey} from '../src/config.mjs';
import {atomicJson} from '../src/store.mjs';
import {resolveEpisodeVoice,synthesizeEpisodeVoice} from '../src/voices.mjs';
loadEnv();const run=promisify(execFile),home=homePath(),cfg=readConfig(home),day=dayKey();
const source=JSON.parse(readFileSync(join(home,'video',day,'episode.json'),'utf8'));
const profiles={openai:resolveEpisodeVoice(cfg,'openai'),deepseek:resolveEpisodeVoice(cfg,'deepseek')};
const revision=Object.values(profiles).map(p=>p.id||p.voice).join('');
const dir=join(home,'video',day,'revoices',revision);mkdirSync(dir,{recursive:true,mode:0o700});
const audio=[];
for(const turn of source.turns){
 const profile=profiles[turn.speaker],key=createHash('sha256').update(JSON.stringify({text:turn.text,profile})).digest('hex').slice(0,16),file=join(dir,`voice-${key}.wav`),metaFile=file+'.json';
 let meta;if(existsSync(file)&&existsSync(metaFile))meta=JSON.parse(readFileSync(metaFile,'utf8'));
 else{meta=await synthesizeEpisodeVoice({cfg,text:turn.text,file,profile});atomicJson(metaFile,meta);}
 audio.push({...turn,...meta});console.log(`${turn.speaker} ${profile.id}：${meta.duration.toFixed(2)}秒`);
}
const videoPath=join(cfg.video.outputDir,`${day}-AI晚报-音色${revision}.mp4`),coverPath=join(cfg.video.outputDir,`${day}-音色${revision}-封面.png`),input=join(dir,'render.json');
atomicJson(input,{day,cutoff:source.data.cutoff,title:'今天，我们干了啥？',data:source.data,turns:audio,assets:join(ROOT,'assets/hosts'),workDir:dir,videoPath,coverPath});
const result=await run(cfg.video.python,[join(ROOT,'scripts/render-video.py'),input],{timeout:600000,maxBuffer:4e6});console.log(result.stdout);
const state={...source,status:'rendered',audio,videoPath,coverPath,voiceProfiles:cfg.video.voiceProfiles,renderedAt:new Date().toISOString(),renderInfo:JSON.parse(readFileSync(join(dir,'render-result.json'),'utf8')),scheduledAt:'',sourcePublicationStatus:source.status,replaces:{scheduledAt:source.scheduledAt,title:source.title,originalVideoPath:source.videoPath},note:'仅换声预览，尚未替换远端作品'};
delete state.publishAttemptId;delete state.publishAttemptAt;delete state.submittedAt;delete state.platformReadback;delete state.platformUrl;
atomicJson(join(dir,'replacement.json'),state);console.log(JSON.stringify({videoPath,replacement:join(dir,'replacement.json')},null,2));
