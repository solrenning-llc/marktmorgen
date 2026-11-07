/** G: a real unsubscribe between CAS read-back and fallback HSET must not be undone by a label update. */
import { changeLabels, leadsKey, readUnsubToken, tokensFor, unsubscribe, upsertContact } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is } from "./check";
const list="g_consent_race",email="reader@example.com",handle="g-consent";
const real=redis.pipeline.bind(redis);
let failedEval=false,unsubscribedDuringRead=false,readBack=false;
async function main(){
 redis.clear();
 await upsertContact(list,email,{agreed:true,explicit:true,source:"free"},ROOM);
 await changeLabels(list,[email],()=>["before"],ROOM);
 const token=(await tokensFor(list,[email],handle)).get(email);
 if(!token||!(await readUnsubToken(token)))throw Error("G valid initial token setup");
 redis.pipeline=async commands=>{
  if(commands.length===1&&commands[0][0]==="EVAL"&&String(commands[0][1]).includes("redis.sha1hex")){
   failedEval=true;throw Error("G synthetic CAS request failed before application");
  }
  if(failedEval&&!readBack&&commands.length===1&&commands[0][0]==="HMGET"&&commands[0][1]===leadsKey(list)){
   readBack=true;const before=await real(commands);
   const left=await unsubscribe(token);if(!left)throw Error("G unsubscribe setup");
   unsubscribedDuringRead=Boolean((await readUnsubToken(token))?.contact.unsub);
   return before;
  }
  return real(commands);
 };
 const changed=await changeLabels(list,[email],()=>["after"],ROOM);
 redis.pipeline=real;
 is("control: the exact fallback race ran and unsubscribe applied",[failedEval,readBack,unsubscribedDuringRead],[true,true,true]);
 is("a label update never overwrites a later real unsubscribe",(await readUnsubToken(token))?.contact.unsub,true);
 is("the next send cannot select the person who just left",(await tokensFor(list,[email],handle)).has(email),false);
 is("control: label operation reports its actual write",changed.changed,[email]);
 await unsubscribe(token);
 is("healthy control: a completed unsubscribe is observable",(await readUnsubToken(token))?.contact.unsub,true);
 await changeLabels(list,[email],()=>["healthy-after"],ROOM);
 is("healthy control: ordinary label write preserves opt-out",[(await readUnsubToken(token))?.contact.unsub,(await tokensFor(list,[email],handle)).has(email)],[true,false]);
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
