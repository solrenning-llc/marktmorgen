import {KIND} from "@/lib/catalog";
import {bumpsFromMeta,bundleFromMeta} from "@/lib/bundle-rules";
import type {Store} from "@/lib/store";
export type LeverKey="bump"|"upsell"|"downsell"|"bundle"|"recovery"|"next";
type PaidRecord={created:number;cents:number;currency:string;upsell:boolean;row:Record<string,unknown>};
export type LeverMeasure={records:number;cents:number|null;scope:string};
export type LeverReading={asOf:string;from:string;currency:string;complete:boolean;rows:Record<LeverKey,LeverMeasure>};
/** Existing settled payment records only. No extra query, event write, forecast or inferred line-item allocation. */
export function measureSalesLevers(sales:readonly PaidRecord[],currency:string,partial:boolean,now=Date.now()):LeverReading{
 const end=new Date(now),from=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth(),end.getUTCDate())-29*86400000);
 const rows:Record<LeverKey,LeverMeasure>={
 bump:{records:0,cents:null,scope:"Whole checkout payments tagged with an order bump; the bump's separate paid amount is not measured."},
 upsell:{records:0,cents:null,scope:"After-checkout offer payments, including downsells. Existing payment metadata does not distinguish the two."},
 downsell:{records:0,cents:null,scope:"Downsell-only revenue is not separately identified in existing payment records."},
 bundle:{records:0,cents:null,scope:"Whole checkout payments tagged with a bundle; other items, discounts and tax can be included."},
 recovery:{records:0,cents:null,scope:"Payments carrying Stripe's recovered_from marker only; not all reminder outcomes are attributable."},
 next:{records:0,cents:null,scope:"A next-offer-specific paid amount is not separately identified in existing records."}
 };
 const totals={bump:0,upsell:0,bundle:0,recovery:0};let complete=!partial;
 for(const sale of sales){
  if(!Number.isFinite(sale.created)){complete=false;continue;}
  if(sale.created<from.getTime()||sale.created>now||sale.currency!==currency)continue;
  if(!Number.isSafeInteger(sale.cents)||sale.cents<0){complete=false;continue;}
  const meta=sale.row.metadata&&typeof sale.row.metadata==="object"&&!Array.isArray(sale.row.metadata)?sale.row.metadata as Record<string,string>:{};
  const add=(key:keyof typeof totals)=>{rows[key].records++;totals[key]+=sale.cents;if(!Number.isSafeInteger(totals[key]))complete=false;};
  if(sale.upsell)add("upsell");
  else{
   if(bumpsFromMeta(meta).length)add("bump");
   if(bundleFromMeta(meta,"bundle").length)add("bundle");
   if(typeof sale.row.recovered_from==="string"&&sale.row.recovered_from.startsWith("cs_"))add("recovery");
  }
 }
 // Tagged subsets are displayed only when present. No tag is unknown attribution, not proof of zero revenue.
 if(complete)for(const key of ["bump","upsell","bundle","recovery"] as const)if(rows[key].records>0)rows[key].cents=totals[key];
 return {asOf:end.toISOString(),from:from.toISOString(),currency,complete,rows};
}
/** The saved on/off state of the two levers that have a setting, in the words the card shows (also after its own switch). */
export function leverStateText(key:"recovery"|"next",on:boolean):string{
 if(!on)return "Off in saved settings";
 return key==="next"?"Enabled in saved settings; add-on gates still apply":"Enabled in saved settings";
}
export function salesLeverSettings(store:Store){
 const visible=store.catalog.items.filter(item=>(item.kind&KIND.hidden)===0),loaded=store.catalog.head.filter(item=>!item.hidden);
 const funnel=visible.some(item=>(item.kind&KIND.funnel)!==0);
 return [
 {key:"bump" as const,title:"Order bump",state:loaded.some(product=>product.bumps.length>0)?"Configured in loaded product records":"Not established from loaded product records",path:"#products",cost:"Available when you choose an optional product and price; the buyer must select it."},
 {key:"upsell" as const,title:"Upsell",state:funnel?"A funnel is configured; review its offer steps":"No visible product funnel is configured",path:"#products",cost:"Configure a real product and its terms; the buyer chooses whether to accept."},
 {key:"downsell" as const,title:"Downsell",state:funnel?"A funnel is configured; review its decline path":"No visible product funnel is configured",path:"#products",cost:"A decline path needs your product choices; no offer or charge is invented."},
 {key:"bundle" as const,title:"Bundle",state:visible.some(item=>(item.kind&KIND.bundle)!==0)?"A visible bundle is configured":"No visible bundle is configured",path:"bundles",cost:"Available for your chosen products and published terms; no buyer is charged automatically."},
 {key:"recovery" as const,title:"Checkout recovery",state:leverStateText("recovery",store.recovery.enabled),path:"#recovery",cost:"Email, consent, sender, allowance and cost gates apply. Not automatically enabled."},
 {key:"next" as const,title:"Next offer",state:leverStateText("next",store.nextOffer.on),path:"#answers",cost:"Store assistant add-on, data reads and optional AI have their own caps and reservation. Not automatically enabled."},
 ];
}
