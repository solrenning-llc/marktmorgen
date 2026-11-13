/**
 * A funded store that renews and pays keeps its rights in the next period
 * (CONTRACT_ADMISSION_COVERAGE.renewals, Claude 2's request C2-20261113-1405-ABRIR-2).
 *
 * Before this, a funded subscription that Stripe renewed was observed with a
 * period its checkout (or switch) proof does not cover: the ledger refused it,
 * readSubscription answered "unknown", the record kept the old funded period,
 * and once that ended allowanceWindow had no window for it (a funded period
 * gets no inferred renewal): the store paid and lost every allowance.
 *
 * What is checked, with Stripe and the contract ledger as doubles (the
 * production Lua runs against a real Redis in scripts/test_contract_funding_redis.py):
 *   - a renewal Stripe charged and was paid for is reserved once, activated, and
 *     written as the new funded period, monthly and yearly, after a trial and
 *     after a plan switch;
 *   - the same renewal observed again reserves nothing more;
 *   - a renewal not yet paid (Stripe's draft hour), failed, past due, refunded
 *     into an ended plan, disputed, refused by the ledger, or read in any shape
 *     that is not exactly a paid renewal of this subscription and period, is
 *     never written as paid, and reserves nothing.
 * The renewals coverage is on only through this test's alias (tests/contract-renewal-rules.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {renewalLedger,resetRenewalLedger} from './contract-renewal-funding';
import {readSubscription} from '@/lib/billing';
import {LEGACY_PLAN_PRICES} from '@/lib/plan';
import {recordState} from '@/lib/billing-sync';
import {allowanceWindow} from '@/lib/allowance-window';
import {claimHandle,ensureStatsId,recordPlanDispute,setSubscription,storeForEmail,storeRef,type Store} from '@/lib/store';
import {store as redis} from './redis-stub';

process.env.STRIPE_SECRET_KEY='sk_test_contract_renewal_only_a_stand_in';
const EMAIL='renewal-owner@example.test',SUB='sub_Renewal00001',CUSTOMER='cus_Renewal00001',INVOICE='in_Renewal00001';
const DAY=86_400;
const day=(seconds:number)=>new Date(seconds*1000).toISOString().slice(0,10);

type Cycle='month'|'year';
const PRICE={month:6900,year:69000} as const;
function subscriptionOf(o:{cycle:Cycle;start:number;end:number;created:number;status?:string;metadata?:Record<string,unknown>;latest?:unknown;amount?:number}):Record<string,unknown>{
 return {id:SUB,object:'subscription',customer:CUSTOMER,created:o.created,status:o.status??'active',cancel_at:null,cancel_at_period_end:false,
  latest_invoice:o.latest===undefined?INVOICE:o.latest,metadata:o.metadata??{store:'renewal',funding_grant:'ctr_checkout_one',funding_review:'test_only'},
  items:{data:[{id:'si_Renewal00001',quantity:1,current_period_start:o.start,current_period_end:o.end,price:{lookup_key:`nimbus_creator_${o.cycle}`,unit_amount:o.amount??PRICE[o.cycle],currency:'usd',recurring:{interval:o.cycle,interval_count:1}}}]}};
}
function invoiceOf(o:{cycle:Cycle;start:number;end:number;amount?:number}):Record<string,unknown>{
 return {id:INVOICE,object:'invoice',status:'paid',billing_reason:'subscription_cycle',currency:'usd',customer:CUSTOMER,subtotal:o.amount??PRICE[o.cycle],amount_paid:o.amount??PRICE[o.cycle],amount_remaining:0,
  parent:{type:'subscription_details',subscription_details:{subscription:SUB}},
  lines:{object:'list',has_more:false,data:[{id:'il_Renewal00001',period:{start:o.start,end:o.end}}]}};
}
let reads:{subscriptions:number;invoices:number}={subscriptions:0,invoices:0};
function stripe(subscription:Record<string,unknown>,invoice:Record<string,unknown>|'fail'|'missing'):void{
 reads={subscriptions:0,invoices:0};
 globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
  if(init?.method&&init.method!=='GET')throw Error('a renewal observation never writes to Stripe');
  const path=new URL(String(input)).pathname.replace(/^\/v1/,'');
  if(path===`/subscriptions/${SUB}`){reads.subscriptions++;return Response.json(subscription);}
  if(path===`/invoices/${INVOICE}`){
   reads.invoices++;
   if(invoice==='fail')return Response.json({error:{message:'unavailable'}},{status:500});
   if(invoice==='missing')return Response.json({error:{message:'No such invoice'}},{status:404});
   return Response.json(invoice);
  }
  throw Error('unexpected Stripe path '+path);
 }) as typeof fetch;
}

/** A store whose funded checkout covered `committed`; its record holds that period, funded. */
async function fundedStore(cycle:Cycle,committed:{start:number;end:number},trial=false):Promise<Store>{
 redis.clear();
 await claimHandle(EMAIL,'renewal','Renewal Kitchen','');
 await ensureStatsId(EMAIL);
 await setSubscription(EMAIL,{customerId:CUSTOMER,subscriptionId:SUB,active:true,tier:'creator',cycle,trialEnds:trial?committed.end:0,shared:false,
  period:trial?null:{start:committed.start,end:committed.end,renews:true,funded:true}});
 resetRenewalLedger(committed);
 return (await storeForEmail(EMAIL))!;
}
async function observe(store:Store):Promise<{state:Awaited<ReturnType<typeof readSubscription>>;wrote:boolean;after:Store}>{
 const state=await readSubscription(SUB,store);
 const wrote=await recordState(store,state);
 return {state,wrote,after:(await storeForEmail(EMAIL))!};
}

