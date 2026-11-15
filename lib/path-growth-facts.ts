import type {Store} from "@/lib/store";
import {KIND,readProductsStrict} from "@/lib/catalog";
import {readBroadcastHeads} from "@/lib/broadcasts";
import {pathBuyerReview} from "@/lib/reviews";
import {isRedisConfigured} from "@/lib/redis";
import type {PathMoney} from "@/lib/path-facts";
import type {PathGrowthFacts} from "@/lib/path-growth-rules";
/** An internal reservation within the existing studio allowance, not a plan limit. */
export const PATH_GROWTH_READ_UNITS=8;
export const PATH_GROWTH_PRODUCTS=8;
export const PATH_GROWTH_CAMPAIGNS=3;
export const PATH_GROWTH_REVIEWS=3;
export const UNKNOWN_GROWTH:PathGrowthFacts={realSale:false,fileProducts:null,listEmailSent:null,repeatBuyer:null,postPurchaseOffer:null,buyerReview:null,keptOrders:null};
/**
 * The newest emails are read without their bodies, and what reading them comes to is taken through `charge` before
 * any is read (lib/broadcasts.ts, readBroadcastHeads): PATH_GROWTH_READ_UNITS pays for the products and the reviews.
 * Not taken, or not read: whether an email was sent stays unknown, never "none".
 */
const emailsPaidFirst=(charge:(units:number)=>Promise<boolean>)=>async(units:number)=>{
 let taken=false;
 try{taken=await charge(units);}catch{/* An unavailable allowance is not evidence. */}
 return taken?{ok:true as const}:{ok:false as const,message:"Not enough studio requests left to read your emails."};
};
/** No provider call, new data family or raw buyer identity leaves this reader. */
export async function readPathGrowth(store:Store,money:PathMoney|null,charge:(units:number)=>Promise<boolean>):Promise<{facts:PathGrowthFacts;read:boolean}>{
 const facts:PathGrowthFacts={...UNKNOWN_GROWTH,realSale:Boolean(money&&money.real>0&&money.cents!==null),repeatBuyer:money?.growth?.repeatBuyer??null,keptOrders:money?.growth?.keptOrders??null};
 if(!facts.realSale||!isRedisConfigured())return {facts,read:false};
 let admitted=false;
 try{admitted=await charge(PATH_GROWTH_READ_UNITS);}catch{/* An unavailable allowance is not evidence. */}
 if(!admitted)return {facts,read:false};
 const listed=store.catalog.items.filter(item=>(item.kind&KIND.hidden)===0);
 const ids=listed.slice(0,PATH_GROWTH_PRODUCTS).map(item=>item.id);
 const [products,campaigns,reviews]=await Promise.allSettled([
  readProductsStrict(store,ids),
  readBroadcastHeads(store.listId,emailsPaidFirst(charge),PATH_GROWTH_CAMPAIGNS).then(read=>{if(!read.ok)throw new Error(read.refused);return read.heads;}),
  pathBuyerReview(store.statsId,new Set(listed.map(item=>item.id)),PATH_GROWTH_REVIEWS),
 ]);
 if(products.status==="fulfilled"){
  const own=new Set(ids);
  const found=products.value.filter(product=>own.has(product.id)&&!product.hidden);
  const files=found.filter(product=>Boolean(product.file||product.options.some(option=>option.file))).length;
  const complete=listed.length<=PATH_GROWTH_PRODUCTS&&found.length===listed.length;
  facts.fileProducts=files>=2||complete?files:null;
  const offer=found.some(product=>Boolean(product.funnel?.steps.length));
  facts.postPurchaseOffer=offer?true:complete?false:null;
 }
 if(campaigns.status==="fulfilled"){
  const own=campaigns.value.filter(campaign=>campaign.listId===store.listId&&campaign.handle===store.handle);
  const sent=own.some(campaign=>campaign.status==="sent"&&campaign.sent>0&&campaign.finishedAt>0);
  facts.listEmailSent=sent?true:own.length===campaigns.value.length&&own.length<PATH_GROWTH_CAMPAIGNS?false:null;
 }
 if(reviews.status==="fulfilled")facts.buyerReview=reviews.value;
 return {facts,read:true};
}
