/** G: a real unsubscribe between CAS read-back and fallback HSET must not be undone by a label update. */
// Codex G's proof on #3116 (review 5814705210, SHA256 5e099e32...). Its one control that expected the label written while
// every CAS script fails now expects the honest answer: nothing written, "not known" (UnknownReplyError). The rest is G's.
import { changeLabels, leadsKey, readUnsubToken, tokensFor, unsubscribe, upsertContact } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is } from "./check";
import { UnknownReplyError } from "@/lib/redis-reply";
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
 const changed=await changeLabels(list,[email],()=>["after"],ROOM).then(r=>r,(error:unknown)=>error);
 redis.pipeline=real;
 is("control: the exact fallback race ran and unsubscribe applied",[failedEval,readBack,unsubscribedDuringRead],[true,true,true]);
 is("a label update never overwrites a later real unsubscribe",(await readUnsubToken(token))?.contact.unsub,true);
 is("the next send cannot select the person who just left",(await tokensFor(list,[email],handle)).has(email),false);
 is("control: label operation reports its actual write (none: not known, never a plain write)",[changed instanceof UnknownReplyError,(await readUnsubToken(token))?.contact.tags],[true,["before"]]);
 await unsubscribe(token);
 is("healthy control: a completed unsubscribe is observable",(await readUnsubToken(token))?.contact.unsub,true);
 await changeLabels(list,[email],()=>["healthy-after"],ROOM);
 is("healthy control: ordinary label write preserves opt-out",[(await readUnsubToken(token))?.contact.unsub,(await tokensFor(list,[email],handle)).has(email)],[true,false]);
 // The tests' Redis runs the script itself: an ordinary label write is one EVAL and never a plain HSET of the list.
 const sent:string[]=[];
 redis.pipeline=async commands=>{for(const c of commands)if(c[1]===leadsKey(list)||String(c[1]).includes("redis.sha1hex"))sent.push(String(c[0]));return real(commands);};
 await changeLabels(list,[email],()=>["one-step"],ROOM);
 redis.pipeline=real;
 is("an ordinary label write is the script's one step, with no HSET of the contact",[sent.filter(c=>c==="EVAL").length,sent.includes("HSET"),(await readUnsubToken(token))?.contact.tags],[1,false,["one-step"]]);
 // Bulk labels (keepWritten): a write whose script failed is answered as not known, and nothing is written.
 const failing=async(commands:(string|number)[][])=>{if(commands.length===1&&commands[0][0]==="EVAL"&&String(commands[0][1]).includes("redis.sha1hex"))throw Error("G synthetic CAS request failed before application");return real(commands);};
 redis.pipeline=failing;
 const kept=await changeLabels(list,[email],()=>["kept-after"],ROOM,{keepWritten:true});
 redis.pipeline=real;
 const after=await readUnsubToken(token);
 is("keepWritten: not known, nothing written, still unsubscribed",[kept.changed,kept.failed,kept.unsure,kept.error instanceof UnknownReplyError,after?.contact.tags,after?.contact.unsub],[[],[email],true,true,["one-step"],true]);
 // A send (tokensFor) whose contact write failed stops as not known, never as "nobody to write to".
 const fresh="fresh@example.com";
 await upsertContact(list,fresh,{agreed:true,explicit:true,source:"free"},ROOM);
 redis.pipeline=failing;
 const tokens=await tokensFor(list,[fresh],handle).then(r=>r,(error:unknown)=>error);
 redis.pipeline=real;
 is("tokensFor: a failed contact write throws UnknownReplyError",tokens instanceof UnknownReplyError,true);
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
