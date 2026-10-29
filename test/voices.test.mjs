import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig,validateConfig} from '../src/config.mjs';
import {VOICE_PRESETS,resolveEpisodeVoice,synthesizeEpisodeVoice} from '../src/voices.mjs';

test('参考音色与指定聊天的实际参数一致，返回值不会修改预置',()=>{
 const cfg=defaultConfig();cfg.video.voiceProfiles={openai:'A',deepseek:'B'};
 const gpt=resolveEpisodeVoice(cfg,'openai'),ds=resolveEpisodeVoice(cfg,'deepseek');
 assert.deepEqual([gpt.voice,gpt.pitch,gpt.rate],['zh-CN-XiaoxiaoNeural','+24Hz','+12%']);
 assert.deepEqual([ds.voice,ds.pitch,ds.rate],['zh-CN-XiaoyiNeural','-3Hz','+8%']);
 gpt.pitch='+0Hz';assert.equal(VOICE_PRESETS.A.pitch,'+24Hz');
});
test('未选择新音色的旧配置保留原配音服务；可以分别混搭 A 与 D',()=>{
 const cfg=defaultConfig();delete cfg.video.voiceProfiles;validateConfig(cfg);
 assert.equal(resolveEpisodeVoice(cfg,'openai').engine,'openai');assert.equal(resolveEpisodeVoice(cfg,'deepseek').voice,'shimmer');
 cfg.video.voiceProfiles={openai:'a',deepseek:'d'};validateConfig(cfg);
 assert.equal(resolveEpisodeVoice(cfg,'openai').id,'A');assert.equal(resolveEpisodeVoice(cfg,'deepseek').pitch,'+0Hz');
});
test('拒绝不存在的候选和异常参数，不把参数作为命令执行',async()=>{
 const cfg=defaultConfig();cfg.video.voiceProfiles={openai:'unknown'};assert.throws(()=>validateConfig(cfg),/voiceProfiles/);
 await assert.rejects(synthesizeEpisodeVoice({cfg,text:'你好',file:'/tmp/unused.wav',profile:{engine:'edge',voice:'$(anything)',rate:'+0%',pitch:'+0Hz'}}),/参数无效/);
});
test('取消配音时不访问网络、不调用替代音色',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(synthesizeEpisodeVoice({cfg:defaultConfig(),text:'你好',file:'/tmp/unused.wav',profile:VOICE_PRESETS.A,signal:controller.signal}),/已取消/);
});
