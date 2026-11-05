/** Opt-in independent review: real student API, session mark, and learner passes; synthetic Redis replies only. */
import { NextRequest } from "next/server";
import { POST as passkeys } from "@/app/api/auth/passkey/route";
import { GET as studentsRead } from "@/app/api/v1/students/route";
import { isFreshSession, noteSignIn, openSession, endSession } from "@/lib/auth";
import { makeKey } from "@/lib/api-keys";
import { emptyCourse, saveCourse } from "@/lib/course";
import { emailKey, forgetLearnerPerson, learnerFrom, mintPass, passCookieName, setBlocked } from "@/lib/learn";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
const mails: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
 const url = new URL(String(input instanceof Request ? input.url : input));
 if (url.hostname === "api.resend.com") { mails.push(String(init?.body)); return Response.json({id:"synthetic"}); }
 if (url.hostname === "api.stripe.com") return Response.json({object:"list",data:[],has_more:false});
 throw new Error(`unexpected synthetic request: ${url.hostname}`);
}) as typeof fetch;
type C = (string | number)[][];
let inject: ((cs:C) => unknown[] | undefined) | null = null;
let hits = 0;
const native = redis.pipeline.bind(redis);
redis.pipeline = (async (cs:C) => { const out = inject?.(cs); if(out !== undefined) {hits++;return out;} return native(cs); }) as typeof redis.pipeline;
async function main() {
 const owner = "g2717-owner@example.com";
 await claimHandle(owner,"g2717-review","Review"," "); await ensureStatsId(owner);
 await setSubscription(owner,{customerId:"cus_G2717Review",subscriptionId:"sub_G2717Review",active:true,tier:"pro",cycle:"month",period:paidPeriod()});
 const made = await addProduct(owner,"Synthetic course","","50"); if(!made.ok) throw Error("product fixture");
 const course = emptyCourse(); await saveCourse(course,ROOM); await setProductCourse(owner,made.product.id,{id:course.id,lessons:0});
 const store = (await storeForEmail(owner))!;
 const key = await makeKey(store.sid,"Synthetic reader");if(!key.ok)throw Error("key fixture");
 const learner = "g2717-student@example.com";
 const field = emailKey(learner), row = JSON.stringify({e:learner,s:1790000000,l:1790000010});
 await native([["HSET",`nl:course:${course.id}:students`,field,row]]);
 await setBlocked(store,course.id,learner,true);
 const request = () => new Request(`https://marktmorgen.com/api/v1/students?product=${made.product.id}`,{headers:{authorization:`Bearer ${key.key}`}});
 const read = async () => {const r=await studentsRead(request());return {status:r.status,body:await r.json() as {data?:{email:string;blocked:boolean}[];total?:number;next?:unknown;error?:string}};};
 part("Real authenticated API: unknown scan and blocked readings are unavailable, never invented rows/state");
 let control=await read();is("native control: one real blocked student",[control.status,control.body.total,control.body.data?.[0]?.email,control.body.data?.[0]?.blocked],[200,1,learner,true]);
 const scan=(cs:C)=>cs[0]?.[0]==="HSCAN"&&cs[0]?.[1]===`nl:course:${course.id}:students`;
 for(const [label,reply] of [
  ["scan payload null",[["0",null],1,1]],
  ["scan payload object",[["0",{result:[]}],1,1]],
  ["odd hash",[["0",[field]],1,1]],
  ["bad stored row",[["0",[field,"{bad"]],1,1]],
 ] as [string,unknown[]][]) {
  hits=0;inject=cs=>scan(cs)?reply:undefined;
  const got=await read(); is(`${label}: injection reached`,hits,1);
  is(`${label}: refuses unavailable instead of 200/empty/end`,[got.status,got.body.error],[502,"unavailable"]);
  console.log("OBSERVED",label,JSON.stringify(got));
 }
 // All rows and counts stay real; replace only the supplementary SMEMBERS for blocked students.
 hits=0;inject=cs=>cs.some(c=>c[0]==="SMEMBERS"&&c[1]===`nl:course:${course.id}:blocked`)?cs.map(c=>c[0]==="SMEMBERS"&&c[1]===`nl:course:${course.id}:blocked`?null:redis.run(c)):undefined;
 let blocked=await read();is("blocked list unknown injection reached",hits,1);is("blocked list unknown is unavailable, not blocked=false",[blocked.status,blocked.body.error],[502,"unavailable"]);console.log("OBSERVED blocked",JSON.stringify(blocked));
 inject=null;control=await read();is("native control after faults: row and block still there",[control.status,control.body.data?.length,control.body.data?.[0]?.blocked],[200,1,true]);
 part("Fresh login: complete EXISTS only; the real passkey route refuses an ended session");
 const session=await openSession(owner);
 const fresh=(cs:C)=>cs.length===1&&cs[0][0]==="EXISTS"&&String(cs[0][1]).startsWith("nl:auth:fresh:");
 for(const [label,reply] of [["null",[null]],["text",["1"]],["extra",[1,1]],["missing",[]],["object",[{result:1}]], ["two",[2]]] as [string,unknown[]][]) {
  inject=cs=>fresh(cs)?reply:undefined;is(`fresh ${label} refuses`,await isFreshSession(session),false);
 }
 inject=null;is("real fresh session is fresh",await isFreshSession(session),true);await endSession(session);const ended = await passkeys(new NextRequest("https://marktmorgen.com/api/auth/passkey", {method:"POST",headers:{"content-type":"application/json",cookie:`nl_session=${session}`},body:JSON.stringify({action:"options"})}));is("ended session cannot request passkey options",[ended.status,(await ended.json()).error],[401,"signed_out"]);
 part("New browser: unknown does not note or email; exact positive path stays reachable");
 const device="b".repeat(64);await noteSignIn(owner,"a".repeat(64),"link","Synthetic");
 for(const reply of [[null,1],[0,"1"],[2,1],[0,1,1],[]]) {
  const before=mails.length;let writes=0;
  inject=cs=>{if(cs.some(c=>c[0]==="SADD"&&String(c[1]).startsWith("nl:auth:devices:")))writes++;return cs.length===2&&cs[0][0]==="SISMEMBER"?reply:undefined;};
  await noteSignIn(owner,device,"link","Synthetic");is(`notice rejects ${JSON.stringify(reply)}`,[writes,mails.length-before],[0,0]);
 }
 inject=null;const before=mails.length;await noteSignIn(owner,device,"link","Synthetic");is("exact new-browser path sends one synthetic notice",mails.length-before,1);
 part("Erasure: real pass persists on unknown read, then exact retry deletes it");
 const token=await mintPass(store,learner,"all");const jar={get:(name:string)=>name===passCookieName(store)?{value:token}:undefined};
 is("real minted pass works",(await learnerFrom(store,jar))?.email,learner);
 inject=cs=>cs.length===1&&cs[0][0]==="SMEMBERS"&&String(cs[0][1]).startsWith("nl:learn:passes:")?[null]:undefined;
 let rejected=false;try{await forgetLearnerPerson(store,learner,[{courseId:course.id,moduleIds:[]}]);}catch(e){rejected=e instanceof Error&&e.name==="UnknownReplyError";}
 is("unknown pass list refuses unfinished",rejected,true);inject=null;
 is("unknown read preserved pass for retry",(await learnerFrom(store,jar))?.email,learner);
 await forgetLearnerPerson(store,learner,[{courseId:course.id,moduleIds:[]}]);
 is("exact retry removes actual pass",await learnerFrom(store,jar),null);
 done();
}
void main();
