/** Independent CX1 proof: exercise the actual discount reader and writer with synthetic HTTP only. */
import {applyMemberDiscount} from '@/lib/member-discount';
import {claimHandle,ensureStatsId,ensureStoreId,setStripeAccount,storeForEmail} from '@/lib/store';
import {store as redis} from './redis-stub';
import {is,part,done} from './check';
process.env.STRIPE_SECRET_KEY='sk_test_cx1_synthetic_only';
const sub='sub_cx1Member01';
let receipt:unknown={id:sub};
let posts=0;
let discounts:unknown=[];
globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
 const u=new URL(String(input)),path=u.pathname.replace(/^\/v1/,'');
 const json=(data:unknown)=>new Response(JSON.stringify(data),{status:200});
 if(path==='/customers')return json({data:[{id:'cus_cx1Member01'}],has_more:false});
 if(path==='/subscriptions')return json({has_more:false,data:[{id:sub,status:'active',metadata:{store:'cx1member',product:'prod000001'},items:{data:[{price:{unit_amount:2900,currency:'usd',recurring:{interval:'month'}}}]},discounts}]});
 if(path==='/promotion_codes')return json({has_more:false,data:[{id:'promo_cx1Active01',code:'THANKS',active:true,promotion:{type:'coupon',coupon:{id:'co_1',percent_off:10,duration:'once'}}}]});
 if(path==='/subscriptions/'+sub&&init?.method==='POST'){posts++;return json(receipt);}
 throw new Error('Unexpected mocked request '+path);
}) as typeof fetch;
async function main(){
 redis.clear();const owner='cx1-member@example.com';
 await claimHandle(owner,'cx1member','Synthetic store','');await ensureStatsId(owner);await ensureStoreId(owner);await setStripeAccount(owner,'acct_1CX1xxxxxxxxxxx',true);
 const store=(await storeForEmail(owner))!;
 const apply=()=>applyMemberDiscount(store,'member@example.com',sub,'promo_cx1Active01');
 part('Controls: healthy receipt and pre-dispatch unknown');
 is('matching known receipt is accepted',await apply(),{ok:true});
 discounts=null;posts=0;
 is('unknown discount cannot authorize a write',(await apply()).ok,false);
 is('unknown discount sends no POST',posts,0);
 discounts=[];
 part('A successful transport is not proof the requested subscription was updated');
 for(const [label,value]of [['empty object',{}],['empty array',[]],['null',null],['foreign subscription',{id:'sub_otherMember1'}]]as const){
  receipt=value;posts=0;const result=await apply();
  is(label+': request reached mocked provider once',posts,1);
  is(label+': unknown receipt must not be reported done',result.ok,false);
 }
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
