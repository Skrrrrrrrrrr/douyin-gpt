import {copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,chmodSync,openSync,closeSync,renameSync,rmSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {atomicJson} from '../src/store.mjs';
import {containerConfig,rebasePaths} from './runtime.mjs';

const ephemeral=new Set(['browser','browser-runtime.json','daemon.json','dashboard-runtime.json','process.lock','supervisor-runtime.json','service','service-desired.json','worker-exit.json','session-health.json','reply-progress.json','dashboard-job.json','codex']);
export function importRuntime({source,home,videos,logs}){
 if(resolve(source)===resolve(home)||existsSync(home)&&readdirSync(home).length)throw new Error('Import requires a separate, empty target data directory');
 let original;try{original=JSON.parse(readFileSync(join(source,'config.json'),'utf8'));}catch{throw new Error('Source config.json could not be validated');}
 if(!original.account?.secUid)throw new Error('Source runtime has no bound account');
 const mappings=[[process.env.DOUYIN_IMPORT_ORIGINAL_HOME||source,home],[original.video.outputDir,join(home,'video-output')],[original.journal.outputDir,join(home,'daily-logs')]];
 const oldRoot=process.env.DOUYIN_IMPORT_ORIGINAL_ROOT;if(oldRoot)mappings.push([oldRoot,'/app']);
 const cfg=containerConfig(rebasePaths(original,mappings));
 mkdirSync(home,{recursive:true,mode:0o700});const lock=join(home,'.import.lock'),fd=openSync(lock,'wx',0o600),staging=join(home,'.import-'+randomUUID());mkdirSync(staging,{mode:0o700});let files=0,bytes=0;
 function copy(from,to,top=false){
  for(const name of readdirSync(from)){
   if(top&&ephemeral.has(name)||/\.lock$|\.guard(?:\.|$)|\.tmp$/.test(name))continue;
   const src=join(from,name),out=join(to,top&&name==='backups'?'imported-macos-backups':name),stat=lstatSync(src);
   if(stat.isSymbolicLink())throw new Error('Import does not follow symbolic links');
   if(stat.isDirectory()){mkdirSync(out,{recursive:true,mode:0o700});copy(src,out);}
   else if(stat.isFile()){
    if(name.endsWith('.json')&&!(top&&name==='backup-key.json')){let value;try{value=JSON.parse(readFileSync(src,'utf8'));}catch{throw new Error('Source JSON could not be validated: '+name);}atomicJson(out,rebasePaths(value,mappings));}
    else{copyFileSync(src,out);chmodSync(out,0o600);}
    files++;bytes+=stat.size;
   }
  }
 }
 try{
  copy(source,staging,true);
  if(videos&&existsSync(videos)){const out=join(staging,'video-output');mkdirSync(out,{recursive:true,mode:0o700});copy(videos,out);}
  if(logs&&existsSync(logs)){const out=join(staging,'daily-logs');mkdirSync(out,{recursive:true,mode:0o700});copy(logs,out);}
  atomicJson(join(staging,'config.json'),cfg);
  atomicJson(join(staging,'service-desired.json'),{version:1,worker:false,dashboard:true,maintenanceUntil:0});
  const proof={version:1,at:new Date().toISOString(),files,bytes,accountHash:createHash('sha256').update(original.account.secUid).digest('hex'),browserLoginRequired:true,codexLoginRequired:true,activation:'paused',sourceRemainsUntouched:true,liveCutoverComplete:false};
  atomicJson(join(staging,'container-import.json'),proof);
  for(const name of readdirSync(staging))renameSync(join(staging,name),join(home,name));
  return proof;
 }finally{closeSync(fd);unlinkSync(lock);rmSync(staging,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(importRuntime({source:'/import/runtime',home:'/data',videos:'/import/videos',logs:'/import/daily-logs'})));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
