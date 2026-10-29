import { CommentStore } from './comment-store.mjs';

export class CommentAutomation {
  constructor({ home, cfg, gpt, comments, dy, store, live = false, log = console.log }) {
    Object.assign(this, { home,cfg,gpt,comments,dy,store,live,log });
    this.ledger = new CommentStore(home); this.ledger.recover(); this.previews=[];
  }
  ready(signal) { this.signal=signal;this.comments.signal=signal;return this.cfg.engagement.enabled&&!signal?.aborted&&!this.ledger.data.halted; }
  async submit(kind,video,target,decision) {
    if(!this.live||!this.cfg.engagement.enabled||this.ledger.data.halted||this.signal?.aborted)return null;
    if(kind==='comment'&&!this.cfg.engagement.commentOnVideos||kind==='reply'&&!this.cfg.engagement.replyToComments)return null;
    if(!decision.shouldPost||decision.confidence<this.cfg.engagement.minConfidence||!decision.text.trim()||[...decision.text].length>this.cfg.engagement.maxChars)return null;
    const action=this.ledger.draft(kind,video,target,decision);
    if(action.status!=='draft')return action;
    await this.dy.checkAccount(this.cfg.account);
    if(this.signal?.aborted)return null;
    if(!this.ledger.quota(kind,this.cfg.engagement))return null;
    this.ledger.transition(action,'sending');
    try{
      const receipt=await this.comments.send({video,target,text:action.text,account:this.cfg.account});
      if(!receipt.accepted||!receipt.id)throw new Error('评论没有可靠回执');
      this.ledger.transition(action,receipt.verified?'sent':'accepted',receipt.verified?'已从评论区回读确认':'抖音已返回评论 ID，等待评论区回读',receipt);
      this.log(`${kind==='comment'?'已评论视频':'已回复评论'} ${kind==='comment'?video.id:target.id}（${receipt.verified?'回读确认':'接口已接收'}）`);
    }catch(error){
      if(error.sendAttempted===false)this.ledger.transition(action,'not_sent',error.message);
      else this.ledger.transition(action,'uncertain',error.message);
      if(error.name==='StopRequired'||error.code==='server_rejected'){
        this.ledger.data.halted='评论页面需要核对：'+error.message;this.ledger.save();
      }
      this.log(`公开评论操作未完成：${error.message}`);
    }
    return action;
  }
  async onVideo(video,analysis,signal) {
    if(!this.ready(signal)||!this.cfg.engagement.commentOnVideos||!this.ledger.canComment(this.cfg.engagement)||this.ledger.has('comment',video.id))return null;
    const context=await this.comments.read(video);
    const decision=await this.gpt.publicComment({video,analysis,comments:context,maxChars:this.cfg.engagement.maxChars});
    if(signal?.aborted)return null;
    if(!this.live){this.previews.push({kind:'comment',videoId:video.id,...decision});this.log(`评论预览 ${video.id}：${decision.shouldPost?decision.text:decision.reason}`);return null;}
    if(!decision.shouldPost||decision.confidence<this.cfg.engagement.minConfidence){
      const action=this.ledger.draft('comment',video,null,decision);this.ledger.transition(action,'skipped',decision.reason);return action;
    }
    return this.submit('comment',video,null,decision);
  }
  async poll(signal,{force=false}={}) {
    if(!this.ready(signal)||!this.cfg.engagement.replyToComments)return;
    if(!force&&Date.now()-this.ledger.data.lastPollAt<this.cfg.engagement.pollSeconds*1000)return;
    try{
      await this.dy.checkAccount(this.cfg.account);
      const events=await this.comments.notices(this.cfg.account);
      this.ledger.data.lastPollAt=Date.now();this.ledger.save();
      if(!this.ledger.data.initialized){
        if(this.live){this.ledger.baseline(events);this.log(`已建立评论通知基线 ${events.length} 条，只回复此后新互动`);}
        return;
      }
      for(const event of events){
        if(signal?.aborted||this.ledger.data.halted)break;
        if(this.ledger.data.seen.includes(event.id))continue;
        let target=event.target;
        if(this.ledger.has('reply',event.video.id,target.id)){if(this.live)this.ledger.markSeen([event.id]);continue;}
        if(!this.ledger.quota('reply',this.cfg.engagement))break;
        if(!target.authorSecUid||target.authorSecUid===this.cfg.account.secUid){if(this.live)this.ledger.markSeen([event.id]);continue;}
        try{
          const video=await this.dy.detail(event.video.id);
          const context=await this.comments.read(video,target);
          const found=context.find(c=>c.id===target.id&&(!target.rootId||c.rootId===target.rootId)&&c.authorSecUid===target.authorSecUid&&(!target.text||c.text===target.text));
          if(!found){this.log(`目标评论 ${target.id} 暂未加载，留待下一轮`);continue;}
          target={...target,rootId:found.rootId,text:found.text,createTime:target.createTime||found.createTime};
          const answered=context.some(c=>c.authorSecUid===this.cfg.account.secUid&&c.id!==target.id&&c.rootId===target.rootId&&c.createTime>=target.createTime&&(c.replyToId===target.id||c.replyToSecUid===target.authorSecUid||target.id===target.rootId));
          if(answered){if(this.live)this.ledger.markSeen([event.id]);continue;}
          const old=this.store.data.videos.find(v=>v.id===video.id);
          const decision=await this.gpt.publicComment({video,analysis:old?.analysis||null,comments:context.filter(c=>c.rootId===target.rootId),target:{...target,parentText:event.parentText},maxChars:this.cfg.engagement.maxChars});
          if(signal?.aborted)break;
          if(!this.live){this.previews.push({kind:'reply',targetId:target.id,...decision});continue;}
          if(decision.shouldPost&&decision.confidence>=this.cfg.engagement.minConfidence)await this.submit('reply',video,target,decision);
          else{const action=this.ledger.draft('reply',video,target,decision);this.ledger.transition(action,'skipped',decision.reason);}
          this.ledger.markSeen([event.id]);
        }catch(error){this.log(`评论回复 ${target.id}：${error.message}`);}
      }
    }catch(error){this.log(`读取评论互动通知失败：${error.message}`);this.ledger.data.lastPollAt=Date.now();this.ledger.save();}
  }
}
