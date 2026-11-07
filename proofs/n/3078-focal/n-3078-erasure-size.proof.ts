import assert from "node:assert/strict";
import test from "node:test";
import {forgetTasksPerson} from "@/lib/assignment";
import {store as redis} from "./redis-stub";
const C="crs_n3078",L="lsnn3078aaaa",W="0123456789abcdef",R="n3078-room";
const bkey="nl:tasks:bytes:"+R;
const fk="nl:course:"+C+":task:"+L+":files";
const sk="nl:course:"+C+":task:"+L+":sub:"+W;
function seed(){redis.clear();redis.run(["SET",bkey,"1100"]);redis.run(["HSET",fk,"a.pdf","100"]);redis.run(["HSET","nl:course:"+C+":task:kept:files","kept.pdf","1000"]);redis.run(["SET",sk,JSON.stringify({text:"x",file:{path:"a.pdf",name:"a.pdf",bytes:100,type:"application/pdf"},at:1,state:"waiting",feedback:"",reviewedAt:0,tries:1})]);redis.run(["ZADD","nl:course:"+C+":tasks:all",1,L+"|"+W]);}
test("control: healthy erasure leaves the other file's 1000 bytes counted",async()=>{seed();await forgetTasksPerson(C,[L],W,R);assert.equal(redis.run(["GET",bkey]),"1000");});
test("conditional unknown submission bytes never release more than the real removed file",async()=>{seed();const orig=redis.pipeline.bind(redis);redis.pipeline=(async(batch)=>{const out=await orig(batch);if(batch.length===1&&batch[0][0]==="GET"&&batch[0][1]===sk){const row=JSON.parse(String(out[0]));row.file.bytes="5000";return [JSON.stringify(row)];}return out;}) as typeof redis.pipeline;try{await forgetTasksPerson(C,[L],W,R).catch(()=>{});assert.equal(Number(redis.run(["GET",bkey]))>=1000,true,"1000-byte unrelated file remains; its room cannot be credited away");}finally{redis.pipeline=orig;}});
test("control: unrelated file remains physically indexed",async()=>{assert.equal(redis.run(["HGET","nl:course:"+C+":task:kept:files","kept.pdf"]),"1000");});