const now=Math.floor(Date.now()/1000);
const P1={start:now-31*DAY,end:now-3600};
const P2={start:P1.end,end:P1.end+30*DAY};

test('a funded store that renewed and paid keeps its rights in the next billing month',async()=>{
 const store=await fundedStore('month',P1);
 stripe(subscriptionOf({cycle:'month',...P2,created:P1.start}),invoiceOf({cycle:'month',...P2}));
 assert.equal(allowanceWindow(store,Date.now()),null,'control: the old funded period alone gives no window after its end');
 const {state,wrote,after}=await observe(store);
 assert.equal(state.state,'active');
 assert.deepEqual(state.state==='active'?state.period:null,{start:P2.start,end:P2.end,renews:true,funded:true});
 assert.ok(wrote);
 assert.deepEqual(after.period,{start:P2.start,end:P2.end,renews:true,funded:true});
 const window=allowanceWindow(after,Date.now());
 assert.ok(window?.billing,'the renewed, paid store has its billing month');
 assert.equal(window?.id,day(P2.start));
 assert.equal(renewalLedger.reserves.length,1);
 assert.deepEqual(renewalLedger.reserves[0],{statsId:store.statsId,subscriptionId:SUB,tier:'creator',cycle:'month',periodStartSeconds:P2.start});
 assert.equal(renewalLedger.activations.length,1);
 assert.deepEqual({...renewalLedger.activations[0],grantId:'-'},{statsId:store.statsId,grantId:'-',reviewId:'test_only',subscriptionId:SUB,tier:'creator',cycle:'month',createdSeconds:P1.start,trialing:false,periodStartSeconds:P2.start,periodEndSeconds:P2.end});
 assert.equal(reads.invoices,1,'one read of the renewal invoice proves it paid');

 // The same renewal observed again (a second event, the daily job, the studio) reserves nothing more.
 const again=await observe(after);
 assert.equal(again.state.state,'active');
 assert.equal(again.wrote,false,'nothing new to write');
 assert.deepEqual(again.after.period,{start:P2.start,end:P2.end,renews:true,funded:true});
 assert.equal(renewalLedger.reserves.length,1,'still one reservation');
});

