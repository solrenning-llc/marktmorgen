import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { clicksOf, forgetClicksPerson, keyIndex, linkKeyOf, usedLinkIn } from "@/lib/mail-clicks";
import { leadsKey } from "@/lib/contacts";
import { store as redis } from "./redis-stub";

const list = "n_privacy_list", email = "reader@example.com", token = "a".repeat(40);
const campaign = "s-0123456789abcdef-fedcba9876543210";
const used = `nl:mail:clk:${list}:${createHash("sha256").update(`nimbus-clk:${email}`).digest("hex").slice(0,32)}`;
const marker = keyIndex(linkKeyOf(token));
const real = redis.pipeline.bind(redis);
type Command = (string | number)[];
beforeEach(() => { redis.pipeline = real; redis.clear(); });
async function seed() {
 await real([["HSET",leadsKey(list),email,JSON.stringify({t:token})],["SET",marker,token],["SADD",used,campaign]]);
}
async function intercept<T>(operation: string, answer: unknown[], run:()=>Promise<T>, writes: Command[] = []) {
 redis.pipeline = async commands => {
  writes.push(...commands.filter(c=>c[0]==="DEL"));
  return commands.some(c=>c[0]===operation)?answer:real(commands);
 };
 try { return await run(); } finally { redis.pipeline = real; }
}
test("C4 P8: unknown link use already rejects on the existing head", async()=>{
 await assert.rejects(intercept("SISMEMBER",[undefined],()=>usedLinkIn(list,campaign,[email])));
 assert.deepEqual([...await intercept("SISMEMBER",[1],()=>usedLinkIn(list,campaign,[email]))],[email]);
});
test("copy returns canonical ids and a confirmed empty set", async()=>{
 await seed(); assert.deepEqual(await clicksOf(list,email),[campaign]);
 assert.deepEqual(await intercept("SMEMBERS",[[]],()=>clicksOf(list,email)),[]);
});
for (const [label,answer] of [
 ["missing envelope",[]],["extra envelope",[[],[]]],["undefined",[undefined]],
 ["null",[null]],["scalar",["not-a-set"]],["non-string",[[7]]],
 ["sparse",[Array(1)]],["invalid id",[["not-a-campaign"]]],["duplicate",[[campaign,campaign]]],
] as [string,unknown[]][]) test(`copy rejects ${label} rather than empty or fabricated ids`,async()=>{
 await assert.rejects(intercept("SMEMBERS",answer,()=>clicksOf(list,email)));
});
for (const [label,answer] of [
 ["missing",[]],["extra",[null,null]],["undefined",[undefined]],["object",[{}]],
 ["broken JSON",["{"]],["null JSON",["null"]],["array JSON",["[]"]],
] as [string,unknown[]][]) test(`erasure preserves its work when contact read is ${label}`,async()=>{
 await seed(); const writes:Command[]=[];
 await assert.rejects(intercept("HGET",answer,()=>forgetClicksPerson(list,email),writes));
 assert.equal(writes.length,0,"no deletion before exact contact/token evidence");
 assert.equal((await real([["GET",marker]]))[0],token);
});
for (const [label,row] of [
 ["missing token", {agreed:false}], ["bad token type", {t:7}], ["bad token value", {t:"broken"}],
] as [string,Record<string,unknown>][]) test(`legacy ${label} has no possible marker and erases only its used links`,async()=>{
 await real([["HSET",leadsKey(list),email,JSON.stringify(row)],["SADD",used,campaign],["SET",marker,token]]);
 const writes:Command[]=[];
 redis.pipeline=async commands=>{writes.push(...commands.filter(c=>c[0]==="DEL"));return real(commands);};
 try{
  assert.equal(await forgetClicksPerson(list,email),1);
  assert.deepEqual(writes,[["DEL",used]],"only the known person click set is deleted");
  assert.deepEqual(await real([["EXISTS",used],["GET",marker]]),[0,token],"an unrelated marker is never guessed or deleted");
 }finally{redis.pipeline=real;}
});
test("healthy erasure deletes both token and used links once; repeat is exact zero",async()=>{
 await seed(); assert.equal(await forgetClicksPerson(list,email),2);
 assert.deepEqual(await real([["GET",marker],["EXISTS",used]]),[null,0]);
 assert.equal(await forgetClicksPerson(list,email),0);
});
test("confirmed absent contact still deletes its known click set",async()=>{
 await real([["SADD",used,campaign]]); assert.equal(await forgetClicksPerson(list,email),1);
});
for(const [label,answer] of [["missing",[]],["unknown",[undefined]],["string",["2"]],["too large",[3]],["extra",[1,0]]] as [string,unknown[]][])
 test(`erasure rejects ${label} deletion receipt`,async()=>{
  await seed(); await assert.rejects(intercept("DEL",answer,()=>forgetClicksPerson(list,email)));
 });
