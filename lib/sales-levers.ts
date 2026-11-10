import {KIND} from "@/lib/catalog";
import type {Store} from "@/lib/store";
import {leverEarnings,type LeverKey,type LeverReading,type PaidRecord} from "@/lib/lever-earnings";
export type {LeverKey,LeverReading};
/** What each lever earned in the last 30 days, from the paid records the kept sales reading already holds (lib/lever-earnings.ts). No extra query, event write, forecast or inferred allocation. */
export function measureSalesLevers(sales:readonly PaidRecord[],currency:string,partial:boolean,now=Date.now()):LeverReading{
 return leverEarnings(sales,currency,partial,now);
}
export function salesLeverSettings(store:Store){
 const visible=store.catalog.items.filter(item=>(item.kind&KIND.hidden)===0),loaded=store.catalog.head.filter(item=>!item.hidden);
 const funnel=visible.some(item=>(item.kind&KIND.funnel)!==0);
 return [
 {key:"bump" as const,title:"Order bump",state:loaded.some(product=>product.bumps.length>0)?"Configured in loaded product records":"Not established from loaded product records",path:"#products",cost:"Available when you choose an optional product and price; the buyer must select it."},
 {key:"upsell" as const,title:"Upsell",state:funnel?"A funnel is configured; review its offer steps":"No visible product funnel is configured",path:"#products",cost:"Configure a real product and its terms; the buyer chooses whether to accept."},
 {key:"downsell" as const,title:"Downsell",state:funnel?"A funnel is configured; review its decline path":"No visible product funnel is configured",path:"#products",cost:"A decline path needs your product choices; no offer or charge is invented."},
 {key:"bundle" as const,title:"Bundle",state:visible.some(item=>(item.kind&KIND.bundle)!==0)?"A visible bundle is configured":"No visible bundle is configured",path:"bundles",cost:"Available for your chosen products and published terms; no buyer is charged automatically."},
 {key:"recovery" as const,title:"Checkout recovery",state:store.recovery.enabled?"Enabled in saved settings":"Off in saved settings",path:"#recovery",cost:"Email, consent, sender, allowance and cost gates apply. Not automatically enabled."},
 {key:"next" as const,title:"Next offer",state:store.nextOffer.on?"Enabled in saved settings; add-on gates still apply":"Off in saved settings",path:"#answers",cost:"Store assistant add-on, data reads and optional AI have their own caps and reservation. Not automatically enabled."},
 ];
}
