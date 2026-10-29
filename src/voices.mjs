import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {ROOT,modelConfig} from './config.mjs';
import {Speech,speechSimilarity} from './speech.mjs';
const run=promisify(execFile);
export const VOICE_PRESETS={
 A:{id:'A',engine:'edge',label:'晓晓 · 参考白发',voice:'zh-CN-XiaoxiaoNeural',pitch:'+24Hz',rate:'+12%'},
 B:{id:'B',engine:'edge',label:'晓伊 · 参考蓝发',voice:'zh-CN-XiaoyiNeural',pitch:'-3Hz',rate:'+8%'},
 C:{id:'C',engine:'edge',label:'晓晓 · 自然原声',voice:'zh-CN-XiaoxiaoNeural',pitch:'+0Hz',rate:'+0%'},
 D:{id:'D',engine:'edge',label:'晓伊 · 自然原声',voice:'zh-CN-XiaoyiNeural',pitch:'+0Hz',rate:'+0%'},
};
export function resolveEpisodeVoice(cfg,speaker){
 const id=cfg.video.voiceProfiles?.[speaker];
 if(id){const preset=VOICE_PRESETS[id.toUpperCase()];if(!preset)throw new Error('未知音色候选');return {...preset};}
 return {engine:'openai',voice:cfg.video.voices[speaker],model:cfg.video.speechModel,tone:speaker==='openai'?'明亮、开朗、有亲和力的成年女性普通话声音':'温柔、清晰、略带俏皮的成年女性普通话声音'};
}
export async function synthesizeEpisodeVoice({cfg,text,file,profile,signal}){
 if(signal?.aborted)throw new Error('配音已取消');
 if(profile.engine==='openai')return new Speech(modelConfig()).create(text,file,{...profile,signal});
 if(profile.engine!=='edge')throw new Error('未知配音服务');
 if(!/^zh-CN-[A-Za-z]+Neural$/.test(profile.voice)||!/^[-+]\d+Hz$/.test(profile.pitch)||!/^[-+]\d+%$/.test(profile.rate))throw new Error('中文音色参数无效');
 mkdirSync(dirname(file),{recursive:true,mode:0o700});const input=file+'.input.json';writeFileSync(input,JSON.stringify({text,file,voice:profile.voice,pitch:profile.pitch,rate:profile.rate}),{mode:0o600});
 const result=await run(cfg.video.python,[join(ROOT,'scripts','edge-speech.py'),input],{timeout:75000,maxBuffer:1e6,signal});
 const meta=JSON.parse(result.stdout),similarity=speechSimilarity(text,meta.transcript);
 if(similarity<.82||!Number.isFinite(meta.duration)||meta.duration<=0)throw new Error('中文配音与原稿不一致或音频无效');
 return {...meta,similarity};
}
