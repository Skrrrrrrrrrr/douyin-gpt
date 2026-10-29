import { sleep } from './browser.mjs';
import { Douyin, StopRequired } from './douyin.mjs';
import { readCommentsInPage, editorStateInPage, commentControlInPage, noticeControlInPage } from './comment-dom.mjs';

export const numericId = value => typeof value === 'string' && /^[0-9]{15,25}$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && /^[0-9]{15,25}$/.test(String(value)) ? String(value) : '';
export function normalizeComment(c, videoId, rootId = '') {
  const id = numericId(c?.cid || c?.id); if (!id) return null;
  const user = c.user || {};
  return { id, videoId: numericId(c.aweme_id || c.awemeId) || videoId, rootId: numericId(c.reply_id || c.replyId) || rootId || id,
    text: String(c.text || '').slice(0,2000), authorSecUid: String(user.sec_uid || user.secUid || ''), authorUid: String(user.uid || ''), authorName: String(user.nickname || ''), createTime: Number(c.create_time || c.createTime || 0) };
}
export function normalizeNotice(notice, account) {
  if (![31,32,35,45].includes(Number(notice.type))) return null;
  const block = Number(notice.type)===45 ? notice.at || notice.comment : notice.comment || notice.at;
  if (!block || typeof block !== 'object') return null;
  const raw = block.comment || {}, schema = String(block.schema_url || '');
  const videoId = numericId(block.aweme_id || block.aweme?.aweme_id || raw.aweme_id) || (schema.match(/aweme\/detail\/([0-9]{15,25})/) || [])[1] || '';
  const cid = numericId(raw.cid || block.comment_id) || (schema.match(/[?&]cid=([0-9]{15,25})/) || [])[1] || '';
  if (!videoId || !cid) return null;
  const target = normalizeComment({ ...raw, cid, user: raw.user || block.user_info || block.from_user }, videoId);
  if (!target || target.authorSecUid === account.secUid) return null;
  const root = numericId(block.parent_id || block.level1_comment?.cid || raw.reply_id);
  if ([31,32].includes(Number(notice.type)) && !root) return null;
  if (block.reply_comment?.user?.sec_uid && block.reply_comment.user.sec_uid !== account.secUid && Number(notice.type) !== 45) return null;
  target.rootId = root || (Number(notice.type)===45 ? '' : cid);
  target.createTime ||= Number(notice.create_time || 0);
  // nid 在部分响应中是超出 JS 安全范围的整数；用字符串 cid 构成稳定去重键。
  return { id: `${Number(notice.type)}:${videoId}:${cid}`, type: Number(notice.type), createdAt: Number(notice.create_time || 0), target, video: { id: videoId, desc: String(block.aweme?.desc || '').slice(0,2000), url: `https://www.douyin.com/video/${videoId}` }, parentText: String(block.reply_comment?.text || block.level1_comment?.text || '').slice(0,1000) };
}
const evaluate = (page, fn, arg) => page.ev(`(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`);
const errorWithAttempt = (message, attempted, code = '') => Object.assign(new Error(message), { sendAttempted: attempted, code });
export function commentVideoIdFromUrl(value) {
  const url=new URL(value);
  if(url.origin!=='https://www.douyin.com')return '';
  return numericId(url.searchParams.get('modal_id')) || (url.pathname.match(/^\/video\/([0-9]{15,25})/)||[])[1] || '';
}

