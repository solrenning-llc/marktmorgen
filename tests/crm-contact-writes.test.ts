import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/crm/route";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { putMember } from "@/lib/team";
import { PIN_HEADER } from "@/lib/studio-route";
import { listOrder } from "@/lib/buyer-list";
import { personKey } from "@/lib/person-key";
import { paidPeriod } from "./billing-period-fixture";
import { ROUND_TRIP_SECONDS, SHAPES } from "./plan-cost-registry";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { crmAnswer } from "@/lib/crm-response";
import { CRM_VALUE_SAVE_BYTES, CRM_VALUE_SAVE_COMMANDS, CRM_VALUE_SAVE_TRIPS, CRM_VALUE_SAVE_UNITS, CRM_VALUE_SCRIPT_CALLS, CrmPersonGone, CrmValueWriteUnconfirmed, SET_CRM_VALUE, forgetCrmPerson, readGeneration, setValue } from "@/lib/crm";
import { dataUsed } from "@/lib/store-data";
import { utf8Length } from "@/lib/store-data-rules";
import { type CrmField } from "@/lib/crm-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";
async function main() {
  redis.clear();
  const person="a".repeat(32), field: CrmField={id:"cust01",name:"Company",type:"text",options:[]};
  const key="nl:crm:v:contact-check:"+field.id;
  const original=redis.pipeline;
  // The value is written by one script (SET_CRM_VALUE).
  const isWrite=(c:(string|number)[])=>c[0]==="EVAL" && c[1]===SET_CRM_VALUE;
  let reply: unknown=[[1]], applied=false, writes=0;
  redis.pipeline=async commands=>{if (!commands.some(isWrite)) return original.call(redis,commands);writes++;if(applied)await original.call(redis,commands);if(reply instanceof Error)throw reply;return reply as unknown[];};
  try {
    part("Contact saves and clears require exact acknowledgements");
    for(const value of ["Acme", ""]) {
      for(const invalid of [null, {}, [], [null], ["1"], [true], [-1], [0], [1], [3], [[]], [[2]], [[1,5]], [[1,"a","b"]], [1,1], new Error("reply lost")]) {
        reply=invalid;writes=0;let uncertain=false;
        try { await setValue("contact-check",person,field,value, ROOM, 0); } catch(error) { uncertain=error instanceof CrmValueWriteUnconfirmed; }
        is("unknown save or clear stays uncertain",uncertain,true);
        is("unknown save or clear is never retried",writes,1);
      }
      for(const result of [[1],[1,"Before"]]) { reply=[result];is("the script's acknowledgement confirms save or clear",await setValue("contact-check",person,field,value, ROOM, 0),true); }
    }
    part("A person deleted after the request was prepared: nothing written, the room taken given back, and it says so");
    {
      const used=async()=>(await dataUsed(ROOM))?.used ?? 0;
      const before=await used();
      reply=[2];writes=0;let gone=false;
      try { await setValue("contact-check",person,field,"Acme Corporation", ROOM, 0); } catch(error) { gone=error instanceof CrmPersonGone; }
      is("CrmPersonGone, tried once",[gone,writes],[true,1]);
      is("the room taken first is given back",await used(),before);
    }
    part("Applied writes with lost replies are not rolled back");
    applied=true;reply=[];writes=0;let uncertain=false;
    try {await setValue("contact-check",person,field,"Acme", ROOM, 0);}catch(error){uncertain=error instanceof CrmValueWriteUnconfirmed;}
    is("applied value is still uncertain",uncertain,true);
    is("applied value is preserved",(await original.call(redis,[["HGET",key,person]]))[0],"Acme");
    is("applied save is attempted once",writes,1);
    writes=0;uncertain=false;
    try {await setValue("contact-check",person,field,"", ROOM, 0);}catch(error){uncertain=error instanceof CrmValueWriteUnconfirmed;}
    is("applied clear is still uncertain",uncertain,true);
    is("cleared value is not recreated",(await original.call(redis,[["HGET",key,person]]))[0],null);
    is("applied clear is attempted once",writes,1);
    part("Invalid person and value are refused before storage");
    writes=0;is("invalid person refused",await setValue("contact-check","bad",field,"Acme", ROOM, 0),false);
    is("invalid number refused",await setValue("contact-check",person,{...field,type:"number"},"bad", ROOM, 0),false);
    is("validation refusals perform no writes",writes,0);
    part("API reports unknown contact writes without claiming success");
    redis.pipeline=original;
    const owner="contact-write-owner@example.com";await claimHandle(owner,"contact-write-check","Contact Check","");await ensureStatsId(owner);await ensureListId(owner);await ensureStoreId(owner);
    await setSubscription(owner,{customerId:"cus_ContactW0001",subscriptionId:"sub_ContactW0001",active:true,tier:"pro",period:paidPeriod()});
    let store=(await storeForEmail(owner))!;const sid=store.statsId!;const session=await openSession(owner);
    await putMember(store,"maya@example.com","support");const teammate=await openSession("maya@example.com");
    // A person the store knows by their address, as the people page shows them.
    const zoe=personKey(sid,"zoe@example.com");
    await original.call(redis,[["SET","nl:crm:fields:"+sid,JSON.stringify([field])]]);
    // As the studio sends it: every request names its store (components/studio-store-pin.tsx, PIN_HEADER).
    const post=(body:Record<string,unknown>,who=session)=>POST(new NextRequest("https://marktmorgen.com/api/store/crm",{method:"POST",headers:{"content-type":"application/json",cookie:SESSION_COOKIE+"="+who,[PIN_HEADER]:store.sid},body:JSON.stringify(body)}));
    const stored=async(p=person)=>(await original.call(redis,[["HGET","nl:crm:v:"+sid+":"+field.id,p]]))[0];
    writes=0;
    redis.pipeline=async commands=>{if(commands.some(isWrite)){writes++;await original.call(redis,commands);return [];}return original.call(redis,commands);};
    const response=await post({action:"value",field:field.id,person,value:"Acme",generation:0});
    const body=await response.json();
    is("API exposes uncertain write",[response.status,body.error],[502,"crm_write_unconfirmed"]);
    is("client recognizes recovery state",crmAnswer(response.ok,body),{ok:false,error:"crm_write_unconfirmed"});
    is("route attempts write once",writes,1);
    is("applied contact value remains",await stored(),"Acme");
    redis.pipeline=original;

    part("The whole save fits in the two studio requests it takes, the second taken before anything is read (C3-125)");
    for(const [who,cookie] of [["the owner",session],["a teammate, whose save is written in the log",teammate]] as const){
      let trips=0, commands=0, inside=0, bytes=0;
      const size=(v:unknown):number=>typeof v==="string"?utf8Length(v):typeof v==="number"?String(v).length:Array.isArray(v)?v.reduce((n:number,x)=>n+size(x),0):v&&typeof v==="object"?size(Object.values(v)):0;
      const allowance=()=>redis.keys().find(k=>k.startsWith("nl:allow:studio:"));
      // The widest value a field keeps (three bytes a character), over another as wide: the most a save moves.
      await post({action:"value",field:field.id,person,value:"\u00e9".repeat(200),generation:0},cookie);
      const before=Number((await original.call(redis,[["GET",allowance()!]]))[0]);
      redis.pipeline=async sent=>{trips++;commands+=sent.length;inside+=sent.filter(isWrite).length*CRM_VALUE_SCRIPT_CALLS;const r=await original.call(redis,sent);bytes+=size(sent)+size(r);return r;};
      const saved=await post({action:"value",field:field.id,person,value:"\u20ac".repeat(200),generation:0},cookie);
      redis.pipeline=original;
      const after=Number((await original.call(redis,[["GET",allowance()!]]))[0]);
      is(`${who}: saved, ${CRM_VALUE_SAVE_UNITS} studio requests taken`,[saved.status,after-before],[200,CRM_VALUE_SAVE_UNITS]);
      is(`${who}: ${trips} trips (${trips*ROUND_TRIP_SECONDS} s at the ceiling of a trip), ${commands+inside} commands, ${bytes} bytes: within its bounds and the two requests`,[trips<=CRM_VALUE_SAVE_TRIPS,trips*ROUND_TRIP_SECONDS<=CRM_VALUE_SAVE_UNITS*SHAPES.studio.seconds,commands+inside<=CRM_VALUE_SAVE_COMMANDS,bytes<=CRM_VALUE_SAVE_BYTES],[true,true,true,true]);
    }

    part("While a person is deleted, no save writes about them, whatever it carries (C3-125)");
    const read=await readGeneration(sid,zoe);
    is("a page read before: generation 0",[(await post({action:"value",field:field.id,person:zoe,value:"Globex",generation:read})).status,await stored(zoe)],[200,"Globex"]);
    await forgetCrmPerson(sid,zoe,"zoe@example.com",store);
    // However long ago (the mark's time put back a day), with the page's generation, the one now, or one made up.
    await original.call(redis,[["SET","nl:crm:erased:"+sid+":"+zoe,String(Date.now()-86_400_000),"EX",3600]]);
    for(const carried of [read,await readGeneration(sid,zoe),99,undefined]){
      const late=await post({action:"value",field:field.id,person:zoe,value:"Umbrella",...(carried===undefined?{}:{generation:carried}),preparedAt:Date.now()});
      const lateBody=await late.json();
      is(`carrying ${String(carried)}: 404 unknown, read as a refusal`,[late.status,crmAnswer(late.ok,lateBody)],[404,{ok:false,error:"unknown"}]);
    }
    is("nothing written again",await stored(zoe),null);
    is("and the mark stays",(await original.call(redis,[["EXISTS","nl:crm:erased:"+sid+":"+zoe]]))[0],1);

    part("A real return, by a paid order: the mark goes; a page read since writes, one read before never does");
    store=(await storeForEmail(owner))!;
    is("(the order is put on the list)",await listOrder(store,{sessionId:"cs_test_contactreturn01",email:"zoe@example.com",news:false,created:Math.floor(Date.now()/1000),products:[{id:"prod01",title:"Course"}]}),"done");
    is("the mark is gone",(await original.call(redis,[["EXISTS","nl:crm:erased:"+sid+":"+zoe]]))[0],0);
    is("a page read before the deletion: still 404",(await post({action:"value",field:field.id,person:zoe,value:"Stale",generation:read})).status,404);
    const since=await readGeneration(sid,zoe);
    is("a page read since: saved",[(await post({action:"value",field:field.id,person:zoe,value:"Initech",generation:since})).status,await stored(zoe)],[200,"Initech"]);
    is("(the value set directly, from a page read before, is refused too)",await setValue(sid,zoe,field,"Stale",store,read).then(()=>"written",(error:unknown)=>error instanceof CrmPersonGone?"gone":String(error)),"gone");
  } finally {redis.pipeline=original;}
  done();
}
void main();