test('a renewal not yet paid, failed, past due or read in any other shape is never written as paid',async()=>{
 const paid=invoiceOf({cycle:'month',...P2});
 const lines=(period:{start:number;end:number},more=false)=>({object:'list',has_more:more,data:[{id:'il_Renewal00001',period}]});
 const cases:[string,Record<string,unknown>,Record<string,unknown>|'fail'|'missing'][]=[
  ["Stripe's draft hour: the period moved, the invoice is not charged yet",subscriptionOf({cycle:'month',...P2,created:P1.start}),{...paid,status:'draft',amount_paid:0,amount_remaining:6900}],
  ['the invoice is open, its charge not through',subscriptionOf({cycle:'month',...P2,created:P1.start}),{...paid,status:'open',amount_paid:0,amount_remaining:6900}],
  ['the card failed and Stripe retries it (past due)',subscriptionOf({cycle:'month',...P2,created:P1.start,status:'past_due'}),{...paid,status:'open',amount_paid:0,amount_remaining:6900}],
  ['the invoice cannot be read',subscriptionOf({cycle:'month',...P2,created:P1.start}),'fail'],
  ['the invoice is missing',subscriptionOf({cycle:'month',...P2,created:P1.start}),'missing'],
  ['no latest invoice is named',subscriptionOf({cycle:'month',...P2,created:P1.start,latest:null}),paid],
  ['the latest invoice id is malformed',subscriptionOf({cycle:'month',...P2,created:P1.start,latest:'in_bad/../x'}),paid],
  ['another id answered',subscriptionOf({cycle:'month',...P2,created:P1.start}),{...paid,id:'in_Other0000001'}],
  ['another subscription',subscriptionOf({cycle:'month',...P2,created:P1.start}),{...paid,parent:{type:'subscription_details',subscription_details:{subscription:'sub_Other0000001'}}}],
  ['no subscription named',subscriptionOf({cycle:'month',...P2,created:P1.start}),{...paid,parent:null}],
  ['the first invoice, not a renewal',subscriptionOf({cycle:'month',...P2,created:P1.start}),{...paid,billing_reason:'subscription_create'}],
  ['a change of plan, not a renewal',subscriptionOf({cycle:'month',...P2,created:P1.start}),{...paid,billing_reason:'subscription_update'}],
  ['another period',subscriptionOf({cycle:'month',...P2,created:P1.start}),{...paid,lines:lines({start:P2.start+1,end:P2.end})}],
  ['more lines than one page shows',subscriptionOf({cycle:'month',...P2,created:P1.start}),{...paid,lines:lines(P2,true)}],
  ['another amount',subscriptionOf({cycle:'month',...P2,created:P1.start}),{...paid,subtotal:6899}],
  ['money still due',subscriptionOf({cycle:'month',...P2,created:P1.start}),{...paid,amount_remaining:1}],
  ['marked paid outside Stripe',subscriptionOf({cycle:'month',...P2,created:P1.start}),{...paid,paid_out_of_band:true}],
  ['another currency',subscriptionOf({cycle:'month',...P2,created:P1.start}),{...paid,currency:'eur'}],
  ['a period that does not begin where the paid one ended',subscriptionOf({cycle:'month',start:P2.start+DAY,end:P2.end+DAY,created:P1.start}),invoiceOf({cycle:'month',start:P2.start+DAY,end:P2.end+DAY})],
 ];
 // Only this last case reads a paid invoice: the ledger is then asked, and refuses.
 const paidButDiscontiguous=cases[cases.length-1][0];
 for(const [what,subscription,invoice] of cases){
  const store=await fundedStore('month',P1);
  stripe(subscription,invoice);
  const {state,wrote,after}=await observe(store);
  assert.notEqual(state.state==='active'?state.period?.start:null,P2.start,what);
  assert.equal(wrote,false,what);
  assert.deepEqual(after.period,{start:P1.start,end:P1.end,renews:true,funded:true},what);
  assert.equal(allowanceWindow(after,Date.now()),null,what+': unknown never becomes paid');
  assert.equal(renewalLedger.reserves.length,0,what+': nothing reserved');
  assert.equal(renewalLedger.renewed,null,what+': nothing activated');
  assert.equal(renewalLedger.activations.length,what===paidButDiscontiguous?1:0,what+': the ledger is asked only after a paid renewal invoice');
 }
});

test('a refund that ended the plan, an open dispute or a ledger that refuses never renews',async()=>{
 // The plan's refund ends it (lib/plan-refund-flow.ts): Stripe has it canceled.
 let store=await fundedStore('month',P1);
 stripe(subscriptionOf({cycle:'month',...P2,created:P1.start,status:'canceled'}),invoiceOf({cycle:'month',...P2}));
 let seen=await observe(store);
 assert.equal(seen.state.state,'inactive');
 assert.equal(seen.after.subscriptionActive,false);
 assert.equal(renewalLedger.reserves.length,0);
 assert.equal(reads.invoices,0,'an ended plan reads no invoice');

 // A dispute of a plan payment pauses costs and gets no new grant.
 store=await fundedStore('month',P1);
 await recordPlanDispute(storeRef(store),{id:'du_Renewal00001',status:'open',at:now-DAY,coversUntil:P1.end});
 store=(await storeForEmail(EMAIL))!;
 stripe(subscriptionOf({cycle:'month',...P2,created:P1.start}),invoiceOf({cycle:'month',...P2}));
 seen=await observe(store);
 assert.equal(seen.wrote,false);
 assert.deepEqual(seen.after.period,{start:P1.start,end:P1.end,renews:true,funded:true});
 assert.equal(renewalLedger.reserves.length,0,'a disputed plan reserves nothing');

 // No slot or cash left: the ledger refuses, the store stays closed (unknown fails), nothing is written.
 store=await fundedStore('month',P1);
 renewalLedger.refuseReserve=true;
 stripe(subscriptionOf({cycle:'month',...P2,created:P1.start}),invoiceOf({cycle:'month',...P2}));
 seen=await observe(store);
 assert.equal(seen.wrote,false);
 assert.equal(allowanceWindow(seen.after,Date.now()),null);
 assert.equal(renewalLedger.activations.length,1,'activation is still asked, and refuses without its reservation');
});

