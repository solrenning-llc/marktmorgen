/**
 * 306 [SY2] unit 2b: the plan charges on our own Stripe account, read for the
 * refund and dispute reserve (lib/refund-reserve-read.ts). Synthetic Stripe
 * only: no request but GET, pinned to 2024-06-20 (as lib/plan-refund.ts).
 *
 * The oracle is the rule already merged: each synthetic charge is also written
 * as the ReserveRead it is (lib/refund-reserve-charge.ts), and the reading
 * must give exactly refundReserve(reserveChargeOf(...)) of those. What is
 * checked besides:
 *   - a charge with no invoice, or an invoice of no known kind, counts at its
 *     ceiling (the whole payment left, plus its dispute part) and is counted
 *     in `unclassified` (Claude 3, 13/11/2026);
 *   - the Store assistant's and the AI captions' charges count no refund,
 *     only their dispute part and their refunds still pending;
 *   - a disputed charge has its dispute read;
 *   - pages are followed to the end; past MAX_PAGES, an unreadable page or
 *     row, a refund list not read whole, another currency, an error, the
 *     deadline or more disputes than MAX_DISPUTE_READS: the whole reserve is
 *     unknown, never a partial sum.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {LOOKBACK_DAYS,MAX_DISPUTE_READS,MAX_PAGES,READ_VERSION,readRefundReserve} from '@/lib/refund-reserve-read';
import {type ReserveRead,reserveChargeOf} from '@/lib/refund-reserve-charge';
import {type ReserveCharge,refundReserve} from '@/lib/refund-reserve-rules';
import {monthlyForYearly} from '@/lib/plan-refund';

process.env.STRIPE_SECRET_KEY='sk_test_refund_reserve_read_only_a_stand_in';
const DAY=86_400;
const NOW=Math.floor(Date.now()/1000);
const LATER=()=>Date.now()+60_000;

type Refund={status:string;amount:number};
type Spec={
 kind:'plan'|'assistant'|'captions'|'none'|'foreign';
 cycle?:'month'|'year';amount:number;paidDaysAgo:number;refunds?:Refund[];status?:string;currency?:string;billing?:string;
 dispute?:{status:string;amount:number};
};
let sequence=0;
type Built={json:Record<string,unknown>;expected:ReserveCharge|null;unclassified:boolean;dispute?:{status:string;amount:number}};
/** One synthetic charge in Stripe's 2024-06-20 shape, and what the rule must count for it. */
function charge(spec:Spec):Built{
 const n=String(++sequence).padStart(8,'0'),id=`ch_Reserve${n}`;
 const status=spec.status??'succeeded',currency=spec.currency??'usd',paid=NOW-spec.paidDaysAgo*DAY,cycle=spec.cycle??'month';
 const length=(cycle==='year'?365:30)*DAY;
 const refunds=spec.refunds??[];
 const refunded=refunds.filter(r=>['succeeded','pending','requires_action'].includes(r.status)).reduce((sum,r)=>sum+r.amount,0);
 const fee=Math.round(spec.amount*0.066)+30;
 const lineFor=(type:string,recurring:boolean)=>({id:`il_Reserve${n}`,object:'line_item',type,period:{start:paid,end:recurring?paid+length:paid},
  price:{id:`price_Reserve${n}`,unit_amount:spec.amount,currency:'usd',recurring:recurring?{interval:cycle,interval_count:1}:null}});
 const subscription=spec.kind==='plan'?{id:`sub_Reserve${n}`,object:'subscription',metadata:{store:'harbor'}}:spec.kind==='assistant'?{id:`sub_Reserve${n}`,object:'subscription',metadata:{addon:'assistant',assistant_for:'harbor'}}:null;
 const invoice=spec.kind==='none'?null:{id:`in_Reserve${n}`,object:'invoice',total:spec.amount,tax:0,
  billing_reason:spec.billing??(spec.kind==='captions'||spec.kind==='foreign'?'manual':'subscription_create'),
  status_transitions:{paid_at:paid},metadata:spec.kind==='captions'?{mark:`captions:vid${n}:1`}:{},subscription,
  lines:{object:'list',has_more:false,data:[lineFor(subscription?'subscription':'invoiceitem',Boolean(subscription))]}};
 const json={id,object:'charge',status,paid:status==='succeeded',amount:spec.amount,amount_captured:status==='succeeded'?spec.amount:0,amount_refunded:refunded,
  currency,created:paid,disputed:Boolean(spec.dispute),balance_transaction:status==='succeeded'?{id:`txn_Reserve${n}`,object:'balance_transaction',fee,currency:'usd'}:null,
  refunds:{object:'list',has_more:false,data:refunds.map((r,i)=>({id:`re_Reserve${n}${i}`,object:'refund',...r}))},invoice};
 const planCharge={currency,succeeded:status==='succeeded',amountCents:status==='succeeded'?spec.amount:0,invoiceTotalCents:spec.amount,
  billingReason:invoice?String(invoice.billing_reason):'',refundedCents:refunded,taxCents:0,feeCents:status==='succeeded'?fee:null,feeCurrency:status==='succeeded'?'usd':null,
  paidAtSeconds:paid,disputeStatus:spec.dispute?.status??null,disputedCents:spec.dispute?.amount??null};
 const read:ReserveRead={kind:spec.kind==='plan'?'plan':'not-refunded',status,cycle:spec.kind==='captions'||spec.kind==='none'||spec.kind==='foreign'?null:cycle,
  monthlyCents:spec.kind==='plan'&&cycle==='year'?monthlyForYearly(spec.amount):null,
  periodStartSeconds:paid,periodEndSeconds:subscription?paid+length:paid,refunds,charge:planCharge};
 const unclassified=spec.kind==='none'||spec.kind==='foreign';
 let expected=reserveChargeOf(read,NOW);
 if(unclassified&&expected&&expected.refund.kind!=='unknown'){
  // The ceiling: the whole payment left.
  const left=spec.amount-refunded;
  expected={...expected,refund:left>0?{kind:'guarantee',cents:left}:{kind:'none',reason:'already_refunded'}};
 }
 return {json,expected,unclassified,dispute:spec.dispute};
}

