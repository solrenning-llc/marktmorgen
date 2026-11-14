/** S: conditional inherited partial-ack probe, real job and durable pending set. */
import {addPeriods,rememberPlan,settlePlans} from '@/lib/plans';
import {store as redis} from './redis-stub';
import {done,is} from './check';
const account='acct_SPlanReview0001',session='cs_test_SPlanReview0001',sub='sub_SPlanReview0001',anchor=1800000000;
let cap=0,posts=0,mode='healthy';
process.env.STRIPE_SECRET_KEY='sk_test_s_plan_review_only';
globalThis.fetch=(async(input: string|URL|Request,init?:RequestInit)=>{
 const u=new URL(String(input));if(u.hostname!=='api.stripe.com')throw Error('unexpected host');
 const answer=(v:unknown)=>new Response(JSON.stringify(v));
 if(u.pathname===`/v1/checkout/sessions/${session}`)return answer({id:session,status:'complete',subscription:sub,metadata:{kind:'plan',plan_payments:'3',plan_interval:'month'}});
 if(u.pathname===`/v1/subscriptions/${sub}`&&init?.method==='GET')return answer({id:sub,status:'active',billing_cycle_anchor:anchor,cancel_at:cap});
 if(u.pathname===`/v1/subscriptions/${sub}`&&init?.method==='POST'){
  posts++;if(mode==='healthy'){cap=Number(new URLSearchParams(String(init.body)).get('cancel_at'));return answer({id:sub,cancel_at:cap});}
  if(mode==='wrong-id')return answer({id:'sub_OtherPlan0001'});
  return answer(mode==='missing'?{id:sub}:mode==='zero'?{id:sub,cancel_at:0}:{id:sub,cancel_at:'unknown'});
 }
 throw Error('unexpected request');
}) as typeof fetch;
async function main(){
 for(const kind of ['healthy','wrong-id','missing','zero','string']){
  redis.clear();cap=0;posts=0;mode=kind;await rememberPlan(account,session);
  const first=await settlePlans();const [pending,retry]=await redis.pipeline([['SMEMBERS','nl:plans:pending'],['ZRANGEBYSCORE','nl:plans:retry','-inf','+inf']]);
  // Merged with claude5/plans-stuck-entries (rule 23): a plan not settled moves from the pending set to the line of
  // plans tried (nl:plans:retry), so "reachable" is in either line, and the healthy pass leaves both empty.
  const lines=[...(Array.isArray(pending)?pending:[]),...(Array.isArray(retry)?retry:[])];
  if(kind==='healthy'){is('healthy real writer caps and clears', [first.done,cap,lines.length],[1,addPeriods(anchor,'month',3),0]);continue;}
  is(`${kind}: no confirmed cap is not a completed plan`,first.done,0);
  is(`${kind}: original pending member remains reachable`,lines.length===1&&lines[0].startsWith(`${account}|${session}|`),true);
  mode='healthy';const second=await settlePlans();
  is(`${kind}: next healthy pass caps the plan`,[second.done,cap],[1,addPeriods(anchor,'month',3)]);
 }
 done();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
