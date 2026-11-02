export type Row=Record<string,any>;
export interface Provider extends Row {id:string;name:string;model:string;videos:number;videoLimit:number|null;comments:number;commentLimit:number|null;replies:number;replyLimit:number|null;voice:string;enabled:boolean}
export interface Video extends Row {id:string;desc:string;author:string;provider:string;day:string;watchedAt:string;analysis:Row}
export interface DashboardState extends Row {day:string;account:string;providers:Provider[];daemon:{running:boolean;stopping?:boolean};totalVideos:number;privateReplies:number;settings:Row;videos:Video[];replies:Row[];groupReplies?:Row[];groupChats?:Row;comments:Row[];alerts:Row[];memory:Row[];stickers:Row[];stickerStats:Row[];audience:Row[];series:Row[];takeovers:Row[];interests:Row[];interestProfiles?:Record<string,Row>;discovery:Row;analytics:Row;usage:Row;prices:Row;updatedAt:string}
export type Perform=(key:string,path:string,body:Row,message?:string)=>Promise<boolean>;
export interface PageProps {data:DashboardState;perform:Perform;busy:Record<string,boolean>;refresh:()=>Promise<void>;command:(key:string,path:string,body:Row,message?:string)=>Promise<Row|null>}
