import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ArrowDown,ChevronUp,Download,Pause,Play,RefreshCw,Search,Terminal} from 'lucide-react';
import {apiFetch,downloadFile,loginUrl} from '../../connection.js';
import {Button,Empty,Input,PageHeading,Select,Tabs} from './ui';
import './service-logs.css';

type Level='info'|'warn'|'error'|'debug';
type LogEntry={id:string;level:Level;levelSource:string;at:string|null;time:string;message:string};
type Source={id:string;name:string;file:string;exists:boolean;bytes:number;updatedAt:string|null};
type Snapshot={entries:LogEntry[];source:Source;sources:Source[];startCursor:string|null;endCursor:string|null;hasEarlier:boolean;hasLater:boolean;reset:boolean;scannedBytes:number};
const sources:[string,string][]=[['dashboard','管理服务'],['assistant','自动任务'],['supervisor','服务守护'],['http','HTTP 请求']];
const labels:Record<Level,string>={info:'INFO',warn:'WARN',error:'ERROR',debug:'DEBUG'};
const bytes=(value:number)=>value<1024?`${value} B`:value<1048576?`${(value/1024).toFixed(1)} KiB`:`${(value/1048576).toFixed(1)} MiB`;
const clock=(value:string|null)=>value?new Date(value).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
const redirect=()=>location.replace(loginUrl()+'#logs');
async function read(path:string,signal:AbortSignal){
  const response=await apiFetch(path,{signal,cache:'no-store'});
  if(response.status===401){redirect();throw new Error('登录已过期，请重新登录');}
  const value=await response.json();if(!response.ok)throw new Error(value.error||'日志暂时无法读取');return value as Snapshot;
}

