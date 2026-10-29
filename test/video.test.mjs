import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pcmWav,speechSimilarity,Speech} from '../src/speech.mjs';
import {publicEpisodeData,episodeTurns,validateEpisodeLines} from '../src/broadcast.mjs';
import {scheduledDate,validatePublishForm,Publisher} from '../src/publisher.mjs';
import {defaultConfig,validateConfig} from '../src/config.mjs';

test('旧配置关闭晚报；拒绝无效时间与相对输出路径',()=>{
 const c=defaultConfig();delete c.video;validateConfig(c);assert.equal(c.video.enabled,false);
 c.video.hour=24;assert.throws(()=>validateConfig(c));c.video.hour=21;c.video.outputDir='../x';assert.throws(()=>validateConfig(c),/绝对路径/);
});
test('配音保存为标准 PCM WAV，文本相似度识别漏字和无关输出',()=>{
 const pcm=Buffer.alloc(48000),wav=pcmWav(pcm);assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(24),24000);assert.equal(wav.readUInt32LE(40),48000);
 assert.equal(speechSimilarity('你好，GPT！','你好 GPT'),1);assert.ok(speechSimilarity('今天记录二十五条视频','这是一首小诗')<.5);assert.throws(()=>pcmWav(Buffer.alloc(1)));
});
test('晚报只读取公开资料及已回读的互动数量，私信、联系人和未知发送不进入播报',()=>{
 const v={id:'7400000000000000001',desc:'钩织',author:'作者',analysis:{summary:'小动物',evidence:'画面',recommend:false,confidence:.8},privateToken:'SECRET'};
 const journal={videos:(_day,p)=>p==='openai'?[v]:[]};const ledger={data:{actions:[{day:'2026-10-29',status:'sent',kind:'comment',text:'PRIVATE_BODY'},{day:'2026-10-29',status:'uncertain',kind:'comment'},{day:'2026-10-29',status:'accepted',kind:'reply'}],outbox:[{text:'PRIVATE_MESSAGE'}]}};
 const data=publicEpisodeData(journal,ledger,'2026-10-29');assert.equal(data.providers.openai.comments,1);assert.equal(data.providers.openai.replies,0);assert.doesNotMatch(JSON.stringify(data),/SECRET|PRIVATE/);
});
test('口播数量由实际记录填入，两个角色各自讲述并保留 AI 配音声明',()=>{
 const data={totalVideos:25,providers:{openai:{videoCount:23,comments:2,replies:1},deepseek:{videoCount:2,comments:2,replies:0}}};
 const turns=episodeTurns(data,{openai:{recap:'今天看到了手作。',highlight:'毛线小动物。'},deepseek:{recap:'我看到了游戏二创。',highlight:''}});
 assert.equal(turns.length,8);assert.match(turns[1].text,/二十五条视频/);assert.match(turns[1].text,/二十三条/);assert.match(turns[1].text,/两条/);
 assert.equal(turns[3].speaker,'deepseek');assert.match(turns.at(-1).text,/AI 角色和合成配音/);
 assert.throws(()=>validateEpisodeLines({recap:'https://x',highlight:''}));
});
test('定时发布使用北京时间，严格限制 2 小时后至 14 天内且拒绝无效日期',()=>{
 const now=new Date('2026-10-29T10:00:00Z');assert.equal(scheduledDate('2026-10-29 21:00',now).toISOString(),'2026-10-29T13:00:00.000Z');
 for(const value of ['2026-10-29 19:00','2026-11-20 21:00','2026-02-30 21:00','2026-10-29 25:00'])assert.throws(()=>scheduledDate(value,now));
});
test('发布前必须核对标题、描述、AI 已声明、公开可见和定时时间',()=>{
 const state={title:'AI晚报',description:'公开日志'};
 const view={url:'https://creator.douyin.com/creator-micro/content/post/video',title:state.title,description:state.description,text:'作者声明：内容由AI生成',checks:[{label:'公开',checked:true},{label:'定时发布',checked:true}],scheduled:'2026-10-29 21:00',publishEnabled:true};
 validatePublishForm(view,state,'2026-10-29 21:00');
 for(const changed of [{title:'其他'},{description:'改动'},{text:'请选择内容由AI生成'},{scheduled:'2026-10-29 21:10'},{publishEnabled:false},{checks:[{label:'仅自己可见',checked:true}]}])assert.throws(()=>validatePublishForm({...view,...changed},state,'2026-10-29 21:00'));
});
test('已定时、已提交或发布结果不明的日记录不能再次点击发布',async t=>{
 const home=mkdtempSync(join(tmpdir(),'dy-publish-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const dir=join(home,'video','2026-10-29');mkdirSync(dir,{recursive:true});const cfg=defaultConfig();cfg.account.secUid='OWNER';
 const p=new Publisher(home,cfg,{page:async()=>{throw new Error('不应访问浏览器');}},{log:()=>{}});
 for(const status of ['scheduled','published','submitted']){writeFileSync(join(dir,'episode.json'),JSON.stringify({day:'2026-10-29',status,account:cfg.account}));assert.equal((await p.publish('2026-10-29',{live:true})).status,status);}
 writeFileSync(join(dir,'episode.json'),JSON.stringify({day:'2026-10-29',status:'uncertain',account:cfg.account}));await assert.rejects(p.publish('2026-10-29',{live:true}),/不自动重发/);
});
test('Realtime 配音收到完整音频及转写后才保存，不接受不一致内容',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'dy-speech-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let content='晚上好，我是 GPT。';let options;
 class Socket extends EventEmitter{
  constructor(url,config){super();options={url,config};queueMicrotask(()=>this.emit('message',JSON.stringify({type:'session.created',session:{model:'gpt-realtime-2.1-mini'}})));}
  send(raw){const v=JSON.parse(raw);if(v.type==='session.update')queueMicrotask(()=>this.emit('message',JSON.stringify({type:'session.updated'})));
   if(v.type==='response.create')queueMicrotask(()=>{this.emit('message',JSON.stringify({type:'response.output_audio.delta',delta:Buffer.alloc(48000).toString('base64')}));this.emit('message',JSON.stringify({type:'response.output_audio_transcript.delta',delta:content}));this.emit('message',JSON.stringify({type:'response.done',response:{status:'completed'}}));});}
  close(){this.emit('close');}
 }
 const speech=new Speech({apiKey:'FAKE_SECRET',baseUrl:'https://api.openai.com/v1'},{WebSocketImpl:Socket}),file=join(dir,'voice.wav');
 const result=await speech.create(content,file);assert.equal(result.duration,1);assert.equal(readFileSync(file).length,48044);assert.equal(new URL(options.url).searchParams.get('model'),'gpt-realtime-2.1-mini');
 content='完全无关的文字';await assert.rejects(speech.create('晚上好，我是 GPT。',join(dir,'bad.wav')),/不一致/);
});