type Seen={method:string;path:string;version:string|null;query:URLSearchParams};
let seen:Seen[]=[];
/** Stripe's charge list over `all`, newest first, `size` a page, and its disputes. */
let request=0;
/** A different, repeatable order of one second's charges for each request (Stripe does not promise their order). */
const mix=(id:string)=>{let h=2166136261^request;for(let i=0;i<id.length;i++)h=Math.imul(h^id.charCodeAt(i),16777619);return h>>>0;};
function stripe(all:Built[],o:{size?:number;page?:(page:Record<string,unknown>,index:number)=>unknown;fail?:boolean;disputes?:(chargeId:string)=>unknown;shuffleTies?:boolean}={}):void{
 seen=[];const size=o.size??100;
 globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=new URL(String(input)),headers=new Headers(init?.headers);
  seen.push({method:init?.method??'GET',path:url.pathname,version:headers.get('Stripe-Version'),query:url.searchParams});
  if((init?.method??'GET')!=='GET')throw Error('the reserve reading never writes to Stripe');
  if(o.fail)return Response.json({error:{message:'unavailable'}},{status:500});
  if(url.pathname==='/v1/charges'){
   request++;
   const gte=url.searchParams.get('created[gte]'),lte=url.searchParams.get('created[lte]');
   const sorted=[...all].filter(c=>(gte===null||Number(c.json.created)>=Number(gte))&&(lte===null||Number(c.json.created)<=Number(lte)))
    .sort((a,b)=>Number(b.json.created)-Number(a.json.created)||(o.shuffleTies?mix(String(a.json.id))-mix(String(b.json.id)):0));
   const after=url.searchParams.get('starting_after');
   const from=after?sorted.findIndex(c=>c.json.id===after)+1:0;
   const rows=sorted.slice(from,from+size).map(c=>c.json);
   const page={object:'list',url:'/v1/charges',has_more:from+size<sorted.length,data:rows};
   return Response.json(o.page?o.page(page,seen.filter(s=>s.path==='/v1/charges').length-1):page);
  }
  if(url.pathname==='/v1/disputes'){
   const id=url.searchParams.get('charge')??'';
   if(o.disputes)return Response.json(o.disputes(id));
   const found=all.find(c=>c.json.id===id);
   return Response.json({object:'list',has_more:false,data:found?.dispute?[{id:`dp_${id.slice(3)}`,object:'dispute',charge:id,...found.dispute}]:[]});
  }
  throw Error('unexpected Stripe path '+url.pathname);
 }) as typeof fetch;
}
const expectedOf=(all:Built[])=>refundReserve(all.map(c=>c.expected).filter((c):c is ReserveCharge=>c!==null),NOW);

