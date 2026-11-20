import assert from "node:assert/strict";
import { test } from "node:test";
import { setChatAddress, chatAddress } from "@/lib/chat-summary";
import { ERASING_KEY, erasingField, ownerKey, storeIdCommand } from "@/lib/store";
import { store as redis } from "./redis-stub";
const control: { reply: unknown } = { reply: undefined };
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = async batch => batch[0]?.[0] === "EVAL" && control.reply !== undefined ? control.reply as unknown[] : pipeline(batch);
const URL="https://hooks.slack.com/services/synthetic/test-fixture-only";
const scope={sid:"c".repeat(32),email:"chat-erasure@example.test",statsId:"d".repeat(32),extra:false};
const setting=`nl:chatsum:${scope.statsId}`, live=storeIdCommand(scope.sid)[1];
for(const during of ["live","erasing","gone"]) test("first message in flight: "+during,async()=>{
 redis.clear();control.reply=undefined;redis.run(["SET",live,scope.email]);
 globalThis.fetch=async()=>{if(during==="gone")redis.run(["DEL",live,setting]);if(during==="erasing")redis.run(["HSET",ERASING_KEY,await erasingField(scope.email),"synthetic"]);return new Response(null,{status:204});};
 const answer=await setChatAddress(scope.statsId,"Synthetic store",URL,scope);
 if(during==="live"){assert.equal(answer,"saved");assert.equal(await chatAddress(scope.statsId),URL);assert.equal(redis.run(["TTL",setting]),-1);}
 else{assert.notEqual(answer,"saved");assert.equal(redis.run(["GET",setting]),null);}
});
test("legacy owner record erased during provider wait",async()=>{
 redis.clear();const record=await ownerKey(scope.email);redis.run(["SET",record,"synthetic-record"]);
 globalThis.fetch=async()=>{redis.run(["DEL",record,setting]);return new Response(null,{status:204});};
 assert.notEqual(await setChatAddress(scope.statsId,"Synthetic",URL,{...scope,sid:""}),"saved");assert.equal(redis.run(["GET",setting]),null);
});
test("unknown commit acknowledgement is never saved",async()=>{
 redis.clear();redis.run(["SET",live,scope.email]);control.reply=[2];globalThis.fetch=async()=>new Response(null,{status:204});
 try{await assert.rejects(setChatAddress(scope.statsId,"Synthetic",URL,scope));assert.equal(redis.run(["GET",setting]),null);}finally{control.reply=undefined;}
});
test("wrong stats scope is rejected before provider",async()=>{
 redis.clear();let posts=0;globalThis.fetch=async()=>{posts++;return new Response(null,{status:204});};
 await assert.rejects(setChatAddress("other","Synthetic",URL,scope));assert.equal(posts,0);
});
test("removal, invalid and refused provider remain honest",async()=>{
 redis.clear();globalThis.fetch=async()=>new Response(null,{status:403});assert.equal(await setChatAddress(scope.statsId,"Synthetic",URL,scope),"refused");
 assert.equal(await setChatAddress(scope.statsId,"Synthetic","https://example.test",scope),"invalid");
 assert.equal(await setChatAddress(scope.statsId,"Synthetic","",scope),"removed");
});
