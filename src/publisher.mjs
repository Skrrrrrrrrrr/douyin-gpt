import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson} from './store.mjs';
import {dayKey} from './config.mjs';
import {journalDay} from './journal.mjs';
import {Douyin} from './douyin.mjs';
import {sleep} from './browser.mjs';

export function publisherSnapshotInPage(){
 const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';};
 const normalize=t=>String(t||'').replace(/[\u200b\ufeff]/g,'').trim();
 const title=document.querySelector('input[placeholder="填写作品标题，为作品获得更多流量"]');
 const editor=[...document.querySelectorAll('[contenteditable=true]')].find(visible);
 const checks=[...document.querySelectorAll('label')].filter(visible).map(e=>({label:normalize(e.innerText),checked:!!e.querySelector('input:checked')}));
 return {url:location.href,title:title?.value||'',description:normalize(editor?.innerText),text:document.body.innerText.slice(0,20000),checks,scheduled:document.querySelector('input[placeholder="日期和时间"]')?.value||'',publishEnabled:[...document.querySelectorAll('button')].some(e=>visible(e)&&e.innerText.trim()==='发布'&&!e.disabled),links:[...document.querySelectorAll('a[href]')].map(e=>({text:normalize(e.innerText),href:e.href}))};
}
export function publisherControlInPage({text,selector}){
 const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden';};
 let es=selector?[...document.querySelectorAll(selector)]:[...document.querySelectorAll('button,label,span,div')].filter(e=>e.innerText?.trim()===text);
 es=es.filter(visible).sort((a,b)=>a.getBoundingClientRect().width*a.getBoundingClientRect().height-b.getBoundingClientRect().width*b.getBoundingClientRect().height);
 const e=es[0];if(!e)return null;e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,value:e.value??e.innerText};
}
const ev=(page,fn,arg)=>page.ev(`(${fn.toString()})(${arg===undefined?'':JSON.stringify(arg)})`);
export function validatePublishForm(snapshot,state,at){
 if(new URL(snapshot.url).origin!=='https://creator.douyin.com')throw new Error('不在抖音创作者中心');
 if(snapshot.title!==state.title||snapshot.description!==state.description)throw new Error('发布前标题或描述发生变化，保留稿件');
 if(!/作者声明[:：]\s*内容由AI生成/.test(snapshot.text))throw new Error('未核对 AI 内容声明');
 if(!snapshot.checks.some(x=>x.label==='公开'&&x.checked))throw new Error('公开可见设置无法核对');
 const mode=at?'定时发布':'立即发布';if(!snapshot.checks.some(x=>x.label===mode&&x.checked))throw new Error('发布时间模式无法核对');
 if(at&&snapshot.scheduled!==at)throw new Error('定时发布时间无法核对');
 if(!snapshot.publishEnabled)throw new Error('发布按钮未就绪');
}
export function scheduledDate(value,now=new Date()){
 if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value))throw new Error('定时发布需要 YYYY-MM-DD HH:mm（北京时间）');
 journalDay(value.slice(0,10));if(Number(value.slice(11,13))>23||Number(value.slice(14,16))>59)throw new Error('定时时间无效');
 const date=new Date(value.replace(' ','T')+':00+08:00');
 if(!Number.isFinite(date.getTime())||date-now<2*3600000||date-now>14*86400000)throw new Error('抖音定时发布需要 2 小时后、14 天内');
 return date;
}
export class Publisher{
 constructor(home,cfg,browser,{log=console.log}={}){Object.assign(this,{home,cfg,browser,log});this.dy=new Douyin(home,browser);}
 file(day){return join(this.home,'video',journalDay(day),'episode.json');}
 read(day){const state=JSON.parse(readFileSync(this.file(day),'utf8'));if(state.account?.secUid!==this.cfg.account.secUid)throw new Error('视频记录绑定的账号不一致');return state;}
 save(state){atomicJson(this.file(state.day),state);}
 async attach(){if(!this.page){this.page=await this.browser.page('publisher','https://creator.douyin.com/creator-micro/content/upload');await this.page.send('Network.enable');}return this.page;}
 async snapshot(){return ev(await this.attach(),publisherSnapshotInPage);}
 async click(options){const page=await this.attach();await page.send('Page.bringToFront');const p=await ev(page,publisherControlInPage,options);if(!p)throw new Error(`发布控件未找到：${options.text||options.selector}`);for(const type of ['mousePressed','mouseReleased'])await page.send('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});await sleep(250);return p;}
 async fill(selector,text,{replace=false}={}){
  const p=await this.click({selector}),old=String(p.value||'').replace(/[\u200b\ufeff]/g,'').trim();
  if(old===text)return;
  if(old&&!replace)throw new Error('创作者中心已有其他稿件，未覆盖');
  if(old){await this.page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:4,commands:['selectAll']});await this.page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:4});}
  await this.page.send('Input.insertText',{text});
  if(selector.includes('日期和时间'))for(const type of ['keyDown','keyUp'])await this.page.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await this.page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await this.page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await sleep(300);
 }
 async prepare(state,{at,reuseUpload=false}={}){
  await this.dy.checkAccount(this.cfg.account);const page=await this.attach();let current=await this.snapshot();
  if(at)scheduledDate(at);
  if(!reuseUpload&&current.url.includes('/content/post/video')&&(current.title||current.description))throw new Error('存在未提交的视频稿件，需先核对；本程序不会覆盖');
  if(!reuseUpload){
   await this.browser.navigate(page,'https://creator.douyin.com/creator-micro/content/upload');
   for(let i=0;i<30;i++){const ready=await page.ev(`!!document.querySelector('input[type=file]')`);if(ready)break;await sleep(500);if(i===29)throw new Error('创作者中心需要登录或页面没有上传控件');}
   state.status='uploading';state.uploadFingerprint=state.fingerprint;state.uploadStartedAt=new Date().toISOString();this.save(state);
   const {root}=await page.send('DOM.getDocument'),{nodeId}=await page.send('DOM.querySelector',{nodeId:root.nodeId,selector:'input[type=file]'});
   await page.send('DOM.setFileInputFiles',{nodeId,files:[state.videoPath]});
   for(let i=0;i<120;i++){if((await this.snapshot()).url.includes('/content/post/video'))break;await sleep(500);if(i===119)throw new Error('上传后未进入视频发布页面');}
  }else if(current.title&&current.title!==state.title)throw new Error('待复用的上传稿件标题不匹配');
  await this.fill('input[placeholder="填写作品标题，为作品获得更多流量"]',state.title);
  await this.fill('[contenteditable=true]',state.description);
  current=await this.snapshot();
  if(!current.text.includes('作者声明：内容由AI生成')){
   await this.click({text:'请选择自主声明'});await this.click({text:'内容由AI生成'});await this.click({text:'确定'});
  }
  current=await this.snapshot();const mode=at?'定时发布':'立即发布';if(!current.checks.some(x=>x.label===mode&&x.checked))await this.click({text:mode});
  if(at)await this.fill('input[placeholder="日期和时间"]',at,{replace:true});
  for(let i=0;i<90;i++){
   current=await this.snapshot();if(current.publishEnabled&&current.text.includes('重新上传'))break;
   await sleep(1000);if(i===89)throw new Error('视频仍未上传完成，未提交发布');
  }
  validatePublishForm(current,state,at);state.status='prepared';state.uploadFingerprint=state.fingerprint;state.scheduledAt=at||'';this.save(state);return current;
 }
 async publish(day,{at,reuseUpload=false,live=false}={}){
  if(!live)throw new Error('发布视频需要明确的 --live 参数');
  let state=this.read(day);
  if(['published','scheduled','submitted'].includes(state.status)){this.log('本日已有已发布或定时视频，不重复发送');return state;}
  if(['publishing','uncertain'].includes(state.status))throw new Error('本日发布结果待核对，不自动重发');
  if(!['rendered','prepared','uploading'].includes(state.status)||!existsSync(state.videoPath))throw new Error('没有已完成的视频可以发布');
  await this.prepare(state,{at,reuseUpload});await this.dy.checkAccount(this.cfg.account);
  validatePublishForm(await this.snapshot(),state,at);
  state.status='publishing';state.publishAttemptId=randomUUID();state.publishAttemptAt=new Date().toISOString();this.save(state);
  try{
   await this.click({text:'发布'});
   for(let i=0;i<120;i++){
    const view=await this.snapshot();
    if(view.url.includes('/content/manage')&&view.text.includes(state.title)&&(!at||view.text.replace(/\s/g,'').includes(at.replace(/^(\d{4})-(\d{2})-(\d{2}) /,(_,y,m,d)=>`${y}年${Number(m)}月${Number(d)}日`).replace(/\s/g,'')))){
     state.status=at?'scheduled':'submitted';state.reviewStatus=view.text.includes('审核中')?'审核中':'已提交';state.platformReadback=view.text.slice(-18000);state.submittedAt=new Date().toISOString();state.scheduledAt=at||'';
     const link=view.links.find(l=>l.href.includes('/video/')&&(l.text.includes(state.title)||view.links.filter(x=>x.href.includes('/video/')).length===1));
     if(link)state.platformUrl=link.href;this.save(state);this.log(`${at?'已定时':'已提交'}发布，并在作品管理回读：${state.title}`);return state;
    }
    if(/验证码|安全验证/.test(view.text))throw new Error('发布页面需要本人完成抖音验证');
    await sleep(500);
   }
   throw new Error('发布后未在作品管理回读到本日标题，需人工核对');
  }catch(error){state.status='uncertain';state.note=error.message;this.save(state);throw error;}
 }
}
