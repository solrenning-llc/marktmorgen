// Independent quota conservation oracle for the requested setProfile composition.
// The CAS-member stand-in applies real model writes before reporting the exact receipt;
// its short script layout follows the existing V bridge, not a no-op CAS.
import {claimHandle,ensureListId,ensureStatsId,ensureStoreId,setCommunity,setSubscription,storeForEmail} from "@/lib/store";
import {memberKey,readMember,setProfile,type Member} from "@/lib/community";
import {dataKey,needData} from "@/lib/store-data";
import {dataBytes} from "@/lib/store-data-rules";
import {indexBytes} from "@/lib/community-search";
import {MAX_MEMBER_LINK_URL,parseMemberLinks} from "@/lib/member-links";
import {paidPeriod} from "../../../tests/billing-period-fixture";
import {store as redis} from "../../../tests/redis-stub";
import {done,is} from "../../../tests/check";
type Command=(string|number)[];
const pipeline=redis.pipeline.bind(redis);let cmd=0,bytes=0,measure=false;
redis.pipeline=async(cs:Command[])=>{
 if(measure){cmd+=cs.length;bytes+=Buffer.byteLength(JSON.stringify(cs));}
 if(cs.length===1&&cs[0][0]==="EVAL"&&String(cs[0][1]).startsWith('local cur = redis.call("HGET"')){
  const [,,,members,dir,field,expected,next,listed,at]=cs[0];
  if(redis.run(["HGET",members,field])!==expected)return[0];
  redis.run(["HSET",members,field,next]);redis.run(listed==="1"?["ZADD",dir,at,field]:["ZREM",dir,field]);return[1];
 }
 return pipeline(cs);
};
async function main(){
 for(const stale of [false,true]){
  redis.clear();process.env.UPSTASH_REDIS_REST_URL??="http://stub";const owner="z3024-room@example.test";
  await claimHandle(owner,"z3024room","Synthetic","");await ensureStatsId(owner);await ensureStoreId(owner);await ensureListId(owner);await setSubscription(owner,{customerId:"cus_synthetic",subscriptionId:"sub_synthetic",active:true,tier:"creator",period:paidPeriod()});await setCommunity(owner,true);
  const club=(await storeForEmail(owner))!,cid=club.community!.id,key=memberKey("member@z3024.example.test"),dk=dataKey(club)!;
  const s=Array.from({length:3},(_,i)=>({network:"github" as const,url:`https://github.com/${i}${"a".repeat(MAX_MEMBER_LINK_URL-30)}`}));
  is("the initial links are valid, mode="+stale,parseMemberLinks(s),s);
  const initial:Member={k:key,e:"member@z3024.example.test",n:"Before",h:"before",dir:true,mail:false,at:1,seen:1,muted:false,removed:false,t:"",q:[],qa:0,qq:[],s};
  await pipeline([["HSET",`nl:cm:${cid}:m`,key,JSON.stringify(initial)],["HSET",`nl:cm:${cid}:h`,"before",key]]);
  await needData(club,[{slot:"cm:m",bytes:dataBytes([JSON.stringify(initial)])+indexBytes([initial.n])+96,set:true}]);
  const first=(await readMember(cid,key))!,second=(await readMember(cid,key))!;
  const before=Number(redis.run(["HGET",dk,"cm:m"]));is("initial record is fully paid mode="+stale,before>=dataBytes([JSON.stringify(initial)]),true);
  measure=true;cmd=0;bytes=0;
  await setProfile(cid,first,{name:"Before",dir:true,mail:false,links:[]},club);
  const afterFirst=Number(redis.run(["HGET",dk,"cm:m"]));
  await setProfile(cid,stale?second:(await readMember(cid,key))!,{name:"Before",dir:true,mail:false,links:[{network:"github",url:"https://github.com/short"}]},club);
  measure=false;
  const raw=String(redis.run(["HGET",`nl:cm:${cid}:m`,key])),held=Number(redis.run(["HGET",dk,"cm:m"])),physical=dataBytes([raw]);
  console.log("PROFILE_ROOM",JSON.stringify({stale,before,afterFirst,held,physical,rawBytes:Buffer.byteLength(raw),links:JSON.parse(raw).s,cmd,jsonRequestBytes:bytes}));
  is("retained actual record remains paid mode="+stale,held>=physical,true);
 }
 done();
}
void main();
