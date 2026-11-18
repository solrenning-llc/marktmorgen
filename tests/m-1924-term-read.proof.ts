import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from '@/lib/store';
import { proposePartnerShare, notePartners } from '@/lib/affiliates';
import { shareReadsExactly } from '@/lib/partner-share';
import { store as redis } from './redis-stub';
import { paidPeriod } from './billing-period-fixture';
import { done, is, part } from './check';
const id='aaaaaaaaaaaa',product='prodaaaaaa';const now=Math.floor(Date.now()/1000)-2*86400,end=now+86400;
async function fixture(){
 redis.clear();const email='term-proof@example.test';await claimHandle(email,'termproof','Term Proof','');const statsId=(await ensureStatsId(email))!.statsId!;await ensureStoreId(email);await setStripeAccount(email,'acct_1TermProof',true);await setSubscription(email,{customerId:'cus_termproof',subscriptionId:'sub_termproof',active:true,tier:'creator',period:paidPeriod()});
 await redis.pipeline([['HSET',`nl:aff:${statsId}:people`,id,JSON.stringify({id,email:'partner@example.test',code:'caaaaaaaaaaaa',status:'approved',appliedAt:1,decidedAt:5,note:'',rate:null,paypal:'',share:null,cleared:null,by:null})]]);
 const store=(await storeForEmail(email))!;is('real proposal writes a dated agreement',(await proposePartnerShare(store,id,{percent:40,products:[product],until:end},now)).ok,true);return{store,statsId};
}
async function main(){
 part('A malformed end read is not a proven unlimited earning agreement');
 for(const [name,bad] of [['string','unknown'],['boolean',true],['fractional',end+0.5]] as const){
  const {store,statsId}=await fixture();const key=`nl:aff:${statsId}:people`;const real=redis.pipeline.bind(redis);const durable=(await real([['HGET',key,id]]))[0];let changed=0;
  redis.pipeline=(async(commands)=>{const r=await real(commands);if(commands.length===1&&commands[0][0]==='HGETALL'&&commands[0][1]===key){const items=r[0] as string[];r[0]=items.map((raw,i)=>{if(i%2===0)return raw;const v=JSON.parse(raw);v.share.until=bad;changed++;return JSON.stringify(v);});}return r;}) as typeof redis.pipeline;
  let outcome='returned';try{await notePartners(store,{ref:'cs_test_termproof',pi:'pi_termproof',at:end+1,product,title:'Pottery',base:1000,total:1000,currency:'usd',buyer:'buyer@example.test'});}catch{outcome='refused';}finally{redis.pipeline=real;}
  const credited=(await real([['HGETALL',`nl:aff:${statsId}:shares`]]))[0];
  is(name+': strict commitment parser knows the field is unreadable',shareReadsExactly({percent:40,products:[product],until:bad}),false);
  is(name+': only a response copy was changed; dated durable record remains',(await real([['HGET',key,id]]))[0],durable);
  is(name+': corrupted end cannot create an earning after the real end',credited,[]);
  is(name+': bad reply was exercised',changed>0,true);
  console.log('M_TERM_READ',JSON.stringify({name,outcome,credited}));
 }
 for(const kind of ['ended','unlimited'] as const){
  const {store,statsId}=await fixture();if(kind==='unlimited'){const k=`nl:aff:${statsId}:people`;const v=JSON.parse(String((await redis.pipeline([['HGET',k,id]]))[0]));delete v.share.until;await redis.pipeline([['HSET',k,id,JSON.stringify(v)]]);}
  await notePartners(store,{ref:'cs_test_control',pi:'pi_control',at:end+1,product,title:'Pottery',base:1000,total:1000,currency:'usd',buyer:'buyer@example.test'});
  const earned=(await redis.pipeline([['HGETALL',`nl:aff:${statsId}:shares`]]))[0] as string[];
  is(kind+': healthy end semantics are preserved',earned.length,kind==='ended'?0:2);
 }
 done();
}
void main();
