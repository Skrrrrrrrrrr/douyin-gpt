import {readState,updateState} from './state-file.mjs';
const defaults={enabled:false,audienceQA:true,followups:true,growth:true};
export function programmeSettings(home,cfg){const d=readState(home,'programme.json',{version:1}),settings={...defaults,...cfg.video?.narrative,...Object.fromEntries(Object.keys(defaults).filter(k=>Object.hasOwn(d,k)).map(k=>[k,d[k]]))};if(Object.values(settings).some(v=>typeof v!=='boolean'))throw new Error('节目组织设置损坏，保留原记录');return settings;}
export function programmeConfig(home,cfg){return {...cfg,video:{...cfg.video,narrative:programmeSettings(home,cfg)}};}
export function saveProgramme(home,patch){if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!Object.hasOwn(defaults,k)||typeof patch[k]!=='boolean'))throw new Error('节目设置字段无效');return updateState(home,'programme.json',{version:1,...defaults},d=>{Object.assign(d,patch);return d;});}
