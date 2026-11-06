import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {claimHandle,storeForEmail,storeRef} from "@/lib/store";
import {UnknownReplyError} from "@/lib/redis-reply";
import {store as redis} from "./redis-stub";

test("owner lookup requires one reply and the exact persisted store identity",async()=>{
 redis.clear();
 const owner="owner-lookup@example.test";
 await claimHandle(owner,"ownerlookupfixture","Owner lookup fixture","");
 const key="nl:store:owner:"+createHash("sha256").update("nimbus-store:"+owner).digest("hex").slice(0,40);
 const pipeline=redis.pipeline;
 const [raw]=await pipeline([["GET",key]]);
 assert.equal(typeof raw,"string");
 const value=JSON.parse(raw as string);
 const original=await storeForEmail(owner);
 assert.ok(original);
 assert.equal((await storeForEmail(owner.toUpperCase()))?.handle,original.handle);
 let reads=0,otherCommands=0;
 // Nil, or a readable record that is not this owner's: no store here (null).
 const notHere:unknown[][]=[
  [null],
  [JSON.stringify({...value,email:"other-owner@example.test"})],
  [JSON.stringify({...value,extra:true,sid:"a".repeat(32)})],
 ];
 // A reply out of shape is unknown (CX-123 rule 24): it throws, never "no store".
 const unknown:unknown[][]=[
  [],["{invalid"],[undefined],[raw,raw],
  [JSON.stringify({...value,email:42})],
 ];
 try{
  for(const [reply,want] of [...notHere.map((r)=>[r,"null"] as const),...unknown.map((r)=>[r,"unknown"] as const)]){
   redis.pipeline=async(commands)=>{
    if(commands.length===1&&commands[0][0]==="GET"&&commands[0][1]===key){reads++;return reply;}
    otherCommands+=commands.length;
    return pipeline(commands);
   };
   const got=await storeForEmail(owner).then((s)=>s===null?"null":"store",(e:unknown)=>e instanceof UnknownReplyError?"unknown":"threw");
   assert.equal(got,want,JSON.stringify(reply));
   assert.deepEqual(await pipeline([["GET",key]]),[raw]);
  }
 }finally{redis.pipeline=pipeline;}
 assert.equal(reads,notHere.length+unknown.length);
 assert.equal(otherCommands,0);
 assert.deepEqual(await storeForEmail(owner),original);
});

test("legacy first stores and extra stores retain their existing addresses",async()=>{
 redis.clear();
 const owner="legacy-lookup@example.test";
 await claimHandle(owner,"legacylookupfixture","Legacy lookup fixture","");
 const key=(ref:string)=>"nl:store:owner:"+createHash("sha256").update("nimbus-store:"+ref.toLowerCase()).digest("hex").slice(0,40);
 const [raw]=await redis.pipeline([["GET",key(owner)]]);
 const value=JSON.parse(raw as string);
 delete value.sid;delete value.extra;
 await redis.pipeline([["SET",key(owner),JSON.stringify(value)]]);
 const legacy=await storeForEmail(owner.toUpperCase());
 assert.ok(legacy);assert.equal(storeRef(legacy),owner);
 const sid="b".repeat(32),ref="#"+sid;
 await redis.pipeline([["SET",key(ref),JSON.stringify({...value,sid,extra:true})]]);
 const extra=await storeForEmail(ref);
 assert.ok(extra);assert.equal(storeRef(extra),ref);assert.equal(extra.email,owner);
 // A valid record copied under another id is not that id's owner.
 await redis.pipeline([["SET",key("#"+"c".repeat(32)),JSON.stringify({...value,sid,extra:true})]]);
 assert.equal(await storeForEmail("#"+"c".repeat(32)),null);
 assert.equal((await storeForEmail(owner))?.handle,legacy.handle);
});
