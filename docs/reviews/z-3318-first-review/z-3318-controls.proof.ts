// Independent bounded review oracle. Synthetic data/network only; no real invoice.
import {disputeStatusOf,planDisputed} from '@/lib/plan-dispute-rules';
import {costPauseCode} from '@/lib/plan-standing';
import {syncPlanDisputes,SEEN_KEY} from '@/lib/plan-disputes';
import {claimHandle,ensureStatsId,setSubscription,storeForEmail,storeRef,recordPlanDispute} from '@/lib/store';
import {paidPeriod} from '../../../tests/billing-period-fixture';
import {store as redis} from '../../../tests/redis-stub';
import {is,done} from '../../../tests/check';
process.env.STRIPE_SECRET_KEY='sk_test_z3318_only';
const NOW=Math.floor(Date.now()/1000),DAY=86400,email='z3318-review@example.test',handle='z3318-review',sub='sub_Z3318Review';
const replies=new Map<string,string>(),asked:string[]=[];
globalThis.fetch=(async(input,init)=>{const u=new URL(String(input));if(u.origin!=='https://api.stripe.com'||(init?.method??'GET')!=='GET'||init?.body)throw Error('unexpected provider operation');asked.push(u.pathname);if(u.pathname==='/v1/disputes')return Response.json({data:[],has_more:false});const id=u.pathname.split('/').pop()??'';if(!replies.has(id))throw Error('unexpected dispute');return Response.json({id,status:replies.get(id),created:NOW-200*DAY});}) as typeof fetch;
const raw=redis.pipeline;let measured=false,commands=0,bytes=0;
redis.pipeline=async cs=>{if(measured){commands+=cs.length;bytes+=Buffer.byteLength(JSON.stringify(cs));}return raw(cs);};
async function main(){
 const closed=[['prevented','lost'],['charge_refunded','lost'],['lost','lost'],['won','won']] as const;
 for(const [status,want] of closed){const parsed=disputeStatusOf(status);is(status+' classification',parsed,want);const record={id:'du_Control',status:parsed,at:NOW-DAY,coversUntil:NOW+DAY};is(status+' before boundary',planDisputed({planDisputes:[record]},NOW),want==='lost');is(status+' exact end releases',planDisputed({planDisputes:[record]},NOW+DAY),false);is(status+' unpaid renewal still refuses',costPauseCode({subscriptionActive:true,renewalUnpaidSince:1,planDisputes:[record]},NOW+2*DAY),'renewal_unpaid');}
 for(const status of ['future_unknown','PREVENTED',' prevented','charge_refunded ',null,0,['prevented'],{status:'prevented'}])is('unknown remains open '+JSON.stringify(status),disputeStatusOf(status),'open');
 is('synthetic store created',(await claimHandle(email,handle,'Synthetic','')).ok,true);await ensureStatsId(email);await setSubscription(email,{customerId:'cus_Z3318Review',subscriptionId:sub,active:true,tier:'pro',cycle:'month',period:paidPeriod()});
 const store=(await storeForEmail(email))!;
 for(const [status] of [...closed,['future_unknown','open']] as const){const id='du_Z3318'+status.replaceAll('_','');replies.set(id,status);await recordPlanDispute(storeRef(store),{id,status:'open',at:NOW-200*DAY,coversUntil:NOW-170*DAY},NOW);await redis.run(['HSET',SEEN_KEY,id,'open:'+store.sid]);}
 const volumes=[];
 for(let n=0;n<3;n++){commands=0;bytes=0;const before=asked.length;measured=true;const r=await syncPlanDisputes(Date.now()+10000,NOW);measured=false;volumes.push({run:n+1,commands,jsonBytes:bytes,providerGET:asked.length-before,failed:r.failed,complete:r.complete});is('bounded run '+n+' has no failure',r.failed,0);}
 for(const [status] of closed){const id='du_Z3318'+status.replaceAll('_','');is(status+' finalized',await redis.run(['HGET',SEEN_KEY,id]),'final');is(status+' read once only',asked.filter(x=>x==='/v1/disputes/'+id).length,1);}
 const unknown='du_Z3318futureunknown';is('unknown retains open memory',await redis.run(['HGET',SEEN_KEY,unknown]),'open:'+store.sid);is('unknown still reread each run',asked.filter(x=>x==='/v1/disputes/'+unknown).length,3);is('actual persisted unknown still pauses',costPauseCode((await storeForEmail(email))!,NOW+400*DAY),'plan_disputed');
 console.log('Z_OPERATION_VOLUME',JSON.stringify(volumes));console.log('Z_PROVIDER_PATHS',JSON.stringify(asked));done();
}
void main();
