/** A late-plan refund cannot return another invoice's money or call a partial payment whole. Synthetic only. */
import { refundLatePayments } from '@/lib/plan-late-refunds';
import { done,is,part } from './check';
process.env.STRIPE_SECRET_KEY='sk_test_x8_late_allocation_only';
const invoice='in_x8allocation01', intent='pi_x8allocation01', subscription='sub_x8allocation01';
let invoicePaid=1000, charged=5000, refunded=0;
const posted:number[]=[];
globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
 const url=new URL(String(input));const path=url.pathname.replace(/^\/v1/,'');
 if(url.hostname!=='api.stripe.com')throw Error('unexpected synthetic host');
 if(path==='/invoices')return Response.json({object:'list',has_more:false,data:[{id:invoice,object:'invoice',subscription,status:'paid',created:200,amount_paid:invoicePaid,paid_out_of_band:false,currency:'usd',charge:{id:'ch_x8allocation01',object:'charge',payment_intent:intent,invoice:null,amount:charged,amount_refunded:refunded,disputed:false,currency:'usd',balance_transaction:{amount:charged,currency:'usd'},refunds:{object:'list',data:[],has_more:false}}}]});
 if(path==='/balance')return Response.json({object:'balance',available:[{amount:100000,currency:'usd'}]});
 if(path==='/refunds'&&init?.method==='POST'){
  const body=new URLSearchParams(String(init.body));const amount=Number(body.get('amount'));posted.push(amount);
  return Response.json({id:'re_x8allocation01',object:'refund',payment_intent:intent,amount,currency:'usd',status:'succeeded',metadata:{plan_late_refund:invoice}});
 }
 if(path==='/refunds')return Response.json({object:'list',has_more:false,data:[]});
 throw Error('unexpected synthetic path');
}) as typeof fetch;
async function main(){
 for(const [paid,total] of [[1000,5000],[5000,1000]] as const){
  part(`Invoice paid ${paid}, expanded charge ${total}: allocation unknown`);
  invoicePaid=paid;charged=total;refunded=0;posted.length=0;
  const answer=await refundLatePayments('acct_x8synthetic',subscription,100).then(()=> 'settled',()=> 'unknown');
  is('the invoice is not settled on a charge with another total',answer,'unknown');
  is('no refund is attempted without exact allocation',posted,[]);
 }
 part('Matching charge: refund only what remains');
 for(const already of [0,2000]){
  invoicePaid=5000;charged=5000;refunded=already;posted.length=0;
  const answer=await refundLatePayments('acct_x8synthetic',subscription,100);
  is('the confirmed payment is returned',posted,[5000-already]);
  is('the invoice is settled',answer.state,'done');
 }
 done();
}
main().catch(e=>{console.error(e);process.exitCode=1});
