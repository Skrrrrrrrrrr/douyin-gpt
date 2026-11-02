const id=value=>typeof value==='string'&&/^\d{15,25}$/.test(value);
export function matchesPublishedComment(comment,action,account){
 const expectedId=action.receipt?.id||action.id;
 return !!comment&&id(expectedId)&&comment.id===expectedId&&comment.videoId===action.videoId&&comment.authorSecUid===account.secUid&&comment.text===action.text
  &&comment.rootId===(action.rootId||expectedId)
  &&(!action.targetId||action.targetId===action.rootId||comment.replyToId===action.targetId);
}
export function publishReceipt(receipt,{video,target,text,account,start}){
 if(!receipt||!Number.isFinite(receipt.request?.at)||receipt.request.at<start||!Number.isFinite(receipt.at)||receipt.at<start||receipt.request?.videoId!==video.id||receipt.request?.text!==text)return null;
 if(!Number.isFinite(receipt.statusCode)||receipt.statusCode!==0)throw Object.assign(new Error('平台没有确认接受评论，发送结果需要核对'),{code:'server_rejected',sendAttempted:true});
 const root=target?.rootId||'',reply=target&&target.id!==target.rootId?target.id:'';
 if(receipt.request.rootId!==root||receipt.request.replyToId!==reply)throw Object.assign(new Error('平台回执的回复楼层与目标不一致'),{code:'wrong_thread',sendAttempted:true});
 const raw=receipt.comment;
 if(!id(raw?.cid))throw Object.assign(new Error('平台回执缺少可靠的评论ID'),{code:'receipt_unconfirmed',sendAttempted:true});
 const returnedRoot=raw.reply_id??raw.replyId,returnedReply=raw.reply_to_reply_id??raw.replyToId;
 const parent=v=>v===0||v==='0'||v===''?'':id(v)?v:null;
 if((returnedRoot!==undefined&&parent(returnedRoot)!==root)||(returnedReply!==undefined&&parent(returnedReply)!==reply))throw Object.assign(new Error('平台返回的评论楼层与请求目标不一致'),{code:'wrong_thread',sendAttempted:true});
 const owner=raw.user?.sec_uid||raw.user?.secUid;
 if((owner&&owner!==account.secUid)||(raw.text!==undefined&&raw.text!==text)||(raw.aweme_id&&raw.aweme_id!==video.id))throw Object.assign(new Error('平台回执的账号、视频或正文不一致'),{code:'receipt_identity_mismatch',sendAttempted:true});
 return {version:2,accepted:true,id:raw.cid,videoId:video.id,rootId:root||raw.cid,replyToId:reply,verified:false,via:'browser-ui-response',text,
  confirmation:{version:1,level:'platform_accepted',acceptedAt:new Date(receipt.at).toISOString(),accountVisible:null,recipientVisible:null}};
}
export function accountConfirmation(visible,method,extra={}){return {version:1,level:visible?'account_confirmed':'unconfirmed',accountVisible:visible,recipientVisible:null,method,checkedAt:new Date().toISOString(),...extra};}
export function commentRequest(request,at=Date.now()){
 let url;try{url=new URL(request.url);}catch{return null;}
 if(url.origin!=='https://www.douyin.com'||!url.pathname.startsWith('/aweme/v1/web/comment/'))return null;
 let body=new URLSearchParams(request.postData||''),json={};try{json=JSON.parse(request.postData||'{}');}catch{}
 const value=(...keys)=>{for(const k of keys){const v=body.get(k)??json?.[k]??url.searchParams.get(k);if(typeof v==='string'&&v)return v;}return '';},numeric=(...keys)=>{const v=value(...keys);return id(v)?v:'';};
 return {path:url.pathname,videoId:numeric('aweme_id','item_id'),rootId:numeric('reply_id','comment_id'),replyToId:numeric('reply_to_reply_id'),text:value('text'),at};
}