test('every kind of charge on the platform account counts as the published rule says',async()=>{
 const all=[
  charge({kind:'plan',amount:6900,paidDaysAgo:3}),
  charge({kind:'plan',amount:6900,paidDaysAgo:45,billing:'subscription_cycle'}),
  charge({kind:'plan',cycle:'year',amount:69000,paidDaysAgo:200,billing:'subscription_cycle'}),
  charge({kind:'plan',amount:44900,paidDaysAgo:10,refunds:[{status:'succeeded',amount:1000},{status:'pending',amount:2000},{status:'requires_action',amount:500},{status:'failed',amount:700}]}),
  charge({kind:'plan',amount:6900,paidDaysAgo:20,dispute:{status:'needs_response',amount:6900}}),
  charge({kind:'assistant',amount:6900,paidDaysAgo:5,billing:'subscription_cycle'}),
  charge({kind:'captions',amount:3500,paidDaysAgo:2,refunds:[{status:'pending',amount:3500}]}),
  charge({kind:'none',amount:1200,paidDaysAgo:7}),
  charge({kind:'foreign',amount:900,paidDaysAgo:8,refunds:[{status:'succeeded',amount:100}]}),
  charge({kind:'plan',amount:6900,paidDaysAgo:1,status:'failed'}),
  charge({kind:'plan',amount:99900,paidDaysAgo:400,billing:'subscription_cycle'}),
 ];
 stripe(all);
 const reading=await readRefundReserve(NOW,LATER());
 assert.equal(reading.why,null);
 assert.deepEqual(reading.reserve,expectedOf(all));
 assert.equal(reading.reserve.kind,'known');
 assert.equal(reading.charges,all.length);
 assert.equal(reading.unclassified,2,'the charge with no invoice and the invoice of no known kind');
 assert.equal(reading.disputeReads,1);
 assert.ok(seen.every(s=>s.method==='GET'&&s.version===READ_VERSION),'GET only, pinned');
 const list=seen.find(s=>s.path==='/v1/charges')!;
 assert.equal(list.query.get('created[gte]'),String(NOW-LOOKBACK_DAYS*DAY));
 assert.equal(list.query.get('limit'),'100');
 for(const field of ['data.invoice','data.invoice.subscription','data.balance_transaction','data.refunds'])assert.ok(list.query.getAll('expand[]').includes(field),field);
 assert.equal(seen.filter(s=>s.path==='/v1/disputes').length,1);
 assert.equal(seen.find(s=>s.path==='/v1/disputes')!.query.get('charge'),all[4].json.id);
});

test('pages are followed to the end, and a list longer than MAX_PAGES leaves the reserve unknown',async()=>{
 const all=Array.from({length:250},(_,i)=>charge({kind:'plan',amount:6900,paidDaysAgo:1+(i%60),billing:i%2?'subscription_cycle':'subscription_create'}));
 stripe(all);
 const reading=await readRefundReserve(NOW,LATER());
 assert.equal(reading.why,null);
 assert.deepEqual(reading.reserve,expectedOf(all));
 // Three pages, and each page boundary's whole second read before going past it.
 assert.equal(reading.pages,5);
 assert.equal(reading.charges,250);
 const after=seen.filter(s=>s.path==='/v1/charges'&&s.query.get('starting_after')!==null).map(s=>s.query.get('starting_after'));
 assert.equal(seen.filter(s=>s.path==='/v1/charges'&&s.query.get('created[lte]')!==null).length,2);
 assert.deepEqual(after,[[...all].sort((a,b)=>Number(b.json.created)-Number(a.json.created))[99].json.id,[...all].sort((a,b)=>Number(b.json.created)-Number(a.json.created))[199].json.id]);

 assert.equal(MAX_PAGES,20,'2,000 charges in the lookback: past that, unit 3 needs an incremental reading before the sales lock');
 const many=Array.from({length:MAX_PAGES*2+1},(_,i)=>charge({kind:'plan',amount:6900,paidDaysAgo:1+(i%60)}));
 stripe(many,{size:2});
 const over=await readRefundReserve(NOW,LATER());
 assert.equal(over.reserve.kind,'unknown');
 assert.equal(over.why,'too_many');
 assert.equal(seen.filter(s=>s.path==='/v1/charges').length,MAX_PAGES,'never a page more than MAX_PAGES');
});

