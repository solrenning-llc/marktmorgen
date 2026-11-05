import test from "node:test";
import assert from "node:assert/strict";
import { joinWords } from "@/lib/buyer-words/join";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { askToJoin } from "@/lib/store-join";
import { claimHandle, ensureListId, ensureStatsId, setJoin, setLanguage, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

let outcome: "accepted"|"refused"|"lost"="accepted";
const requests: { method: string; url: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  requests.push({ method: init?.method ?? "GET", url });
  if (new URL(url).hostname !== "api.resend.com") throw new Error(`Unexpected provider: ${url}`);
  if(outcome==="lost")throw new Error("synthetic lost reply");
  if(outcome==="refused")return new Response(JSON.stringify({message:"synthetic refusal"}),{status:400});
  return new Response(JSON.stringify({ id: "email_join_delivery_copy" }));
}) as typeof fetch;


for(const mode of ["accepted","refused","lost"] as const)test(`G: real join ${mode} never confuses refusal or loss with confirmation`,async()=>{
 for(const [i,language] of LANGUAGE_CODES.entries()) {
 redis.clear();requests.length=0;outcome=mode;process.env.RESEND_API_KEY="re_test_join_only";
 const owner="g-join@example.test";await claimHandle(owner,"g-join","Original <store> & name","");await ensureStatsId(owner);await ensureListId(owner);
 await setSubscription(owner,{customerId:"cus_GJoin",subscriptionId:"sub_GJoin",active:true,tier:"creator",trialEnds:0,period:paidPeriod()});await setJoin(owner,{on:true});await setLanguage(owner,language);
 const store=(await storeForEmail(owner))!;
 const result=await askToJoin({store,email:`reader-${i}@example.test`,ip:`192.0.2.${i+1}`,origin:"https://example.test"});
 assert.equal(result,mode==="accepted"?"sent":"error");assert.equal(requests.length,1);assert.equal(requests[0].method,"POST");
 const words=joinWords(language);assert.ok(words.sentBody(store.name).includes(store.name));assert.ok(/spam/i.test(words.sentBody(store.name)));
 }
});
