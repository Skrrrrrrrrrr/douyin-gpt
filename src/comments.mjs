import { sleep } from './browser.mjs';
import { Douyin, StopRequired } from './douyin.mjs';
import { readCommentsInPage, editorStateInPage, commentControlInPage, noticeControlInPage } from './comment-dom.mjs';
import {commentDiagnostic} from './send-diagnostics.mjs';
import {publishReceipt,commentRequest,matchesPublishedComment,accountConfirmation} from './comment-confirmation.mjs';

export const numericId = value => typeof value === 'string' && /^[0-9]{15,25}$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && /^[0-9]{15,25}$/.test(String(value)) ? String(value) : '';
export const compatibleCommentText=(found,text)=>found.text===text||(!found.text&&found.mediaPresent&&/^\[(?:图片表情|图片|贴纸)\]$/.test(text));
export function normalizeComment(c, videoId, rootId = '') {
  const id = numericId(c?.cid || c?.id); if (!id) return null;
  const user = c.user || {};
  return { id, videoId: numericId(c.aweme_id || c.awemeId) || videoId, rootId: numericId(c.reply_id || c.replyId) || rootId || id,
    text: String(c.text || '').slice(0,2000), authorSecUid: String(user.sec_uid || user.secUid || ''), authorUid: String(user.uid || ''), authorName: String(user.nickname || ''), createTime: Number(c.create_time || c.createTime || 0),
    replyToId: numericId(c.reply_to_reply_id || c.replyToId), replyToSecUid: String(c.reply_to_user?.sec_uid || c.replyToSecUid || ''),
    ...(Number.isSafeInteger(c.reply_comment_total??c.replyCommentTotal)&&(c.reply_comment_total??c.replyCommentTotal)>=0?{replyCount:c.reply_comment_total??c.replyCommentTotal}:{}) };
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
  // On a comment to our own video, parent_id is the video ID, not a comment root.
  const parents=[raw.reply_id,block.level1_comment?.cid,block.parent_id].map(numericId).filter(Boolean),videoParent=parents.includes(videoId),root=parents.find(id=>id!==videoId)||'';
  if ([31,32].includes(Number(notice.type)) && !root&&!videoParent) return null;
  if (block.reply_comment?.user?.sec_uid && block.reply_comment.user.sec_uid !== account.secUid && Number(notice.type) !== 45) return null;
  target.rootId = root || (Number(notice.type)===45||videoParent ? '' : cid);
  target.createTime ||= Number(notice.create_time || 0);
  // nid 在部分响应中是超出 JS 安全范围的整数；用字符串 cid 构成稳定去重键。
  return { id: `${Number(notice.type)}:${videoId}:${cid}`, type: Number(notice.type), createdAt: Number(notice.create_time || 0), replyToId: numericId(block.reply_comment?.cid), target, video: { id: videoId, desc: String(block.aweme?.desc || '').slice(0,2000), url: `https://www.douyin.com/video/${videoId}` }, parentText: String(block.reply_comment?.text || block.level1_comment?.text || '').slice(0,1000) };
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
    this.home=home;this.browser=browser;this.dy=new Douyin(home,browser);this.page=null;this.attaching=null;this.pageListeners=[];this.receipts=[];this.requests=new Map();this.cache=new Map();this.wait=sleep;
  }
  async attach() {
    if(!this.attaching)this.attaching=this.attachPage();
    const pending=this.attaching;
    try{return await pending;}finally{if(this.attaching===pending)this.attaching=null;}
  }
  async attachPage() {
    // Browser.page checks the socket and reconnects its existing target. Do not
    // bypass it with a stale Comments.page, or retry any in-flight send here.
    const page=await this.browser.page('comments','https://www.douyin.com/');
    if(page===this.page)return page;
    for(const remove of this.pageListeners)if(typeof remove==='function')remove();
    this.pageListeners=[];this.page=null;this.requests.clear();this.receipts=[];this.cache.clear();
    try{await page.send('Network.enable');}catch(error){page.close?.();throw error;}
    this.page=page;
    this.pageListeners.push(page.on('Network.requestWillBeSent', event=>{
      if(this.page!==page)return;
      const request=commentRequest(event.request);if(!request)return;
      this.requests.set(event.requestId,request);
      if(this.requests.size>200)this.requests.delete(this.requests.keys().next().value);
    }));
    this.pageListeners.push(page.on('Network.loadingFinished', async event=>{
      if(this.page!==page)return;
      const request=this.requests.get(event.requestId);if(!request)return;
      this.requests.delete(event.requestId);
      const body=await page.send('Network.getResponseBody',{requestId:event.requestId});
      if(this.page!==page)return;
      const json=JSON.parse(body.base64Encoded?Buffer.from(body.body,'base64').toString('utf8'):body.body);
      if(/\/publish(?:\/|$)/.test(request.path)){
        this.receipts.push({request,statusCode:json.status_code,comment:json.comment||null,at:Date.now()});
        this.receipts=this.receipts.slice(-30);
      }
      for(const c of json.comments||[]){const item=normalizeComment(c,request.videoId,request.rootId);if(item?.videoId)this.cache.set(item.id,item);}
      if(this.cache.size>1000)this.cache.delete(this.cache.keys().next().value);
    }));
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
    const existing=await this.editorState();
    if(existing.text||existing.anyDraftPresent)throw errorWithAttempt('评论框已有未发送草稿，已保留',false,'existing_draft');
    if(target){const current=await evaluate(page,readCommentsInPage),activeVideo=commentVideoIdFromUrl(await page.ev('location.href'));if(activeVideo===video.id&&current.some(c=>c.id===target.id&&c.videoId===video.id)){await this.holdVideos();return current.filter(c=>c.videoId===video.id);}}
    // A notification opens the platform's exact comment landing view, including comments absent from the hot list.
    if(target){const landed=await this.openNoticeTarget(video,target);if(landed)return landed;}
    const url=`https://www.douyin.com/video/${video.id}${target?`?comment_id=${target.rootId||target.id}`:''}`;
    await this.browser.navigate(page,url);
    for(let attempt=0;attempt<45;attempt++){
      if(this.signal?.aborted)throw errorWithAttempt('已停止评论操作',false);
      const state=await page.ev(`({title:document.title,video:!!document.querySelector('.video_${video.id}'),input:!!document.querySelector('#comment-input-container')})`);
      if(/^验证码中间页$|^安全验证/.test(state.title))throw Object.assign(new StopRequired('评论页需要完成抖音验证','PAGE_VERIFICATION'),{pageKind:'comments'});
      if(state.video&&state.input)break;
      if(attempt===44)throw errorWithAttempt('评论页面没有加载完成',false);
      await this.wait(500);
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
  async openNoticeTarget(video,target){
    let point=await evaluate(this.page,noticeControlInPage,{kind:'item',targetId:target.id,text:target.text});
    if(!point){const header=await evaluate(this.page,noticeControlInPage,{kind:'header'});if(!header)return null;await this.click(header);for(let i=0;i<12&&!point;i++){await this.wait(150);point=await evaluate(this.page,noticeControlInPage,{kind:'item',targetId:target.id,text:target.text});}}
    if(!point)return null;await this.click(point);
    for(let i=0;i<25;i++){await this.wait(200);await this.holdVideos();const items=await evaluate(this.page,readCommentsInPage);if(items.some(c=>c.id===target.id&&c.videoId===video.id))return items.filter(c=>c.videoId===video.id);}
    return null;
  }
  async holdVideos() { await this.page.ev(`document.querySelectorAll('video').forEach(v=>{v.autoplay=false;v.pause()})`); }
  async checkVideo(videoId) { if(commentVideoIdFromUrl(await this.page.ev('location.href'))!==videoId)throw errorWithAttempt('评论页已切换到其他视频，未发送',false,'video_changed'); }
  async readApi(video, target = null, {includeReplies=true}={}) {
    if (!numericId(video.id) || target && (!numericId(target.id) || target.rootId && !numericId(target.rootId))) throw new Error('评论读取对象 ID 无效');
    const items = new Map();
    const collect = (rows, rootId = '') => {
      for (const raw of rows) {
        const item = normalizeComment(raw, video.id, rootId);
        if (!item || item.videoId !== video.id) continue;
        items.set(item.id, item);
        if (Array.isArray(raw.reply_comment)) collect(raw.reply_comment, item.rootId);
      }
    };
    const pages = async (path, params, rootId = '', limit = 3) => {
      let cursor = '0';
      for (let i = 0; i < limit; i++) {
        if (this.signal?.aborted) throw errorWithAttempt('已停止评论读取', false);
        const query = new URLSearchParams({ device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', pc_client_type: '1', count: '50', item_type: '0', ...params, cursor });
        if(path==='/aweme/v1/web/comment/list/'&&params.insert_ids){query.set('count','20');query.delete('item_type');}
        const json = await this.dy.fetchInPage(path + '?' + query,{timeoutMs:6000,noCache:true});
        const rows = json.comments === null && Number(json.total) === 0 ? [] : json.comments;
        if (!Array.isArray(rows)) throw new Error('评论接口返回格式无效');
        collect(rows, rootId);
        if(target&&path==='/aweme/v1/web/comment/list/'&&items.has(target.id))break;
        const next = String(json.cursor ?? '');
        if (!rows.length || !(json.has_more === true || Number(json.has_more) === 1) || !/^\d+$/.test(next) || next === cursor) break;
        cursor = next;
      }
    };
    const readReplies = rootId => pages('/aweme/v1/web/comment/list/reply/', { item_id: video.id, comment_id: rootId }, rootId);
    if (target?.rootId && target.rootId !== target.id) {
      await readReplies(target.rootId);
      if (items.has(target.id)) return [...items.values()];
    }
    // A new comment need not rank in the hot list. Ask the platform for the exact stable CID as well.
    await pages('/aweme/v1/web/comment/list/', { aweme_id: video.id, ...(target ? {insert_ids:target.id,insert_way:'0'} : {}) }, '', target ? 3 : 1);
    const found = target && items.get(target.id);
    if (includeReplies&&found && found.replyCount!==0 && (!target.rootId || target.rootId === target.id)) await readReplies(found.rootId);
    return [...items.values()];
  }
  async read(video,target=null) {
    if (!numericId(video.id) || target && (!numericId(target.id) || target.rootId && !numericId(target.rootId))) throw new Error('评论读取对象 ID 无效');
    this.lastReadVia = 'api';
    try {
      const items = await this.readApi(video,target);
      if (!target || items.some(c => c.id === target.id)) return items;
    } catch (error) {
      if (this.signal?.aborted) throw error;
    }
    this.lastReadVia = 'browser-ui';
    return this.open(video,target);
  }
  async click(point) {
    if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))throw errorWithAttempt('评论控件无法定位',false);
    if(this.signal?.aborted)throw errorWithAttempt('已停止评论操作',false);
    if(this.browser.headless)await this.page.send('Page.bringToFront');
    await this.holdVideos();
    await this.page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,button:'none',buttons:0});
    await this.page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1});
    await this.page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',buttons:0,clickCount:1});
  }
  async editorState(targetId='') {return this.lastEditorState=await evaluate(this.page,editorStateInPage,{targetId});}
  async prepareEditor(videoId, expectedTarget='', {attempts=40,interval=200}={}) {
    let state,activationFound=false;
    for(let i=0;i<=attempts;i++) {
      if(this.signal?.aborted)throw errorWithAttempt('已停止评论操作',false,'stopped');
      await this.checkVideo(videoId);
      state=await this.editorState(expectedTarget);
      if(state.text||state.anyDraftPresent)throw errorWithAttempt('评论框已有未发送草稿，已保留',false,'existing_draft');
      if(state.editor&&state.replyTargetKnown&&state.replyTarget===expectedTarget) {
        if(state.editorFocused)return state;
        if(i%5===0)await this.click(state.editor);
      } else if(!state.editor&&[0,5,15,30].includes(i)) {
        const point=await evaluate(this.page,commentControlInPage,{kind:'editor',targetId:expectedTarget});
        if(point){activationFound=true;await this.click(point);}
      }
      if(i<attempts)await this.wait(interval);
    }
    const [code,message]=!state.editor?(state.editorCount>0?['editor_unavailable','评论编辑器不可见或被遮挡，未输入正文']:activationFound?['editor_missing','已点击评论占位区，但等待后仍未出现可编辑输入框']:['editor_activation_missing','未找到可点击的评论输入区域'])
      :!state.replyTargetKnown?['reply_target_unknown','评论回复对象尚未就绪，未输入正文']
      :state.replyTarget!==expectedTarget?['reply_target_changed','当前评论回复对象与目标不一致，未输入正文']
      :['editor_unfocused','评论输入框未获得页面内焦点，未输入正文'];
    throw errorWithAttempt(message,false,code);
  }
  assertComposed(state,text,expectedTarget) {
    if(state.draftCount>1)throw errorWithAttempt('其他评论框出现未发送草稿，已保留所有草稿',false,'existing_draft');
    if(!state.editor||state.text!==text.trim())throw errorWithAttempt('发送前评论正文发生变化，草稿已保留',false,'text_changed');
    if(!state.replyTargetKnown||state.replyTarget!==expectedTarget)throw errorWithAttempt('发送前评论回复对象发生变化，草稿已保留',false,'reply_target_changed');
  }
  async verifyDelivery(action,account){
    if(!numericId(action.receipt?.id)||!numericId(action.videoId))return accountConfirmation(null,'missing_receipt',{reason:'缺少可靠评论ID，等待人工核对'});
    await this.dy.checkAccount(account);
    const video={id:action.videoId,url:'https://www.douyin.com/video/'+action.videoId};
    try{
      const rows=await this.readApi(video,{id:action.receipt.id,rootId:action.rootId||action.receipt.id},{includeReplies:false});
      if(rows.some(c=>matchesPublishedComment(c,action,account)))return accountConfirmation(true,'fresh_api');
    }catch(error){if(this.signal?.aborted||error.name==='StopRequired')throw error;}
    const page=await this.attach(),state=await this.editorState();
    if(state.text||state.anyDraftPresent)return accountConfirmation(null,'deferred_draft',{reason:'评论框有草稿，暂不刷新复核'});
    if(this.signal?.aborted)return accountConfirmation(null,'cancelled');
    await page.send('Page.reload',{ignoreCache:true});await this.wait(1500);
    const target={id:action.targetId||action.receipt.id,rootId:action.rootId||action.receipt.id,text:'',authorSecUid:action.targetAuthor||account.secUid};
    let rows=await this.open(video,target);
    if(rows.some(c=>matchesPublishedComment(c,action,account)))return accountConfirmation(true,'fresh_native_page');
    if(action.targetId){const point=await evaluate(page,commentControlInPage,{kind:'expand',targetId:action.rootId});if(point){await this.click(point);for(let i=0;i<15;i++){if(this.signal?.aborted)break;await this.wait(250);rows=await evaluate(page,readCommentsInPage);if(rows.some(c=>matchesPublishedComment(c,action,account)))return accountConfirmation(true,'fresh_native_page');}}}
    return accountConfirmation(null,'fresh_native_page',{reason:'重新读取后尚未找到匹配的评论，保持待复核'});
  }
  async send({video,target=null,text,account}) {
    let attempted=false,stage='validate',candidate=null;this.lastEditorState=null;
    try{
      if(!text.trim()||[...text].length>200)throw new Error('评论正文无效');
      await this.dy.checkAccount(account);
      stage='open';const before=await this.open(video,target),beforeIds=new Set(before.map(c=>c.id));
      await this.checkVideo(video.id);
      if(target){
        stage='target';
        const found=before.find(c=>c.id===target.id);
        if(!found||found.rootId!==target.rootId||found.authorSecUid!==target.authorSecUid||!compatibleCommentText(found,target.text))throw new Error('目标评论身份、正文或楼层无法核对，未发送');
        const selected=await this.editorState(target.id);
        if(!(selected.inline&&selected.replyTargetKnown&&selected.replyTarget===target.id))await this.click(await evaluate(this.page,commentControlInPage,{kind:'reply',targetId:target.id}));
      }
      const expectedTarget=target?.id||'';
      stage='editor';await this.prepareEditor(video.id,expectedTarget);
      stage='typing';
      await this.page.send('Input.insertText',{text});
      await sleep(500);
      this.assertComposed(await this.editorState(expectedTarget),text,expectedTarget);
      stage='submit';
      await this.dy.checkAccount(account);
      await this.holdVideos();
      await this.checkVideo(video.id);
      this.assertComposed(await this.editorState(expectedTarget),text,expectedTarget);
      const button=await evaluate(this.page,commentControlInPage,{kind:'send',targetId:expectedTarget});
      if(!button)throw errorWithAttempt('没有找到可用的评论发送按钮，草稿已保留',false,'send_button_missing');
      this.assertComposed(await this.editorState(expectedTarget),text,expectedTarget);
      const start=Date.now();
      if(this.signal?.aborted)throw new Error('已停止评论操作');
      attempted=true;await this.click(button);stage='receipt';
      for(let i=0;i<40;i++){
        await this.wait(250);
        for(const receipt of this.receipts){const accepted=publishReceipt(receipt,{video,target,text,account,start});if(accepted)return accepted;}
        const visible=await evaluate(this.page,readCommentsInPage);
        const echoed=visible.find(c=>!beforeIds.has(c.id)&&c.videoId===video.id&&c.authorSecUid===account.secUid&&c.text===text&&c.createTime>=Math.floor(start/1000)-10&&(!target||c.rootId===target.rootId));
        if(echoed)candidate={version:2,accepted:false,id:echoed.id,videoId:video.id,rootId:echoed.rootId,replyToId:target?.id||'',verified:false,via:'local-echo',text,confirmation:{version:1,level:'local_echo',accountVisible:null,recipientVisible:null}};
      }
      const error=errorWithAttempt(candidate?'只看到页面即时回显，尚未取得平台回执，等待重新读取复核':'发送后没有收到可靠回执，已停止自动重试',true,'receipt_unconfirmed');if(candidate)error.receipt=candidate;throw error;
    }catch(error){if(error.sendAttempted===undefined)error.sendAttempted=attempted;
      if(candidate&&attempted&&!error.receipt)error.receipt=candidate;
      error.diagnostic=commentDiagnostic(this.lastEditorState,{code:error.code|| (error.sendAttempted?'comment_send_failed':'comment_pre_send_failed'),stage,attempted:error.sendAttempted});throw error;}
  }
}
