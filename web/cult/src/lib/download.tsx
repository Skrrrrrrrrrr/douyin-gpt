import {useState,type ReactNode} from 'react';
import {downloadFile} from '../../../connection.js';
export function DownloadLink({path,className,children}:{path:string;className?:string;children:ReactNode}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  return <span><button type="button" className={className} disabled={busy} onClick={async()=>{if(busy)return;setBusy(true);setError('');try{await downloadFile(path);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>{busy?'正在下载…':children}</button>{error&&<span className="field-error" role="alert">{error}</span>}</span>;
}
