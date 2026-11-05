/** Additional financial-boundary controls for Claude 4's three findings.
 * Real orchestration/SES transport, synthetic stores and provider replies.
 * MemoryRedis is an ACK adapter; separate native proofs run the actual Lua.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUMP_KEYS } from "@/lib/bundle-rules";
import { ADMITTED_FIELD } from "@/lib/order-admission";
import { storeOrdersThisMonth } from "@/lib/orders";
import { confirmPurchase, type SessionRecord } from "@/lib/purchase-email";
import { sesBatch, sesConfig, sesReady, notYetTaken } from "@/lib/ses";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductBundle, setProductLink,
  setStripeAccount, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { orderDataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";

process.env.NIMBUS_DATA_KEY = "SYNTHETIC_ONLY_CONFIRMATION_ORIGIN_KEY_2026";
process.env.RESEND_API_KEY = "re_SYNTHETIC_A3_C4_CONTROLS";
globalThis.fetch = async () => { throw Error("No external service is allowed in this proof"); };

async function shop() {
  redis.clear();
  const owner = "a3-c4-control@example.test";
  await claimHandle(owner, "a3-c4-control", "Original store", "");
  await ensureStatsId(owner); await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_TestA3C401", true);
  const now = Math.floor(Date.now() / 1000);
  await setSubscription(owner, { customerId: "cus_A3C4", subscriptionId: "sub_A3C4", active: true, tier: "creator",
    period: { start: now - 86400, end: now + 20 * 86400, renews: true } });
  let store = (await storeForEmail(owner))!;
  const refresh = async () => { store = (await storeForEmail(owner))!; };
  const product = async (title: string, linked = true) => {
    const result = await addProduct(owner, title, "Synthetic original product", "25", null);
    assert.ok(result.ok);
    if (linked) assert.ok((await setProductLink(owner, result.product.id, `https://example.test/${result.product.id}`)).ok);
    await refresh();
    return result.product;
  };
  const holdWithSibling = async (items: number) => {
    const folder = await storeFolder(storeRef(store)), hour = Math.floor(Date.now() / 3600000);
    const open = `nl:orders:open:${folder}`, bytes = `${open}:b`;
    redis.run(["HSET", open, String(hour), 2]);
    redis.run(["HSET", bytes, String(hour), orderDataBytes(items) + orderDataBytes(1)]);
    return { hour, open, bytes, remaining: () => [redis.run(["HGET", open, String(hour)]), redis.run(["HGET", bytes, String(hour)])] };
  };
  const session = (id: string, metadata: Record<string, string>): SessionRecord => ({
    id, status: "complete", payment_status: "paid", mode: "payment", created: Math.floor(Date.now() / 1000),
    amount_total: 2500, currency: "usd", metadata: { store: store.handle, ...metadata },
    customer_details: { email: "paid-buyer@example.test" },
  });
  return { owner, get store() { return store; }, refresh, product, holdWithSibling, session };
}


// Independent G controls: concurrent outcomes in a single wave and maximal captured roots.
test("G: four roots sharing twenty captured members settle eighty slots without counting affiliate extras", async () => {
 const f=await shop(); const members=[];
 for(let i=0;i<20;i++) members.push(await f.product(`Member ${i}`));
 const roots=[];
 for(let i=0;i<4;i++) { const p=await f.product(`Root ${i}`,false); roots.push(p); assert.ok((await setProductBundle(f.owner,p.id,members.map(x=>x.id))).ok); }
 await f.refresh(); const hold=await f.holdWithSibling(80);
 const meta:Record<string,string>={product:roots[0].id,cart:"yes",bundle:members.slice(0,10).map(x=>x.id).join(","),bundle_2:members.slice(10).map(x=>x.id).join(","),aff_extra:members.slice(0,3).map(x=>x.id).join(","),[ADMITTED_FIELD]:String(hold.hour)};
 for(let i=0;i<3;i++) { const key=BUMP_KEYS[i]; meta[key]=roots[i+1].id; meta[`${key}_bundle`]=meta.bundle; meta[`${key}_bundle_2`]=meta.bundle_2; }
 const session=f.session("cs_test_GFourCapturedRoots0001",meta); const mail=installSesMailFixture();
 try {mail.configure();await mail.setReady(true); await confirmPurchase(f.store,session.id as string,session); assert.equal(await storeOrdersThisMonth(f.store),1); assert.deepEqual(hold.remaining(),["1",String(orderDataBytes(1))]); await confirmPurchase(f.store,session.id as string,session); assert.equal(await storeOrdersThisMonth(f.store),1);assert.deepEqual(hold.remaining(),["1",String(orderDataBytes(1))]);} finally{mail.restore();}
});
const waveMessages=["first","second","tail"].map(x=>({from:"Store <mail@example.test>",to:`${x}@example.test`,subject:"Original",text:"Original"}));
for(const outcome of ["ok","lost","refused"] as const) test(`G: same-wave ${outcome} plus denial preserves exact unresolved tail`,async()=>{
 redis.clear();const mail=installSesMailFixture();
 try {mail.configure();await mail.setReady(true,{rate:2});mail.setSesOutcome(outcome); const config=sesConfig(),state=await sesReady();assert.ok(config&&state); let guards=0;
 const result=await sesBatch(config,state,waveMessages,`g-mixed-${outcome}`,async()=>++guards===1);
 assert.equal(mail.calls.ses,1);assert.equal(mail.calls.resend,0);assert.equal(guards,2);assert.equal(result.notPosted,true);
 assert.deepEqual(result.taken,outcome==="ok"?[waveMessages[0]]:[]);
 assert.deepEqual(result.left,outcome==="lost"?waveMessages:waveMessages.slice(1));
 assert.equal(result.uncertain,outcome==="lost"?true:undefined);
 assert.deepEqual(await notYetTaken(`g-mixed-${outcome}`,waveMessages),outcome==="ok"?waveMessages.slice(1):waveMessages);
 } finally{mail.restore();}
});
