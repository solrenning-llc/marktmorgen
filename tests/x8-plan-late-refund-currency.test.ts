/** A late-plan refund cannot return another invoice's money or call a partial payment whole. Synthetic only. */
import { refundLatePayments } from '@/lib/plan-late-refunds';
import { done,is,part } from './check';
process.env.STRIPE_SECRET_KEY='sk_test_x8_late_allocation_only';
const invoice='in_x8allocation01', intent='pi_x8allocation01', subscription='sub_x8allocation01';
const invoicePaid=1000, charged=1000, refunded=0;
let invoiceCurrency: unknown='usd';
const posted:number[]=[];
globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
 const url=new URL(String(input));const path=url.pathname.replace(/^\/v1/,'');
 if(url.hostname!=='api.stripe.com')throw Error('unexpected synthetic host');
 if(path==='/invoices')return Response.json({object:'list',has_more:false,data:[{id:invoice,object:'invoice',subscription,status:'paid',created:200,amount_paid:invoicePaid,paid_out_of_band:false,currency:invoiceCurrency,charge:{id:'ch_x8allocation01',object:'charge',payment_intent:intent,invoice:null,amount:charged,amount_refunded:refunded,disputed:false,currency:'usd',balance_transaction:{amount:charged,currency:'usd'},refunds:{object:'list',data:[],has_more:false}}}]});
 if(path==='/balance')return Response.json({object:'balance',available:[{amount:100000,currency:'usd'}]});
 if(path==='/refunds'&&init?.method==='POST'){
  const body=new URLSearchParams(String(init.body));const amount=Number(body.get('amount'));posted.push(amount);
  return Response.json({id:'re_x8allocation01',object:'refund',payment_intent:intent,amount,currency:'usd',status:'succeeded',metadata:{plan_late_refund:invoice}});
 }
 if(path==='/refunds')return Response.json({object:'list',has_more:false,data:[]});
 throw Error('unexpected synthetic path');
}) as typeof fetch;
async function main(){
 for(const currency of ['jpy',null,undefined,42]){
  part('Invoice currency '+String(currency)+' cannot authorize USD money');
  invoiceCurrency=currency;posted.length=0;
  // A currency that reads but is not the charge's is left owed and tried again (Claude 3's LOW on #4867); one that does
  // not read at all is still unknown. Never settled either way.
  const result=await refundLatePayments('acct_x8synthetic',subscription,100).then((o)=> o.state,()=> 'unknown');
  is('currency must be confirmed against the charge',result,currency==='jpy'?'owed':'unknown');
  is('no money request on incompatible or missing currency',posted,[]);
 }
 invoiceCurrency='usd';posted.length=0;
 const result=await refundLatePayments('acct_x8synthetic',subscription,100);
 is('matching currency still refunds',posted,[1000]);is('matching payment settles',result.state,'done');
 done();
}
main().catch(e=>{console.error(e);process.exitCode=1});