test('a yearly renewal opens the first month of the new year',async()=>{
 const Y1={start:now-366*DAY,end:now-3600},Y2={start:Y1.end,end:Y1.end+365*DAY};
 const store=await fundedStore('year',Y1);
 stripe(subscriptionOf({cycle:'year',...Y2,created:Y1.start}),invoiceOf({cycle:'year',...Y2}));
 const {state,after}=await observe(store);
 assert.equal(state.state,'active');
 assert.deepEqual(after.period,{start:Y2.start,end:Y2.end,renews:true,funded:true});
 const window=allowanceWindow(after,Date.now());
 assert.ok(window?.billing);
 assert.equal(window?.id,day(Y2.start));
 assert.equal(renewalLedger.reserves[0]?.cycle,'year');
});

test('a trial that converts into its first paid month keeps its rights',async()=>{
 const T={start:now-14*DAY-3600,end:now-3600},F={start:T.end,end:T.end+30*DAY};
 const store=await fundedStore('month',T,true);
 stripe(subscriptionOf({cycle:'month',...F,created:T.start}),invoiceOf({cycle:'month',...F}));
 const {state,after}=await observe(store);
 assert.equal(state.state,'active');
 assert.deepEqual(after.period,{start:F.start,end:F.end,renews:true,funded:true});
 assert.ok(allowanceWindow(after,Date.now())?.billing);
 assert.equal(renewalLedger.reserves.length,1,'the first paid month after a trial has its own grant');
});

test('a plan switched in the middle renews on its own switch proof',async()=>{
 const store=await fundedStore('month',P1);
 const metadata={store:'renewal',funding_action:'switch',funding_grant:'ctr_switch_one',funding_review:'test_only'};
 stripe(subscriptionOf({cycle:'month',...P2,created:P1.start,metadata}),invoiceOf({cycle:'month',...P2}));
 const {state,after}=await observe(store);
 assert.equal(state.state,'active');
 assert.deepEqual(after.period,{start:P2.start,end:P2.end,renews:true,funded:true});
 assert.equal(renewalLedger.activations[0]?.reviewId,'test_only');
});

test('the contract ledger exposes the renewal reservation and activation',async()=>{
 const real=await import('../lib/contract-funding') as Record<string,unknown>;
 for(const name of ['reserveRenewalContractFunding','activateRenewalContract','renewalContractNonce','ACTIVATE_RENEWAL_CONTRACT'])assert.ok(name in real,name);
 assert.match(String(real.RESERVE_CONTRACT),/'renewal'/,'RESERVE_CONTRACT names the renewal action');
});

test('a subscription on a price list published before keeps its rights when it renews; a price no list has stays unknown',async()=>{
 // planOf still reads a subscription on LEGACY_PLAN_PRICES as its plan: its paid renewal is the same plan's renewal.
 for(const amount of LEGACY_PLAN_PRICES.map(list=>list.creator.month)){
  const store=await fundedStore('month',P1);
  stripe(subscriptionOf({cycle:'month',...P2,created:P1.start,amount}),invoiceOf({cycle:'month',...P2,amount}));
  const {state,after}=await observe(store);
  assert.equal(state.state,'active',String(amount));
  assert.deepEqual(after.period,{start:P2.start,end:P2.end,renews:true,funded:true},String(amount));
  assert.ok(allowanceWindow(after,Date.now())?.billing,String(amount));
  assert.equal(renewalLedger.reserves.length,1,String(amount));
 }
 // The invoice must charge the subscription's own price, never another list's.
 let store=await fundedStore('month',P1);
 stripe(subscriptionOf({cycle:'month',...P2,created:P1.start,amount:LEGACY_PLAN_PRICES[0].creator.month}),invoiceOf({cycle:'month',...P2}));
 let seen=await observe(store);
 assert.equal(seen.wrote,false);
 assert.equal(renewalLedger.reserves.length,0);
 // A price on no list Marktmorgen ever published is unknown: nothing read as paid, nothing reserved.
 store=await fundedStore('month',P1);
 stripe(subscriptionOf({cycle:'month',...P2,created:P1.start,amount:3000}),invoiceOf({cycle:'month',...P2,amount:3000}));
 seen=await observe(store);
 assert.equal(seen.wrote,false);
 assert.deepEqual(seen.after.period,{start:P1.start,end:P1.end,renews:true,funded:true});
 assert.equal(renewalLedger.reserves.length,0);
 assert.equal(reads.invoices,0,'an unknown price reads no invoice');
});
