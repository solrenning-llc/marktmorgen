import assert from "node:assert/strict";
import test from "node:test";
import {ordersGrant} from "@/lib/buyer-orders";
import type {Store} from "@/lib/store";
import {store as redis} from "../../tests/redis-stub";

// Only the GET boundary is substituted. No session, account, payment,
// provider call, write or complete orders journey is exercised.
const store = {stripeAccountId:"acct_TestGrantEvidence"} as Store;
const token = "b".repeat(64);
const email = "buyer@example.com";
const raw = JSON.stringify({a:store.stripeAccountId,e:email});
const original = redis.pipeline.bind(redis);
let reply: unknown;
let reads = 0;
redis.pipeline = (async (commands:(string|number)[][])=>{
  assert.equal(commands.length,1);
  assert.equal(commands[0][0],"GET");
  reads++;
  return reply;
}) as typeof redis.pipeline;
globalThis.fetch = (async()=>{throw new Error("No network allowed in this proof");}) as typeof fetch;

const inherited = new Array(1);
Object.setPrototypeOf(inherited,Object.create(Array.prototype,{0:{value:raw}}));
const malformed:[string,unknown][] = [
  ["extra command result",[raw,"unexpected"]],
  ["inherited result slot",inherited],
  ["unexpected record field",[JSON.stringify({a:store.stripeAccountId,e:email,unexpected:true})]],
  ["conflicting duplicate account",[`{"a":"another-account","a":"${store.stripeAccountId}","e":"${email}"}`]],
  ["conflicting duplicate address",[`{"a":"${store.stripeAccountId}","e":"other@example.com","e":"${email}"}`]],
  ["invalid nonempty address",[JSON.stringify({a:store.stripeAccountId,e:"not-an-email"})]],
];
for(const [name,value] of malformed){
  test(`ordersGrant: ${name} never authorizes an address`,async()=>{
    reply=value;
    let got:string|null;
    try {got=await ordersGrant(store,token);} catch {return;}
    assert.equal(got,null);
  });
}
test("ordersGrant: exact valid record retains its address",async()=>{
  reply=[raw];assert.equal(await ordersGrant(store,token),email);
});
test("ordersGrant: exact missing record is expired",async()=>{
  reply=[null];assert.equal(await ordersGrant(store,token),null);
});
test("ordersGrant: another account is never accepted",async()=>{
  reply=[JSON.stringify({a:"another-account",e:email})];assert.equal(await ordersGrant(store,token),null);
});
test("ordersGrant: invalid token performs no read",async()=>{
  const before=reads;reply=[raw];assert.equal(await ordersGrant(store,"invalid"),null);assert.equal(reads,before);
});
test.after(()=>{redis.pipeline=original;});
