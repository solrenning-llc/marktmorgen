import {planPaymentDisputeFixture, zeroExposureFixture } from './margin-test-fixtures';
import {CURRENT_UPLOAD_BUDGET_POLICY as testUploadFunding} from "./upload-budget-approved-policy";
import {fundedCustomerScenario,fundedCustomerWithAi} from './margin-test-fixtures';
import { assessCustomerWorstCase, CUSTOMER_COST_CATEGORIES, MINIMUM_NET_MARGIN_BPS, MINIMUM_NET_PROFIT_CENTS, type CustomerWorstCase } from "@/lib/net-margin-rules";
import { commercialMarginReady, commercialPlansMayOpen, CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, REQUIRED_MARGIN_SCENARIOS, BASE_PLAN_REVENUE_CEILINGS, type CommercialMarginReview } from "@/lib/commercial-margin";
import { PLANS_ON_SALE } from "@/lib/opening";
import { done, is } from "./check";
import {txCustomerFixture} from './customer-tax-review-fixture';
const zeroCosts=()=>Object.fromEntries(CUSTOMER_COST_CATEGORIES.map(key=>[key,0])) as Record<typeof CUSTOMER_COST_CATEGORIES[number],number>;
const scenario=(changes:Partial<CustomerWorstCase>={}):CustomerWorstCase=>({...fundedCustomerScenario(),...changes});
is("owner percentage floor is retired",MINIMUM_NET_MARGIN_BPS,0);
is("a positive whole net cent is required",MINIMUM_NET_PROFIT_CENTS,1);
is("historical sixty-percent net is still positive and passes",assessCustomerWorstCase(scenario()),{approved:true,reason:"approved",netCents:6000,marginBps:6000});
is("a positive profit below the retired floor passes",assessCustomerWorstCase(fundedCustomerScenario(10000,5999)).approved,true);
is("exact zero net is refused",assessCustomerWorstCase(txCustomerFixture(10000,10000)).approved,false);
is("one cent of loss is refused",assessCustomerWorstCase(txCustomerFixture(10000,10001)).approved,false);
is("larger positive profit passes",assessCustomerWorstCase(txCustomerFixture(10000,1000)).approved,true);
is("missing complete input never passes",assessCustomerWorstCase(null).approved,false);
for(const key of CUSTOMER_COST_CATEGORIES){
 const costs={...zeroCosts(),[key]:null};
 is("missing "+key+" not silently zero",assessCustomerWorstCase(scenario({costCeilings:costs})).reason,"unknown");
 const expensive={...zeroCosts(),[key]:10000};
 is(key+" counted in customer worst case",assessCustomerWorstCase(scenario({costCeilings:expensive})).approved,false);
}
for(const n of [NaN,Infinity,-1,0.5,Number.MAX_SAFE_INTEGER+1]){
 is("invalid money rejected",assessCustomerWorstCase(scenario({taxesCeilingCents:n})).reason,"invalid");
}
is("unknown taxes rejected",assessCustomerWorstCase(scenario({taxesCeilingCents:null})).reason,"unknown");
is("unreviewed tax ceiling rejected",assessCustomerWorstCase(scenario({allTaxesReviewed:false})).approved,false);
is("unbounded resource cost rejected",assessCustomerWorstCase(scenario({allCostsBounded:false})).approved,false);
is("invoice not collected is not funded revenue",assessCustomerWorstCase(scenario({revenueCollected:false})).reason,"uncollected");
is("free period does not invent margin",assessCustomerWorstCase(scenario({collectedRevenueCents:0,taxesCeilingCents:0,costCeilings:zeroCosts()})).reason,"no_revenue");
const refundCase=txCustomerFixture(10000,3000,undefined,10000);refundCase.taxReview!.books[0].exchanges[0].brlCents=10000;refundCase.taxesCeilingCents=8;
const refunded=assessCustomerWorstCase(refundCase);
is("full refund after consumption fails",refunded.approved,false);
is("full refund exposes customer loss",refunded.netCents,-3008);
is("refund beyond collection invalid",assessCustomerWorstCase(scenario({refundableRevenueCents:10001})).reason,"invalid");
is("fixed costs included even with one customer",assessCustomerWorstCase(scenario({costCeilings:{...zeroCosts(),fixedBusinessCosts:10000}})).approved,false);
is("cost sum overflow fails safely",assessCustomerWorstCase(scenario({costCeilings:Object.fromEntries(CUSTOMER_COST_CATEGORIES.map(key=>[key,Number.MAX_SAFE_INTEGER]))})).approved,false);
for(const gross of [1,3,10,101,1000,10001,1000000]){
 for(const cost of [gross,Math.max(0,gross-1),Math.max(0,gross-2)]){
  const input=txCustomerFixture(gross,cost),tax=input.taxesCeilingCents!;
  const result=assessCustomerWorstCase(input);
  is("exact boundary not display rounding",result.approved,gross-cost-tax>0);
 }
}
const review=():CommercialMarginReview=>({companyBase:{monthlyFixedCostsCeilingCents:0,monthlyFixedTaxesCeilingCents:0,allFixedCostsBounded:true,allFixedTaxesReviewed:true,fixedCostsEvidence:"TEST ONLY: zero fixed costs",fixedTaxEvidence:"TEST ONLY: zero fixed taxes",reviewedPayingCustomers:1},planPaymentDisputes:planPaymentDisputeFixture(),priceAndRightsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,taxEvidence:"TEST ONLY: hypothetical ceilings",costAndLimitEvidence:"TEST ONLY: hypothetical enforced limits",allocatedFixedCostsVerified:true, fundedExposure:zeroExposureFixture(),prepaidUsageEnforced:true,scenarios:Object.fromEntries(REQUIRED_MARGIN_SCENARIOS.map(key=>{const gross=BASE_PLAN_REVENUE_CEILINGS[key]??10000;return [key,fundedCustomerWithAi(gross,Math.floor(gross*.65),12,key)];}))});
is("hypothetical complete passing review passes calculation",commercialMarginReady(review()),true);
is("absent real review stays closed",commercialMarginReady(),false);
is("requesting launch cannot bypass missing review",commercialPlansMayOpen(true),false);
is("actual commercial release stays closed",PLANS_ON_SALE,false);
is("no launch request stays closed even with passing fixture",commercialPlansMayOpen(false,review()),false);
for(const key of REQUIRED_MARGIN_SCENARIOS){
 const r=review();delete r.scenarios[key];
 is("missing worst-case scenario "+key+" blocks release",commercialMarginReady(r),false);
 const bad=review();bad.scenarios[key]={...bad.scenarios[key]!,costCeilings:{...zeroCosts(),other:Math.ceil(bad.scenarios[key]!.collectedRevenueCents!*0.9)}};
 is("one unprofitable "+key+" is not cross-subsidized",commercialMarginReady(bad),false);
}
is("price change invalidates old review",commercialMarginReady({...review(),priceAndRightsSnapshot:"old prices"}),false);
is("tax evidence required",commercialMarginReady({...review(),taxEvidence:" "}),false);
is("cost and limit evidence required",commercialMarginReady({...review(),costAndLimitEvidence:""}),false);
is("allocated fixed costs must be reviewed",commercialMarginReady({...review(),allocatedFixedCostsVerified:false}),false);
is("postpaid unlimited consumption cannot be certified",commercialMarginReady({...review(),prepaidUsageEnforced:false}),false);
is("published commission menu cannot launch before fee collection is proven",commercialPlansMayOpen(true,review()),false);

