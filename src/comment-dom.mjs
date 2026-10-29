// 在评论页执行，仅读取公开评论；使用稳定 cid，不按昵称或正文猜收件人。
export function readCommentsInPage() {
  const scopes = [...document.querySelectorAll('[data-e2e="comment-list"]')];
  if (!scopes.length) return [];
  const result = new Map();
  const stableId=v=>typeof v==='string'&&/^[0-9]{15,25}$/.test(v)?v:typeof v==='number'&&Number.isSafeInteger(v)&&/^[0-9]{15,25}$/.test(String(v))?String(v):'';
  const nodes = scopes.flatMap(scope=>[scope, ...scope.querySelectorAll('div')]).slice(0, 5000);
  for (const node of nodes) {
    const key = Object.keys(node).find(k => k.startsWith('__reactFiber$'));
    let fiber = key && node[key];
    for (let depth = 0; fiber && depth < 16; depth++, fiber = fiber.return) {
      const p = fiber.memoizedProps || {}, c = p.commentInfo;
      if (!c || !c.cid) continue;
      const id = stableId(c.cid), user = c.user || {};
      if (!id) break;
      const rawParent=c.replyId || c.reply_id || '0',parent=stableId(rawParent);
      if(String(rawParent)!=='0'&&!parent)break;
      const videoId = stableId(p.awemeInfo?.awemeId || p.awemeInfo?.aweme_id || '');
      if (!result.has(id)) result.set(id, {
        id, videoId, rootId: parent || id,
        text: String(c.text || ''), authorSecUid: String(user.secUid || user.sec_uid || ''),
        authorUid: String(user.uid || ''), authorName: String(user.nickname || ''),
        replyToId: String(c.replyToReplyId || c.reply_to_reply_id || ''),
        replyToSecUid: String(c.replySecUid || c.reply_sec_uid || ''),
        createTime: Number(c.createTime || c.create_time || 0),
      });
      break;
    }
  }
  return [...result.values()];
}

export function editorStateInPage() {
  const containers=[...document.querySelectorAll('#comment-input-container,.comment-input-container')];
  const front=e=>{const r=e.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&!!hit&&e.contains(hit);};
  const container = containers.find(front)||containers[0];
  if (!container) return { exists: false, text: '', replyTarget: '', replyTargetKnown: false, editor: null };
  const editors = [...container.querySelectorAll('[contenteditable="true"],textarea')].filter(e => {
    const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 10;
  });
  const editor = editors.find(e => e.classList.contains('public-DraftEditor-content')) || editors[0];
  let replyTarget = '', replyTargetKnown = false;
  let n = container;
  for (let outer = 0; n && outer < 4 && !replyTargetKnown; outer++, n = n.parentElement) {
    const key = Object.keys(n).find(k => k.startsWith('__reactFiber$'));
    let f = key && n[key];
    for (let depth = 0; f && depth < 40; depth++, f = f.return) {
      const value = f.memoizedProps?.value;
      if (value && Object.hasOwn(value, 'currentReplyCid')) {
        replyTarget = String(value.currentReplyCid || ''); replyTargetKnown = true; break;
      }
    }
  }
  const r = editor?.getBoundingClientRect();
  return {
    exists: true, text: editor ? String(editor.tagName === 'TEXTAREA' ? editor.value : editor.innerText || '').replaceAll(String.fromCharCode(0x200b), '').trim() : '',
    anyDraftPresent: containers.some(c=>[...c.querySelectorAll('[contenteditable="true"],textarea')].some(e=>String(e.tagName==='TEXTAREA'?e.value:e.innerText||'').replaceAll(String.fromCharCode(0x200b),'').trim())),
    replyTarget, replyTargetKnown,
    editor: r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null,
  };
}

export function commentControlInPage({ kind, targetId = '' }) {
  const visible = e => { const r=e.getBoundingClientRect(); return r.width>0&&r.height>0; };
  const front=e=>{const r=e.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!hit&&e.contains(hit);};
  const point = e => { if(!e)return null;e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();if(!front(e))return null;return {x:r.x+r.width/2,y:r.y+r.height/2}; };
  const info = node => {
    const key=Object.keys(node).find(k=>k.startsWith('__reactFiber$'));let f=key&&node[key];
    for(let d=0;f&&d<18;d++,f=f.return)if(f.memoizedProps?.commentInfo)return f.memoizedProps.commentInfo;
    return null;
  };
  if(kind==='reply'||kind==='expand'){
    const scopes=[...document.querySelectorAll('[data-e2e="comment-list"]')];if(!scopes.length)return null;
    const foreground=scopes.filter(front),active=foreground.length?foreground:scopes;
    const candidates=active.flatMap(scope=>[...scope.querySelectorAll('span,div,button,a')]).filter(e=>{
      const text=(e.innerText||'').trim();
      return visible(e)&&(kind==='reply'?text==='回复':/^展开[0-9]+条回复$/.test(text))&&String(info(e)?.cid||'')===targetId;
    }).sort((a,b)=>a.getBoundingClientRect().width*a.getBoundingClientRect().height-b.getBoundingClientRect().width*b.getBoundingClientRect().height);
    return point(candidates[0]);
  }
  const containers=[...document.querySelectorAll('#comment-input-container,.comment-input-container')];
  const container=containers.find(front)||containers[0];if(!container)return null;
  if(kind==='editor'){
    const ed=container.querySelector('.public-DraftEditor-content[contenteditable="true"], [contenteditable="true"], textarea');
    if(ed&&visible(ed))return point(ed);
    const texts=[...container.querySelectorAll('div,span')].filter(e=>visible(e)&&(/留下你的精彩评论/.test(e.innerText||'')||/评论一下/.test(e.innerText||''))).sort((a,b)=>(a.innerText||'').length-(b.innerText||'').length||a.getBoundingClientRect().width*a.getBoundingClientRect().height-b.getBoundingClientRect().width*b.getBoundingClientRect().height);
    return point(texts[0]||container);
  }
  if(kind==='send'){
    const paths=[...container.querySelectorAll('path[fill]')].filter(p=>/^#?fe2c55$/i.test(p.getAttribute('fill')||''));
    for(const p of paths){const svg=p.ownerSVGElement;if(svg&&visible(svg))return point(svg);}
    return null;
  }
  return null;
}

export function noticeControlInPage({ kind, targetId = '', text = '' }) {
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
  const area=e=>{const r=e.getBoundingClientRect();return r.width*r.height;};
  let candidates=[];
  if(kind==='header')candidates=[...document.querySelectorAll('div,span')].filter(e=>visible(e)&&e.innerText.trim()==='通知');
  else{
    const needle=String(text||'').replace(/\[[^\]]+\]/g,'').trim();
    for(const e of document.querySelectorAll('div,span')){
      if(!visible(e))continue;
      const content=(e.innerText||'').trim();
      if(!content||content.length>500||!(needle?content.includes(needle):/回复|提|@|评论/.test(content)))continue;
      const key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));let f=key&&e[key];
      for(let d=0;f&&d<16;d++,f=f.return){const p=f.memoizedProps||{},info=p.noticeInfo||p.notice?.comment||p.notice?.at;
        const cid=info?.comment?.cid||info?.comment_id||info?.cid;
        if(cid){if(String(cid)===targetId)candidates.push(e);break;}
      }
    }
  }
  const exact=String(text||'').replace(/\[[^\]]+\]/g,'').trim();
  const e=candidates.sort((a,b)=>(kind!=='header'&&exact?Number(b.innerText.trim()===exact)-Number(a.innerText.trim()===exact):0)||area(a)-area(b))[0];if(!e)return null;
  e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};
}
