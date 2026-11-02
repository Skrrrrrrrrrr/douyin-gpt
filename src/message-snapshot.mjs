// 客户端临时 ID 变为服务器 ID 时，只接受同一平台消息对象给出的别名。
const ids=m=>new Set([m.id,...(m.aliases||[])].filter(x=>typeof x==='string'&&x));
export function sameMessageSnapshot(actual,expected){
 if(!Array.isArray(actual)||!Array.isArray(expected)||actual.length!==expected.length)return false;
 return actual.every((a,i)=>{const b=expected[i];if(a.from!==b.from||!a.id||!b.id)return false;const own=ids(a);if(![...ids(b)].some(id=>own.has(id)))return false;return ['text','item'].every(k=>!Object.hasOwn(b,k)||String(a[k]||'')===String(b[k]||''));});
}
export function snapshotMessages(messages){return messages.map(m=>({id:m.id,aliases:m.aliases||[],from:m.from,text:String(m.text||''),item:String(m.item||'')}));}
// 输入框高度变化会让抖音卸载最旧的 DOM 行。只容许旧前缀增减；
// 最近至少六行、最新输入、正文及归属必须一致，不能忽略新增的尾部消息。
export function sameMessageWindow(actual,expected){
 if(sameMessageSnapshot(actual,expected))return true;
 if(!Array.isArray(actual)||!Array.isArray(expected))return false;
 const count=Math.min(actual.length,expected.length);if(count<6)return false;
 const lastMine=expected.findLastIndex(m=>m.from==='me'),required=expected.slice(lastMine+1).filter(m=>m.from==='them');
 if(required.some(r=>!actual.some(a=>sameMessageSnapshot([a],[r]))))return false;
 return sameMessageSnapshot(actual.slice(-count),expected.slice(-count));
}
