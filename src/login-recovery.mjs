import {Browser,sleep} from './browser.mjs';
import {probeSession,clearSessionStop,saveSession} from './recovery.mjs';
import {readConfig} from './config.mjs';

// Only the account tab's login form is inspected. Never select the header's 登录 button to submit SMS.
export function loginDomInPage({op='inspect'}={}){
 const visible=n=>{const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(n).visibility!=='hidden';};
 const point=n=>{if(!n||!visible(n))return null;const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};};
 const inputs=[...document.querySelectorAll('input')].filter(visible),phone=inputs.find(n=>/手机号|手机号码/.test(n.placeholder||'')),code=inputs.find(n=>/验证码/.test(n.placeholder||''));
 let form=phone?.parentElement;while(form&&code&&!form.contains(code))form=form.parentElement;
 if(!phone||!code)form=null;
 const candidates=root=>[...(root||document).querySelectorAll('button,[role=button],div,span')].filter(visible);
 const exact=(root,re)=>candidates(root).filter(n=>re.test(n.textContent?.trim()||'')).sort((a,b)=>a.getBoundingClientRect().width-b.getBoundingClientRect().width)[0];
 if(op==='open')return {point:point(exact(document,/^登录$/))};
 if(op==='phone')return {point:point(phone)};
 if(op==='code')return {point:point(code)};
 if(op==='sms')return {point:point(form&&exact(form,/^获取验证码$/))};
 if(op==='submit'){
  let root=form,button;for(let i=0;root&&root!==document.body&&i<5;i++,root=root.parentElement){button=candidates(root).find(n=>/^登录$/.test(n.textContent?.trim()||'')&&n.getBoundingClientRect().width>150);if(button)break;}
  return {point:point(button)};
 }
 if(op==='refresh')return {point:point(exact(document,/^(点击刷新|刷新二维码|二维码已失效.*|二维码已过期.*|重新加载|重新获取)$/))};
 const text=(form?.parentElement||document.body).innerText||'',expired=/二维码.{0,6}(失效|过期)|点击刷新|刷新二维码/.test(text),challenge=/安全验证|请完成验证|拖动.{0,8}滑块|请依次点击/.test(text);
 let root=form;for(let i=0;root&&i<6;i++,root=root.parentElement){if(/扫码登录/.test(root.innerText||''))break;}
 let clip=null;if(root&&root!==document.body){const r=root.getBoundingClientRect();if(r.width>200&&r.height>100&&r.width<1800&&r.height<1200)clip={x:Math.max(0,r.x),y:Math.max(0,r.y),width:r.width,height:r.height,scale:1};}
 const qr=root&&root!==document.body?[...root.querySelectorAll('canvas,img')].filter(visible).filter(n=>{const r=n.getBoundingClientRect();return r.width>=100&&r.width<=550&&Math.abs(r.width-r.height)<r.width*.15;}):[];
 if(qr.length===1){const r=qr[0].getBoundingClientRect();clip={x:Math.max(0,r.x-8),y:Math.max(0,r.y-8),width:r.width+16,height:r.height+16,scale:1};}
 return {formReady:!!form,expired,challenge,clip};
}
export class LoginRecovery{
 constructor(home,{browserFactory=(cfg)=>new Browser(home,{...cfg.browser,background:true}),probe=probeSession,wait=sleep}={}){Object.assign(this,{home,browserFactory,probe,wait});this.image=null;this.expiresAt=0;this.nextSmsAt=0;this.busy=false;}
 view(){if(this.image&&Date.now()>=this.expiresAt)this.image=null;return {hasImage:!!this.image&&Date.now()<this.expiresAt,expiresAt:this.expiresAt||null,nextSmsAt:this.nextSmsAt||null};}
 screenshot(){if(!this.image||Date.now()>=this.expiresAt)return null;return this.image;}
 async execute(action,body={}){
  if(!['check','prepare','refresh','sms','submit'].includes(action))throw Object.assign(new Error('登录操作无效'),{status:400});
  if(this.busy)throw Object.assign(new Error('登录操作正在进行，请稍后'),{status:409});this.busy=true;
  let browser;
  try{
   const cfg=readConfig(this.home),check=await this.probe(this.home,cfg);
   if(check.ready){this.image=null;this.expiresAt=0;clearSessionStop(this.home);return {ready:true,...this.view()};}
   if(action==='check')return {...check,...this.view()};
   if(check.code!=='AUTH_REQUIRED'&&check.code!=='PLATFORM_VERIFICATION')return {...check,...this.view()};
   if(action==='sms'&&!/^1\d{10}$/.test(body.phone||''))throw Object.assign(new Error('请输入有效的 11 位手机号'),{status:400});
   if(action==='submit'&&!/^\d{6}$/.test(body.code||''))throw Object.assign(new Error('请输入 6 位验证码'),{status:400});
   if(action==='sms'&&Date.now()<this.nextSmsAt)throw Object.assign(new Error('验证码已请求，请等倒计时结束再获取'),{status:429});
   browser=this.browserFactory(cfg);await browser.start();const page=await browser.page('account','https://www.douyin.com/');
   const inspect=op=>page.ev(`(${loginDomInPage.toString()})(${JSON.stringify({op})})`);
   const click=async op=>{const target=await inspect(op);if(!target.point)throw new Error('登录表单暂未就绪，请刷新登录页');for(const type of ['mousePressed','mouseReleased'])await page.send('Input.dispatchMouseEvent',{type,...target.point,button:'left',clickCount:1});};
   const fill=async(op,value)=>{await click(op);for(const type of ['rawKeyDown','keyUp'])await page.send('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',modifiers:process.platform==='darwin'?4:2,windowsVirtualKeyCode:65});await page.send('Input.insertText',{text:value});};
   let state=await inspect('inspect');
   if(!state.formReady&&!state.challenge){await click('open');for(let i=0;i<12&&!state.formReady&&!state.challenge;i++){await this.wait(250);state=await inspect('inspect');}}
   if(state.challenge){saveSession(this.home,{state:'blocked',code:'PLATFORM_VERIFICATION'});return {ready:false,code:'PLATFORM_VERIFICATION',message:'请在专用抖音窗口完成平台验证',...this.view()};}
   if(!state.formReady)throw new Error('登录表单暂未就绪，请刷新登录页');
   if(action==='sms'){await fill('phone',body.phone);this.nextSmsAt=Date.now()+60000;await click('sms');this.image=null;return {ready:false,smsRequested:true,message:'已点击获取验证码，请查看手机；平台验证须本人完成',...this.view()};}
   if(action==='submit'){
    await fill('code',body.code);await click('submit');await this.wait(1200);const result=await this.probe(this.home,cfg);
    if(result.ready){this.image=null;this.expiresAt=0;clearSessionStop(this.home);}return {...result,...this.view()};
   }
   if(action==='refresh'||state.expired){
    const refresh=await inspect('refresh');if(refresh.point)await click('refresh');else{await page.send('Page.reload',{ignoreCache:true});await this.wait(1500);state=await inspect('inspect');if(!state.formReady&&!state.challenge)await click('open');}
    await this.wait(500);state=await inspect('inspect');
   }
   if(!state.clip||state.challenge)throw new Error('登录区域暂未就绪，请稍后刷新');
   const shot=await page.send('Page.captureScreenshot',{format:'png',clip:state.clip,captureBeyondViewport:false});
   this.image=Buffer.from(shot.data,'base64');this.expiresAt=Date.now()+90000;
   return {ready:false,code:'AUTH_REQUIRED',expired:state.expired,...this.view()};
  }catch(error){if(error.status)throw error;throw Object.assign(new Error('登录步骤暂未完成，请刷新状态或在专用抖音窗口处理验证'),{status:503});}
  finally{browser?.disconnect();this.busy=false;}
 }
}
