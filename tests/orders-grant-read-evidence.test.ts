import assert from "node:assert/strict";
import test from "node:test";
import {ordersGrant} from "@/lib/buyer-orders";
import type {Store} from "@/lib/store";
import {store as redis} from "./redis-stub";

// Codex K2 (CX-123 rule 24), proof proofs/k2/orders-grant-read-evidence.proof.ts
// at 59cabc181a30a596b8bcd898f7d196682cf0eb5c: a purchases-link grant counts
// only in the exact shape it was written in. Only the GET boundary is
// substituted; no session, account, payment, provider call or write is used.
const store = {stripeAccountId:"acct_K2Proof"} as Store;
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
globalThis.fetch = (async()=>{throw new Error("No network allowed in this test");}) as typeof fetch;

const inherited = new Array(1);
Object.setPrototypeOf(inherited,Object.create(Array.prototype,{0:{value:raw}}));
const malformed:[string,unknown][] = [
  ["extra command result",[raw,"unexpected"]],
  ["inherited result slot",inherited],
  ["unexpected record field",[JSON.stringify({a:store.stripeAccountId,e:email,unexpected:true})]],
  ["conflicting duplicate account",[`{"a":"another-account","a":"${store.stripeAccountId}","e":"${email}"}`]],
  ["conflicting duplicate address",[`{"a":"${store.stripeAccountId}","e":"other@example.com","e":"${email}"}`]],
  ["invalid nonempty address",[JSON.stringify({a:store.stripeAccountId,e:"not-an-email"})]],
  // Beyond the proof: other shapes that are not the written record.
  ["reply that is not a list",raw],
  ["empty reply list",[]],
  ["identical duplicate member",[`{"a":"${store.stripeAccountId}","e":"${email}","e":"${email}"}`]],
  ["record in another spelling",[`{"e":"${email}","a":"${store.stripeAccountId}"}`]],
  ["record with spaces",[`{"a": "${store.stripeAccountId}", "e": "${email}"}`]],
  ["record that is a list",[JSON.stringify([store.stripeAccountId,email])]],
  ["address that is not a string",[JSON.stringify({a:store.stripeAccountId,e:1})]],
  ["empty address",[JSON.stringify({a:store.stripeAccountId,e:""})]],
  ["address with a space",[JSON.stringify({a:store.stripeAccountId,e:"bu yer@example.com"})]],
  ["address over the length limit",[JSON.stringify({a:store.stripeAccountId,e:`${"x".repeat(250)}@example.com`})]],
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
test("ordersGrant: an address kept as typed at the request still grants",async()=>{
  const typed="Buyer.Name+tag@Example.COM";
  reply=[JSON.stringify({a:store.stripeAccountId,e:typed})];assert.equal(await ordersGrant(store,token),typed);
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