if(!testUploadFunding)throw new Error("Synthetic upload funding fixture missing");
const originalUploadSlots=testUploadFunding.fundedStores.creator;
testUploadFunding.fundedStores.creator=0;
is("a paid cohort is not approved without upload capacity for its possible plan mix",commercialMarginReady(review()),false);
testUploadFunding.fundedStores.creator=originalUploadSlots;
const originalUploadMonth=testUploadFunding.month;
testUploadFunding.month="2000-01";
is("an expired resource budget cannot approve a paid release",commercialMarginReady(review()),false);
testUploadFunding.month=originalUploadMonth;
{
// Financial reviews are detached own-data records, never executable assertions.
is('plain complete synthetic financial data remains assessable',commercialMarginReady(review()),true);
const nullPrototype=Object.assign(Object.create(null),review()) as CommercialMarginReview;
is('own financial data with null prototype remains assessable',commercialMarginReady(nullPrototype),true);
is('frozen reviewed data remains assessable',commercialMarginReady(Object.freeze(review())),true);
is('no request cannot activate a synthetic review',commercialPlansMayOpen(false,review()),false);
is('absent real review remains closed',commercialPlansMayOpen(true),false);
for(const field of ['priceAndRightsSnapshot','taxEvidence','costAndLimitEvidence','companyBase','fundedExposure','scenarios','allocatedFixedCostsVerified','prepaidUsageEnforced'] as const){
 const input=review();const value=input[field];let calls=0;
 Object.defineProperty(input,field,{enumerable:true,get(){calls++;return value;}});
 is('calculator rejects executable review assertion '+field,commercialMarginReady(input),false);
 is('calculator never invokes review accessor '+field,calls,0);
 is('release rejects executable review assertion '+field,commercialPlansMayOpen(true,input),false);
 is('release never invokes review accessor '+field,calls,0);
}
for(const entry of ['companyBase','fundedExposure','scenarios'] as const){
 const input=review();const target=input[entry] as unknown as Record<string,unknown>;
 const key=Object.keys(target)[0],value=target[key];let calls=0;
 Object.defineProperty(target,key,{enumerable:true,get(){calls++;return value;}});
 is('nested financial accessor rejected '+entry,commercialMarginReady(input),false);
 is('nested financial accessor not invoked '+entry,calls,0);
 is('release refuses nested financial accessor '+entry,commercialPlansMayOpen(true,input),false);
 is('release never invokes nested financial accessor '+entry,calls,0);
}
for(const field of ['taxEvidence','costAndLimitEvidence'] as const){
 for(const invalid of [null,undefined,0,false,{},[],['source'],{trim:'not a function'}]){
  const input=review();Object.assign(input,{[field]:invalid});
  is('malformed evidence type refuses calculation '+field,commercialMarginReady(input),false);
  is('malformed evidence type refuses release '+field,commercialPlansMayOpen(true,input),false);
 }
}
const inherited=Object.create(review()) as CommercialMarginReview;
is('inherited reviewed assertions cannot pass calculator',commercialMarginReady(inherited),false);
is('inherited reviewed assertions cannot pass release',commercialPlansMayOpen(true,inherited),false);
const hook=review();let hookCalls=0;
Object.assign(hook,{toJSON(){hookCalls++;return review();}});
is('JSON hook cannot turn a review into verified data',commercialMarginReady(hook),false);
is('JSON hook never executed by calculator',hookCalls,0);
is('release rejects JSON hook',commercialPlansMayOpen(true,hook),false);
is('JSON hook never executed by release',hookCalls,0);
const cyclic=review();Object.assign(cyclic,{cycle:cyclic});
is('cyclic review fails closed',commercialMarginReady(cyclic),false);
is('cyclic release review fails closed',commercialPlansMayOpen(true,cyclic),false);
const symbolic=review();Object.defineProperty(symbolic,Symbol('evidence'),{value:true});
is('symbol financial assertions fail closed',commercialMarginReady(symbolic),false);
const oversized=review();oversized.taxEvidence='x'.repeat(1024*1024+1);
is('review beyond existing contract snapshot ceiling fails closed',commercialMarginReady(oversized),false);
is('oversized release review fails closed',commercialPlansMayOpen(true,oversized),false);
const stale=review();stale.priceAndRightsSnapshot='old terms';
is('detachment never makes stale terms current',commercialMarginReady(stale),false);
const unknown=review();unknown.scenarios.creator_month_full!.taxesCeilingCents=null;
is('detachment never treats unknown taxes as zero',commercialMarginReady(unknown),false);
is('real missing review still cannot open plans',commercialMarginReady(),false);
}

