/** Synthetic bridge control for the setProfile merge; no provider or native Redis. */
import {strict as assert} from "node:assert";
import {freshConfig,memberKey,readMember,saveConfig,setProfile,type Member} from "@/lib/community";
import {claimHandle,ensureListId,ensureStatsId,ensureStoreId,setCommunity,setSubscription,storeForEmail} from "@/lib/store";
import {whoIs} from "@/lib/community-mentions";
import {paidPeriod} from "../../../tests/billing-period-fixture";
import {store as redis} from "../../../tests/redis-stub";
import {test} from "node:test";
type Command=(string|number)[];
const pipeline=redis.pipeline.bind(redis);
let lost=false;
redis.pipeline=(async(commands:Command[])=>{
 if(commands.length===1&&commands[0][0]==="EVAL"&&String(commands[0][1]).startsWith('local cur = redis.call("HGET"')){
  const [,,,members,dir,field,expected,next,listed,at]=commands[0];
  if(redis.run(["HGET",members,field])!==expected)return[0];
  redis.run(["HSET",members,field,next]);
  redis.run(listed==="1"?["ZADD",dir,at,field]:["ZREM",dir,field]);
  return lost?[]:[1];
 }
 return pipeline(commands);
}) as typeof redis.pipeline;
globalThis.fetch=(async()=>new Response(JSON.stringify({object:"list",data:[],has_more:false}),{status:200})) as typeof fetch;

test("profile links survive the current handle protocol, including a committed write with lost acknowledgement",async()=>{
 redis.clear();process.env.UPSTASH_REDIS_REST_URL??="http://stub";
 const owner="club@v3024.example";
 assert.equal((await claimHandle(owner,"v3024club","Synthetic Club","")).ok,true);
 await ensureStatsId(owner);await ensureStoreId(owner);await ensureListId(owner);
 await setSubscription(owner,{customerId:"cus_fixture",subscriptionId:"sub_fixture",active:true,tier:"creator",period:paidPeriod()});
 await setCommunity(owner,true);const club=(await storeForEmail(owner))!;const cid=club.community!.id;
 await saveConfig(cid,freshConfig(club.name));
 for(const mode of ["known","lost"] as const){
  lost=mode==="lost";const email=mode+"@v3024.example",key=memberKey(email),old=mode+"-before",name=mode+" after";
  const record:Member={k:key,e:email,n:"Before",h:old,dir:true,mail:false,at:1,seen:1,muted:false,removed:false,t:"",q:[],qa:0,qq:[],s:[]};
  await pipeline([["HSET",`nl:cm:${cid}:m`,key,JSON.stringify(record)],["HSET",`nl:cm:${cid}:h`,old,key]]);
  const outcome=await setProfile(cid,(await readMember(cid,key))!,{name,dir:true,mail:false,links:[{network:"github",url:"https://github.com/member?utm_source=fixture"}]},club).then(()=>"returned",()=>"thrown");
  assert.equal(outcome,lost?"thrown":"returned");
  const stored=(await readMember(cid,key))!;
  assert.deepEqual(stored.s,[{network:"github",url:"https://github.com/member"}]);
  assert.equal(stored.h,mode+"-after");
  assert.equal((await whoIs(cid,[stored.h])).get(stored.h),key);
  assert.equal((await whoIs(cid,[old])).has(old),false);
 }
});