export class Comments {
  constructor(home, browser) {
    this.home=home;this.browser=browser;this.dy=new Douyin(home,browser);this.page=null;this.receipts=[];this.requests=new Map();this.cache=new Map();
  }
  async attach() {
    if(this.page)return this.page;
    const page=await this.browser.page('comments','https://www.douyin.com/');this.page=page;
    await page.send('Network.enable');
    page.on('Network.requestWillBeSent', event=>{
      const u=new URL(event.request.url);
      if(u.origin!=='https://www.douyin.com'||!u.pathname.startsWith('/aweme/v1/web/comment/'))return;
      const body=new URLSearchParams(event.request.postData||'');
      this.requests.set(event.requestId,{path:u.pathname,videoId:numericId(body.get('aweme_id')||u.searchParams.get('aweme_id')||u.searchParams.get('item_id')),rootId:numericId(body.get('reply_id')||u.searchParams.get('comment_id')),replyToId:numericId(body.get('reply_to_reply_id')),text:body.get('text')||'',at:Date.now()});
      if(this.requests.size>200)this.requests.delete(this.requests.keys().next().value);
    });
    page.on('Network.loadingFinished', async event=>{
      const request=this.requests.get(event.requestId);if(!request)return;
      this.requests.delete(event.requestId);
      const body=await page.send('Network.getResponseBody',{requestId:event.requestId});
      const json=JSON.parse(body.base64Encoded?Buffer.from(body.body,'base64').toString('utf8'):body.body);
      if(request.path.includes('/publish/')){
        this.receipts.push({request,statusCode:json.status_code,comment:json.comment||null,at:Date.now()});
        this.receipts=this.receipts.slice(-30);
      }
      for(const c of json.comments||[]){const item=normalizeComment(c,request.videoId,request.rootId);if(item?.videoId)this.cache.set(item.id,item);}
      if(this.cache.size>1000)this.cache.delete(this.cache.keys().next().value);
    });
    return page;
  }
  async notices(account) {
    const items=new Map();
    for(const group of [700,960]){
      const path='/aweme/v1/web/notice/?'+new URLSearchParams({device_platform:'webapp',aid:'6383',channel:'channel_pc_web',is_new_notice:'1',is_mark_read:'0',count:'50',min_time:'0',group:String(group),notice_group:String(group)});
      const json=await this.dy.fetchInPage(path);
      if(!Array.isArray(json.notice_list_v2))throw new Error('互动通知返回格式无效，未更新已读基线');
      for(const raw of json.notice_list_v2){const item=normalizeNotice(raw,account);if(item)items.set(item.id,item);}
    }
    return [...items.values()].sort((a,b)=>a.createdAt-b.createdAt);
  }
  async open(video, target = null) {
    if(!numericId(video.id))throw new Error('无效视频 ID');
    const page=await this.attach();
    const existing=await evaluate(page,editorStateInPage);
    if(existing.text||existing.anyDraftPresent)throw errorWithAttempt('评论框已有未发送草稿，已保留',false,'existing_draft');
    if(target){const current=await evaluate(page,readCommentsInPage);if(current.some(c=>c.id===target.id&&c.videoId===video.id)){await this.holdVideos();return current.filter(c=>c.videoId===video.id);}}
    const url=`https://www.douyin.com/video/${video.id}${target?`?comment_id=${target.rootId||target.id}`:''}`;
    await this.browser.navigate(page,url);
    for(let attempt=0;attempt<45;attempt++){
      if(this.signal?.aborted)throw errorWithAttempt('已停止评论操作',false);
      const state=await page.ev(`({title:document.title,video:!!document.querySelector('.video_${video.id}'),input:!!document.querySelector('#comment-input-container')})`);
      if(/^验证码中间页$|^安全验证/.test(state.title))throw new StopRequired('评论页需要完成抖音验证');
      if(state.video&&state.input)break;
      if(attempt===44)throw errorWithAttempt('评论页面没有加载完成',false);
      await sleep(500);
    }
    await this.holdVideos();
    let items=await evaluate(page,readCommentsInPage);
    for(let i=0;!items.some(c=>c.videoId===video.id)&&i<24;i++){
      const empty=await page.ev(`!![...document.querySelectorAll('[data-e2e="comment-list"]')].find(e=>/暂无评论|还没有评论/.test(e.innerText||''))`);
      if(empty)break;
      await sleep(400);items=await evaluate(page,readCommentsInPage);
    }
    for(let i=0;target&&!items.some(c=>c.id===target.id)&&i<8;i++){await sleep(400);items=await evaluate(page,readCommentsInPage);}
    if(target&&!items.some(c=>c.id===target.id)){
      const expand=await evaluate(page,commentControlInPage,{kind:'expand',targetId:target.rootId});
      if(expand){await this.click(expand);for(let i=0;i<20;i++){await sleep(300);items=await evaluate(page,readCommentsInPage);if(items.some(c=>c.id===target.id))break;}}
    }
    if(target&&!items.some(c=>c.id===target.id)){
      let point=await evaluate(page,noticeControlInPage,{kind:'item',targetId:target.id,text:target.text});
      if(!point){const header=await evaluate(page,noticeControlInPage,{kind:'header'});if(header){await this.click(header);for(let i=0;i<12&&!point;i++){await sleep(150);point=await evaluate(page,noticeControlInPage,{kind:'item',targetId:target.id,text:target.text});}}}
      if(point){await this.click(point);for(let i=0;i<30;i++){await sleep(300);await this.holdVideos();items=await evaluate(page,readCommentsInPage);if(items.some(c=>c.id===target.id))break;}}
    }
    await this.holdVideos();
    return items.filter(c=>c.videoId===video.id);
  }
  async holdVideos() { await this.page.ev(`document.querySelectorAll('video').forEach(v=>{v.autoplay=false;v.pause()})`); }
  async checkVideo(videoId) { if(commentVideoIdFromUrl(await this.page.ev('location.href'))!==videoId)throw errorWithAttempt('评论页已切换到其他视频，未发送',false,'video_changed'); }
  async read(video,target=null) { return this.open(video,target); }
  async click(point) {
    if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))throw errorWithAttempt('评论控件无法定位',false);
    if(this.signal?.aborted)throw errorWithAttempt('已停止评论操作',false);
    await this.page.send('Page.bringToFront');
    await this.holdVideos();
    await this.page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,button:'none',buttons:0});
    await this.page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1});
    await this.page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',buttons:0,clickCount:1});
  }
  async send({video,target=null,text,account}) {
    let attempted=false;
    try{
      if(!text.trim()||[...text].length>200)throw new Error('评论正文无效');
      await this.dy.checkAccount(account);
      const before=await this.open(video,target),beforeIds=new Set(before.map(c=>c.id));
      await this.checkVideo(video.id);
      if(target){
        const found=before.find(c=>c.id===target.id);
        if(!found||found.rootId!==target.rootId||found.authorSecUid!==target.authorSecUid||found.text!==target.text)throw new Error('目标评论身份、正文或楼层无法核对，未发送');
        await this.click(await evaluate(this.page,commentControlInPage,{kind:'reply',targetId:target.id}));
        await sleep(250);
      }
      await this.click(await evaluate(this.page,commentControlInPage,{kind:'editor'}));
      await sleep(300);
      let state=await evaluate(this.page,editorStateInPage);
      for(let i=0;!state.editor&&i<12;i++){await sleep(100);state=await evaluate(this.page,editorStateInPage);}
      if(!state.editor||state.text)throw new Error('评论输入框未就绪或已有草稿');
      const expectedTarget=target?.id||'';
      if(!state.replyTargetKnown||state.replyTarget!==expectedTarget)throw new Error('当前评论回复对象无法核对');
      await this.click(state.editor);
      await this.page.send('Input.insertText',{text});
      await sleep(500);
      state=await evaluate(this.page,editorStateInPage);
      if(state.text!==text.trim()||state.replyTarget!==expectedTarget)throw new Error('发送前评论正文或回复对象发生变化');
      const button=await evaluate(this.page,commentControlInPage,{kind:'send'});
      if(!button)throw new Error('没有找到评论发送按钮');
      await this.dy.checkAccount(account);
      await this.holdVideos();
      await this.checkVideo(video.id);
      const start=Date.now();
      if(this.signal?.aborted)throw new Error('已停止评论操作');
      attempted=true;await this.click(button);
      for(let i=0;i<40;i++){
        await sleep(250);
        const receipt=this.receipts.find(r=>r.at>=start&&r.request.videoId===video.id&&r.request.text===text);
        if(receipt){
          const item=normalizeComment(receipt.comment,video.id,target?.rootId||'');
          if(receipt.statusCode!==0||!item)throw errorWithAttempt(`抖音未接受评论（状态 ${receipt.statusCode}），请检查页面验证`,true,'server_rejected');
          const expectedRoot=target?.rootId||'',expectedReply=target&&target.id!==target.rootId?target.id:'';
          if(receipt.request.rootId!==expectedRoot||receipt.request.replyToId!==expectedReply)throw errorWithAttempt('评论实际发送楼层与目标不一致，已暂停核对',true,'wrong_thread');
          await sleep(500);
          const visible=await evaluate(this.page,readCommentsInPage);
          const echoed=visible.find(c=>c.id===item.id&&c.authorSecUid===account.secUid&&c.text===text);
          return {accepted:true,id:item.id,videoId:video.id,rootId:expectedRoot||item.id,replyToId:expectedReply,verified:!!echoed,via:'browser-ui',text};
        }
        const visible=await evaluate(this.page,readCommentsInPage);
        const echoed=visible.find(c=>!beforeIds.has(c.id)&&c.authorSecUid===account.secUid&&c.text===text&&c.createTime>=Math.floor(start/1000)-10&&(!target||c.rootId===target.rootId));
        if(echoed)return {accepted:true,id:echoed.id,videoId:video.id,rootId:echoed.rootId,replyToId:target?.id||'',verified:true,via:'browser-ui-dom',text};
      }
      throw new Error('发送后没有收到可靠回执，已停止自动重试');
    }catch(error){if(error.sendAttempted===undefined)error.sendAttempted=attempted;throw error;}
  }
}