for(const key of Object.keys(BASE_PLAN_REVENUE_CEILINGS) as (keyof typeof BASE_PLAN_REVENUE_CEILINGS)[]){
 const gross=BASE_PLAN_REVENUE_CEILINGS[key]!;
 const room=key.includes("_year_")?100:25;
 const noSpare=review();noSpare.scenarios[key]=fundedCustomerWithAi(gross,room,12,key);
 is("positive unit alone does not waive the existing cost room "+key,assessCustomerWorstCase(noSpare.scenarios[key]!).approved,true);
 is("all existing room cannot consume the last positive cent "+key,commercialMarginReady(noSpare),false);
 const spare=review();spare.scenarios[key]=fundedCustomerWithAi(gross,room+1,12,key);
 is("full reviewed taxes and existing cost room retain a positive cent "+key,commercialMarginReady(spare),true);
}
{
 const r=review();
 for(const key of REQUIRED_MARGIN_SCENARIOS){
  const prior=r.scenarios[key]!;
  const gross=prior.collectedRevenueCents!;
  const cost=CUSTOMER_COST_CATEGORIES.reduce((sum,k)=>sum+prior.costCeilings[k]!,0);
  const months=key.includes('_year_')?12:1;
  const tx=txCustomerFixture(gross,cost,{scenario:key,from:'2026-01-01',through:months===12?'2027-01-01':'2026-02-01',months});
  tx.costCeilings={...prior.costCeilings};r.scenarios[key]=tx;
 }
 is('complete TX scenarios pass the real commercial review with every existing cost and room retained',commercialMarginReady(r),true);
 const selected=r.scenarios.creator_month_full!,net=assessCustomerWorstCase(selected).netCents!;
 const taxHeld=selected.taxesCeilingCents;
 selected.costCeilings.other!+=net-25;
 is('TX unit with only the existing 25-cent room remains positive alone',assessCustomerWorstCase(selected).netCents,25);
 is('the actual commercial check adds all room without granting a speculative tax deduction',commercialMarginReady(r),false);
 selected.costCeilings.other!--;
 is('one cent beyond full TX room passes the actual commercial check',commercialMarginReady(r),true);
 is('adding the full room never shrinks the reviewed TX tax ceiling',selected.taxesCeilingCents,taxHeld);
 const current=r.priceAndRightsSnapshot;r.priceAndRightsSnapshot='schema26 historical review';
 is('an older commercial snapshot cannot approve TX data',commercialMarginReady(r),false);r.priceAndRightsSnapshot=current;
 r.scenarios.creator_month_full!.taxContext!.scenario='scale_month_full';
 is('the commercial map binds each TX scenario to its actual key',commercialMarginReady(r),false);
 is('TX synthetic data never fills the actual commercial review',commercialMarginReady(),false);
}
{
 let getters=0;
 for(const field of ['taxReview','taxContext'])for(const kind of ['hidden','getter','inherited','proxy']){
  const r=review();is('baseline legacy review is healthy before hidden TX '+field+kind,commercialMarginReady(r),true);
  const row=r.scenarios.creator_month_full!;
  if(kind==='inherited')Object.setPrototypeOf(row,{[field]:null});
  else Object.defineProperty(row,field,kind==='getter'?{enumerable:false,get(){getters++;return null;}}:{value:null,enumerable:false,configurable:true});
  if(kind==='proxy')r.scenarios.creator_month_full=new Proxy(row,{has(){return false;}});
  is('original TX presence cannot vanish in commercial snapshot '+field+kind,commercialMarginReady(r),false);
  is('launch cannot discard original TX presence '+field+kind,commercialPlansMayOpen(true,r),false);
 }
 is('hidden fiscal accessors were never invoked',getters,0);
 for(const field of ['taxReview','taxContext'] as const)for(const kind of ['hidden-data','hidden-getter']){
  const r=review(),old=r.scenarios.creator_month_full!;
  const gross=old.collectedRevenueCents!,cost=CUSTOMER_COST_CATEGORIES.reduce((sum,k)=>sum+old.costCeilings[k]!,0);
  const tx=txCustomerFixture(gross,cost);tx.costCeilings={...old.costCeilings};r.scenarios.creator_month_full=tx;
  is('deep TX baseline is assessable before lossiness '+field+kind,commercialMarginReady(r),true);
  Object.defineProperty(tx[field]!,'extra',kind==='hidden-getter'?{enumerable:false,get(){getters++;throw Error('must not execute');}}:{enumerable:false,value:null});
  is('deep nonenumerable fiscal data is rejected directly '+field+kind,assessCustomerWorstCase(tx).approved,false);
  is('deep nonenumerable fiscal data cannot vanish in commercial clone '+field+kind,commercialMarginReady(r),false);
 }
 is('deep fiscal getters were never invoked',getters,0);
 for(const field of ['taxReview','taxContext']){
  const r=review();
  is('legacy exposure baseline passes before unsupported TX '+field,commercialMarginReady(r),true);
  Object.defineProperty(r.fundedExposure!.cases.trial.worstCase!,field,{value:null,enumerable:false});
  is('unsupported hidden TX exposure cannot become legacy during commercial cloning '+field,commercialMarginReady(r),false);
 }
 {
  const r=review(),row=r.scenarios.creator_month_full!;
  Object.assign(row,{taxReview:null,taxContext:null});
  r.scenarios.creator_month_full=new Proxy(row,{ownKeys(target){return Reflect.ownKeys(target).filter(key=>key!=='taxReview'&&key!=='taxContext');}});
  is('an ownKeys trap cannot erase original fiscal presence during commercial serialization',commercialMarginReady(r),false);
 }
}
done();
