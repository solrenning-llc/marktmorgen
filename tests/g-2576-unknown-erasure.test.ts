/** G: real erasure functions, synthetic Redis partial acknowledgements only. */
import { addPersonNote, forgetNotesPerson, readPersonNotes, personKey } from "@/lib/buyer-profile";
import { erasePerson } from "@/lib/person-erasure";
import { claimHandle, ensureStatsId, ensureListId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

async function main() {
 const real=redis.pipeline.bind(redis);
 const stats="s".repeat(16),person="a".repeat(32);
 for(const bad of [[],[undefined]]) {
  redis.clear();
  await addPersonNote(stats,person,"team@example.com","Private note must disappear",ROOM);
  redis.pipeline=(async(commands:(string|number)[][])=>commands.some(c=>c[0]==="EVAL"&&String(c[1]).startsWith("-- marktmorgen:hash-take-all:"))?bad:real(commands)) as typeof redis.pipeline;
  let refused=false;
  try {await forgetNotesPerson(stats,person,ROOM);} catch {refused=true;}
  finally {redis.pipeline=real as typeof redis.pipeline;}
  is("control: note still present after unapplied partial answer "+JSON.stringify(bad),(await readPersonNotes(stats,person)).length,1);
  is("unknown deletion must be refused, not certified as zero "+JSON.stringify(bad),refused,true);
 }
 redis.clear();
 is("confirmed empty hash remains a valid no-op",await forgetNotesPerson(stats,person,ROOM),0);
 redis.clear();
 const owner="g-erasure@example.com",email="person@example.com";
 await claimHandle(owner,"gerasure","G Erasure","");
 await ensureStatsId(owner);await ensureListId(owner);
 await setSubscription(owner,{customerId:"cus_gproof",subscriptionId:"sub_gproof",active:true,tier:"scale",period:paidPeriod()});
 const store=(await storeForEmail(owner))!;
 if(!store?.statsId)throw Error("fixture missing store");
 const who=personKey(store.statsId,email);
 await addPersonNote(store.statsId,who,owner,"Personal note survives unknown deletion",store);
 const target=`nl:person:${store.statsId}:n:${who}`;
 redis.pipeline=(async(commands:(string|number)[][])=>commands.some(c=>c[0]==="EVAL"&&String(c[1]).startsWith("-- marktmorgen:hash-take-all:")&&c[3]===target)?[]:real(commands)) as typeof redis.pipeline;
 let result;
 try {result=await erasePerson(store,email,{kind:"person"});}
 finally {redis.pipeline=real as typeof redis.pipeline;}
 console.log("Actual aggregate result",result);
 is("control: real note survives aggregate deletion",(await readPersonNotes(store.statsId,who)).length,1);
 is("aggregate must not certify erasure with surviving notes",result.ok,false);
 done();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
