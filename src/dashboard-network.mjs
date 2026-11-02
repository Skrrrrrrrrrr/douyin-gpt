import {isIP} from 'node:net';

export function dashboardPublicUrl(value=''){
 if(value==='')return '';
 let url;try{url=new URL(value);}catch{throw new Error('管理服务公开地址需要完整 HTTP 或 HTTPS 网址');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.hostname.includes('*'))throw new Error('管理服务公开地址不能包含路径、凭据、参数或通配符');
 return url.origin;
}
export function dashboardNetwork({host='127.0.0.1',publicUrl=''}={}){
 if(typeof host!=='string'||!host||host.length>253||!(/^[A-Za-z0-9.-]+$/.test(host)||isIP(host)))throw new Error('管理服务监听地址需要有效的主机名或 IP');
 return {host,publicUrl:dashboardPublicUrl(publicUrl)};
}
export function dashboardRequestOrigin(req,port,{host,publicUrl}){
 const authority=req.headers.host;
 if(typeof authority!=='string'||/[\s,@\\/?#]/.test(authority)||!req.url?.startsWith('/')||req.url.startsWith('//'))return null;
 let incoming;try{incoming=new URL('http://'+authority);}catch{return null;}
 if(!incoming.hostname||incoming.username||incoming.password)return null;
 // A configured reverse-proxy address defines the scheme. Forwarded headers
 // alone cannot turn an arbitrary Host into a trusted management origin.
 if(publicUrl){const external=new URL(publicUrl);if(new URL(external.protocol+'//'+authority).origin===external.origin)return external.origin;}
 const name=incoming.hostname.replace(/^\[|\]$/g,''),actualPort=Number(incoming.port||80);
 if(actualPort!==port)return null;
 if(isIP(name)||name==='localhost'||!['0.0.0.0','::'].includes(host)&&name===host.toLowerCase())return incoming.origin;
 return null;
}
export function dashboardUrl(network,port){
 if(network.publicUrl)return network.publicUrl;
 const host=['0.0.0.0','::'].includes(network.host)?'127.0.0.1':network.host;
 return `http://${isIP(host)===6?'['+host+']':host}:${port}`;
}
