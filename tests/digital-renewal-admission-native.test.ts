import { test } from "node:test";
import assert from "node:assert/strict";
import { renewalFixture } from "./single-digital-access-renewal-world";
import { confirmationLocalPipeline } from "./order-confirmation-paid-fixture";
import { enqueueSingleDigitalRenewal, readSingleDigitalRenewalOrigin, readConfirmationOrigin, confirmationOriginId, forgetOrderConfirmationMail } from "@/lib/order-confirmation-outbox";
import { createCheckout } from "@/lib/store-checkout";
import { seal } from "@/lib/secret-box";
import type { ConfirmationOriginRuntime } from "@/lib/order-confirmation-outbox";
const native = process.env.MARKTMORGEN_REDIS_INTEGRATION === "1" && Boolean(process.env.CONFIRMATION_ORIGIN_REDIS_PORT);

async function world() {
  const f = await renewalFixture(), made = new Set<string>();
  const runtime: ConfirmationOriginRuntime = { ...f.runtime, policy: { ...f.runtime.policy!, storeItems: 2, globalItems: 3 }, pipeline: async commands => {
    for (const c of commands) if (c[0] === "EVAL") c.slice(3, 3 + Number(c[2])).forEach(k => made.add(String(k)));
    return confirmationLocalPipeline(commands);
  } };
  const [priorPool] = await confirmationLocalPipeline([["TYPE", "nl:ship:mail:pool"]]);
  assert.ok(priorPool === "none" || priorPool === "hash");
  if(priorPool === "hash") assert.deepEqual(await confirmationLocalPipeline([["HGET","nl:ship:mail:pool","items"],["HGET","nl:ship:mail:pool","bytes"]]),["0","0"]);
  assert.deepEqual(await confirmationLocalPipeline([["TYPE",`nl:ship:mail:pool:${f.store.statsId}`]]),["none"]);
  const sessions = new Map<string, Record<string, unknown>>(); let posts = 0;
  runtime.provider = async (method, account, path, body) => {
    assert.equal(account, f.store.stripeAccountId);
    if (method === "POST") {
      const nonce = body!.get("metadata[mm_order_intent]")!;
      const found = await readConfirmationOrigin(confirmationOriginId(f.store.statsId!, nonce), runtime);
      assert.ok(found); assert.equal(found.row.phase, "creating");
      posts++;
      const id = `cs_test_PhysicalAfterRenewal${posts}000001`;
      const session = { object: "checkout.session", id, mode: "payment", status: "open", currency: "usd", created: Math.floor(Date.now()/1000), url: `https://checkout.stripe.com/c/pay/${id}`,
        metadata: Object.fromEntries([...body!].filter(([k]) => k.startsWith("metadata[")).map(([k,v]) => [k.slice(9,-1),v])),
        line_items: { object: "list", has_more: false, data: [{ quantity: 1, price: { unit_amount: 3500, currency: "usd" } }] } };
      sessions.set(id, session); return session;
    }
    return sessions.get(path.split("?")[0].split("/").at(-1)!) ?? {};
  };
  const physical = { ...f.product, file: null, shipping: { cents: 500, region: "us" as const, countries: ["US"], note: "Original shipping" } };
  return { f, runtime, physical, posts: () => posts, cleanup: async () => {
    await forgetOrderConfirmationMail(f.store.statsId,undefined,runtime);
    if(priorPool === "hash") made.delete("nl:ship:mail:pool");
    return confirmationLocalPipeline([["DEL", ...made]]);
  } };
}

test("actual Lua deduplicates concurrent nonce churn, caps the store and leaves a physical checkout slot", { skip: !native }, async () => {
  const w = await world(), { f, runtime } = w;
  try {
    const capsule = f.url.searchParams.get("origin")!;
    const answers = await Promise.all(Array.from({length:5}, (_,i) => enqueueSingleDigitalRenewal(f.store, capsule, String(i+1).padStart(64,"0"), runtime)));
    assert.ok(answers.every(r => r.ok));
    const ids = new Set(answers.map(r => r.ok ? r.id : "")); assert.equal(ids.size,1);
    const id = [...ids][0], saved = await readSingleDigitalRenewalOrigin(id,runtime); assert.ok(saved);
    assert.deepEqual(await confirmationLocalPipeline([["SCARD",`nl:order-confirmation:store:${f.store.statsId}`],["HGET",`nl:ship:mail:pool:${f.store.statsId}`,"items"],["HGET",`nl:ship:mail:pool:${f.store.statsId}`,"bytes"]]),[1,"1",String(saved.row.bytes)]);
    const anotherValidCapsule = seal(JSON.stringify(f.capsule),"single-digital-access|v1");
    assert.notEqual(anotherValidCapsule,capsule);
    assert.equal((await enqueueSingleDigitalRenewal(f.store,anotherValidCapsule,"f".repeat(64),runtime)).ok,false,"a different authenticated capsule cannot take another pending slot");
    assert.equal((await confirmationLocalPipeline([["TTL",`nl:order-confirmation:row:${id}`]]))[0],-1);
    const checkout = await createCheckout(f.store,w.physical,"https://example.test",undefined,{},runtime);
    assert.ok(checkout.url.startsWith("https://checkout.stripe.com/")); assert.equal(w.posts(),1);
    assert.deepEqual(await confirmationLocalPipeline([["HGET",`nl:ship:mail:pool:${f.store.statsId}`,"items"],["SCARD",`nl:order-confirmation:store:${f.store.statsId}`]]),["2",2]);
  } finally { await w.cleanup(); }
});

test("renewals cannot consume the only item or the bytes needed by the next physical sale", {skip:!native}, async()=>{
  for(const cap of [{storeItems:1,storeBytes:10_000_000},{storeItems:2,storeBytes:200_000}]) {
    const w=await world(),{f,runtime}=w;
    try{
      runtime.policy={...runtime.policy!,...cap};
      assert.equal((await enqueueSingleDigitalRenewal(f.store,f.url.searchParams.get("origin")!,"a".repeat(64),runtime)).ok,false);
      assert.deepEqual(await confirmationLocalPipeline([["TYPE",`nl:ship:mail:pool:${f.store.statsId}`],["SCARD",`nl:order-confirmation:store:${f.store.statsId}`]]),["none",0]);
      const checkout=await createCheckout(f.store,w.physical,"https://example.test",undefined,{},runtime);assert.ok(checkout.url);assert.equal(w.posts(),1);
    }finally{await w.cleanup();}
  }
});
