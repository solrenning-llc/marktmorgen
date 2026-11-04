import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/crm/route";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { crmAnswer } from "@/lib/crm-response";
import { CRM_VALUE_SET_COMMANDS, CRM_VALUE_SET_SENT, CrmPersonGone, CrmValueWriteUnconfirmed, ERASED_CLOCK_MS, SET_CRM_VALUE, setValue } from "@/lib/crm";
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
        try { await setValue("contact-check",person,field,value, ROOM, Date.now()); } catch(error) { uncertain=error instanceof CrmValueWriteUnconfirmed; }
        is("unknown save or clear stays uncertain",uncertain,true);
        is("unknown save or clear is never retried",writes,1);
      }
      for(const result of [[1],[1,"Before"]]) { reply=[result];is("the script's acknowledgement confirms save or clear",await setValue("contact-check",person,field,value, ROOM, Date.now()),true); }
    }
    part("A person deleted after the request was prepared: nothing written, the room taken given back, and it says so");
    {
      const used=async()=>(await dataUsed(ROOM))?.used ?? 0;
      const before=await used();
      reply=[2];writes=0;let gone=false;
      try { await setValue("contact-check",person,field,"Acme Corporation", ROOM, Date.now()); } catch(error) { gone=error instanceof CrmPersonGone; }
      is("CrmPersonGone, tried once",[gone,writes],[true,1]);
      is("the room taken first is given back",await used(),before);
    }
    part("Applied writes with lost replies are not rolled back");
    applied=true;reply=[];writes=0;let uncertain=false;
    try {await setValue("contact-check",person,field,"Acme", ROOM, Date.now());}catch(error){uncertain=error instanceof CrmValueWriteUnconfirmed;}
    is("applied value is still uncertain",uncertain,true);
    is("applied value is preserved",(await original.call(redis,[["HGET",key,person]]))[0],"Acme");
    is("applied save is attempted once",writes,1);
    writes=0;uncertain=false;
    try {await setValue("contact-check",person,field,"", ROOM, Date.now());}catch(error){uncertain=error instanceof CrmValueWriteUnconfirmed;}
    is("applied clear is still uncertain",uncertain,true);
    is("cleared value is not recreated",(await original.call(redis,[["HGET",key,person]]))[0],null);
    is("applied clear is attempted once",writes,1);
    part("Invalid person and value are refused before storage");
    writes=0;is("invalid person refused",await setValue("contact-check","bad",field,"Acme", ROOM, Date.now()),false);
    is("invalid number refused",await setValue("contact-check",person,{...field,type:"number"},"bad", ROOM, Date.now()),false);
    is("validation refusals perform no writes",writes,0);
    part("API reports unknown contact writes without claiming success");
    redis.pipeline=original;
    const owner="contact-write-owner@example.com";await claimHandle(owner,"contact-write-check","Contact Check","");await ensureStatsId(owner);
    const sid=(await storeForEmail(owner))!.statsId!;const session=await openSession(owner);
    await original.call(redis,[["SET","nl:crm:fields:"+sid,JSON.stringify([field])]]);
    const post=(body:Record<string,unknown>)=>POST(new NextRequest("https://marktmorgen.com/api/store/crm",{method:"POST",headers:{"content-type":"application/json",cookie:SESSION_COOKIE+"="+session},body:JSON.stringify(body)}));
    const stored=async()=>(await original.call(redis,[["HGET","nl:crm:v:"+sid+":"+field.id,person]]))[0];
    writes=0;
    redis.pipeline=async commands=>{if(commands.some(isWrite)){writes++;await original.call(redis,commands);return [];}return original.call(redis,commands);};
    const response=await post({action:"value",field:field.id,person,value:"Acme",preparedAt:Date.now()});
    const body=await response.json();
    is("API exposes uncertain write",[response.status,body.error],[502,"crm_write_unconfirmed"]);
    is("client recognizes recovery state",crmAnswer(response.ok,body),{ok:false,error:"crm_write_unconfirmed"});
    is("route attempts write once",writes,1);
    is("applied contact value remains",await stored(),"Acme");
    redis.pipeline=original;

    part("A save fits in the one studio request it takes: its commands and bytes, with the route's own reads (C3-123)");
    {
      let trips=0, commands=0, bytes=0, sets=0, own=0;
      const size=(v:unknown):number=>typeof v==="string"?utf8Length(v):typeof v==="number"?String(v).length:Array.isArray(v)?v.reduce((n:number,x)=>n+size(x),0):v&&typeof v==="object"?size(Object.values(v)):0;
      redis.pipeline=async sent=>{trips++;commands+=sent.length;sets+=sent.filter(isWrite).length;own+=sent.filter(c=>isWrite(c)||(c[0]==="EVAL"&&String(c[1]).startsWith("-- marktmorgen:store-data:"))).length;const r=await original.call(redis,sent);bytes+=size(sent)+size(r);return r;};
      // The widest value a field keeps (three bytes a character), over another as wide: the most a save moves.
      await post({action:"value",field:field.id,person,value:"é".repeat(200),preparedAt:Date.now()});
      trips=0;commands=0;bytes=0;sets=0;own=0;
      const saved=await post({action:"value",field:field.id,person,value:"€".repeat(200),preparedAt:Date.now()});
      redis.pipeline=original;
      is("saved",saved.status,200);
      is(`its commands (${commands} sent, and what the value's script runs inside) and bytes (${bytes}) are within a studio request's twenty and its count's, and 50,000`,[commands+CRM_VALUE_SET_COMMANDS-CRM_VALUE_SET_SENT<=24,bytes<=50_000],[true,true]);
      is(`one write, and the value set's own commands (the room taken, the write, the room given back) within CRM_VALUE_SET_COMMANDS; ${trips} trips in all`,[sets,own<=CRM_VALUE_SET_SENT],[1,true]);
      const allowance=redis.keys().find(k=>k.startsWith("nl:allow:studio:"))!;
      const before=Number((await original.call(redis,[["GET",allowance]]))[0]);
      await post({action:"value",field:field.id,person,value:"Acme",preparedAt:Date.now()});
      const after=Number((await original.call(redis,[["GET",allowance]]))[0]);
      is("and a save takes one studio request, never more",after-before,1);
    }

    part("A person deleted after the page was drawn: 404 unknown, nothing about them written again");
    const erasedAt=Date.now();
    await original.call(redis,[["SET","nl:crm:erased:"+sid+":"+person,String(erasedAt),"EX",60]]);
    const old=await post({action:"value",field:field.id,person,value:"Umbrella",preparedAt:erasedAt-60_000});
    const oldBody=await old.json();
    is("a page drawn before the deletion: 404 unknown",[old.status,oldBody.error],[404,"unknown"]);
    is("the page reads it as a refusal",crmAnswer(old.ok,oldBody),{ok:false,error:"unknown"});
    is("nothing written again",await stored(),"Acme");
    is("a page that sends no time is taken as drawn before",(await post({action:"value",field:field.id,person,value:"Umbrella"})).status,404);
    is("nor one drawn within the clocks' difference of it",(await post({action:"value",field:field.id,person,value:"Umbrella",preparedAt:erasedAt+ERASED_CLOCK_MS-1})).status,404);
    is("and the mark stays",(await original.call(redis,[["GET","nl:crm:erased:"+sid+":"+person]]))[0],String(erasedAt));

    part("Someone who came back: a page drawn after the deletion writes, and the mark goes");
    await original.call(redis,[["SET","nl:crm:erased:"+sid+":"+person,String(Date.now()-60_000),"EX",60]]);
    const back=await post({action:"value",field:field.id,person,value:"Initech",preparedAt:Date.now()});
    is("saved",[back.status,await stored()],[200,"Initech"]);
    is("the mark is gone",(await original.call(redis,[["EXISTS","nl:crm:erased:"+sid+":"+person]]))[0],0);
  } finally {redis.pipeline=original;}
  done();
}
void main();
