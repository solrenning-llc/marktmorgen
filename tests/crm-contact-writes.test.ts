import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/crm/route";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { crmAnswer } from "@/lib/crm-response";
import { CrmValueWriteUnconfirmed, SET_CRM_VALUE, setValue } from "@/lib/crm";
import { LockBusyError } from "@/lib/redis-lock";
import { dataUsed } from "@/lib/store-data";
import { type CrmField } from "@/lib/crm-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";
async function main() {
  redis.clear();
  const person="a".repeat(32), field: CrmField={id:"cust01",name:"Company",type:"text",options:[]};
  const key="nl:crm:v:contact-check:"+field.id;
  const original=redis.pipeline;
  // The value is written by one script (SET_CRM_VALUE), under the store's people lock.
  const isWrite=(c:(string|number)[])=>c[0]==="EVAL" && c[1]===SET_CRM_VALUE;
  let reply: unknown=[[1]], applied=false, writes=0;
  redis.pipeline=async commands=>{if (!commands.some(isWrite)) return original.call(redis,commands);writes++;if(applied)await original.call(redis,commands);if(reply instanceof Error)throw reply;return reply as unknown[];};
  try {
    part("Contact saves and clears require exact acknowledgements");
    for(const value of ["Acme", ""]) {
      for(const invalid of [null, {}, [], [null], ["1"], [true], [-1], [1], [2], [[]], [[2]], [[1,5]], [[1,"a","b"]], [1,1], new Error("reply lost")]) {
        reply=invalid;writes=0;let uncertain=false;
        try { await setValue("contact-check",person,field,value, ROOM); } catch(error) { uncertain=error instanceof CrmValueWriteUnconfirmed; }
        is("unknown save or clear stays uncertain",uncertain,true);
        is("unknown save or clear is never retried",writes,1);
      }
      for(const result of [[1],[1,"Before"]]) { reply=[result];is("the script's acknowledgement confirms save or clear",await setValue("contact-check",person,field,value, ROOM),true); }
    }
    part("A lock lost before the write: nothing written, the room taken given back, and it says so");
    {
      const used=async()=>(await dataUsed(ROOM))?.used ?? 0;
      const before=await used();
      reply=[0];writes=0;let busy=false;
      try { await setValue("contact-check",person,field,"Acme Corporation", ROOM); } catch(error) { busy=error instanceof LockBusyError; }
      is("LockBusyError, tried once",[busy,writes],[true,1]);
      is("the room taken first is given back",await used(),before);
    }
    part("Applied writes with lost replies are not rolled back");
    applied=true;reply=[];writes=0;let uncertain=false;
    try {await setValue("contact-check",person,field,"Acme", ROOM);}catch(error){uncertain=error instanceof CrmValueWriteUnconfirmed;}
    is("applied value is still uncertain",uncertain,true);
    is("applied value is preserved",(await original.call(redis,[["HGET",key,person]]))[0],"Acme");
    is("applied save is attempted once",writes,1);
    writes=0;uncertain=false;
    try {await setValue("contact-check",person,field,"", ROOM);}catch(error){uncertain=error instanceof CrmValueWriteUnconfirmed;}
    is("applied clear is still uncertain",uncertain,true);
    is("cleared value is not recreated",(await original.call(redis,[["HGET",key,person]]))[0],null);
    is("applied clear is attempted once",writes,1);
    part("Invalid person and value are refused before storage");
    writes=0;is("invalid person refused",await setValue("contact-check","bad",field,"Acme", ROOM),false);
    is("invalid number refused",await setValue("contact-check",person,{...field,type:"number"},"bad", ROOM),false);
    is("validation refusals perform no writes",writes,0);
    part("API reports unknown contact writes without claiming success");
    redis.pipeline=original;
    const owner="contact-write-owner@example.com";await claimHandle(owner,"contact-write-check","Contact Check","");await ensureStatsId(owner);
    const sid=(await storeForEmail(owner))!.statsId!;const session=await openSession(owner);
    await original.call(redis,[["SET","nl:crm:fields:"+sid,JSON.stringify([field])]]);
    writes=0;
    redis.pipeline=async commands=>{if(commands.some(isWrite)){writes++;await original.call(redis,commands);return [];}return original.call(redis,commands);};
    const response=await POST(new NextRequest("https://marktmorgen.com/api/store/crm",{method:"POST",headers:{"content-type":"application/json",cookie:SESSION_COOKIE+"="+session},body:JSON.stringify({action:"value",field:field.id,person,value:"Acme"})}));
    const body=await response.json();
    is("API exposes uncertain write",[response.status,body.error],[502,"crm_write_unconfirmed"]);
    is("client recognizes recovery state",crmAnswer(response.ok,body),{ok:false,error:"crm_write_unconfirmed"});
    is("route attempts write once",writes,1);
    is("applied contact value remains",(await original.call(redis,[["HGET","nl:crm:v:"+sid+":"+field.id,person]]))[0],"Acme");
    // The store's people lock held by another change past the wait: 409 busy, nothing written, and the page says so.
    redis.pipeline=original;
    await original.call(redis,[["SET","nl:crm:tasklock:"+sid,"someone-else","EX",10]]);
    const busy=await POST(new NextRequest("https://marktmorgen.com/api/store/crm",{method:"POST",headers:{"content-type":"application/json",cookie:SESSION_COOKIE+"="+session},body:JSON.stringify({action:"value",field:field.id,person,value:"Globex"})}));
    const busyBody=await busy.json();
    is("busy lock: 409 busy",[busy.status,busyBody.error],[409,"busy"]);
    is("the page reads it as a refusal, not an unconfirmed write",crmAnswer(busy.ok,busyBody),{ok:false,error:"busy"});
    is("nothing written",(await original.call(redis,[["HGET","nl:crm:v:"+sid+":"+field.id,person]]))[0],"Acme");
    await original.call(redis,[["DEL","nl:crm:tasklock:"+sid]]);
  } finally {redis.pipeline=original;}
  done();
}
void main();
