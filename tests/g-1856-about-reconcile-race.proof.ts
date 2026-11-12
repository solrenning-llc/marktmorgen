/** Current real confirmation/studio-write schedule: its rollback must not release a successor's actual text. */
import { addProduct, claimHandle, ensureStatsId, setProductAbout, setSubscription, storeForEmail } from "@/lib/store";
import { readAbout, writeAbout } from "@/lib/product-about";
import { proposeDescription } from "@/lib/agent-propose";
import { confirmFor } from "@/lib/agent-confirm";
import { dataKey } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done,is } from "./check";
async function main(){
 redis.clear();const owner="g-about-room@example.test";await claimHandle(owner,"gaboutroom","About room","");await ensureStatsId(owner);
 await setSubscription(owner,{customerId:"cus_AboutRoom00001",subscriptionId:"sub_AboutRoom00001",active:true,period:paidPeriod()});
 const p=await addProduct(owner,"Guide","A guide.","29",null);if(!p.ok)throw Error("missing fixture product");
 const id=p.product.id,shop=(await storeForEmail(owner))!;if(!shop.statsId)throw Error("missing stats id");const statsId=shop.statsId;
 const studio=async(text:string)=>{const m=await setProductAbout(owner,id,true);if(!m.ok)throw Error("mark refused");await writeAbout(statsId,id,text,m.store);};
 await studio("Original.");
 const proposed="Agent proposed text. ".repeat(150).trim(),creator="Creator keeps these words. ".repeat(25).trim();
 const r=await proposeDescription((await storeForEmail(owner))!,"key-g",{product:id,description:proposed});const proposal=JSON.parse(r.content[0].text).proposal;if(typeof proposal!=="string")throw Error("no proposal");
 const base=redis.pipeline.bind(redis);let injected=0, second=0; const newest="Latest studio text. ".repeat(200).trim();
 const about=`nl:product:about:${statsId}:${id}`;
 redis.pipeline=(async commands=>{
  const c=commands[0],write=commands.length===1&&((c[0]==="EVAL"&&String(c[1]).startsWith("-- marktmorgen:about-write-if:v1\n"))||(c[0]==="SET"&&c[1]===about));
  if(injected===0&&write){injected++;redis.pipeline=base;await studio(creator);redis.pipeline=spy;}
  const answer=await base(commands);
  if(write&&second===0){second++;redis.pipeline=base;await studio(newest);redis.pipeline=spy;}
  return answer;
 }) as typeof redis.pipeline;const spy=redis.pipeline;
 let result;
 try{result=await confirmFor({...((await storeForEmail(owner))!),statsId},owner,[proposal],owner);}finally{redis.pipeline=base;}
 const actual=await readAbout(statsId,id),[raw]=await base([["HGET",dataKey(shop)!,`ab:${id}`]]),kept=Number(raw??0),expected=dataBytes([actual],1);
 console.log("G actual about room",{injected,kept,expected,length:actual.length,done:result.done,refused:result.refused});
 is("another real studio write occurred in the admission/write gap",injected,1);
 is("creator's newer text is preserved by the CAS",actual,newest);
 is("second real writer ran after CAS before slot reconciliation",second,1);
 is("current text keeps its exact allocated room after rollback",kept,expected);
 done();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
