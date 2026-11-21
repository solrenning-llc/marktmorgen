/** G independent proof: damage ONLY account metadata; preserve cryptographically recoverable grant. */
import { disconnect } from "@/lib/meet-connect";
import { seal, unseal } from "@/lib/secret-box";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
const SID="s0000000000000000-g3121";
const HOST="0123456789abcdef01234567";
let revoked=0, grant=true;
globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
 const u=new URL(String(input));
 if(init?.method!=="POST"||!u.pathname.endsWith("/revoke"))throw Error("Unexpected synthetic provider request");
 const token=u.searchParams.get("token")??new URLSearchParams(String(init.body??"")).get("token");
 if(token!=="synthetic-recoverable-grant")throw Error("Unexpected synthetic token");
 revoked++;grant=false;return new Response("{}",{status:200});
}) as typeof fetch;
async function outcome(provider:"google"|"zoom",host:string){try{return await disconnect(SID,provider,host)?"view":"none";}catch{return "unknown";}}
async function main(){
 for(const [label,provider,host] of [["Google store","google",""],["Google host","google",HOST],["Zoom store","zoom",""]] as const){
  part(label);
  const ctx=(which:string)=>host?`meet|hosts|${provider}|h:${host}|${which}`:`meet|${SID}|${provider}|${which}`;
  const key=host?`nl:meet:conn:hosts:${provider}:h:${host}`:`nl:meet:conn:${SID}:${provider}`;
  const healthy={provider,account:{id:"synthetic-account",email:"creator@example.test",name:""},refresh:seal("synthetic-recoverable-grant",ctx("refresh")),access:seal("synthetic-recoverable-grant",ctx("access")),expires:0,scope:"",connectedAt:1,by:"creator@example.test",owner:{email:"creator@example.test",handle:"fixture"},broken:"",brokenAt:0};
  const damaged={...healthy,account:null};
  is("untouched sealed grant is recoverable despite damaged account metadata",unseal(provider==="zoom"?damaged.access:damaged.refresh,ctx(provider==="zoom"?"access":"refresh")).ok,true);
  redis.clear();revoked=0;grant=true;
  await redisPipeline([["SET",key,JSON.stringify(damaged)]]);
  const first=await outcome(provider,host);
  const kept=(await redisPipeline([["GET",key]]))[0];
  console.log("G3121_FIRST",JSON.stringify({label,first,retained:kept!==null,revoked,grant}));
  is("disconnect does not discard a recoverable live grant without revoking it",grant&&kept===null,false);
  const retry=await outcome(provider,host);
  console.log("G3121_RETRY",JSON.stringify({label,retry,revoked,grant}));
  is("healthy retry ends the simulated provider grant",grant,false);
  redis.clear();revoked=0;grant=true;
  await redisPipeline([["SET",key,JSON.stringify(healthy)]]);
  const control=await outcome(provider,host);
  is("control: same sealed grant with intact metadata is revoked exactly once and deleted",[control,revoked,grant,(await redisPipeline([["GET",key]]))[0]],["view",1,false,null]);
 }
 done();
}
void main();
