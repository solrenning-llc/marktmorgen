/** Independent G: malformed daily admission must never authorize paid backup I/O. */
import test from "node:test";
import assert from "node:assert/strict";
import {runBackup,type BackupCostReview} from "@/lib/backup-run";
import type {BackupBucket} from "@/lib/backup-roundtrip";
import {store as redis} from "./redis-stub";
const now=Date.parse("2026-11-02T03:00:00Z");
const review:BackupCostReview={maxRows:1000,maxCommands:10000,maxBytes:1000000,retentionDays:3,maxStoredBytes:5*1131232,reviewedAt:"2026-10-31",source:"G synthetic admission only"};
function fixture(){
 redis.clear();redis.now=()=>now;redis.run(["SET","nl:store:one","one"]);
 const objects=new Map<string,Uint8Array>();let writes=0,lists=0;
 const bucket:BackupBucket={putNew:async(id,bytes)=>{writes++;objects.set(id,new Uint8Array(bytes));},read:async id=>objects.get(id)??Promise.reject(Error("missing")),list:async()=>{lists++;return {objects:[...objects].map(([id,bytes])=>({id,bytes:bytes.byteLength,writtenAt:now})),next:null};},delete:async id=>{objects.delete(id);}};
 return {bucket,writes:()=>writes,lists:()=>lists};
}
test("G positive: exact admission permits the first run and caps a repeat",async()=>{const f=fixture();assert.equal((await runBackup({now,review,store:f.bucket,key:Buffer.alloc(32,9)})).ok,true);const n=f.writes();assert.deepEqual(await runBackup({now,review,store:f.bucket,key:Buffer.alloc(32,9)}),{ok:false,reason:"already_ran"});assert.equal(f.writes(),n);});
for(const value of [true,[1],"01"])test(`G unknown ${JSON.stringify(value)} admission cannot authorize any copy`,async()=>{
 const f=fixture(),base=redis.pipeline.bind(redis);let intercepted=0;
 (redis as unknown as {pipeline:typeof redis.pipeline}).pipeline=(async commands=>{
  if(commands.length===2&&commands[0][0]==="SET"&&String(commands[0][1]).startsWith("nl:backup:ran:")&&commands[1][0]==="INCRBY"){intercepted++;return [null,value];}
  return base(commands);
 }) as typeof redis.pipeline;
 try {const results=[];for(let i=0;i<4;i++)results.push(await runBackup({now,review,store:f.bucket,key:Buffer.alloc(32,9)}));console.log(JSON.stringify({value,intercepted,writes:f.writes(),lists:f.lists(),results}));assert.equal(f.writes(),0,"unknown admission never authorizes writing paid objects");assert.equal(f.lists(),0,"unknown admission never authorizes paid listing");assert.ok(results.every(x=>!x.ok&&x.reason==="mark_error"));}finally{(redis as unknown as {pipeline:typeof redis.pipeline}).pipeline=base;}
});
