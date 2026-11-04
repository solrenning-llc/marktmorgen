/** Read-only C2 precheck. No operation, price, allowance or sales gate is changed. */
import {PLAN_PRICES,PLAN_TITLES,TIERS,monthlyEmails,type Tier,type Cycle} from "@/lib/plan";
import {STORE_ALLOWANCES} from "@/lib/store-allowance-rules";
import {VISITS_INCLUDED} from "@/lib/traffic-rules";
import {ORDERS_INCLUDED} from "@/lib/order-rules";
import {paidStorageBytes} from "@/lib/storage-rules";
import {PAID_VIDEO_HOURS} from "@/lib/video-admission-rules";
import {captureCustomerTaxInput,type CustomerTaxInput} from "@/lib/customer-tax-review";
import {reviewedUnitUnder} from "@/lib/reviewed-receiving";

export type CapacityKey=`${Tier}_${Cycle}`;
/** The complete non-receiving cost of full rights must be explicit, not a
 * supplier quote inferred from a registry or unknown quantities entered as0. */
export type CapacityReviewInput={taxInput:CustomerTaxInput|null;fullUsageCeilingCents:number|null};
export type CapacityInputs=Partial<Record<CapacityKey,CapacityReviewInput|null>>;
const cents=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
function own(value:unknown,key:string):unknown{
 try{if(!value||typeof value!=='object'||Array.isArray(value))return undefined;const d=Object.getOwnPropertyDescriptor(value,key);return d&&d.enumerable&&Object.hasOwn(d,'value')?d.value:undefined;}catch{return undefined;}
}
function scoped(value:unknown,key:CapacityKey):CustomerTaxInput|null{
 const captured=captureCustomerTaxInput(value);
 if(!captured||captured.taxContext?.scenario!==key+'_full'||captured.taxContext.months!==(key.endsWith('_year')?12:1))return null;
 return captured;
}
/** Arithmetic, even a known loss, never approves or rules out supplier capacity. */
export function capacityStatus(priceCents:number):'unreviewed'{
 if(!Number.isSafeInteger(priceCents)||priceCents<=0)throw Error('Unknown price is not capacity');
 return 'unreviewed';
}
export function capacityWindows(cycle:Cycle):number{if(cycle!=='month'&&cycle!=='year')throw Error('Unknown payment interval is not a window count');return cycle==='year'?12:1;}
export function capacityQuantities(tier:Tier,cycle:Cycle){
 if(!TIERS.includes(tier))throw Error('Unknown plan is not an entitlement count');
 const windows=capacityWindows(cycle),storageGiB=paidStorageBytes(tier)/(1024**3);
 return {windows,emails:monthlyEmails(tier)*windows,buyerActions:STORE_ALLOWANCES[tier].buyer*windows,visits:VISITS_INCLUDED[tier]*windows,orders:ORDERS_INCLUDED[tier]*windows,storageGiB,storageGiBMonths:storageGiB*windows,videoHours:PAID_VIDEO_HOURS[tier]*windows};
}
/** An absolute reviewed amount, never15.38%, an IOF-on-profit shortcut or a
 * claimed maximum. Unknown usage or incomplete evidence remains unknown. */
export function capacityTaxCeilingCents(priceCents:number,usageCeilingCents:number|null,input:CustomerTaxInput|null):number|null{
 if(!cents(priceCents)||priceCents===0||!cents(usageCeilingCents))return null;
 return reviewedUnitUnder(priceCents,usageCeilingCents,input)?.taxCents??null;
}
export function capacityRows(inputs:CapacityInputs={}){
 return TIERS.flatMap(tier=>(['month','year'] as const).map(cycle=>{
  const key:CapacityKey=`${tier}_${cycle}`,priceCents=PLAN_PRICES[tier][cycle];
  const supplied=own(inputs,key),input=scoped(own(supplied,'taxInput'),key),usage=own(supplied,'fullUsageCeilingCents');
  const full=input&&cents(usage)?reviewedUnitUnder(priceCents,usage,input):null;
  // Explicit zero is only a counterfactual: no supplier's cost is declared0.
  // The exact same review must cover its greater pretax base too.
  const zeroUsage=input?reviewedUnitUnder(priceCents,0,input):null;
  return {tier,cycle,priceCents,full,zeroUsage,taxCeilingCents:full?.taxCents??zeroUsage?.taxCents??null,status:capacityStatus(priceCents),maximum:null,...capacityQuantities(tier,cycle)};
 }));
}
const percent=(bps:number)=>(bps/100).toFixed(2)+'%';
export function capacityModelLines(inputs:CapacityInputs={}):string[]{
 return capacityRows(inputs).map(row=>'| '+PLAN_TITLES[row.tier]+' | '+row.cycle+' | $'+(row.priceCents/100).toFixed(2)+' | '+(row.full?percent(row.full.netBps):'unknown')+' | '+(row.zeroUsage?percent(row.zeroUsage.netBps):'unknown')+' | '+row.status+'; no approved maximum |');
}
export function capacityQuantityLines():string[]{
 return capacityRows().map(r=>'| '+PLAN_TITLES[r.tier]+' | '+r.cycle+' | '+[r.windows,r.emails,r.buyerActions,r.visits,r.orders,r.storageGiB,r.storageGiBMonths,r.videoHours].join(' | ')+' |');
}
export function capacityInputLines():string[]{
 return [
  'Current TX precheck: no scoped CustomerTaxInput or complete paid full-use ceiling is supplied; all fiscal ceilings, net results and approved maxima are unknown.',
  'Tax ceilings are absolute USD cents calculated from complete scoped annual BRL books, explicit incoming exchange operations, dated sources/facts and both reviewed FX ceilings; a15%/38bps metadata profile supplies no bound.',
  'Zero usage is a counterfactual only, not a zero supplier cost. Existing prices, entitlements, twelve annual windows and concurrent storage are unchanged.',
 ];
}
