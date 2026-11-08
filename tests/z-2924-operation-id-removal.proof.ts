/** Explicit delayed-completion model, not a native Redis ordering claim. */
import {strict as assert} from "node:assert";
import {test} from "node:test";
import {addSpend,removeSpend} from "@/lib/ad-spend";
import {readSpend,MAX_SPEND_CENTS} from "@/lib/ad-spend-rules";
import {store as redis} from "./redis-stub";
const SID="z2924-op-removal",KEY=`nl:stats:${SID}:spend`,OP="0123456789abcdef0123456789abcdef";
const day=new Date().toISOString().slice(0,10);
const LINE={channel:"instagram",cents:1200,from:day,to:day,op:OP};
type Command=(string|number)[];
const real=redis.pipeline.bind(redis);
async function rows(){const [flat]=await real([["HGETALL",KEY]]);return (flat as string[]).filter((_,i)=>i%2===1).map(s=>(JSON.parse(s) as {cents:number}).cents);}
for(const late of [false,true]){
 test(`a confirmed removal stays removed: original completion ${late?"after":"before"} removal`,async()=>{
  redis.clear();const pending:Command[][]=[];
  redis.pipeline=async commands=>{if(commands.some(c=>c[0]==="HSETNX")){pending.push(commands);throw Error("synthetic first completion unresolved");}return real(commands);};
  try{await assert.rejects(addSpend(SID,LINE));}finally{redis.pipeline=real;}
  assert.equal(pending.length,1);
  assert.equal((await addSpend(SID,LINE)).ok,true);
  assert.deepEqual(await rows(),[1200]);
  if(!late)for(const commands of pending)await real(commands);
  assert.deepEqual((await removeSpend(SID,OP)).spends,[]);
  assert.deepEqual(await rows(),[],"the confirmed remove really applied");
  if(late)for(const commands of pending)await real(commands);
  const final=await rows();console.log(JSON.stringify({originalCompletion:late?"after remove":"before remove",final}));
  assert.deepEqual(final,[],"the confirmed removal must not be silently reversed by the first add");
 });
}
test("operation identity adds 24 field bytes; one maximally shaped entry stays inside the existing 512-byte allowance",()=>{
 const read=readSpend({channel:"x".repeat(30),campaign:"y".repeat(40),cents:MAX_SPEND_CENTS,from:day,to:day});
 assert.equal(read.ok,true);if(!read.ok)throw Error("invalid maximum fixture");
 const value=JSON.stringify(read.spend),old=Buffer.byteLength(value)+8,current=Buffer.byteLength(value)+32;
 // Conservative explicit per-field/key bookkeeping stand-in, not measured native Redis allocation.
 const bookkeeping=128;
 console.log(JSON.stringify({valueBytes:Buffer.byteLength(value),oldFieldAndValue:old,newFieldAndValue:current,extra:current-old,withBookkeeping:current+bookkeeping,registryPerEntry:512}));
 assert.equal(current-old,24);assert.ok(current+bookkeeping<=512);
});
test("measured caller command counts: HSETNX replaces HSET and an already kept operation sends no write",async()=>{
 async function measured(op:string|undefined){
  const commands:Command[]=[];let requestBytes=0,replyBytes=0;
  redis.pipeline=async batch=>{commands.push(...batch);requestBytes+=Buffer.byteLength(JSON.stringify(batch));const reply=await real(batch);replyBytes+=Buffer.byteLength(JSON.stringify(reply));return reply;};
  try{assert.equal((await addSpend(SID,{...LINE,op})).ok,true);}finally{redis.pipeline=real;}
  return {commands:commands.length,writes:commands.filter(c=>c[0]==="HSET"||c[0]==="HSETNX").map(c=>c[0]),requestBytes,replyBytes};
 }
 redis.clear();const legacy=await measured(undefined);
 redis.clear();const fresh=await measured(OP),retry=await measured(OP);
 console.log(JSON.stringify({callerVolume:{legacy,fresh,retry},bytes:"JSON batches/replies only; excludes REST envelope, headers and TLS"}));
 assert.deepEqual(legacy.writes,["HSET"]);assert.deepEqual(fresh.writes,["HSETNX"]);assert.deepEqual(retry.writes,[]);
 assert.equal(fresh.commands,legacy.commands);assert.equal(retry.commands,fresh.commands-2);
});
