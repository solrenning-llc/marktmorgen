/** Derived actual DEL-boundary lease-expiry probe. Original GET-ordinal probe stays frozen separately. Real plan/team writers; no forged reply. */
import {eraseClosed,markDue,WALK_KEY}from'@/lib/closed-store-data';
import {claimHandle,storeForEmail,storeRef}from'@/lib/store';
import {putMember,readTeam}from'@/lib/team';
import {store as redis}from'./redis-stub';
import {closeForErasure,reactivate}from'./closed-for-erasure';
import {is,done,part}from'./check';
globalThis.fetch=(async()=>new Response('{}',{status:500}))as typeof fetch;
const owner='lease-owner@example.test',member='teammate@example.test';
const original=redis.pipeline.bind(redis);
async function main(){
 for(const at of ['before-walk','before-team-delete']as const){
  redis.pipeline=original;redis.clear();
  await original([['HSET',WALK_KEY,'phase','idle','cursor','0','started',1,'finished',1]]);
  await claimHandle(owner,'leaseprobe','Synthetic studio','');
  const store=(await storeForEmail(owner))!;
  const added=await putMember(store,member,'admin');
  if(!added)throw Error('Synthetic member setup failed');
  await closeForErasure(owner);await markDue(storeRef(store),Date.now()-1000);
  const key=`nl:team:${store.sid}`;let reads=0,reached=false,renewed=false,renewedBeforeDelete=false;
  if(at==='before-walk'){await reactivate(owner);reached=true;}
  else redis.pipeline=(async(commands:(string|number)[][])=>{
   if(commands.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:extend:v1')&&String(c[3]).startsWith('nl:store:lock:'))){
    const reply=await original(commands);renewed=reply[0]===1;return reply;
   }
   const team=commands.some(c=>c[0]==='DEL'&&c.slice(1).includes(key));
   if(team)reads++;
   if(!reached&&team){
    renewedBeforeDelete=renewed;reached=true;
    redis.advance(120001);
    await reactivate(owner);
   }
   return original(commands);
  })as typeof redis.pipeline;
  let outcome='completed';try{await eraseClosed(Date.now()+60000,async()=>{});}catch(error){outcome=error instanceof Error?error.name:'threw';}finally{redis.pipeline=original;}
  const current=await storeForEmail(owner);const team=await readTeam(store.sid);
  console.log('M_LEASE_OBSERVATION',JSON.stringify({at,reached,reads,renewedBeforeDelete,outcome,record:!!current,running:current?.subscriptionActive,members:team.members.map(m=>m.email)}));
  part(at);
  is('the actual plan reactivation was reached',reached,true);
  is('the real reactivated store remains active',!!current&&current.subscriptionActive,true);
  is('the active store keeps its existing team',team.members.map(m=>m.email),[member]);
 }
 done();
}
void main();
