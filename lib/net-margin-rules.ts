import { captureCustomerTaxInput, customerTaxCeiling, customerTaxReviewFields, type CustomerTaxReview, type TaxContext } from './customer-tax-review';
/** Platform fees only, never creator GMV. All amounts are USD cents for one customer's worst case.
 * This checks supplied ceilings, not the accuracy of tax advice, vendor quotes or usage enforcement.
 */
/** MR27Oct2026: percentage floors are retired; a whole positive net cent is required. */
export const MINIMUM_NET_MARGIN_BPS=0;
export const MINIMUM_NET_PROFIT_CENTS=1;
export const CUSTOMER_COST_CATEGORIES=[
 "infrastructure","storageDeliveryVideo","email","ai","paymentAndFx",
 "supportAndOperations","acquisitionAndAffiliates","fixedBusinessCosts",
 "postCancellation","refundAndDisputeFees","other",
] as const;
export type CustomerCostCategory=typeof CUSTOMER_COST_CATEGORIES[number];
export type CustomerWorstCase={
 collectedRevenueCents:number|null;
 refundableRevenueCents:number|null;
 taxesCeilingCents:number|null;
 costCeilings:Partial<Record<CustomerCostCategory,number|null>>;
 allCostsBounded:boolean;
 allTaxesReviewed:boolean;
 revenueCollected:boolean;
 /** Explicit complete TX evidence is mandatory; absence cannot approve a customer. */
 taxReview?:CustomerTaxReview|null;
 taxContext?:TaxContext|null;
};
export type MarginAssessment={approved:boolean;reason:"unknown"|"invalid"|"unbounded"|"uncollected"|"no_revenue"|"below_floor"|"tax_review_unknown"|"tax_below_reviewed_ceiling"|"approved";netCents:number|null;marginBps:number|null};
const stopped=(reason:MarginAssessment["reason"]):MarginAssessment=>({approved:false,reason,netCents:null,marginBps:null});
const money=(n:unknown):n is number=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
/** Only explicit data belongs to a review. Inherited defaults and computed
 * properties are not evidence and must never execute during a margin check. */
const ownReviewData=(record:object,key:string)=>{
 try{
  const field=Object.getOwnPropertyDescriptor(record,key);
  return field&&Object.prototype.hasOwnProperty.call(field,"value")?field.value:undefined;
 }catch{return undefined;}
};
/** Exact whole-cent comparison: zero profit or a rounded display never passes MR. */
export function assessCustomerWorstCase(value:CustomerWorstCase|null,expectedMonths?:1|12):MarginAssessment{
 if(!value||typeof value!=="object"||Array.isArray(value))return stopped("unknown");
 const fields=customerTaxReviewFields(value);
 const fiscal=captureCustomerTaxInput({taxReview:fields.taxReview,taxContext:fields.taxContext});
 const suppliedCosts=ownReviewData(value,"costCeilings");
 if(!suppliedCosts||typeof suppliedCosts!=="object"||Array.isArray(suppliedCosts))return stopped("unknown");
 // Read once into a plain snapshot. Validation and arithmetic use identical data.
 value={
  collectedRevenueCents:ownReviewData(value,"collectedRevenueCents"),
  refundableRevenueCents:ownReviewData(value,"refundableRevenueCents"),
  taxesCeilingCents:ownReviewData(value,"taxesCeilingCents"),
  costCeilings:Object.fromEntries(CUSTOMER_COST_CATEGORIES.map(key=>[key,ownReviewData(suppliedCosts,key)])),
  allCostsBounded:ownReviewData(value,"allCostsBounded")===true,
  allTaxesReviewed:ownReviewData(value,"allTaxesReviewed")===true,
  revenueCollected:ownReviewData(value,"revenueCollected")===true,
 };
 const amounts=[value.collectedRevenueCents,value.refundableRevenueCents,value.taxesCeilingCents,...CUSTOMER_COST_CATEGORIES.map(key=>value.costCeilings[key])];
 if(amounts.some(n=>n===null||n===undefined))return stopped("unknown");
 if(!amounts.every(money)||value.refundableRevenueCents!>value.collectedRevenueCents!)return stopped("invalid");
 if(value.allCostsBounded!==true||value.allTaxesReviewed!==true)return stopped("unbounded");
 if(value.revenueCollected!==true)return stopped("uncollected");
 const gross=BigInt(value.collectedRevenueCents!);
 if(gross===BigInt(0))return stopped("no_revenue");
 const costs=CUSTOMER_COST_CATEGORIES.reduce((total,key)=>total+BigInt(value.costCeilings[key]!),BigInt(0));
 const pretax=gross-BigInt(value.refundableRevenueCents!)-costs;
 if(!fiscal||(expectedMonths!==undefined&&fiscal.taxContext!.months!==expectedMonths))return stopped("tax_review_unknown");
 const ceiling=customerTaxCeiling(fiscal.taxReview,fiscal.taxContext,{revenueCents:value.collectedRevenueCents!,refundableCents:value.refundableRevenueCents!,pretaxCents:pretax});
 if(ceiling===null)return stopped("tax_review_unknown");
 if(value.taxesCeilingCents!<ceiling)return stopped("tax_below_reviewed_ceiling");
 const net=pretax-BigInt(value.taxesCeilingCents!);
 if(net>BigInt(Number.MAX_SAFE_INTEGER)||net< -BigInt(Number.MAX_SAFE_INTEGER))return stopped("invalid");
 const ratio=Number(net*BigInt(10_000)/gross);
 const approved=net>=BigInt(MINIMUM_NET_PROFIT_CENTS);
 return {approved,reason:approved?"approved":"below_floor",netCents:Number(net),marginBps:Number.isSafeInteger(ratio)?ratio:null};
}
