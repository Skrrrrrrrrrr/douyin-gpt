// Only structural facts are retained. Draft text, DOM, account IDs and credentials never enter diagnostics.
const STAGES={validate:'核对评论',open:'打开评论页',target:'核对回复对象',editor:'等待评论输入框',typing:'核对已输入正文',submit:'提交前复核',receipt:'等待平台回执'};
const CODES=new Set(['existing_draft','editor_missing','editor_unavailable','editor_unfocused','reply_target_unknown','reply_target_changed','editor_activation_missing','video_changed','text_changed','send_button_missing','server_rejected','wrong_thread','receipt_identity_mismatch','receipt_unconfirmed','comment_pre_send_failed','comment_send_failed','stopped']);
export function commentDiagnostic(state={}, {code='',stage='',attempted=false}={}) {
  const data={version:1,code:CODES.has(code)?code:'comment_pre_send_failed',stage:Object.hasOwn(STAGES,stage)?stage:'validate',sendAttempted:attempted===true};
  for(const key of ['containerCount','editorCount','visibleEditorCount','draftCount'])if(Number.isSafeInteger(state?.[key])&&state[key]>=0)data[key]=Math.min(state[key],1000);
  for(const key of ['exists','anyDraftPresent','placeholderPresent','pageVisible','documentFocused','editorFocused','replyTargetKnown'])if(typeof state?.[key]==='boolean')data[key]=state[key];
  return data;
}
export const safeDeliveryNote=value=>String(value||'').replace(/sk-[A-Za-z0-9_-]+/g,'[已隐藏]').replace(/\b(?:Bearer\s+)[A-Za-z0-9_.-]+/gi,'Bearer [已隐藏]').replace(/(?:\/Users\/|\/var\/|\/tmp\/)[^\n"']+/g,'[本机文件]').slice(0,600);
export function sendInfo(row) {
  const failedStep=row.steps?.find(s=>['not_sent','uncertain'].includes(s.status)&&s.note);
  const reason=safeDeliveryNote(failedStep?.note||row.note);
  const diagnostic=row.diagnostic?commentDiagnostic(row.diagnostic,{code:row.diagnostic.code,stage:row.diagnostic.stage,attempted:row.diagnostic.sendAttempted}):null;
  const terminal=['not_sent','superseded','partial_cancelled'].includes(row.status);
  const legacyAmbiguous=!diagnostic&&reason==='评论输入框未就绪或已有草稿';
  const c=row.confirmation||row.receipt?.confirmation,comment=!!row.videoId&&['comment','reply'].includes(row.kind);
  const confirmation=comment&&['sent','accepted','uncertain'].includes(row.status)?{accountVisible:c?.accountVisible??null,recipientVisible:c?.recipientVisible??null,checkedAt:c?.checkedAt||null,
    label:c?.accountVisible===true?'发送账号内复核通过':!c&&row.receipt?.via==='browser-ui-dom'?'历史页面回显，尚未重新复核':row.receipt?.accepted?'平台已接收，待重新读取':'发送结果待复核',note:c?.recipientVisible===true?'对方已确认可见':c?.recipientVisible===false?'对方反馈尚不可见，保留记录待核对':'尚未确认对方可见；账号内回显不代表对方已收到。'}:null;
  return {reason,terminal,legacyAmbiguous,diagnostic,confirmation,stageLabel:diagnostic?STAGES[diagnostic.stage]:'',
    detail:legacyAmbiguous?'旧记录没有保存输入框状态，无法区分未就绪与已有草稿。':'',
    disposition:terminal?'本次尝试已结束，不会自动补发。':row.status==='uncertain'?'发送结果待核对，不会自动重发。':''};
}
