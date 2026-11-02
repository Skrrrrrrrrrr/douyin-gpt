import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {Reviews} from './reviews.mjs';
export const mediaHash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
export const episodeText=turns=>turns.map(t=>(t.speaker==='openai'?'GPT：':'DeepSeek：')+t.text).join('\n');
export function queueEpisodeReview(home,state){const queue=new Reviews(home),sha256=mediaHash(state.videoPath),key='episode:'+state.day+':'+state.fingerprint+':'+sha256;for(const old of queue.list())if(old.kind==='episode'&&old.payload.day===state.day&&old.key!==key&&['pending','approved'].includes(old.status))queue.finish(old.id,'stale','成片版本已更新');return queue.add('episode',key,{day:state.day,title:state.title,text:episodeText(state.turns),turns:state.turns,fingerprint:state.fingerprint,sha256,requiresRender:false});}
export function approvedEpisode(home,state){const sha256=mediaHash(state.videoPath);return new Reviews(home).list().find(r=>r.kind==='episode'&&r.status==='approved'&&r.payload.day===state.day&&r.payload.fingerprint===state.fingerprint&&r.payload.sha256===sha256&&!r.payload.requiresRender);}
