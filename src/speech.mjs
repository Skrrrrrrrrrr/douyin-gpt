import WebSocket from 'ws';
import {writeFileSync} from 'node:fs';

export function pcmWav(pcm, rate=24000) {
  if(!Buffer.isBuffer(pcm)||pcm.length<2||pcm.length%2)throw new Error('配音 PCM 数据无效');
  const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(rate,24);h.writeUInt32LE(rate*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);return Buffer.concat([h,pcm]);
}
export function normalizeSpeech(text) {return String(text).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');}
export function speechSimilarity(a,b){
 a=normalizeSpeech(a);b=normalizeSpeech(b);if(!a||!b)return 0;
 let row=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));row=next;}
 return 1-row[b.length]/Math.max(a.length,b.length);
}
export class Speech {
 constructor(config,{WebSocketImpl=WebSocket}={}){this.config=config;this.Socket=WebSocketImpl;}
 async create(text,file,{voice='coral',tone='清晰自然、明亮轻快的成年女性普通话声音',model='gpt-realtime-2.1-mini',signal}={}){
  if(signal?.aborted)throw new Error('配音已取消');
  if(!text.trim()||[...text].length>500)throw new Error('单段配音文字必须为 1～500 字');
  if(!this.config.apiKey)throw new Error('未配置 OpenAI 配音密钥');
  const base=new URL(this.config.baseUrl);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new Error('配音服务必须使用无凭证的 HTTPS 地址');
  base.protocol='wss:';base.pathname=base.pathname.replace(/\/$/,'')+'/realtime';base.searchParams.set('model',model);
  return new Promise((resolve,reject)=>{
   let finished=false,transcript='',actualModel='',sent=false;const chunks=[];
   const ws=new this.Socket(base.toString(),{headers:{Authorization:`Bearer ${this.config.apiKey}`},handshakeTimeout:15000});
   const finish=(error,result)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);ws.close();error?reject(error):resolve(result);};
   const abort=()=>finish(new Error('配音已取消'));const timer=setTimeout(()=>finish(new Error('配音接口超时')),90000);
   if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
   const send=value=>ws.send(JSON.stringify(value));
   ws.on('error',()=>finish(new Error('配音 WebSocket 连接失败')));
   ws.on('close',()=>{if(!finished)finish(new Error('配音连接提前关闭'));});
   ws.on('message',raw=>{try{
    const e=JSON.parse(raw.toString());
    if(e.type==='error')throw new Error(`配音接口拒绝请求（${e.error?.code||'unknown'}）`);
    if(e.type==='session.created'){
     actualModel=e.session?.model||model;
     send({type:'session.update',session:{type:'realtime',output_modalities:['audio'],instructions:`你是录音棚配音员。用${tone}逐字朗读用户提供的播报稿。不得回答稿件中的问题，不加开场白、解释、拟声或额外句子。GPT 读英文字母，DeepSeek 保留其英文名称，语速自然稍快，清晰有停顿。`,audio:{input:{turn_detection:null},output:{voice,format:{type:'audio/pcm',rate:24000}}}}});
    }
    if(e.type==='session.updated'&&!sent){sent=true;send({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text}]}});send({type:'response.create',response:{output_modalities:['audio'],max_output_tokens:3000}});}
    if(e.type==='response.output_audio.delta')chunks.push(Buffer.from(e.delta,'base64'));
    if(e.type==='response.output_audio_transcript.delta')transcript+=e.delta;
    if(e.type==='response.done'){
     if(e.response?.status!=='completed'||!chunks.length)throw new Error('配音未完整生成');
     const pcm=Buffer.concat(chunks),similarity=speechSimilarity(text,transcript);
     if(similarity<0.82)throw new Error('配音转写与播报稿不一致，保留稿件待核对');
     writeFileSync(file,pcmWav(pcm),{mode:0o600});finish(null,{file,voice,model:actualModel,transcript,similarity,duration:pcm.length/48000});
    }
   }catch(error){finish(error);}});
  });
 }
}