test('anything that cannot be read leaves the whole reserve unknown, never a partial sum',async()=>{
 const good=()=>[charge({kind:'plan',amount:6900,paidDaysAgo:3}),charge({kind:'plan',amount:6900,paidDaysAgo:9})];
 // why: the reading could not finish ('unreadable'), or it read everything and the rule says unknown (null).
 const cases:[string,(all:Built[])=>void,string|null][]=[
  ['a page that is not a list',all=>stripe(all,{page:()=>({object:'list',data:'nope',has_more:false})}),'unreadable'],
  ['has_more that is not true or false',all=>stripe(all,{page:page=>({...page,has_more:'no'})}),'unreadable'],
  ['a row without its id',all=>stripe(all,{page:page=>({...page,data:[{...(page.data as Record<string,unknown>[])[0],id:undefined},...(page.data as unknown[]).slice(1)]})}),'unreadable'],
  ['an invoice not expanded',all=>{all[0].json.invoice='in_NotExpanded01';stripe(all);},'unreadable'],
  ['a refund list not read whole',all=>{all[0].json.refunds={object:'list',has_more:true,data:[]};stripe(all);},null],
  ['another currency',all=>{all[0].json.currency='eur';stripe(all);},null],
  ['a pending charge',all=>{all[0].json.status='pending';all[0].json.paid=false;stripe(all);},null],
  ['Stripe answers an error',all=>stripe(all,{fail:true}),'unreadable'],
  ['a dispute list that is not readable',all=>{all[0].json.disputed=true;stripe(all,{disputes:()=>({data:null})});},'unreadable'],
  ['a disputed charge with no dispute listed',all=>{all[0].json.disputed=true;stripe(all,{disputes:()=>({object:'list',has_more:false,data:[]})});},'unreadable'],
 ];
 for(const [what,arrange,why] of cases){
  const all=good();arrange(all);
  const reading=await readRefundReserve(NOW,LATER());
  assert.equal(reading.reserve.kind,'unknown',what);
  assert.equal(reading.why,why,what);
 }
});

test('the deadline and the dispute reads are bounded',async()=>{
 const all=[charge({kind:'plan',amount:6900,paidDaysAgo:3})];
 stripe(all);
 const late=await readRefundReserve(NOW,Date.now()-1);
 assert.equal(late.reserve.kind,'unknown');
 assert.equal(late.why,'deadline');
 assert.equal(seen.length,0,'no request after the deadline');

 const disputed=Array.from({length:MAX_DISPUTE_READS+1},(_,i)=>charge({kind:'plan',amount:6900,paidDaysAgo:1+i%60,dispute:{status:'under_review',amount:6900}}));
 stripe(disputed);
 const reading=await readRefundReserve(NOW,LATER());
 assert.equal(reading.reserve.kind,'unknown');
 assert.equal(reading.why,'too_many');
 assert.equal(seen.filter(s=>s.path==='/v1/disputes').length,MAX_DISPUTE_READS);
});

test('without a Stripe key nothing is read and nothing is known',async()=>{
 const key=process.env.STRIPE_SECRET_KEY;delete process.env.STRIPE_SECRET_KEY;
 try{
  stripe([charge({kind:'plan',amount:6900,paidDaysAgo:3})]);
  const reading=await readRefundReserve(NOW,LATER());
  assert.equal(reading.reserve.kind,'unknown');
  assert.equal(reading.why,'billing_off');
  assert.equal(seen.length,0);
 }finally{process.env.STRIPE_SECRET_KEY=key;}
});

test('many charges of one second, listed in another order at every request across pages, are all counted once',async()=>{
 // Clusters of 30 charges sharing a second, so every page boundary falls inside one (Claude 3, 13/11/2026).
 const all:Built[]=[];
 for(let c=0;c<12;c++)for(let i=0;i<30;i++)all.push(charge({kind:'plan',amount:6900+c,paidDaysAgo:(c+1)*3}));
 stripe(all,{shuffleTies:true});
 const reading=await readRefundReserve(NOW,LATER());
 assert.equal(reading.why,null);
 assert.equal(reading.charges,all.length,'every charge read once');
 assert.deepEqual(reading.reserve,expectedOf(all));
});
