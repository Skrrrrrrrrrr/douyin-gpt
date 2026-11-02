import type {Row} from './types';

export function SendStatus({row}:{row:Row}) {
  const info=row.sendInfo;
  if(!info)return null;
  if(info.confirmation&&['sent','accepted'].includes(row.status))return <div className="send-status"><p className="send-reason">{info.confirmation.label}</p><p className="send-disposition">{info.confirmation.note}</p></div>;
  if(['sent','accepted'].includes(row.status)||!info.reason)return null;
  const d=info.diagnostic;
  return <div className="send-status">
    <p className="send-reason"><strong>{row.status==='uncertain'?'待核对原因':row.status==='skipped'?'跳过原因':'拦截原因'}：</strong>{info.reason}</p>
    {info.disposition&&<p className="send-disposition">{info.disposition}</p>}
    {info.detail&&<p className="send-disposition">{info.detail}</p>}
    {d&&<details className="send-diagnostic"><summary>查看发送诊断</summary><dl>
      <div><dt>检查阶段</dt><dd>{info.stageLabel}</dd></div>
      {d.containerCount!==undefined&&<div><dt>评论框</dt><dd>{d.containerCount} 个</dd></div>}
      {d.visibleEditorCount!==undefined&&<div><dt>可见编辑器</dt><dd>{d.visibleEditorCount} 个</dd></div>}
      {d.draftCount!==undefined&&<div><dt>已有草稿</dt><dd>{d.draftCount} 处</dd></div>}
      {d.editorFocused!==undefined&&<div><dt>页面内输入焦点</dt><dd>{d.editorFocused?'已就绪':'未就绪'}</dd></div>}
      <div><dt>是否尝试提交</dt><dd>{d.sendAttempted?'是，须核对回执':'否'}</dd></div>
    </dl></details>}
  </div>;
}
