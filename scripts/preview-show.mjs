import {readStoredFile as readFileSync, storedExists as existsSync, storedReadDir as readdirSync} from '../src/storage.mjs';
import {mkdirSync, writeFileSync} from 'node:fs';import {join} from 'node:path';
import {loadEnv,homePath,readConfig,modelConfig,dayKey} from '../src/config.mjs';import {Store,atomicJson} from '../src/store.mjs';import {CommentStore} from '../src/comment-store.mjs';import {Gpt} from '../src/openai.mjs';import {buildEpisode} from '../src/broadcast.mjs';
const copyRecord=(from,to)=>writeFileSync(to,readFileSync(from),{mode:0o600});
loadEnv();const home=homePath(),cfg=readConfig(home),weekly=process.argv.includes('--weekly'),preview=join(home,'show-preview');mkdirSync(preview,{recursive:true,mode:0o700});
const source=new Store(home);atomicJson(join(preview,'state.json'),{version:1,contacts:{},outbox:[],videos:source.data.videos,apiUsage:[],lastBrowseAt:0});
const comments=new CommentStore(home);atomicJson(join(preview,'comments.json'),{version:1,initialized:true,seen:[],actions:comments.data.actions,lastPollAt:0,halted:''});
for(const file of ['audience.json','public-events.json','storylines.json'])if(existsSync(join(home,file)))copyRecord(join(home,file),join(preview,file));
const past=join(home,'video');if(existsSync(past))for(const day of readdirSync(past).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&d<dayKey())){const episode=join(past,day,'episode.json');if(existsSync(episode)){mkdirSync(join(preview,'video',day),{recursive:true});copyRecord(episode,join(preview,'video',day,'episode.json'));}}
mkdirSync(join(preview,'reports'),{recursive:true});for(const name of readdirSync(join(home,'reports')))if(/^\d{4}-\d{2}-\d{2}\.videos\.json$/.test(name))copyRecord(join(home,'reports',name),join(preview,'reports',name));
cfg.journal.enabled=false;cfg.video.narrative={...cfg.video.narrative,enabled:process.argv.includes('--legacy')?false:process.argv.includes('--narrative')||cfg.video.narrative.enabled};cfg.video.show={enabled:true,format:cfg.video.show?.format||'roundtable'};cfg.video.animation=true;cfg.video.outputDir=join(cfg.video.outputDir,weekly?'weekly-preview':'features-preview');
const state=await buildEpisode({home:preview,cfg,models:{openai:new Gpt({...modelConfig(),...(process.argv.includes('--luna')?{model:'gpt-6-luna'}:{})}),deepseek:new Gpt(modelConfig('deepseek'))},force:true,weekly});
console.log(JSON.stringify({status:state.status,videoPath:state.videoPath,show:state.show},null,2));
