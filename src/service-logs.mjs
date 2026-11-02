import {constants,openSync,closeSync,fstatSync,lstatSync,readSync,readFileSync,writeSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {ROOT} from './config.mjs';

export const LOG_SOURCES=Object.freeze({
  dashboard:{name:'管理服务',file:'dashboard.log'},
  assistant:{name:'自动任务',file:'assistant.log'},
  supervisor:{name:'服务守护',file:'supervisor.log'},
  http:{name:'HTTP 请求',file:'http-requests.log'}
});
const LEVELS=['info','warn','error','debug'];
const fail=(status,message)=>Object.assign(new Error(message),{status,code:'LOG_REQUEST_INVALID'});
const anchor=(fd,offset)=>{const data=Buffer.alloc(Math.min(64,offset));if(data.length)readSync(fd,data,0,data.length,offset-data.length);return createHash('sha256').update(data).digest('hex').slice(0,24);};
const signature=s=>createHash('sha256').update(`${s.dev}:${s.ino}:${s.birthtimeMs}`).digest('hex').slice(0,24);
const sensitive=/^(?:.*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token|authorization|cookie)$/i;
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');

export function redactLog(value,{secrets=[],home='',root=ROOT}={}){
  let text=String(value).replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
  for(const secret of secrets)if(typeof secret==='string'&&secret.length>=4)text=text.split(secret).join('[已隐藏]');
  text=text.replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g,'[已隐藏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,'Bearer [已隐藏]').replace(/\b[a-f0-9]{64}\b/gi,'[长凭证已隐藏]')
    .replace(/((?:["']?(?:[\w.-]*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|session[_-]?token|password|passwd|authorization|cookie|set-cookie|sessionid|sid_guard|token)["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;,}\]]+)/gi,(_,prefix,value)=>prefix+(/^["']/.test(value)?value[0]+'[已隐藏]'+value[0]:'[已隐藏]'))
    .replace(/((?:初始密码|登录密码|API密钥)\s*[:：=]\s*)[^\r\n]+/g,'$1[已隐藏]')
    .replace(/https?:\/\/[^\s<>"']+/g,value=>{try{const url=new URL(value);return url.origin+url.pathname+(url.search?'?[查询参数已隐藏]':'')+(url.hash?'#[已隐藏]':'');}catch{return '[链接已隐藏]';}});
  for(const [path,label]of [[home,'[数据目录]'],[root,'[项目目录]']])if(path)text=text.split(path).join(label);
  return text.replace(/\/Users\/[^/\s"']+/g,'[用户目录]');
}

function secretsAt(home){
  const secrets=[];
  const visit=(value,depth=0)=>{if(depth>5||!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){if(sensitive.test(key)&&typeof item==='string'&&item.length>=4&&item.length<=4096)secrets.push(item);else if(item&&typeof item==='object')visit(item,depth+1);}};
  for(const [key,value]of Object.entries(process.env))if(sensitive.test(key)&&value?.length>=4&&value.length<=4096)secrets.push(value);
  for(const name of ['openai.json','deepseek.json','official.json','official-oauth.json'])try{const file=join(home,name),stat=lstatSync(file);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<65536)visit(JSON.parse(readFileSync(file,'utf8')));}catch{}
  return [...new Set(secrets)].sort((a,b)=>b.length-a.length);
}

export function logQuery(params){
  const allowed=new Set(['source','archive','level','q','after','before','limit']);
  for(const key of params.keys())if(!allowed.has(key)||params.getAll(key).length!==1)throw fail(400,'日志查询字段无效');
  const source=params.get('source')||'dashboard',archive=params.get('archive')||'0',level=params.get('level')||'all',q=params.get('q')||'',limit=params.get('limit')||'500';
  if(!Object.hasOwn(LOG_SOURCES,source)||!/^[0-3]$/.test(archive)||(archive!=='0'&&source!=='http'))throw fail(400,'日志来源无效');
  if(!['all',...LEVELS].includes(level)||q.length>200||/[\x00-\x1f\x7f]/.test(q)||!/^\d{1,4}$/.test(limit)||Number(limit)<1||Number(limit)>1000)throw fail(400,'日志筛选条件无效');
  if(params.has('after')&&params.has('before'))throw fail(400,'日志游标不能同时向前和向后读取');
  return {source,archive:Number(archive),level,q:q.trim(),limit:Number(limit),after:params.get('after')||'',before:params.get('before')||''};
}

function decodeCursor(value,source,archive,key){
  if(!value)return null;
  let cursor;try{if(!/^[A-Za-z0-9_-]{1,450}\.[A-Za-z0-9_-]{43}$/.test(value))throw 0;const [payload,mac]=value.split('.'),expected=createHmac('sha256',key).update(payload).digest(),actual=Buffer.from(mac,'base64url');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw 0;cursor=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));}catch{throw fail(400,'日志游标无效');}
  if(cursor?.v!==1||cursor.source!==source||cursor.archive!==archive||!/^[a-f0-9]{24}$/.test(cursor.sig)||!Number.isSafeInteger(cursor.offset)||cursor.offset<0||!LEVELS.includes(cursor.level)||typeof cursor.skipping!=='boolean'||!/^[a-f0-9]{24}$/.test(cursor.anchor))throw fail(400,'日志游标无效');
  return cursor;
}

function entry(raw,previous,redact){
  let data;try{data=JSON.parse(raw);}catch{}
  const clean=redact(raw).slice(0,8192)+(raw.length>8192?' …[单行内容已截短]':'');
  let level=String(data?.level||data?.severity||'').toLowerCase();if(level==='warning')level='warn';
  const structured=LEVELS.includes(level);
  if(!structured){
    if(/^\s+(?:at\s|\.\.\.)|^Caused by:/.test(raw))level=previous;
    else if(/\b(?:error|fatal|exception|failed|failure)\b|错误|异常|失败/i.test(raw)&&!/无异常|没有异常|没有错误|0\s*(?:个|条|项)?错误/.test(raw))level='error';
    else if(/\bwarn(?:ing)?\b|警告|告警|重试|超时/i.test(raw))level='warn';
    else if(/\bdebug\b|调试/i.test(raw))level='debug';else level='info';
  }
  const stamp=data?.time||data?.timestamp||data?.at;
  const at=typeof stamp==='string'&&/^\d{4}-\d\d-\d\dT/.test(stamp)&&Number.isFinite(Date.parse(stamp))?stamp:null;
  const legacyTime=raw.match(/^\[?(\d{2}:\d{2}:\d{2})(?:\.\d+)?\]?/);
  let message=clean;
  if(data?.event==='http.request')message=`${data.method} ${data.path} → ${data.status} · ${data.durationMs} ms${data.code?' · '+data.code:''} · ${data.requestId}`;
  else if(typeof data?.message==='string')message=redact(data.message).slice(0,8192);
  return {level,levelSource:structured?'structured':'inferred',at,time:at?new Date(at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):legacyTime?.[1]||'',message:redact(message),raw:clean};
}

export class ServiceLogs{
  constructor(home,{maxReadBytes=512*1024,maxDownloadBytes=10*1024*1024}={}){this.home=home;this.cursorKey=randomBytes(32);this.maxReadBytes=maxReadBytes;this.maxDownloadBytes=maxDownloadBytes;this.secretCache={until:0,values:[]};}
  redact(value){if(Date.now()>=this.secretCache.until)this.secretCache={until:Date.now()+10000,values:secretsAt(this.home)};return redactLog(value,{home:this.home,secrets:this.secretCache.values});}
  open(source,archive=0){
    if(!Object.hasOwn(LOG_SOURCES,source)||!Number.isInteger(archive)||archive<0||archive>3||(archive&&source!=='http'))throw fail(400,'日志来源无效');
    const descriptor=LOG_SOURCES[source],file=join(this.home,descriptor.file+(archive?'.'+archive:''));let fd;
    try{const initial=lstatSync(file);if(!initial.isFile()||initial.isSymbolicLink())throw fail(403,'该日志不是可读取的普通文件');fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));const stat=fstatSync(fd);if(!stat.isFile())throw fail(403,'该日志不是可读取的普通文件');return {fd,stat,source,archive,file:descriptor.file+(archive?'.'+archive:''),name:descriptor.name,sig:signature(stat)};}
    catch(error){if(fd!==undefined)closeSync(fd);if(error.code==='ENOENT')return null;if(error.status)throw error;throw fail(503,'日志暂时无法读取，请稍后重试');}
  }
  sources(){return Object.entries(LOG_SOURCES).map(([source,descriptor])=>{let opened;try{opened=this.open(source);return {id:source,name:descriptor.name,file:descriptor.file,exists:!!opened,bytes:opened?.stat.size||0,updatedAt:opened?.stat.mtime.toISOString()||null};}catch{return {id:source,name:descriptor.name,file:descriptor.file,exists:false,bytes:0,updatedAt:null,unreadable:true};}finally{if(opened)closeSync(opened.fd);}});}
  read(options={}){
    const {source='dashboard',archive=0,level='all',q='',limit=500,after='',before=''}=options;
    // Direct callers use the same validation as HTTP callers.
    const normalized=logQuery(new URLSearchParams({source,archive:String(archive),level,q,limit:String(limit),...(after?{after}:{}),...(before?{before}:{})}));
    const cursor=decodeCursor(after||before,source,archive,this.cursorKey),opened=this.open(source,archive),sources=this.sources();
    if(!opened)return {source:{id:source,...LOG_SOURCES[source],file:LOG_SOURCES[source].file+(archive?'.'+archive:''),exists:false,bytes:0,updatedAt:null},sources,entries:[],startCursor:null,endCursor:null,hasEarlier:false,hasLater:false,reset:!!cursor,scannedBytes:0};
    try{
      const {fd,stat,sig}=opened,reset=!!cursor&&(cursor.sig!==sig||cursor.offset>stat.size||cursor.anchor!==anchor(fd,cursor.offset)),position=reset?null:cursor,direction=position?(after?'after':'before'):'tail';
      const end=direction==='before'?position.offset:direction==='after'?Math.min(stat.size,position.offset+this.maxReadBytes):stat.size;
      let start=direction==='after'?position.offset:Math.max(0,end-this.maxReadBytes),buffer=Buffer.alloc(Math.max(0,end-start));
      const count=buffer.length?readSync(fd,buffer,0,buffer.length,start):0;buffer=buffer.subarray(0,count);let offset=0,skipping=direction==='after'&&position.skipping;
      let cutLine=false;if(start>0&&direction!=='after'){const prior=Buffer.alloc(1);cutLine=readSync(fd,prior,0,1,start-1)!==1||prior[0]!==10;}
      if(cutLine||skipping){const first=buffer.indexOf(10);if(first<0){offset=buffer.length;skipping=true;}else{offset=first+1;skipping=false;}}
      const effectiveStart=start+offset,entries=[];let lastLevel=direction==='after'?position.level:'info',processed=effectiveStart,hasLater=false;
      while(offset<buffer.length){const newline=buffer.indexOf(10,offset);if(newline<0)break;const raw=buffer.subarray(offset,newline).toString('utf8').replace(/\r$/,'');const lineStart=start+offset;processed=start+newline+1;offset=newline+1;
        if(!raw.trim())continue;const row=entry(raw,lastLevel,v=>this.redact(v));lastLevel=row.level;
        if((level==='all'||row.level===level)&&(!q||row.raw.toLocaleLowerCase().includes(q.toLocaleLowerCase())))entries.push({...row,id:`${source}:${archive}:${sig}:${lineStart}`,offset:lineStart});
        if(direction==='after'&&entries.length>=normalized.limit){hasLater=processed<stat.size;break;}
      }
      // A malformed giant line must not make the incremental reader stall forever.
      if(processed===effectiveStart&&buffer.length-offset>=Math.min(65536,this.maxReadBytes)){processed=start+buffer.length;skipping=true;}
      if(direction==='after'&&end<stat.size)hasLater=true;
      const visible=direction==='after'?entries:entries.slice(-normalized.limit),first=visible[0]?.offset??effectiveStart;
      const make=(offset,level='info',skipping=false)=>{const payload=encode({v:1,source,archive,sig,offset,level,skipping,anchor:anchor(fd,offset)});return payload+'.'+createHmac('sha256',this.cursorKey).update(payload).digest('base64url');};
      return {source:{id:source,name:opened.name,file:opened.file,exists:true,bytes:stat.size,updatedAt:stat.mtime.toISOString()},sources,entries:visible,startCursor:make(first),endCursor:make(processed,lastLevel,skipping),hasEarlier:first>0,hasLater,reset,scannedBytes:count};
    }finally{closeSync(opened.fd);}
  }
  download(options={}){
    const query=logQuery(new URLSearchParams({source:options.source||'dashboard',archive:String(options.archive||0),level:options.level||'all',q:options.q||'',limit:'1000'})),opened=this.open(query.source,query.archive);
    if(!opened)throw fail(404,'这个日志文件尚未生成');
    try{const {stat,fd}=opened,start=Math.max(0,stat.size-this.maxDownloadBytes),buffer=Buffer.alloc(stat.size-start),count=buffer.length?readSync(fd,buffer,0,buffer.length,start):0;let text=buffer.subarray(0,count).toString('utf8');if(start>0){const newline=text.indexOf('\n');text=newline<0?'':text.slice(newline+1);}
      let previous='info';const selected=[];for(const raw of text.split(/\r?\n/)){if(!raw.trim())continue;const row=entry(raw,previous,v=>this.redact(v));previous=row.level;if((query.level==='all'||row.level===query.level)&&(!query.q||row.raw.toLocaleLowerCase().includes(query.q.toLocaleLowerCase())))selected.push(row.raw);}
      const header=`# 留座中转站 · ${opened.name}\n# ${opened.file} · ${new Date().toISOString()}\n# 内容已脱敏${start>0?'；文件较大，仅导出最近 10 MiB':''}\n`;
      return {text:header+selected.join('\n')+'\n',filename:`liuzuo-${query.source}${query.archive?'-'+query.archive:''}-${new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'})}.log`};
    }finally{closeSync(opened.fd);}
  }
}

const KNOWN_PATHS=new Set(['/', '/login','/api/state','/api/auth/session','/api/auth/login','/api/auth/logout','/api/auth/password','/api/config','/api/contact','/api/daemon','/api/reviews','/api/service','/api/backup','/api/backup/restore','/api/backup-file','/api/backup-key','/api/official','/api/story/settings','/api/story/thread','/api/story/event','/api/memory/forget','/api/alerts/resolve','/api/audience','/api/takeover','/api/interests/feedback','/api/stickers/sync-native','/api/discovery/search','/api/preview','/api/media','/api/logs','/api/logs/download']);
export class HttpRequestLogs{
  constructor(home,{maxBytes=5*1024*1024,keep=3,onError=message=>console.error(message)}={}){this.home=home;this.file=join(home,LOG_SOURCES.http.file);this.maxBytes=maxBytes;this.keep=keep;this.onError=onError;this.retryAt=0;this.dropped=0;this.context=new WeakMap();}
  track(req,res){
    const start=process.hrtime.bigint(),at=new Date().toISOString(),context={};this.context.set(res,context);let written=false;
    const finish=aborted=>{if(written)return;written=true;this.context.delete(res);let path;try{path=new URL(req.url,'http://localhost').pathname;}catch{path='[未匹配路径]';}
      const status=aborted?499:res.statusCode;if(['/api/logs','/api/logs/download'].includes(path)&&(status<400||status===499))return;
      if(!KNOWN_PATHS.has(path))path=path.startsWith('/brand/')?'/brand/[静态素材]':path.startsWith('/fonts/')?'/fonts/[字体]':'[未匹配路径]';
      this.write({time:at,level:status>=500?'error':status>=400?'warn':'info',event:'http.request',requestId:randomUUID(),method:['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS','CONNECT','TRACE'].includes(req.method)?req.method:'OTHER',path,status,durationMs:Math.round(Number(process.hrtime.bigint()-start)/1e5)/10,...(context.code?{code:context.code}:{})});
    };
    res.once('finish',()=>finish(false));res.once('close',()=>{if(!res.writableFinished)finish(true);});
  }
  error(res,error){const context=this.context.get(res);if(context)context.code=/^[A-Z][A-Z0-9_]{1,48}$/.test(String(error.code||''))?error.code:'REQUEST_ERROR';}
  write(value){
    if(Date.now()<this.retryAt){this.dropped++;return;}let fd;
    try{const text=JSON.stringify(value)+'\n';let size=0;try{const stat=lstatSync(this.file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('invalid file');size=stat.size;}catch(error){if(error.code!=='ENOENT')throw error;}
      if(size+Buffer.byteLength(text)>this.maxBytes){try{unlinkSync(this.file+'.'+this.keep);}catch(error){if(error.code!=='ENOENT')throw error;}for(let index=this.keep-1;index>=1;index--)try{renameSync(this.file+'.'+index,this.file+'.'+(index+1));}catch(error){if(error.code!=='ENOENT')throw error;}try{renameSync(this.file,this.file+'.1');}catch(error){if(error.code!=='ENOENT')throw error;}}
      fd=openSync(this.file,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|(constants.O_NOFOLLOW||0),0o600);if(!fstatSync(fd).isFile())throw new Error('invalid file');writeSync(fd,text);
    }catch{this.dropped++;this.retryAt=Date.now()+60000;try{this.onError('[HTTP 日志] 写入暂时失败，服务继续处理请求。');}catch{}}
    finally{if(fd!==undefined)closeSync(fd);}
  }
}
