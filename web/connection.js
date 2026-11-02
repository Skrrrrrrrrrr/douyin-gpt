const TOKEN=/^[a-f0-9]{64}$/;
export function normalizeBackendUrl(value){
  let url;try{url=new URL(value);}catch{throw new Error('请输入完整的管理服务地址');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.hostname.includes('*'))throw new Error('服务地址须为 HTTP 或 HTTPS，不能包含路径、凭据或参数');
  return url.origin;
}
const read=(storage,key)=>{try{return storage?.getItem(key)||'';}catch{return '';}};
const write=(storage,key,value)=>{try{value?storage?.setItem(key,value):storage?.removeItem(key);}catch{}};
export function createBackendClient({pageUrl,hosted=false,backendUrl,storage,sessionStorage,fetchImpl=(...args)=>globalThis.fetch(...args),createUrl=blob=>URL.createObjectURL(blob),revokeUrl=url=>URL.revokeObjectURL(url)}={}){
  const page=new URL(pageUrl||globalThis.location?.href||'http://localhost/'),directory=new URL('.',page);
  const prefix='liuzuo:'+directory.pathname,baseKey=prefix+':backend';let base=page.origin;
  if(hosted)try{base=normalizeBackendUrl(read(storage,baseKey)||backendUrl||page.origin);}catch{base=normalizeBackendUrl(backendUrl||page.origin);}
  const tokenKey=()=>prefix+':session:'+base;let token=read(sessionStorage,tokenKey());if(!TOKEN.test(token))token='';
  const resources=new Map(),listeners=new Set();let version=0,generation=0,revision='';
  const changed=()=>{version++;for(const listener of listeners)listener();};
  const clearResources=()=>{generation++;for(const item of resources.values())if(item.url)revokeUrl(item.url);resources.clear();changed();};
  const setToken=value=>{token=TOKEN.test(value)?value:'';write(sessionStorage,tokenKey(),token);clearResources();};
  const url=path=>{if(typeof path!=='string'||!path.startsWith('/api/'))throw new Error('本机接口路径无效');const target=new URL(path,base);if(target.origin!==base||!target.pathname.startsWith('/api/'))throw new Error('本机接口路径无效');return target.href;};
  async function request(path,options={}){
    const target=url(path),headers=new Headers(options.headers);
    if(hosted){headers.delete('authorization');if(token)headers.set('authorization','Bearer '+token);}
    let response;try{response=await fetchImpl(target,{...options,headers,mode:hosted?'cors':'same-origin',credentials:hosted?'omit':'same-origin',redirect:'error'});}catch(error){if(['AbortError','TimeoutError'].includes(error.name))throw error;throw new Error('无法连接管理服务，请确认地址正确且服务可访问。');}
    if(hosted){
      if(response.status===401&&!path.startsWith('/api/auth/login'))setToken('');
      if(response.ok&&['/api/auth/login','/api/auth/password'].includes(path)){
        const data=await response.clone().json();if(!TOKEN.test(data.accessToken||''))throw new Error('服务未返回有效的登录会话，请检查服务版本和地址');setToken(data.accessToken);
      }
      if(response.ok&&path==='/api/auth/logout')setToken('');
      if(response.ok&&path==='/api/auth/session'&&!(await response.clone().json()).authenticated)setToken('');
    }
    return response;
  }
  function resource(path){
    if(!path.startsWith('/api/media?'))throw new Error('媒体接口路径无效');
    if(!hosted)return path;
    if(!token)return undefined;
    let entry=resources.get(path);if(entry&&(!entry.failedUntil||entry.failedUntil>Date.now()))return entry.url;
    entry={url:undefined,failedUntil:0};resources.set(path,entry);const current=generation;
    entry.promise=(async()=>{try{const response=await request(path);if(!response.ok)throw new Error('媒体暂时无法读取');const blob=await response.blob();if(current!==generation||resources.get(path)!==entry)return;entry.url=createUrl(blob);changed();}catch{if(current===generation&&resources.get(path)===entry){entry.failedUntil=Date.now()+60000;changed();}}})();
    return undefined;
  }
  async function download(path){
    if(!['/api/backup-key','/api/backup-file','/api/logs/download'].includes(new URL(url(path)).pathname))throw new Error('下载接口不允许');
    const response=await request(path);if(!response.ok){let data;try{data=await response.json();}catch{}throw Object.assign(new Error(data?.error||'文件暂时无法下载'),{status:response.status});}
    const disposition=response.headers.get('content-disposition')||'',match=/filename="?([^";]+)"?/.exec(disposition);
    return {blob:await response.blob(),filename:(match?.[1]||'download').replace(/[\\/\r\n]/g,'_').slice(0,128)};
  }
  return {hosted,request,resource,download,url,hasSession:()=>!!token,getBase:()=>base,
    setBase(value){const next=normalizeBackendUrl(value);if(!hosted)return;if(next!==base){setToken('');base=next;token='';write(sessionStorage,tokenKey(),'');write(storage,baseKey,base);}},
    clearResources,subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},version:()=>version,
    setRevision(value){if(value!==revision){revision=value;clearResources();}},
    loginUrl(change=false){return (hosted?new URL('login.html',directory).href:page.origin+'/login')+(change?'?password=change':'');},
    appUrl:()=>hosted?new URL('index.html',directory).href:page.origin+'/',
    assetUrl:path=>new URL(path.replace(/^\/+/,''),directory).href};
}
const browser=typeof window!=='undefined';
export const isHosted=browser&&document.documentElement.dataset.hostedDashboard==='true';
const client=browser?createBackendClient({pageUrl:location.href,hosted:isHosted,backendUrl:document.querySelector?.('meta[name="douyin-backend-url"]')?.content,storage:window.localStorage,sessionStorage:window.sessionStorage}):null;
export const apiFetch=(...args)=>client.request(...args);
export const mediaUrl=path=>client.resource(path);
export const subscribeMedia=listener=>client.subscribe(listener);
export const mediaVersion=()=>client.version();
export const setMediaRevision=value=>client.setRevision(value);
export const getBackendUrl=()=>client.getBase();
export const backendApiUrl=path=>client.url(path);
export const setBackendUrl=value=>client.setBase(value);
export const hasRemoteSession=()=>client.hasSession();
export const loginUrl=change=>client.loginUrl(change);
export const appUrl=()=>client.appUrl();
export const assetUrl=path=>client.assetUrl(path);
export async function downloadFile(path){const {blob,filename}=await client.download(path),url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=filename;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
if(browser)window.addEventListener('pagehide',()=>client.clearResources());
