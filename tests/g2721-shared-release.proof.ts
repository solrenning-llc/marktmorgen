import {claimMark,releaseMark} from "@/lib/claim-mark";
import {releaseLockStrict} from "@/lib/redis-lock";
import {store as redis} from "./redis-stub";
import {done,is} from "./check";
type Commands=(string|number)[][];
async function main(){
for(const job of ["courses","reminders","discord","quiet"]){
 redis.clear();const key=`g:2721:release:${job}`,owner=`g-owner-${job}`,next=`g-successor-${job}`;
 const acquired=await claimMark(key,2,owner);if(acquired!=="ours")throw Error("fixture claim not acquired");
 const real=redis.pipeline.bind(redis),clock=Date.now;let failed=0,got:unknown=null,won:unknown=null,before:unknown=null;
 redis.pipeline=(async(commands:Commands)=>{const c=commands[0];if(c?.[0]==="EVAL"&&c[3]===key){failed++;throw Error("G: release EVAL not applied");}
 const answer=await real(commands);if(failed&&got===null&&c?.[0]==="GET"&&c[1]===key){got=answer[0];const future=clock()+2001;Date.now=()=>future;won=(await real([["SET",key,next,"NX","EX",300]]))[0];before=(await real([["GET",key]]))[0];}return answer;
 }) as typeof redis.pipeline;
 try{await releaseMark(key,owner);}finally{redis.pipeline=real;Date.now=clock;}
 is(`G ${job}: release EVAL was attempted once`,failed,1);
 is(`G ${job}: real original claim then legitimate successor NX`,[got,won,before],[owner,"OK",next]);
 is(`G ${job}: old release preserves new owner`,redis.run(["GET",key]),next);
}
redis.clear();const key="g:2721:strict-control",token="g-original-strict-control";await claimMark(key,2,token);
const real=redis.pipeline.bind(redis);let fallback=0;redis.pipeline=(async(commands:Commands)=>{if(commands[0]?.[0]==="EVAL"&&commands[0]?.[3]===key)throw Error("G: unavailable release EVAL");fallback++;return real(commands);}) as typeof redis.pipeline;
let result="";try{result=await releaseLockStrict({key,token,ttlSeconds:2});}finally{redis.pipeline=real;}
is("G existing strict release reports unknown on EVAL failure",result,"unknown");
is("G existing strict release performs no GET/DEL fallback",fallback,0);
is("G existing strict release leaves the actual held key intact",redis.run(["GET",key]),token);
done();}
main().catch(e=>{console.error(e);process.exitCode=1;});
