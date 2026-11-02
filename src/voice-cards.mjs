import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT} from './config.mjs';
import {atomicJson} from './store.mjs';
import {resolveEpisodeVoice,synthesizeEpisodeVoice} from './voices.mjs';
import {safeVoiceText} from './conversation-policy.mjs';
const run=promisify(execFile);
export class VoiceCards{
 constructor(home,cfg,{synthesize=synthesizeEpisodeVoice,runImpl=run}={}){Object.assign(this,{home,cfg,synthesize,run:runImpl});this.base=join(home,'voice-cards');mkdirSync(this.base,{recursive:true,mode:0o700});}
 asset(id){if(!/^[a-f0-9]{64}$/.test(id))throw new Error('语音卡编号无效');const dir=join(this.base,id),meta=JSON.parse(readFileSync(join(dir,'card.json'),'utf8')),file=join(dir,'card.mp4');if(meta.status!=='rendered'||!existsSync(file))throw new Error('语音卡尚未完成');const data=readFileSync(file),sha256=createHash('sha256').update(data).digest('hex');if(sha256!==meta.sha256)throw new Error('语音卡文件已变化');return {id,label:'角色语音卡',file,filename:'card.mp4',format:'mp4',mediaKind:'video',bytes:data.length,sha256,available:true,duration:meta.duration,provider:meta.provider};}
 async build(provider,text,{signal}={}){
  if(!['openai','deepseek'].includes(provider)||!safeVoiceText(text)||[...text].length>this.cfg.reply.voiceCards.maxChars)throw new Error('语音卡只支持普通短回复，不朗读敏感格式');
  const profile=resolveEpisodeVoice(this.cfg,provider),id=createHash('sha256').update(JSON.stringify({version:1,provider,text,profile})).digest('hex'),dir=join(this.base,id),metaFile=join(dir,'card.json');mkdirSync(dir,{recursive:true,mode:0o700});
  if(existsSync(metaFile)){const old=JSON.parse(readFileSync(metaFile));if(old.status==='rendered')return this.asset(id);if(old.retryAt>Date.now())throw new Error('语音卡制作稍后重试');}
  try{const audioFile=join(dir,'voice.wav'),audioMeta=audioFile+'.json';let audio;if(existsSync(audioMeta)&&existsSync(audioFile))audio=JSON.parse(readFileSync(audioMeta));else{audio=await this.synthesize({cfg:this.cfg,text,file:audioFile,profile,signal});atomicJson(audioMeta,audio);}if(audio.duration>this.cfg.reply.voiceCards.maxSeconds)throw new Error('配音超过语音卡时长上限');
   const output=join(dir,'card.mp4'),input=join(dir,'render.json');atomicJson(input,{provider,text,audio,assets:join(ROOT,'assets','hosts'),output,maxSeconds:this.cfg.reply.voiceCards.maxSeconds,workDir:dir});
   await this.run(this.cfg.video.python,[join(ROOT,'scripts','render-voice-card.py'),input],{timeout:180000,maxBuffer:1000000,signal});const data=readFileSync(output),result=JSON.parse(readFileSync(join(dir,'render-result.json')));atomicJson(metaFile,{version:1,id,status:'rendered',provider,text,duration:result.duration,sha256:createHash('sha256').update(data).digest('hex'),createdAt:new Date().toISOString()});return this.asset(id);
  }catch(error){atomicJson(metaFile,{version:1,id,status:'failed',retryAt:Date.now()+300000});throw error;}
 }
}