export function ServiceLogs(){
  const [source,setSource]=useState('dashboard'),[archive,setArchive]=useState('0'),[level,setLevel]=useState('all'),[search,setSearch]=useState(''),[query,setQuery]=useState('');
  const [rows,setRows]=useState<LogEntry[]>([]),[meta,setMeta]=useState<Source|null>(null),[live,setLive]=useState(true),[follow,setFollow]=useState(true),[loading,setLoading]=useState(true),[earlierLoading,setEarlierLoading]=useState(false),[downloading,setDownloading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[updatedAt,setUpdatedAt]=useState<string|null>(null),[hasEarlier,setHasEarlier]=useState(false),[version,setVersion]=useState(0);
  const viewport=useRef<HTMLDivElement>(null),generation=useRef(0),inFlight=useRef(false),cursors=useRef<{start:string|null;end:string|null}>({start:null,end:null}),controller=useRef<AbortController|null>(null),following=useRef(true),liveRef=useRef(true),fetchRef=useRef<(direction?:'after'|'before')=>Promise<void>>(async()=>{}),prepend=useRef<{height:number;top:number}|null>(null),mounted=useRef(true);
  const selection=JSON.stringify([source,archive,level,query]);
  useEffect(()=>{const timer=setTimeout(()=>setQuery(search.trim()),300);return()=>clearTimeout(timer);},[search]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;controller.current?.abort();};},[]);
  useEffect(()=>{
    const scope=++generation.current;controller.current?.abort();inFlight.current=false;cursors.current={start:null,end:null};prepend.current=null;following.current=true;setFollow(true);setRows([]);setMeta(null);setError('');setNotice('');setLoading(true);setEarlierLoading(false);setHasEarlier(false);setUpdatedAt(null);
    const fetchRows=async(direction?:'after'|'before')=>{
      if(inFlight.current||generation.current!==scope)return;
      const cursor=direction==='before'?cursors.current.start:direction==='after'?cursors.current.end:null;
      if(direction==='before'&&!cursor)return;
      inFlight.current=true;const request=new AbortController();controller.current=request;let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;request.abort();},20000);
      if(direction==='before')setEarlierLoading(true);
      try{
        const params=new URLSearchParams({source,archive,level,q:query,limit:'500',...(direction&&cursor?{[direction]:cursor}:{})});
        const result=await read('/api/logs?'+params,request.signal);
        if(generation.current!==scope||!mounted.current||(direction==='after'&&!liveRef.current))return;
        setMeta(result.source);setError('');setUpdatedAt(new Date().toISOString());
        if(result.reset)setNotice('日志文件已轮换或截短，已切换到当前文件。');
        if(direction==='before'&&!result.reset){
          if(viewport.current)prepend.current={height:viewport.current.scrollHeight,top:viewport.current.scrollTop};
          setRows(previous=>{const seen=new Set(previous.map(row=>row.id));return [...result.entries.filter(row=>!seen.has(row.id)),...previous].slice(0,5000);});
          cursors.current.start=result.startCursor;setHasEarlier(result.hasEarlier);
        }else if(direction==='after'&&!result.reset){
          setRows(previous=>{const seen=new Set(previous.map(row=>row.id));return [...previous,...result.entries.filter(row=>!seen.has(row.id))].slice(-5000);});
          cursors.current.end=result.endCursor;if(!cursors.current.start){cursors.current.start=result.startCursor;setHasEarlier(result.hasEarlier);}
        }else{
          setRows(result.entries);cursors.current={start:result.startCursor,end:result.endCursor};setHasEarlier(result.hasEarlier);
        }
      }catch(error){if(generation.current===scope&&mounted.current){if(timedOut)setError('日志读取超时，请重试');else if((error as Error).name!=='AbortError')setError((error as Error).message);}}
      finally{clearTimeout(timeout);if(generation.current===scope&&mounted.current){inFlight.current=false;setLoading(false);setEarlierLoading(false);}}
    };
    fetchRef.current=fetchRows;void fetchRows();
    return()=>{generation.current++;controller.current?.abort();};
  },[selection,version]);
  useEffect(()=>{
    liveRef.current=live;
    if(!live)return;
    const tick=()=>{if(document.visibilityState==='visible')void fetchRef.current('after');};
    const timer=setInterval(tick,2000);document.addEventListener('visibilitychange',tick);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',tick);};
  },[live,selection,version]);
  useLayoutEffect(()=>{
    const element=viewport.current;if(!element)return;
    if(prepend.current){element.scrollTop=prepend.current.top+element.scrollHeight-prepend.current.height;prepend.current=null;}
    else if(following.current)element.scrollTop=element.scrollHeight;
  },[rows]);
  useEffect(()=>{const element=viewport.current;if(!element)return;const observer=new ResizeObserver(()=>{if(following.current)element.scrollTop=element.scrollHeight;});observer.observe(element);return()=>observer.disconnect();},[]);
  const setFollowing=(value:boolean)=>{following.current=value;setFollow(value);if(value&&viewport.current)viewport.current.scrollTop=viewport.current.scrollHeight;};
  const toggleLive=()=>{liveRef.current=!live;setLive(!live);};
  const loadEarlier=()=>{liveRef.current=false;setLive(false);setFollowing(false);void fetchRef.current('before');};
  const download=async()=>{
    if(downloading)return;setDownloading(true);
    try{await downloadFile('/api/logs/download?'+new URLSearchParams({source,archive,level,q:query}));}
    catch(error){if((error as Error&{status?:number}).status===401)redirect();if(mounted.current)setError((error as Error).message);}
    finally{if(mounted.current)setDownloading(false);}
  };
  const warnings=rows.filter(row=>row.level==='warn').length,errors=rows.filter(row=>row.level==='error').length;
  return <div className="service-logs">
    <PageHeading title="服务日志" description="查看 Node 进程输出与 HTTP 请求，按来源、级别和关键词定位问题。" action={<><Button onClick={()=>void download()} isLoading={downloading} loadingText="导出中…" disabled={!meta?.exists}><Download size={15}/>下载筛选结果</Button><Button variant={live?'primary':'secondary'} onClick={toggleLive} aria-pressed={live}>{live?<Pause size={15}/>:<Play size={15}/>}<span>{live?'暂停实时刷新':'恢复实时刷新'}</span></Button></>}/>
    <Tabs value={source} onChange={value=>{setSource(value);setArchive('0');}} items={sources} label="日志来源"/>
    <div className="service-log-filters"><div className="service-log-search"><Input aria-label="搜索服务日志" value={search} onChange={event=>setSearch(event.target.value)} maxLength={200} placeholder="搜索关键词、请求路径或状态码" leadingSlot={<Search size={16}/>}/></div><Select label="日志级别" value={level} onChange={setLevel} options={[["all","全部级别"],["error","ERROR · 错误"],["warn","WARN · 警告"],["info","INFO · 信息"],["debug","DEBUG · 调试"]]}/>{source==='http'&&<Select label="请求日志文件" value={archive} onChange={value=>{setArchive(value);if(value!=='0'){liveRef.current=false;setLive(false);}}} options={[["0","当前文件"],["1","上一份文件"],["2","前两份文件"],["3","前三份文件"]]}/>}<Button aria-label="刷新日志" onClick={()=>setVersion(value=>value+1)} disabled={loading||earlierLoading}><RefreshCw size={15}/></Button></div>
    {error&&<div className="service-log-error" role="alert"><span>{error}{updatedAt?' · 上次成功 '+clock(updatedAt):''}</span><Button variant="ghost" onClick={()=>setVersion(value=>value+1)}>重试</Button></div>}
    {notice&&<div className="service-log-notice" role="status">{notice}</div>}
    <section className="service-log-panel" aria-label="服务日志查看器"><header className="service-log-toolbar"><div><Terminal size={17}/><b>{meta?.file||({dashboard:'dashboard.log',assistant:'assistant.log',supervisor:'supervisor.log',http:'http-requests.log'} as Record<string,string>)[source]}</b>{meta&&<span>{bytes(meta.bytes)}</span>}</div><span className={'service-log-live '+(live?'is-live':'')}><i/>{live?'每 2 秒刷新':'刷新已暂停'}{updatedAt?' · '+clock(updatedAt):''}</span></header>
      <div className="service-log-before"><Button variant="ghost" onClick={loadEarlier} isLoading={earlierLoading} loadingText="读取中…" disabled={!hasEarlier||loading||rows.length>=5000}><ChevronUp size={14}/>加载更早记录</Button><span>{rows.length>=5000?'已达 5000 条显示上限，更多内容可下载':'查看更早记录时暂停刷新'}</span></div>
      <div className="service-log-columns" aria-hidden="true"><span>北京时间</span><span>级别</span><span>日志内容</span></div>
      <div className="service-log-viewport" ref={viewport} tabIndex={0} role="log" aria-label="日志内容" aria-live="off" aria-busy={loading} onScroll={event=>{const el=event.currentTarget;const nearBottom=el.scrollHeight-el.scrollTop-el.clientHeight<30;following.current=nearBottom;setFollow(nearBottom);}}>
        {rows.map(row=><div className={'service-log-row log-level-'+row.level} key={row.id}><time title={row.at||'旧文本日志保留原始时间'}>{row.time||'—'}</time><span className="service-log-level" title={row.levelSource==='inferred'?'旧文本日志：按关键字识别级别':'由服务明确记录的日志级别'}>{labels[row.level]}</span><pre>{row.message}</pre></div>)}
        {!rows.length&&<div className="service-log-empty"><Terminal size={28}/><p>{loading?'正在读取日志…':error?'暂时无法读取日志':meta?.exists?'没有符合条件的日志':archive==='0'?'该服务还没有写入日志':'这份历史请求日志尚不存在'}</p>{!loading&&<span>{query||level!=='all'?'试试其他关键词或日志级别。':'服务产生输出后，这里会显示实际记录。'}</span>}</div>}
      </div>
      <footer className="service-log-footer"><span aria-live="polite">当前显示 {rows.length} 条<span className="service-log-count">ERROR {errors} · WARN {warnings}</span></span><button onClick={()=>setFollowing(true)} disabled={follow}><ArrowDown size={14}/>{follow?'正在跟随最新':'回到最新'}</button></footer>
    </section>
    <p className="service-log-help">显示和下载均会隐藏常见凭证。旧文本日志按关键字识别级别；HTTP 请求日志从本次更新开始记录，不保存请求正文、查询参数或认证信息。下载最多导出最近 10 MiB。</p>
  </div>;
}
