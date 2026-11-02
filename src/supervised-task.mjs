// A long render/upload must not suspend the supervisor heartbeat or service recovery loop.
export async function supervisePending(task,onTick,{intervalMs=15000,onTickError=()=>{}}={}){
 const settled=Promise.resolve().then(task).then(value=>({done:true,ok:true,value}),error=>({done:true,ok:false,error}));
 while(true){
  let timer;const tick=new Promise(resolve=>{timer=setTimeout(()=>resolve({done:false}),intervalMs);});
  const result=await Promise.race([settled,tick]);clearTimeout(timer);
  if(result.done){if(!result.ok)throw result.error;return result.value;}
  try{await onTick();}catch(error){try{onTickError(error);}catch{}}
 }
}
