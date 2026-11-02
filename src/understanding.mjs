import {storageFault} from './storage.mjs';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {atomicJson} from './store.mjs';
import {modelConfig} from './config.mjs';
import {UsageMeter,requestDefinitelyRejected} from './usage.mjs';
import {efficiencySettings} from './token-policy.mjs';
export function startCaptureInPage({id,seconds}){
 const v=document.querySelector(`.video_${id} video,[data-e2e-vid="${id}"] video`);if(!v)return {error:'没有定位到当前视频'};
 const captions=[];for(const track of v.textTracks||[])for(const cue of track.cues||[])if(cue.text)captions.push({start:cue.startTime,end:cue.endTime,text:cue.text});
 const state={id,captions:captions.slice(0,200),start:v.currentTime,chunks:[],error:''};window.__douyinAudioCapture=state;
 try{
  const stream=v.captureStream?v.captureStream():v.mozCaptureStream?.();const tracks=stream?.getAudioTracks()||[];if(!tracks.length)throw new Error('网页未提供可采集的音轨');
  const mime=['audio/webm;codecs=opus','audio/webm'].find(t=>MediaRecorder.isTypeSupported(t));if(!mime)throw new Error('浏览器不支持音轨录制');
  const recorder=new MediaRecorder(new MediaStream(tracks),{mimeType:mime,audioBitsPerSecond:64000});state.recorder=recorder;state.mime=mime;
  state.done=new Promise(resolve=>{recorder.ondataavailable=e=>{if(e.data.size)state.chunks.push(e.data);};recorder.onstop=()=>resolve();recorder.onerror=()=>{state.error='音轨录制失败';resolve();};});
  recorder.start(250);state.timer=setTimeout(()=>{if(recorder.state==='recording')recorder.stop();},Math.min(60,seconds)*1000);
 }catch(error){if(storageFault(error))throw error;state.error=String(error.message).slice(0,120);}
 return {captions:state.captions,error:state.error,start:state.start};
}
export async function finishCaptureInPage({id}){
 const s=window.__douyinAudioCapture;if(!s||s.id!==id)return {error:'没有本条视频的音轨记录',captions:[]};
 clearTimeout(s.timer);if(s.recorder?.state==='recording')s.recorder.stop();if(s.done)await Promise.race([s.done,new Promise(r=>setTimeout(r,2000))]);
 const result={captions:s.captions,start:s.start,mime:s.mime,error:s.error,seconds:Math.max(0,(document.querySelector(`.video_${id} video,[data-e2e-vid="${id}"] video`)?.currentTime||s.start)-s.start)};
 if(!s.error&&s.chunks.length){const blob=new Blob(s.chunks,{type:s.mime});if(blob.size>2000000)result.error='音轨超过本地限制';else result.base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=reject;r.readAsDataURL(blob);});}
 delete window.__douyinAudioCapture;return result;
}
export class VideoUnderstanding{
 constructor(home,cfg,{fetchImpl=fetch}={}){this.home=home;this.cfg=cfg;this.fetch=fetchImpl;this.meter=new UsageMeter(home);mkdirSync(join(home,'understanding'),{recursive:true,mode:0o700});}
 async transcribe(file,{signal,seconds=0,mime='audio/webm',full=false}={}){
  const config=modelConfig(),base=new URL(config.baseUrl);if(base.username||base.password||base.search||base.hash||base.protocol!=='https:')throw new Error('转写接口需要 HTTPS');
  base.pathname=base.pathname.replace(/\/$/,'')+'/audio/transcriptions';const data=readFileSync(file);if(data.length>24000000)throw new Error('转写音轨过大');
  const form=new FormData();form.append('model',this.cfg.understanding.model);let kind=mime.split(';')[0];if(data.toString('ascii',0,4)==='RIFF')kind='audio/wav';else if(data.toString('ascii',0,4)==='OggS')kind='audio/ogg';else if(data.toString('ascii',0,3)==='ID3'||data[0]===255&&(data[1]&224)===224)kind='audio/mpeg';else if(data.toString('ascii',4,8)==='ftyp')kind='audio/mp4';if(kind==='application/octet-stream')throw new Error('音轨容器暂无法识别');const extension=({'audio/mpeg':'mp3','audio/mp4':'m4a','audio/ogg':'ogg','audio/wav':'wav','audio/x-wav':'wav'})[kind]||'webm';form.append('file',new Blob([data],{type:kind}),`clip.${extension}`);form.append('prompt','短视频原声音频；只转写听到的发言，不为纯音乐、静音或听不清的部分编造文字。');
  return this.meter.measure('openai','transcription',this.cfg.understanding.model,async()=>{const response=await this.fetch(base,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${config.apiKey}`},body:form,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)});
  if(!response.ok)throw Object.assign(new Error(`音频转写 HTTP ${response.status}`),{httpRejected:requestDefinitelyRejected(response.status)});const result=await response.json();if(typeof result.text!=='string')throw new Error('音频转写返回格式无效');return {text:full?result.text:result.text.slice(0,12000),languages:result.languages||[],model:this.cfg.understanding.model,usage:result.usage,seconds:result.duration||result.usage?.seconds||seconds};},{seconds});
 }
 async process(video,frames,model,signal){
  if(!this.cfg.understanding.enabled)return null;const file=join(this.home,'understanding',`${video.id}.json`),policy=efficiencySettings(this.cfg);
  if(existsSync(file)){try{const old=JSON.parse(readFileSync(file,'utf8'));if(old.status==='ready'||policy.enabled&&old.captions)return old;}catch{}}
  const capture=frames.audioCapture||{},evidence={videoId:video.id,status:'visual_only',sampleStart:capture.start||0,sampleSeconds:capture.seconds||0,captions:(capture.captions||[]).map(c=>c.text).join('\n').slice(0,12000),captionSource:capture.captions?.length?'text-track':'',transcript:'',createdAt:new Date().toISOString()};
  if(policy.enabled&&evidence.captions&&!policy.transcribeWithCaptions){evidence.status='captions_only';evidence.reason='已有页面字幕，复用字幕而不重复转写';}
  else if(capture.base64){const audio=join(this.home,'understanding',`${video.id}.webm`);writeFileSync(audio,Buffer.from(capture.base64,'base64'),{mode:0o600});
   try{const t=await this.transcribe(audio,{signal,seconds:capture.seconds});evidence.transcript=t.text;evidence.languages=t.languages;evidence.model=t.model;evidence.status=t.text.trim()?'ready':'no_speech';}catch(error){if(storageFault(error))throw error;evidence.reason=error.message;}
  }else evidence.reason=capture.error||'没有取得音轨';
  if(!evidence.captions&&this.cfg.understanding.ocr&&(!policy.enabled||policy.separateOCR)&&typeof model?.visibleCaptions==='function'&&frames.length&&!signal?.aborted){try{const text=await model.visibleCaptions(frames);evidence.captions=text.text;evidence.captionSource=text.text?'sampled-frames':'';}catch(error){if(storageFault(error))throw error;evidence.captionError=error.message;}}
  atomicJson(file,evidence);return evidence;
 }
}
