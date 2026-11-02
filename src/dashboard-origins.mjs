import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {atomicJson} from './store.mjs';

export function dashboardOrigin(value) {
  if(typeof value!=='string')throw new Error('管理页面来源需要完整网址');
  let url;try{url=new URL(value);}catch{throw new Error('管理页面来源网址无效');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.hostname.includes('*')||url.origin==='null')throw new Error('只允许明确的 HTTP 或 HTTPS 来源，不能包含路径、通配符或登录信息');
  return url.origin;
}
export function dashboardOrigins(home) {
  const file=join(home,'dashboard-origins.json');if(!existsSync(file))return [];
  let value;try{value=JSON.parse(readFileSync(file,'utf8'));}catch{throw new Error('管理页面来源配置损坏，已拒绝跨站连接');}
  if(value?.version!==1||!Array.isArray(value.origins)||value.origins.length>8)throw new Error('管理页面来源配置无效');
  return [...new Set(value.origins.map(dashboardOrigin))];
}
export function setDashboardOrigins(home,origins) {
  if(!Array.isArray(origins)||origins.length>8)throw new Error('管理页面来源最多配置八个');
  const clean=[...new Set(origins.map(dashboardOrigin))];atomicJson(join(home,'dashboard-origins.json'),{version:1,origins:clean});return clean;
}
export function prepareDashboardCors(req,res,home,origin) {
  const incoming=req.headers.origin,remote=Boolean(incoming&&incoming!==origin);
  if(remote&&!dashboardOrigins(home).includes(incoming))return {allowed:false,remote};
  if(req.headers['sec-fetch-site']==='cross-site'&&!remote)return {allowed:false,remote};
  if(remote){res.setHeader('access-control-allow-origin',incoming);res.setHeader('vary','Origin');res.setHeader('access-control-expose-headers','Retry-After, Content-Disposition');}
  if(req.method==='OPTIONS'){
    const headers=String(req.headers['access-control-request-headers']||'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
    if(!remote||!req.url.startsWith('/api/')||!['GET','POST'].includes(req.headers['access-control-request-method'])||headers.some(h=>!['authorization','content-type','range'].includes(h)))return {allowed:false,remote};
    res.setHeader('access-control-allow-methods','GET, POST, OPTIONS');res.setHeader('access-control-allow-headers','Authorization, Content-Type, Range');res.setHeader('access-control-max-age','300');
    if(req.headers['access-control-request-private-network']==='true')res.setHeader('access-control-allow-private-network','true');
    res.writeHead(204);res.end();return {allowed:true,remote,preflight:true};
  }
  return {allowed:true,remote};
}
