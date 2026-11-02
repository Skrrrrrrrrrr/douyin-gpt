import {readStoredFile as readFileSync, storedExists as existsSync, storedReadDir as readdirSync} from './storage.mjs';
import {groupSummary,applyGroupAction} from './group-chats.mjs';
import {replyContacts} from './reply-audience.mjs';
import {saveProgramme} from './programme-config.mjs';
import {Storylines} from './storylines.mjs';
import {PublicEvents} from './public-events.mjs';
import http from 'node:http';
import {writeFileSync, statSync, createReadStream, realpathSync} from 'node:fs';
import {join,resolve,extname} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT,loadEnv,homePath,readConfig,validateConfig,dayKey,modelConfig,PROVIDERS,providerBrowse,providerEngagement} from './config.mjs';
import {Store,atomicJson,takeLock} from './store.mjs';
import {CommentStore} from './comment-store.mjs';
import {ConversationMemory} from './memory.mjs';
import {Health} from './health.mjs';
import {Audience} from './audience.mjs';
import {Takeover} from './takeover.mjs';
import {Interests,validTopic} from './interests.mjs';
import {Analytics} from './analytics.mjs';
import {UsageMeter,PRICES} from './usage.mjs';
import {StickerLibrary} from './stickers.mjs';
import {seriesEpisodes} from './series.mjs';
import {readState} from './state-file.mjs';
import {Browser} from './browser.mjs';
import {modernDashboardState,applyContactPatch} from './dashboard-extensions.mjs';
import {Reviews} from './reviews.mjs';
import {VoiceCards} from './voice-cards.mjs';
import {Backups} from './backups.mjs';
import {installService,uninstallService,serviceDesired,endMaintenance} from './service-control.mjs';
import {OfficialClient} from './official.mjs';
import {mediaHash} from './episode-review.mjs';
import {outgoingParts} from './delivery-state.mjs';
import {Douyin} from './douyin.mjs';
import {DashboardAuth,authBody} from './dashboard-auth.mjs';
import {sendInfo} from './send-diagnostics.mjs';
import {prepareDashboardCors} from './dashboard-origins.mjs';
import {dashboardNetwork,dashboardRequestOrigin,dashboardUrl} from './dashboard-network.mjs';
import {ServiceLogs,HttpRequestLogs,logQuery} from './service-logs.mjs';
import {recoverySummary,ChannelRecovery} from './recovery.mjs';
import {LoginRecovery} from './login-recovery.mjs';
const safeText=x=>String(x||'').replace(/sk-[A-Za-z0-9_-]+/g,'[已隐藏]').replace(/(?:\/Users\/|\/var\/|\/tmp\/)[^\n"']+/g,'[本机文件]');
const pick=(o,keys)=>Object.fromEntries(keys.map(k=>[k,o?.[k]]));
function streamFile(file,res,options){const stream=createReadStream(file,options);stream.on('error',()=>{if(!res.headersSent)json(res,404,{error:'文件暂时无法读取'});else res.destroy();});stream.pipe(res);}
const exec=promisify(execFile),read=(p,fallback)=>{try{return JSON.parse(readFileSync(p,'utf8'));}catch(error){if(error.code?.startsWith('STORAGE_'))throw error;return fallback;}};
const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
export function applyDashboardPatch(cfg,patch){
 cfg=structuredClone(cfg);
 const allowed={videoAnalysis:['enabled'],tokenEfficiency:['enabled'],browse:['enabled','videosPerDay'],reply:['enabled','audience','friends','groups','routing','takeover','media','stickers','delivery','collaboration','voiceCards','usageContext'],engagement:['enabled','commentsPerDay','repliesPerDay'],deepseek:['enabled','browse','engagement'],memory:['enabled'],understanding:['enabled','ocr'],monitor:['notify'],video:['voiceProfiles','hour','show','animation','series','production','weekly','narrative'],audience:['enabled','autoSelect'],analytics:['enabled'],discovery:['enabled','topics','profiles','fallbackToFeed'],budget:['enabled','limitsUSD','prices'],review:['private','comments','videos'],service:['enabled'],backup:['enabled','keep']};
 for(const [section,value]of Object.entries(patch)){
  if(!allowed[section]||!value||typeof value!=='object'||Array.isArray(value))throw new Error('设置字段不允许');
  for(const key of Object.keys(value))if(!allowed[section].includes(key))throw new Error('设置字段不允许');
  if(section==='deepseek')for(const key of ['browse','engagement'])if(value[key])for(const k of Object.keys(value[key]))if(!(key==='browse'?['videosPerDay']:['commentsPerDay','repliesPerDay']).includes(k))throw new Error('DeepSeek 设置字段不允许');
  if(section==='reply'&&value.routing)for(const k of Object.keys(value.routing))if(!['enabled','deepseekKeyword'].includes(k))throw new Error('路由字段不允许');
  if(section==='video'&&value.voiceProfiles)for(const k of Object.keys(value.voiceProfiles))if(!PROVIDERS.includes(k))throw new Error('音色角色不允许');
  if(section==='video'&&value.hour!==undefined&&![21,22,23].includes(value.hour))throw new Error('晚间发布时间请选择 21、22 或 23 点');
  if(section==='video'&&value.show){if(!value.show||typeof value.show!=='object'||Array.isArray(value.show)||Object.keys(value.show).some(k=>!['enabled','format'].includes(k)))throw new Error('节目设置字段不允许');}
  const nestedRules=section==='video'?{series:['enabled','maxEpisodes','catchphrases'],production:['enabled','camera','cards','music','musicVolume'],weekly:['enabled'],narrative:['enabled','audienceQA','followups','growth']}:section==='reply'?{friends:['syncSeconds'],groups:['enabled','cooldownSeconds','maxChars'],takeover:['enabled','minutes'],media:['enabled','maxBytes'],stickers:['mode','enabled','unlimited','perContactPerDay','cooldownMinutes'],delivery:['enabled','textWithSticker'],collaboration:['enabled'],voiceCards:['enabled','reviewBeforeSend'],usageContext:['enabled','audience','contacts','groups']}:section==='budget'?{limitsUSD:PROVIDERS}:{};
  for(const [key,keys]of Object.entries(nestedRules))if(value[key]!==undefined){if(!value[key]||typeof value[key]!=='object'||Array.isArray(value[key])||Object.keys(value[key]).some(k=>!keys.includes(k)))throw new Error('新增功能设置字段不允许');}
  if(value.series?.catchphrases&&Object.keys(value.series.catchphrases).some(k=>!PROVIDERS.includes(k)))throw new Error('角色设置字段不允许');
  const previous=cfg[section];cfg[section]={...previous,...value};
  if(section==='discovery'&&value.profiles!==undefined){if(!value.profiles||typeof value.profiles!=='object'||Array.isArray(value.profiles))throw new Error('兴趣档案格式无效');cfg.discovery.profiles={...previous.profiles,...value.profiles};}
  for(const key of (section==='deepseek'?['browse','engagement']:section==='reply'?['friends','groups','routing','takeover','media','stickers','delivery','collaboration','voiceCards','usageContext']:section==='video'?['voiceProfiles','show','series','production','weekly','narrative']:section==='budget'?['limitsUSD','prices']:[]))if(value[key]){if(typeof value[key]!=='object'||Array.isArray(value[key]))throw new Error('嵌套设置格式无效');cfg[section][key]={...previous[key],...value[key]};}
  if(section==='reply'&&value.groups?.enabled===true&&!previous.groups?.enabled)cfg.reply.groups.enabledAt=new Date().toISOString();
  if(section==='reply'&&value.audience==='friends'&&previous.audience!=='friends')cfg.reply.friends.enabledAt=new Date().toISOString();
  if(section==='video'&&value.series?.catchphrases)cfg.video.series.catchphrases={...previous.series.catchphrases,...value.series.catchphrases};
 }
 if(patch.video?.series?.catchphrases)cfg.video.series.catchphrases={...cfg.video.series.catchphrases,...patch.video.series.catchphrases};
 return validateConfig(cfg);
}
export async function dashboardState(home){
 const cfg=readConfig(home),store=new Store(home),comments=new CommentStore(home),health=new Health(home),day=dayKey();
 let daemon={running:false};try{daemon=JSON.parse((await exec(process.execPath,[join(ROOT,'scripts/background.mjs'),'status'],{cwd:ROOT,env:{...process.env,DOUYIN_GPT_HOME:home},timeout:5000})).stdout);}catch{}
 const video=read(join(home,'video',day,'episode.json'),null),preview=read(join(home,'show-preview','video',day,'episode.json'),null),plan=read(join(home,'video',day,'replacement-plan.json'),null);
 let memory=[];try{const m=new ConversationMemory(home,cfg);memory=replyContacts(home,cfg).map(c=>({id:c.secUid,label:c.label,facts:m.facts(c.secUid)}));}catch(error){health.alert('memory-file','长期记忆不可读',error.message);}
 const providers=PROVIDERS.map(p=>{const browse=providerBrowse(cfg,p),engagement=providerEngagement(cfg,p);return {id:p,name:p==='openai'?'GPT':'DeepSeek',model:safeText(modelConfig(p).model),videos:store.videoCount(day,p),videoLimit:browse.videosPerDay,comments:comments.count('comment',day,p),commentLimit:engagement.commentsPerDay,replies:comments.count('reply',day,p),replyLimit:engagement.repliesPerDay,voice:cfg.video.voiceProfiles[p]||cfg.video.voices[p],enabled:p==='openai'||cfg.deepseek.enabled};});
 const safeVideo=v=>v?{day:v.day,status:v.status,title:v.title,cutoff:v.data?.cutoff,voiceProfiles:v.voiceProfiles,duration:v.renderInfo?.duration,renderedAt:v.renderedAt,review:v.review?{...pick(v.review,['status','checkedAt','publicVisible','publishedAt']),reason:safeText(v.review.reason)}:null,publishAt:v.scheduledAt||v.replaces?.scheduledAt||'',note:safeText(v.note||''),ready:existsSync(v.videoPath||'')}:null;
 return {...await modernDashboardState(home,cfg),recovery:recoverySummary(home,cfg,daemon,serviceDesired(home)),day,account:cfg.account.douyinId,providers,daemon:{running:daemon.running,stopping:daemon.stopping},totalVideos:providers.reduce((n,p)=>n+p.videos,0),privateReplies:outgoingParts(store.data.outbox).filter(o=>o.recipientKind!=='group'&&o.day===day&&o.status==='sent').length,video:safeVideo(video),preview:safeVideo(preview),plan:plan?{stage:plan.stage,originalScheduledAt:plan.originalScheduledAt}:null,
  interestProfiles:Object.fromEntries(PROVIDERS.map(provider=>[provider,new Interests(home,cfg).snapshot(provider)])),
  alerts:health.read().alerts.filter(a=>!a.resolvedAt).slice(-8).reverse().map(a=>({...pick(a,['id','key','severity','createdAt','occurrences']),title:safeText(a.title),message:safeText(a.message)})),memory,job:(()=>{const j=read(join(home,'dashboard-job.json'),null);return j?{...pick(j,['status','startedAt','finishedAt']),log:safeText(j.log)}:null;})(),
  stickers:new StickerLibrary(home,cfg).all().map(({id,provider,emotion,label,format,bytes,available,transport,shared})=>({id,provider,emotion,label,format,bytes,available,transport,shared})),stickerStats:replyContacts(home,cfg).map(c=>({label:c.label,...new StickerLibrary(home,cfg).status(store.data.outbox,c.secUid)})),audience:new Audience(home).list().slice(-100).reverse(),series:seriesEpisodes(home),takeovers:replyContacts(home,cfg).map(c=>({id:c.secUid,label:c.label,...new Takeover(home,cfg).get(c.secUid)})),interests:new Interests(home,cfg).list(),discovery:readState(home,'discovery-preview.json',{version:1,query:'',videos:[]}),analytics:new Analytics(home,cfg).summary(),usage:new UsageMeter(home).summary(),prices:PRICES,
  settings:{videoAnalysis:pick(cfg.videoAnalysis,['enabled','model','sampleIntervalSeconds']),tokenEfficiency:pick(cfg.tokenEfficiency,['enabled']),review:cfg.review,service:cfg.service,backup:cfg.backup,audience:cfg.audience,analytics:cfg.analytics,discovery:cfg.discovery,budget:cfg.budget,browse:pick(cfg.browse,['enabled','videosPerDay']),reply:{groups:pick(cfg.reply.groups,['enabled','cooldownSeconds','maxChars']),perContactPerDay:cfg.reply.perContactPerDay,totalPerDay:cfg.reply.totalPerDay,audience:cfg.reply.audience,friends:{syncSeconds:cfg.reply.friends.syncSeconds},maxChars:cfg.reply.maxChars,enabled:cfg.reply.enabled,delivery:cfg.reply.delivery,collaboration:cfg.reply.collaboration,voiceCards:cfg.reply.voiceCards,usageContext:cfg.reply.usageContext,routing:pick(cfg.reply.routing,['enabled','deepseekKeyword']),takeover:cfg.reply.takeover,media:cfg.reply.media,stickers:pick(cfg.reply.stickers,['mode','enabled','unlimited','perContactPerDay','cooldownMinutes'])},engagement:pick(cfg.engagement,['enabled','commentsPerDay','repliesPerDay']),deepseek:{enabled:cfg.deepseek.enabled,browse:pick(cfg.deepseek.browse,['videosPerDay']),engagement:pick(cfg.deepseek.engagement,['commentsPerDay','repliesPerDay'])},understanding:pick(cfg.understanding,['enabled','ocr']),memory:pick(cfg.memory,['enabled','maxFacts','retentionDays']),monitor:pick(cfg.monitor,['enabled','notify']),video:{weekly:cfg.video.weekly,hour:cfg.video.hour,voiceProfiles:pick(cfg.video.voiceProfiles,PROVIDERS),show:pick(cfg.video.show,['enabled','format']),animation:cfg.video.animation,series:cfg.video.series,production:cfg.video.production}},
  videos:store.data.videos.slice(-150).reverse().map(v=>({id:v.id,desc:v.desc,author:v.author,provider:v.provider||'openai',day:v.day,discoveryTopic:v.discoveryTopic||'',watchedAt:v.watchedAt,analysis:v.analysis})),
  groupChats:groupSummary(home,cfg,store),groupReplies:store.data.outbox.filter(o=>o.recipientKind==='group').slice(-60).reverse().map(o=>({id:o.id,label:o.label,provider:o.provider,model:o.model,text:o.text,status:o.status,kind:'group_text',sendInfo:sendInfo(o),createdAt:o.createdAt,failureCode:o.failureCode||''})),
  replies:store.data.outbox.filter(o=>o.recipientKind!=='group').slice(-50).reverse().map(o=>({id:o.id,label:o.label,provider:o.provider||'openai',model:o.model,text:o.text,kind:o.kind||'text',sticker:o.sticker?{id:o.sticker.id,label:o.sticker.label}:null,status:o.status,sendInfo:sendInfo(o),createdAt:o.createdAt,contributors:o.contributors||[],steps:(o.steps||[]).map(s=>({kind:s.kind,status:s.status,text:s.kind==='text'?s.text:'',mediaId:s.sticker?.id||s.card?.id||'',label:s.sticker?.label||'',sendInfo:sendInfo(s)}))})),
  comments:comments.data.actions.slice(-40).reverse().map(a=>({id:a.id,kind:a.kind,provider:a.provider||'openai',text:a.text,status:a.status,sendInfo:sendInfo(a),videoId:a.videoId,createdAt:a.createdAt})),updatedAt:new Date().toISOString()};
}
export function createDashboard(home,{port=3146,host,publicUrl,authOptions,recoveryOptions}={}){
 const settings=readConfig(home).dashboard,network=dashboardNetwork({host:host??process.env.DOUYIN_DASHBOARD_HOST??settings.host??'127.0.0.1',publicUrl:publicUrl??process.env.DOUYIN_DASHBOARD_URL??settings.publicUrl??''});
 const loginRecovery=new LoginRecovery(home,recoveryOptions);
 const auth=new DashboardAuth(home,authOptions),health=new Health(home,{notify:readConfig(home).monitor.notify}),logs=new ServiceLogs(home),requestLogs=new HttpRequestLogs(home);let changing=false,child=null;
 const bg=async(command,keep=false,internal=false)=>exec(process.execPath,[join(ROOT,'scripts/background.mjs'),command,...(keep?['--keep-browser']:[]),...(internal?['--maintenance']:[])],{cwd:ROOT,env:{...process.env,DOUYIN_GPT_HOME:home},timeout:65000});
 const server=http.createServer(async(req,res)=>{requestLogs.track(req,res);try{
  const port=server.address().port,origin=dashboardRequestOrigin(req,port,network);if(!origin)return json(res,403,{error:'管理服务地址不匹配，请检查公开地址配置'});
  const url=new URL(req.url,origin),secure=origin.startsWith('https:');
  res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','no-referrer');res.setHeader('cross-origin-resource-policy','same-origin');
  res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
  const cors=prepareDashboardCors(req,res,home,origin);if(!cors.allowed)return json(res,403,{error:'来源不允许'});if(cors.preflight)return;
  const authRequest=cors.remote?{headers:{authorization:req.headers.authorization}}:req;
  const session=auth.session(authRequest,port),authenticated=!!session&&!session.mustChangePassword;
  const sessionData=(s,expose=false)=>({authenticated:!!s,username:s?.username||'',mustChangePassword:s?.mustChangePassword||false,expiresAt:s?.expiresAt||null,...(expose&&s?.token?{accessToken:s.token}:{})});
  if(url.pathname==='/api/auth/session'&&req.method==='GET')return json(res,200,sessionData(session));
  if(url.pathname==='/api/auth/login'&&req.method==='POST'){
   const body=await authBody(req),loggedIn=await auth.login(body.username,body.password);
   if(!cors.remote)res.setHeader('set-cookie',auth.cookie(port,loggedIn.token,{secure}));return json(res,200,sessionData(loggedIn,cors.remote));
  }
  if(url.pathname==='/api/auth/logout'&&req.method==='POST'){
   await authBody(req);auth.logout(authRequest,port);if(!cors.remote)res.setHeader('set-cookie',auth.clearCookie(port,{secure}));return json(res,200,{ok:true});
  }
  if(url.pathname==='/api/auth/password'&&req.method==='POST'){
   if(!session)return json(res,401,{error:'请先登录',code:'AUTH_REQUIRED'});
   const body=await authBody(req),updated=await auth.changePassword(body.currentPassword,body.newPassword);
   if(!cors.remote)res.setHeader('set-cookie',auth.cookie(port,updated.token,{secure}));return json(res,200,sessionData(updated,cors.remote));
  }
  if(url.pathname==='/login'&&req.method==='GET'){
   if(authenticated&&url.searchParams.get('password')!=='change'){res.writeHead(303,{location:'/'});res.end();return;}
   res.setHeader('content-security-policy',"default-src 'none'; base-uri 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'");
   res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(readFileSync(join(ROOT,'web/login.html')));return;
  }
  const loginAssets={'/brand/liuzuo-mark.png':'image/png','/brand/liuzuo-illustration.png':'image/png','/brand/logo.svg':'image/svg+xml','/brand/logo.png':'image/png','/fonts/outfit-variable.ttf':'font/ttf','/login.css':'text/css','/login.js':'text/javascript','/fonts/dm-sans-400.ttf':'font/ttf','/fonts/dm-sans-600.ttf':'font/ttf'};
  loginAssets['/connection.js']='text/javascript';
  if(req.method==='GET'&&Object.hasOwn(loginAssets,url.pathname)){
   res.writeHead(200,{'content-type':loginAssets[url.pathname]});streamFile(join(ROOT,'web',url.pathname.slice(1)),res);return;
  }
  if(req.method==='GET'&&['/login-gpt.png','/login-deepseek.png'].includes(url.pathname)){
   res.writeHead(200,{'content-type':'image/png'});streamFile(join(ROOT,'assets/hosts',url.pathname==='/login-gpt.png'?'gpt.png':'deepseek.png'),res);return;
  }
  if(!authenticated){
   if(url.pathname==='/'&&req.method==='GET'){res.writeHead(303,{location:'/login'});res.end();return;}
   return json(res,401,{error:session?'请先修改初始密码':'请先登录后台管理',code:session?'PASSWORD_CHANGE_REQUIRED':'AUTH_REQUIRED'});
  }
  if(url.pathname==='/'&&req.method==='GET'){
   res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(readFileSync(join(ROOT,'web/index.html')));return;
  }
  if(['/app.js','/features.js','/interest-profiles.js','/modern.js','/style.css','/fonts/dm-sans.woff2',...['400','500','600','700'].flatMap(w=>['ttf','woff2'].map(e=>`/fonts/dm-sans-${w}.${e}`))].includes(url.pathname)){
   const file=join(ROOT,'web',url.pathname.slice(1));if(!existsSync(file))return json(res,404,{error:'静态文件不存在'});const type=url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.ttf')?'font/ttf':'font/woff2';res.writeHead(200,{'content-type':type,'cache-control':'no-cache'});streamFile(file,res);return;
  }
  if(url.pathname.startsWith('/host/')){const name=url.pathname.slice(6);if(!['gpt.png','deepseek.png'].includes(name))return json(res,404,{error:'未找到角色'});res.writeHead(200,{'content-type':'image/png'});streamFile(join(ROOT,'assets/hosts',name),res);return;}
  if(url.pathname==='/api/logs'&&req.method==='GET')return json(res,200,logs.read(logQuery(url.searchParams)));
  if(url.pathname==='/api/logs/download'&&req.method==='GET'){
   const query=logQuery(url.searchParams);if(query.after||query.before)throw Object.assign(new Error('下载不接受日志游标'),{status:400});const output=logs.download(query);
   res.writeHead(200,{'content-type':'text/plain; charset=utf-8','content-disposition':`attachment; filename="${output.filename}"`,'cache-control':'no-store'});res.end(output.text);return;
  }
  if(url.pathname==='/api/state'&&req.method==='GET')return json(res,200,await dashboardState(home));
  if(url.pathname==='/api/recovery/login'&&req.method==='GET')return json(res,200,loginRecovery.view());
  if(url.pathname==='/api/recovery/image'&&req.method==='GET'){const png=loginRecovery.screenshot();if(!png)return json(res,410,{error:'二维码已过期，请刷新'});res.writeHead(200,{'content-type':'image/png','cache-control':'no-store','content-length':png.length});res.end(png);return;}
  if(url.pathname==='/api/media'){
   res.setHeader('cache-control','no-store');
   const cfg=readConfig(home),kind=url.searchParams.get('kind'),day=url.searchParams.get('day')||dayKey();if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('日期无效');let file;
   if(kind==='sticker'){const asset=new StickerLibrary(home,cfg).all().find(a=>a.id===url.searchParams.get('id')&&a.available);file=asset?.file;}
   else if(kind==='voice-card'){file=new VoiceCards(home,cfg).asset(url.searchParams.get('id')).file;}
   else if(kind==='review-video'){const entry=new Reviews(home).list().find(r=>r.id===url.searchParams.get('id')&&r.kind==='episode'&&!r.payload.requiresRender);if(entry){const state=read(join(home,'video',entry.payload.day,'episode.json'));if(state?.fingerprint===entry.payload.fingerprint&&mediaHash(state.videoPath)===entry.payload.sha256)file=state.videoPath;}}
   else if(kind==='voice'){const id=url.searchParams.get('id');if(!/^[A-D]$/.test(id||''))throw new Error('音色无效');file=join(cfg.video.outputDir,'voice-samples',`${id}.wav`);}
   else if(kind==='video'||kind==='cover'){const state=read(join(home,'video',day,'episode.json'),null);file=kind==='video'?state?.videoPath:state?.coverPath;}
   else if(kind==='preview'||kind==='preview-cover'){const state=read(join(home,'show-preview','video',day,'episode.json'),null);file=kind==='preview'?state?.videoPath:state?.coverPath;}
   if(!file||!existsSync(file))return json(res,404,{error:'文件尚未生成'});
   if(!realpathSync(file).startsWith(realpathSync(kind==='sticker'?(file.startsWith(join(home,'native-stickers')+'/')?join(home,'native-stickers'):join(ROOT,'assets','stickers')):kind==='voice-card'?join(home,'voice-cards'):(cfg.video.outputDir||join(home,'video-output')))+'/'))throw new Error('文件不在输出目录');
   const stat=statSync(file);if(!stat.isFile()||!['.mp4','.wav','.png','.jpg','.jpeg','.gif'].includes(extname(file)))throw new Error('媒体文件类型无效');const size=stat.size,type=extname(file)==='.mp4'?'video/mp4':extname(file)==='.wav'?'audio/wav':extname(file)==='.gif'?'image/gif':['.jpg','.jpeg'].includes(extname(file))?'image/jpeg':'image/png',range=req.headers.range;
   if(range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);if(!m)return json(res,416,{error:'范围无效'});const start=Number(m[1]),end=m[2]?Math.min(Number(m[2]),size-1):size-1;if(start>end||start>=size)return json(res,416,{error:'范围无效'});res.writeHead(206,{'content-type':type,'content-range':`bytes ${start}-${end}/${size}`,'accept-ranges':'bytes','content-length':end-start+1});streamFile(file,res,{start,end});}else{res.writeHead(200,{'content-type':type,'content-length':size,'accept-ranges':'bytes'});streamFile(file,res);}return;
  }
  if(url.pathname==='/api/backup-file'){const file=new Backups(home).file(url.searchParams.get('id'));res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename=encrypted-backup.dybackup','cache-control':'no-store'});streamFile(file,res);return;}
  if(url.pathname==='/api/backup-key'){const backup=new Backups(home);backup.key();res.writeHead(200,{'content-type':'application/json','content-disposition':'attachment; filename=douyin-recovery-key.json','cache-control':'no-store'});res.end(readFileSync(join(home,'backup-key.json')));return;}
  if(req.method!=='POST')return json(res,404,{error:'未找到该操作'});
  let raw='';for await(const part of req){raw+=part;if(raw.length>32768)throw new Error('请求过大');}const body=raw?JSON.parse(raw):{};
  if(url.pathname==='/api/recovery/login'){
   if(changing||child)return json(res,409,{error:'后台正在维护，请稍后再处理登录'});
   changing=true;try{const result=await loginRecovery.execute(body.action,body);return json(res,200,result);}finally{changing=false;}
  }
  if(url.pathname==='/api/recovery/channel'){if(changing)return json(res,409,{error:'后台正在维护'});changing=true;try{return json(res,200,await new ChannelRecovery(home).check(body.key,readConfig(home)));}finally{changing=false;}}
  if(url.pathname==='/api/config'||url.pathname==='/api/contact'||url.pathname==='/api/backup/restore'){
   if(changing)return json(res,409,{error:'设置正在保存，请稍后'});changing=true;let restart=false,release;
   try{const before=readConfig(home),contactEdit=url.pathname==='/api/contact',restore=url.pathname==='/api/backup/restore',patch=c=>contactEdit?applyContactPatch(c,body,home):restore?c:applyDashboardPatch(c,body),candidate=patch(before);if(!restore&&JSON.stringify(candidate)===JSON.stringify(before))return json(res,200,{saved:true,restarted:false,noChange:true});restart=JSON.parse((await bg('status')).stdout).running;health.maintenance();if(restart)await bg('stop',true,true);release=takeLock(home);if(restore)new Backups(home).restore(body.id,body.proof);else{const cfg=patch(readConfig(home));atomicJson(join(home,'config.json'),cfg);}release();release=null;if(restart&&serviceDesired(home).worker)await bg('start',false,true);else endMaintenance(home);return json(res,200,{saved:true,restarted:restart});}
   finally{release?.();if(restart&&serviceDesired(home).worker){try{const alive=JSON.parse((await bg('status')).stdout).running;if(!alive)await bg('start',false,true);}catch{}}changing=false;}
  }
  if(url.pathname==='/api/daemon'){if(changing)return json(res,409,{error:'运行设置正在更新，请稍后'});if(!['start','stop'].includes(body.action))throw new Error('操作无效');changing=true;try{health.maintenance();await bg(body.action,body.action==='stop');return json(res,200,{ok:true});}finally{changing=false;}}
  if(url.pathname==='/api/reviews'){
   const queue=new Reviews(home),entry=queue.list().find(r=>r.id===body.id);if(!entry)throw new Error('未找到草稿');
   if(body.action==='approve')queue.approve(body.id,body.hash);
   else if(body.action==='cancel')queue.cancel(body.id);
   else if(body.action==='edit'){const cfg=readConfig(home),max=entry.kind==='private'?cfg.reply.maxChars:entry.kind==='comment'?providerEngagement(cfg,entry.payload.provider).maxChars:4000;if(typeof body.text!=='string'||!body.text.trim()||[...body.text].length>max||entry.kind==='private'&&!entry.payload.plan.steps.some(s=>['text','voice_card'].includes(s.kind)))throw new Error('草稿文字无效或超出字数限制');queue.edit(body.id,body.revision,body.text);}
   else if(body.action==='rebuild'){if(child)throw new Error('媒体任务正在进行');if(entry.status!=='pending'||!entry.payload.requiresRender)throw new Error('没有待重做媒体');child=spawn(process.execPath,[join(ROOT,'scripts/rebuild-draft.mjs'),body.id],{cwd:ROOT,env:{...process.env,DOUYIN_GPT_HOME:home},stdio:['ignore','ignore','pipe']});const job={status:'running',startedAt:new Date().toISOString(),log:'正在制作审核媒体'};atomicJson(join(home,'dashboard-job.json'),job);child.stderr.on('data',b=>{job.log=safeText(b.toString()).slice(-2000);});child.on('error',e=>{job.log=safeText(e.message);});child.on('close',code=>{job.status=code===0?'done':'failed';job.finishedAt=new Date().toISOString();atomicJson(join(home,'dashboard-job.json'),job);child=null;});}
   else throw new Error('草稿操作无效');return json(res,200,{ok:true});
  }
  if(url.pathname==='/api/service'){if(!['install','uninstall'].includes(body.action))throw new Error('启动项操作无效');const result=await(body.action==='install'?installService(home):uninstallService(home));return json(res,200,result);}
  if(url.pathname==='/api/backup'){const b=new Backups(home);if(body.action==='create')return json(res,200,b.create());if(body.action==='plan')return json(res,200,b.proof(body.id));throw new Error('备份操作无效');}
  if(url.pathname==='/api/official'){const client=new OfficialClient(home,readConfig(home));if(body.action==='authorize')return json(res,200,client.authorize());if(body.action==='exchange')return json(res,200,await client.exchange(body.callback));if(body.action==='refresh')return json(res,200,await client.refresh());throw new Error('官方接入操作无效');}
  if(url.pathname==='/api/story/settings'){return json(res,200,{saved:true,settings:saveProgramme(home,body)});}
  if(url.pathname==='/api/story/thread'){if(body.action!=='archive')throw new Error('回访操作无效');new Storylines(home,readConfig(home)).archive(body.id);return json(res,200,{ok:true});}
  if(url.pathname==='/api/story/event'){new PublicEvents(home).setEnabled(body.id,body.enabled);return json(res,200,{ok:true});}
  if(url.pathname==='/api/memory/forget'){new ConversationMemory(home,readConfig(home)).forget(body.contactId,body.id);return json(res,200,{ok:true});}
  if(url.pathname==='/api/alerts/resolve'){health.resolve(body.id);return json(res,200,{ok:true});}
  if(url.pathname==='/api/audience'){const a=new Audience(home);const item=body.id?a.set(body.id,body.status):a.add(body.text);return json(res,200,{ok:true,item});}
  if(url.pathname==='/api/takeover'){const h=new Takeover(home,readConfig(home));if(body.action==='resume')h.resume(body.contactId);else if(body.action==='pause')h.pause(body.contactId,body.minutes??readConfig(home).reply.takeover.minutes);else throw new Error('接管操作无效');return json(res,200,{ok:true});}
  if(url.pathname==='/api/interests/feedback'){const cfg=readConfig(home),video=new Store(home).data.videos.find(v=>v.id===body.id),topics=new Interests(home,cfg).feedback(video,body.vote,body.provider??video?.provider??'openai');return json(res,200,{ok:true,topics});}
  if(url.pathname==='/api/groups'){
   if(changing||child)throw new Error('后台正在处理其他任务，请稍后');changing=true;let running=false,release;
   try{running=JSON.parse((await bg('status')).stdout).running;health.maintenance();if(running)await bg('stop',true,true);release=takeLock(home);const result=applyGroupAction(home,readConfig(home),new Store(home),body);return json(res,200,result);}
   finally{release?.();try{if(running&&serviceDesired(home).worker)await bg('start',false,true);else endMaintenance(home);}finally{changing=false;}}
  }
  if(url.pathname==='/api/friends/sync'||url.pathname==='/api/groups/sync'){
   if(changing||child)throw new Error('后台正在处理其他任务，请稍后');changing=true;let running=false;
   try{running=JSON.parse((await bg('status')).stdout).running;health.maintenance();if(running)await bg('stop',true,true);const result=await exec(process.execPath,[join(ROOT,'scripts',url.pathname==='/api/groups/sync'?'groups.mjs':'friends.mjs')],{cwd:ROOT,env:{...process.env,DOUYIN_GPT_HOME:home},timeout:180000,maxBuffer:1000000});return json(res,200,{synced:true,...JSON.parse(result.stdout)});}
   finally{try{if(running&&serviceDesired(home).worker)await bg('start',false,true);else endMaintenance(home);}finally{changing=false;}}
  }
  if(url.pathname==='/api/stickers/sync-native'){
   if(changing||child)throw new Error('后台正在处理其他任务，请稍后');changing=true;let running=false;
   try{running=JSON.parse((await bg('status')).stdout).running;health.maintenance();if(running)await bg('stop',true,true);const result=await exec(process.execPath,[join(ROOT,'scripts/stickers.mjs'),'sync-native'],{cwd:ROOT,env:{...process.env,DOUYIN_GPT_HOME:home},timeout:180000,maxBuffer:1000000});const items=JSON.parse(result.stdout);return json(res,200,{synced:true,count:items.length});}
   finally{try{if(running&&serviceDesired(home).worker)await bg('start',false,true);else endMaintenance(home);}finally{changing=false;}}
  }
  if(url.pathname==='/api/discovery/search'){
   if(changing)throw new Error('后台正在更新，请稍后');if(!validTopic(body.query))throw new Error('搜索词无效');const channels=new ChannelRecovery(home);channels.isolateSearch();if(channels.blocked('discovery-search'))return json(res,409,{code:'PAGE_VERIFICATION',error:'视频搜索等待本人验证，请完成验证后检查恢复；推荐流独立运行。'});changing=true;let running=false,release,browser;
   try{running=JSON.parse((await bg('status')).stdout).running;health.maintenance();if(running)await bg('stop',true,true);release=takeLock(home);const cfg=readConfig(home);browser=new Browser(home,cfg.browser);await browser.start();const dy=new Douyin(home,browser);await dy.checkAccount(cfg.account);const videos=await dy.search(body.query,{limit:3});channels.clear('discovery-search');atomicJson(join(home,'discovery-preview.json'),{version:1,query:body.query,videos,at:new Date().toISOString()});return json(res,200,{ok:true,count:videos.length});}
   catch(error){if(error.code==='PAGE_VERIFICATION'&&error.pageKind==='discovery'){channels.fail('discovery-search',error);channels.refreshAlerts({notify:readConfig(home).monitor?.notify,force:true});}const previous=readState(home,'discovery-preview.json',{version:1,query:'',videos:[]});atomicJson(join(home,'discovery-preview.json'),{...previous,attemptedQuery:body.query,error:safeText(error.message),attemptedAt:new Date().toISOString()});throw error;}
   finally{browser?.disconnect();release?.();try{if(running&&serviceDesired(home).worker)await bg('start',false,true);else endMaintenance(home);}finally{changing=false;}}
  }
  if(url.pathname==='/api/preview'){
   if(child)return json(res,409,{error:'正在制作预览，请等待'});const job={status:'running',startedAt:new Date().toISOString(),log:''};atomicJson(join(home,'dashboard-job.json'),job);
   child=spawn(process.execPath,[join(ROOT,'scripts/preview-show.mjs'),...(body.weekly===true?['--weekly']:[]),...(body.narrative===true?['--narrative']:[])],{cwd:ROOT,env:{...process.env,DOUYIN_GPT_HOME:home},stdio:['ignore','pipe','pipe']});
   const data=b=>{job.log=(job.log+b.toString()).slice(-5000);atomicJson(join(home,'dashboard-job.json'),job);};child.stdout.on('data',data);child.stderr.on('data',data);
   child.on('error',e=>data(e.message));child.on('close',code=>{job.status=code===0?'done':'failed';job.finishedAt=new Date().toISOString();atomicJson(join(home,'dashboard-job.json'),job);child=null;if(code!==0)health.alert('preview-failed','晚报预览制作失败','请在控制台查看制作记录');else health.resolve('preview-failed');});return json(res,202,{started:true});
  }
  return json(res,404,{error:'未找到该操作'});
 }catch(error){requestLogs.error(res,error);if(error.retryAfter)res.setHeader('retry-after',String(error.retryAfter));json(res,error.status||(['MEMORY_CONFLICT','STATE_BUSY'].includes(error.code)?409:400),{error:safeText(error.message),...(error.code?{code:error.code}:{})});}});
 const monitor=setInterval(async()=>{try{const cfg=readConfig(home);health.notify=cfg.monitor.notify;const meta=read(join(home,'daemon.json'),null);if(meta&&!meta.stoppingAt){let alive=true;try{process.kill(meta.pid,0);}catch{alive=false;}if(!alive&&!health.read().alerts.some(a=>a.key==='worker-error'&&!a.resolvedAt))health.alert('worker-stopped','后台意外停止','浏览和回复进程没有运行，请在控制台重新启动');}const day=dayKey(),record=read(join(home,'video',day,'episode.json'),null),at=record?.replaces?.scheduledAt||`${day} ${String(cfg.video.hour).padStart(2,'0')}:${String(cfg.video.minute).padStart(2,'0')}`;const due=Date.parse(at.replace(' ','T')+':00+08:00');if(cfg.video.enabled&&Date.now()>due+10*60000&&(!record||['rendered','scripted','audio_ready','prepared','uploading'].includes(record.status)))health.alert(`video-missed:${day}`,'今晚晚报尚未提交','已超过计划时间，请查看晚报任务与制作记录');}catch{}},30000);monitor.unref();server.on('close',()=>clearInterval(monitor));
 return {server,network,listen:()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,network.host,()=>resolve(server.address()));})};
}
if(process.argv[1]===join(ROOT,'src/dashboard.mjs')){
 loadEnv();const home=homePath(),cfg=readConfig(home),app=createDashboard(home,{port:cfg.dashboard.port});
 app.listen().then(address=>{const url=dashboardUrl(app.network,address.port);atomicJson(join(home,'dashboard-runtime.json'),{pid:process.pid,runtimeId:process.argv[2]||'',port:address.port,host:app.network.host,url,startedAt:new Date().toISOString()});console.log(`控制台：${url}`);}).catch(e=>{console.error(e.message);process.exitCode=1;});
}
