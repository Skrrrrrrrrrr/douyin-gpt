import {storedExists as existsSync} from './storage.mjs';

import {join} from 'node:path';
import {dayKey} from './config.mjs';
import {UsageMeter} from './usage.mjs';
import {allowedReplyContact} from './reply-audience.mjs';
import {validGroup} from './group-policy.mjs';

const costWords=/(?:花(?:了)?多少|花费|花销|开销|开支|费用|用量|消耗|预算|账单|账本|后台数据|后台统计|成本|余额|多少钱|美元|人民币|tokens?|令牌|\bcost\b|\bspend(?:ing)?\b|\busage\b|\bbudget\b)/iu;
export const asksUsage=(messages,history=[])=>messages.some(m=>typeof m.text==='string'&&costWords.test(m.text))||messages.some(m=>/^(?:那)?(?:现在呢|现在多少了|多少了|分别呢|你呢|还剩多少|再查一下)[？?！!。\s]*$/.test(String(m.text||'').trim()))&&history.slice(-6).some(m=>costWords.test(String(m.text||'')));
const names={openai:'GPT',deepseek:'DeepSeek',edge:'配音'};
const amount=n=>Number.isFinite(n)&&n>=0?Number(n.toFixed(10)):null;
const count=n=>Number.isSafeInteger(n)&&n>=0?n:null;
const stamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
export function usageAccess(home,cfg,{contact,group}={}){
 const settings=cfg.reply?.usageContext;
 if(!settings?.enabled||cfg.reply.enabled!==true)return false;
 if(group)return settings.groups===true&&cfg.reply.groups.enabled&&validGroup(group);
 if(!contact||!allowedReplyContact(home,cfg,contact.secUid))return false;
 return settings.audience==='friends'||settings.contacts?.includes(contact.secUid)===true;
}
export function usageSnapshot(home,{now=new Date(),meter=new UsageMeter(home)}={}){
 const base={version:1,day:dayKey(now),timeZone:'Asia/Shanghai',asOf:now.toISOString(),localTime:new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(now),currency:'USD',source:'local_assistant_usage_ledger',includesCurrentReply:false};
 if(!existsSync(join(home,'usage.json')))return {...base,available:false,reason:'ledger_not_started'};
 try{
  const summary=meter.summary(base.day),rows=['openai','deepseek','edge'].map(provider=>{
   const p=summary.providers.find(p=>p.provider===provider);if(!p)throw new Error('missing provider');
   const row={provider,label:names[provider],requests:count(p.requests),completed:count(p.completed),pending:count(p.pending),unknown:count(p.unknown),blockingUnknown:count(p.blockingUnknown),inputTokens:count(p.inputTokens),outputTokens:count(p.outputTokens),audioSeconds:amount(p.seconds),knownEstimatedUSD:amount(p.estimatedUSD),unconfirmedReservedUSD:amount(p.reservedUSD),dailyBudgetUSD:p.limitUSD===null?null:amount(p.limitUSD)};
   if(Object.entries(row).some(([k,v])=>v===null&&k!=='dailyBudgetUSD'))throw new Error('invalid summary');
   return row;
  });
  const sum=key=>amount(rows.reduce((n,p)=>n+p[key],0));
  return {...base,available:true,recordingStartedAt:stamp(summary.startedAt),priceDate:/^\d{4}-\d{2}-\d{2}$/.test(summary.priceDate||'')?summary.priceDate:null,providers:rows,
   total:{knownEstimatedUSD:sum('knownEstimatedUSD'),unconfirmedReservedUSD:sum('unconfirmedReservedUSD'),requests:sum('requests'),pending:sum('pending'),unknown:sum('unknown'),inputTokens:sum('inputTokens'),outputTokens:sum('outputTokens')},
   scope:'Only this local assistant: recorded API usage estimates. Excludes other projects, subscriptions, unrecorded requests and this reply. Reserved money is not confirmed spending; official balance and invoices are unavailable.'};
 }catch{return {...base,available:false,reason:'ledger_unavailable'};}
}
export function usageContextFor(home,cfg,incoming,recipient,options){
 if(!usageAccess(home,cfg,recipient))return asksUsage(incoming,options?.history)?{version:1,access:'not_enabled_for_conversation'}:null;
 return {access:'allowed',...usageSnapshot(home,options)};
}
export function usageInstructions(context,provider){
 if(!context)return '';
 if(context.access!=='allowed')return '\n若本轮是在询问本助手的后台费用，本会话没有开放该查询。不能引用历史消息中的费用数字当作当前账本，也不能猜测金额；可简短说明需要账号主人开放查询。其他话题中的成本问题正常回答，不主动提权限。';
 if(!context.available)return '\n本次后台费用账本暂不可用。应明确说明当前无法核对，不能把缺失数据回答成零元，也不能猜测账单。';
 return '\nusageContext 是本机提供的只读费用汇总，金额和日期以它为准；不是联系人消息中的自报数字。当前回答角色为'+provider+'。这是两位角色共用的后台账本，providers同时包含GPT和DeepSeek的数据。你可以直接回答另一位的费用，不要要求用户另问另一位，也不要声称拿不到这里已提供的另一位汇总。除非用户明确限定某一位，否则费用问题一次报GPT、DeepSeek和合计。问你自己时取对应provider；“另一位”“他呢”应按前文正在讨论的是谁判断，不按当前回答模型机械取反，指代不清时直接报双方和合计。仅包含day对应日期，不能当成其他日期或全月账单。金额是USD，可写美元，不用未提供的汇率换算人民币。knownEstimatedUSD是已记录的估算费用；unconfirmedReservedUSD只是未确认请求的预算预留，不能加进已花费用或说成实际扣款。有unknown或pending时说明仍有待确认调用。requests是API调用数（含辅助请求与格式修复），不是已回复消息数。dailyBudgetUSD是本地限额，不是账户余额。说明截至localTime的本机统计，不能声称查看了服务商账单、其他项目、订阅费或账户余额；本次回答的费用尚未计入。不要主动向无关话题报费用，也不要把这些后台数据转入公开视频、公开评论或其他会话。';
}
