export async function duoReply(models,input,{maxChars,recentVideos}={}){
 if(!models.openai||!models.deepseek)throw new Error('一问双答需要两个模型均已启用');
 if(maxChars<32)throw new Error('一问双答至少需要32字的回复上限');
 for(const p of ['openai','deepseek'])models[p].meter?.assertAvailable(p,models[p].config.model);
 const limit=Math.floor((maxChars-20)/2),providers=['openai','deepseek'];
 const results=await Promise.allSettled(providers.map(p=>models[p].reply({...input,stickers:[],stickerStatus:null,deliveryModes:[],draftOnly:true,maxChars:limit,recentVideos:recentVideos(p)})));
 const failed=results.find(r=>r.status==='rejected');if(failed)throw new Error('一问双答未完整生成：'+failed.reason.message);
 const values=results.map(r=>r.value),contributors=providers.map(p=>({provider:p,model:models[p].lastResponse?.model||models[p].config?.model||''}));
 if(values.every(v=>!v.shouldReply))return {shouldReply:false,text:'',reason:'两个模型均未生成需要发送的回答',contributors};
 const text=values.map((v,i)=>(i===0?'GPT：':'DeepSeek：')+(v.shouldReply?v.text:'本轮未生成可用观点。')).join('\n');
 if([...text].length>maxChars)throw new Error('双答合成结果超过字数上限');return {shouldReply:true,text,reason:'两模型分别生成后合并',delivery:'text',contributors};
}
