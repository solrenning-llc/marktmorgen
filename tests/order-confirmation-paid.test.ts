import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DEMO_CONNECTED_ACCOUNT } from "@/lib/demo-account";
import { admitOrders } from "@/lib/order-admission";
import { COMMIT_ORDER_CONFIRMATION, prepareOrderConfirmationPreintent } from "@/lib/orders";
import { createCheckout } from "@/lib/store-checkout";
import { confirmationFor, confirmPurchase, originalPhysicalConfirmation } from "@/lib/purchase-email";
import { confirmationOriginRowKey, forgetOrderConfirmationMail, readConfirmationOrigin, reserveConfirmationOrigin, runOrderConfirmationMail } from "@/lib/order-confirmation-outbox";
import { enqueueShipmentMail, runShipmentMail } from "@/lib/shipment-mail-outbox";
import { store as redis } from "./redis-stub";
import { physicalPaidFixture, originId, confirmationLocalPipeline } from "./order-confirmation-paid-fixture";

const person = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
async function paid() {
  const f = await physicalPaidFixture();
  const checkout = await createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime);
  const session = f.sessions.get(checkout.id)!;
  Object.assign(session, { status: "complete", payment_status: "paid", amount_total: 4000, customer_details: { email: "buyer@example.test" },
    payment_intent: { object: "payment_intent", status: "succeeded", amount_received: 4000, currency: "usd",
      latest_charge: { object: "charge", paid: true, amount: 4000, amount_refunded: 0, currency: "usd", refunded: false } },
    shipping_details: { name: "Original Buyer", address: { line1: "1 Original Street", city: "Test City", country: "US" } } });
  f.advance(61_000); // The bound source deliberately schedules its first payment check.
  return { ...f, id: originId(), session, checkout };
}

test("a paid original physical source survives 73h and uses only its original contents", async () => {
  const f = await paid(); f.advance(73 * 3_600_000);
  assert.equal(confirmationFor(f.store, f.session, f.runtime.now!() / 1000, [], [f.product]), null);
  const original = originalPhysicalConfirmation(f.store, f.session, f.product); assert.ok(original);
  assert.equal(original.text.includes("/thanks?"), false); assert.equal(original.text.includes("three days"), false);
  f.store.name = "Changed store"; f.product.title = "Changed product";
  let posts = 0;
  const result = await runOrderConfirmationMail(f.runtime.now!() + 30_000, async (message, beforePost) => {
    assert.ok(message.text.includes("Original printed book")); assert.ok(message.text.includes("Original printed store"));
    assert.ok(message.text.includes("1 Original Street")); assert.equal(message.text.includes("Changed product"), false);
    const found = await readConfirmationOrigin(f.id, f.runtime); assert.ok(found);
    assert.equal(found.raw.includes(message.to), false); assert.equal(found.payload.message?.text, message.text);
    assert.deepEqual(redis.run(["SMEMBERS", `nl:order-confirmation:person:${f.store.statsId}:${person(message.to)}`]), [f.id]);
    assert.equal(await beforePost(), true); assert.equal(await beforePost(), false); posts++; return "accepted";
  }, f.runtime);
  assert.deepEqual(result, { accepted: 1, waiting: 0, unknown: 0 }); assert.equal(posts, 1);
  assert.equal(await readConfirmationOrigin(f.id, f.runtime), null);
  assert.ok(Number(redis.run(["TTL", `nl:order-confirmation:source:${f.id}`])) > 399 * 86_400);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1, "only the original checkout creation POST");
  assert.ok(f.calls.filter(c => c.method === "GET").every(c => c.account === "acct_TestOrigin01"));
});

test("unknown accounting does not cost the paid buyer their email or destroy the original token", async () => {
  const f = await paid(); f.setAccounting("unknown"); let posts = 0;
  const send = async (_message: unknown, barrier: () => Promise<boolean>) => { assert.equal(await barrier(), true); posts++; return "accepted" as const; };
  await runOrderConfirmationMail(f.runtime.now!() + 30_000, send, f.runtime, f.id);
  const held = await readConfirmationOrigin(f.id, f.runtime); assert.ok(held);
  assert.equal(held.row.phase, "accepted"); assert.ok(held.payload.settlementToken); assert.ok(held.payload.message);
  assert.equal(redis.run(["TTL", confirmationOriginRowKey(f.id)]), -1);
  f.advance(73 * 3_600_000);
  await runOrderConfirmationMail(f.runtime.now!() + 30_000, send, f.runtime, f.id);
  assert.equal(posts, 1); assert.ok(await readConfirmationOrigin(f.id, f.runtime));
  f.setAccounting("committed"); f.advance(74 * 3_600_000);
  await runOrderConfirmationMail(f.runtime.now!() + 30_000, send, f.runtime, f.id);
  assert.equal(posts, 1); assert.equal(await readConfirmationOrigin(f.id, f.runtime), null);
});

test("a provider's unknown outcome and a lost dispatch ACK never permit another POST", async () => {
  for (const lostAck of [false, true]) {
    const f = await paid(); if (lostAck) f.loseShared("dispatch"); let posts = 0;
    const send = async (_message: unknown, barrier: () => Promise<boolean>) => { if (await barrier()) posts++; return "unknown" as const; };
    await runOrderConfirmationMail(f.runtime.now!() + 30_000, send, f.runtime, f.id);
    f.advance(73 * 3_600_000);
    await runOrderConfirmationMail(f.runtime.now!() + 30_000, send, f.runtime, f.id);
    assert.equal(posts, lostAck ? 0 : 1);
    const held = await readConfirmationOrigin(f.id, f.runtime); assert.ok(held);
    assert.equal(held.row.state, "dispatching"); assert.ok(held.payload.settlementToken);
  }
});

test("known nonacceptance retries the same protected message only after its next check", async () => {
  const f = await paid(); const messages: string[] = [];
  const send = async (message: { text: string }, barrier: () => Promise<boolean>) => { assert.equal(await barrier(), true); messages.push(message.text); return messages.length === 1 ? "not_accepted" as const : "accepted" as const; };
  await runOrderConfirmationMail(f.runtime.now!() + 30_000, send, f.runtime, f.id);
  await runOrderConfirmationMail(f.runtime.now!() + 30_000, send, f.runtime, f.id); assert.equal(messages.length, 1);
  f.advance(73 * 3_600_000); f.product.title = "Changed product";
  await runOrderConfirmationMail(f.runtime.now!() + 30_000, send, f.runtime, f.id);
  assert.equal(messages.length, 2); assert.equal(messages[0], messages[1]);
});

test("lost paid-binding ACK cannot send, and a restart recovers only the saved payload", async () => {
  const f = await paid(); f.loseNext("paid"); let posts = 0;
  const send = async (_message: unknown, barrier: () => Promise<boolean>) => { assert.equal(await barrier(), true); posts++; return "accepted" as const; };
  await runOrderConfirmationMail(f.runtime.now!() + 30_000, send, f.runtime, f.id); assert.equal(posts, 0);
  const held = await readConfirmationOrigin(f.id, f.runtime); assert.ok(held?.payload.message);
  f.advance(73 * 3_600_000); f.product.title = "Changed product";
  await runOrderConfirmationMail(f.runtime.now!() + 30_000, send, f.runtime, f.id); assert.equal(posts, 1);
});

test("person erasure wins before dispatch, including a recipient learned during provider read", async () => {
  for (const duringRead of [false, true]) {
    const f = await paid(); let posts = 0, erased = false;
    const provider = f.runtime.provider!;
    if (duringRead) f.runtime.provider = async (...args) => {
      const value = await provider(...args);
      if (args[0] === "GET" && !erased) { erased = true; assert.equal(await forgetOrderConfirmationMail(f.store.statsId, "buyer@example.test", f.runtime), 0); }
      return value;
    };
    await runOrderConfirmationMail(f.runtime.now!() + 30_000, async (_message, barrier) => {
      assert.equal(duringRead, false, "erased recipient cannot reach dispatcher");
      assert.equal(await forgetOrderConfirmationMail(f.store.statsId, "buyer@example.test", f.runtime), 1);
      if (await barrier()) posts++; return "unknown";
    }, f.runtime, f.id);
    assert.equal(posts, 0);
    const found = await readConfirmationOrigin(f.id, f.runtime);
    if (duringRead) { assert.ok(found); assert.equal(found.payload.message, undefined); }
    else assert.equal(found, null);
  }
});

test("paid source refuses substituted or unpaid provider records without a POST", async () => {
  for (const change of [
    { id: "cs_test_SubstitutedSession01" }, { status: "open" }, { payment_status: "unpaid" },
    { payment_status: "no_payment_required", amount_total: 4000 }, { amount_total: -1 }, { amount_total: undefined },
    { currency: "eur" }, { metadata: { mm_order_origin: "physical-v1" } },
    { line_items: { has_more: true, data: [] } }, { created: 0 },
  ]) {
    const f = await paid(); Object.assign(f.session, change); let posts = 0;
    await runOrderConfirmationMail(f.runtime.now!() + 30_000, async () => { posts++; return "accepted"; }, f.runtime, f.id);
    assert.equal(posts, 0); assert.ok(await readConfirmationOrigin(f.id, f.runtime));
  }
});

test("never activated means no worker or cleanup IO; retired cleanup still erases the source", async () => {
  const f = await paid(); let io = 0;
  const inactive = { ...f.runtime, lifecycle: "never_activated" as const, pipeline: async () => { io++; return []; } };
  await runOrderConfirmationMail(f.runtime.now!() + 30_000, async () => "accepted", inactive);
  assert.equal(await forgetOrderConfirmationMail(f.store.statsId, undefined, inactive), 0); assert.equal(io, 0);
  assert.equal(await forgetOrderConfirmationMail(f.store.statsId, undefined, { ...f.runtime, lifecycle: "retired", policy: null }), 1);
  assert.equal(await readConfirmationOrigin(f.id, f.runtime), null);
});

test("the thanks-page path cannot duplicate the origin's sender or accounting", async () => {
  const f = await paid();
  assert.equal(await confirmPurchase(f.store, f.checkout.id, f.session), "skip");
  assert.ok(await readConfirmationOrigin(f.id, f.runtime));
});


test("provider metadata cannot add consent, marketing or another purchase kind to the original source", async () => {
  for (const extra of [{ dc: "yes:2026-10-30.2:d:1793480000" }, { news: "yes" }, { kind: "plan" }, { gift: "changed" }]) {
    const f = await paid(); Object.assign(f.session.metadata as object, extra); let posts = 0;
    await runOrderConfirmationMail(f.runtime.now!() + 30_000, async () => { posts++; return "accepted"; }, f.runtime, f.id);
    assert.equal(posts, 0);
    const found = await readConfirmationOrigin(f.id, f.runtime); assert.ok(found); assert.equal(found.payload.message, undefined);
  }
});

test("refund and unknown payment evidence stop a queued retry before a new provider POST", async () => {
  for (const change of [
    { refunded: true, amount_refunded: 4000 }, { refunded: false, amount_refunded: 4000 },
    { refunded: undefined }, { amount_refunded: undefined }, { paid: false },
  ]) {
    const f = await paid(); let posts = 0;
    const send = async (_message: unknown, barrier: () => Promise<boolean>) => { if (await barrier()) posts++; return "not_accepted" as const; };
    await runOrderConfirmationMail(f.runtime.now!() + 30_000, send, f.runtime, f.id); assert.equal(posts, 1);
    Object.assign((f.session.payment_intent as { latest_charge: object }).latest_charge, change);
    f.advance(73 * 3_600_000);
    await runOrderConfirmationMail(f.runtime.now!() + 30_000, send, f.runtime, f.id); assert.equal(posts, 1);
    assert.ok(await readConfirmationOrigin(f.id, f.runtime));
  }
});

test("a partial refund preserves the physical purchase and a legitimate zero charge remains eligible", async () => {
  for (const zero of [false, true]) {
    const f = await paid();
    if (zero) Object.assign(f.session, { payment_status: "no_payment_required", amount_total: 0, payment_intent: null });
    else (f.session.payment_intent as { latest_charge: { amount_refunded: number } }).latest_charge.amount_refunded = 1000;
    let posts = 0;
    await runOrderConfirmationMail(f.runtime.now!() + 30_000, async (_message, barrier) => { assert.equal(await barrier(), true); posts++; return "accepted"; }, f.runtime, f.id);
    assert.equal(posts, 1);
  }
});

test("a cutoff reached during the original-account read prevents the POST", async () => {
  const f = await paid(), provider = f.runtime.provider!; let reads = 0, posts = 0;
  const deadline = f.runtime.now!() + 100;
  f.runtime.provider = async (...args) => {
    const value = await provider(...args);
    if (args[0] === "GET" && ++reads === 2) f.advance(73 * 3_600_000);
    return value;
  };
  await runOrderConfirmationMail(deadline, async (_message, barrier) => { if (await barrier()) posts++; return "unknown"; }, f.runtime, f.id);
  assert.equal(reads, 2); assert.equal(posts, 0); assert.ok(await readConfirmationOrigin(f.id, f.runtime));
});


test("a shipping acknowledgement waiting in the shared slice does not starve a paid confirmation", async () => {
  const f = await paid();
  assert.equal((await enqueueShipmentMail({ statsId: f.store.statsId!, session: "cs_test_parallelShipment0001", authorizedAt: f.runtime.now!(),
    shipped: { at: Math.floor(f.runtime.now!() / 1000), tracking: "https://example.test/shipped" },
    message: { from: "Store <mail@example.test>", to: "another@example.test", subject: "On its way", text: "Original shipping notice", replyTo: "owner@example.test" },
  }, f.runtime)).ok, true);
  const deadline = f.runtime.now!() + 5_000; let confirmationPosts = 0, shippingPosts = 0;
  let finishShipping!: () => void; const acknowledgement = new Promise<void>(resolve => { finishShipping = resolve; });
  const results = await Promise.allSettled([
    runShipmentMail(deadline, async (_message, barrier) => {
      assert.equal(await barrier(), true); shippingPosts++; await acknowledgement;
      f.advance(67_000); return "accepted";
    }, f.runtime),
    runOrderConfirmationMail(deadline, async (_message, barrier) => {
      try { assert.equal(await barrier(), true); confirmationPosts++; return "accepted"; }
      finally { finishShipping(); }
    }, f.runtime),
  ]);
  assert.ok(results.every(result => result.status === "fulfilled"));
  assert.equal(shippingPosts, 1); assert.equal(confirmationPosts, 1);
});


test("accepted mail whose final accounting check is unknown parks without a hot polling member", async () => {
  const f = await paid(); f.setAccounting("unknown"); f.runtime.policy = { ...f.runtime.policy!, maximumChecks: 1 };
  let posts = 0;
  await runOrderConfirmationMail(f.runtime.now!()+30_000, async (_message,barrier) => { assert.equal(await barrier(),true); posts++; return "accepted"; }, f.runtime,f.id);
  assert.equal(posts,1); assert.equal(redis.run(["ZSCORE","nl:order-confirmation:due",f.id]),null);
  assert.equal((await readConfirmationOrigin(f.id,f.runtime))?.row.phase,"accepted");
  f.advance(73*3_600_000); await runOrderConfirmationMail(f.runtime.now!()+30_000, async()=>{posts++;return "accepted";},f.runtime,f.id);
  assert.equal(posts,1); assert.ok(await readConfirmationOrigin(f.id,f.runtime));
});

if (process.env.MARKTMORGEN_REDIS_INTEGRATION === "1") test("production paid worker and exact Lua settle an original73h source once on disposable Redis", async () => {
  const currentTime = Date.now, originalTime = currentTime() - 73 * 3_600_000;
  let f: Awaited<ReturnType<typeof paid>>;
  try { Date.now = () => originalTime; f = await paid(); } finally { Date.now = currentTime; }
  f.advance(0);
  const source = await readConfirmationOrigin(f.id, f.runtime); assert.ok(source);
  assert.ok(currentTime() - source.row.created >= 73 * 3_600_000);
  const row = source.row;
  const keys = [confirmationOriginRowKey(f.id), `nl:order-confirmation:source:${f.id}`, "nl:order-confirmation:due",
    `nl:order-confirmation:store:${row.statsId}`, `nl:order-confirmation:person:${row.statsId}:${row.person}`,
    "nl:ship:mail:pool", `nl:ship:mail:pool:${row.statsId}`, "nl:ship:mail:all", `nl:order-confirmation:closed:${row.statsId}`,
    `nl:order-confirmation:erased:${row.statsId}:${row.person}`, `nl:order-confirmation:person:${row.statsId}:${person("buyer@example.test")}`];
  const made = new Set(keys); let settlement: (string | number)[] | undefined; let posts = 0;
  // This consumer proof starts with the authentic source generated by the
  // real checkout in its synthetic ACK fixture. The separate origin Lua
  // proof covers durable creation/binding; no real Stripe is contacted.
  try {
    await confirmationLocalPipeline([["SET",keys[0],source.raw],["SET",keys[1],row.sourceValue],
      ["ZADD",keys[2],row.next,row.id],...[3,4,7].map(i=>["SADD",keys[i],row.id]),
      ["HSET",keys[5],"items",1,"bytes",row.bytes],["HSET",keys[6],"items",1,"bytes",row.bytes]]);
    const runtime = { ...f.runtime, now: currentTime, pipeline: async (commands: (string | number)[][]) => {
      for (const c of commands) if (c[0] === "EVAL" && c[1] === COMMIT_ORDER_CONFIRMATION && !settlement) {
        settlement=c; c.slice(3,9).forEach(k=>made.add(String(k)));
        await confirmationLocalPipeline([["HSET",String(c[5]),String(c[10]),2],["HSET",String(c[6]),String(c[10]),2*Number(c[11])]]);
      }
      return confirmationLocalPipeline(commands);
    } };
    const result = await runOrderConfirmationMail(currentTime()+30_000, async (message, barrier) => {
      assert.ok(message.text.includes("Original printed book")); assert.equal(await barrier(), true); posts++; return "accepted";
    }, runtime, f.id);
    assert.deepEqual(result,{accepted:1,waiting:0,unknown:0}); assert.equal(posts,1); assert.ok(settlement);
    assert.equal(String(settlement[10]),String(Math.floor(originalTime/3_600_000)));
    assert.deepEqual(await confirmationLocalPipeline([["GET",String(settlement[4])],["HGET",String(settlement[5]),String(settlement[10])],
      ["HGET",String(settlement[6]),String(settlement[10])],["HGET",keys[5],"items"],["EXISTS",keys[0]]]),["1","1",String(settlement[11]),"0",0]);
    assert.match(String((await confirmationLocalPipeline([["GET",String(settlement[3])]]))[0]),/^oc1:/);
    assert.ok(Number((await confirmationLocalPipeline([["TTL",keys[1]]]))[0])>399*86_400);
    await runOrderConfirmationMail(currentTime()+30_000,async()=>{posts++;return "accepted";},runtime,f.id);assert.equal(posts,1);
  } finally { await confirmationLocalPipeline([["DEL",...made]]); }
});


test("the demonstration account can neither reserve nor dispatch a physical confirmation", async () => {
  const f=await paid(), found=await readConfirmationOrigin(f.id,f.runtime);assert.ok(found);assert.ok(DEMO_CONNECTED_ACCOUNT);
  const demoStore={...f.store,stripeAccountId:DEMO_CONNECTED_ACCOUNT};
  assert.equal(originalPhysicalConfirmation(demoStore,f.session,f.product),null);
  const admission=await admitOrders(demoStore,1,Date.now(),1);assert.equal(admission.ok,true);
  const preintent=await prepareOrderConfirmationPreintent(demoStore,admission,{nonce:found.row.nonce,accountId:DEMO_CONNECTED_ACCOUNT,bodyDigest:found.row.bodyDigest},{now:f.runtime.now});assert.ok(preintent);
  let io=0;
  assert.deepEqual(await reserveConfirmationOrigin({statsId:f.store.statsId,nonce:found.row.nonce,accountId:DEMO_CONNECTED_ACCOUNT,body:found.payload.body,preintent,
    snapshot:{...found.payload.snapshot,store:{...found.payload.snapshot.store as object,stripeAccountId:DEMO_CONNECTED_ACCOUNT}}},
    {...f.runtime,pipeline:async commands=>{io++;return f.runtime.pipeline!(commands);}}),{ok:false});
  assert.equal(io,0,"a genuine demo-account admission cannot create a reservation");
  // Defensive handling of an old/corrupt source must not even ask the demo
  // provider, regardless of whether a payment-shaped reply could be supplied.
  const row={...found.row,accountId:DEMO_CONNECTED_ACCOUNT,sourceValue:JSON.stringify({...JSON.parse(found.row.sourceValue),accountId:DEMO_CONNECTED_ACCOUNT})};
  redis.run(["SET",confirmationOriginRowKey(f.id),JSON.stringify(row)]);redis.run(["SET",`nl:order-confirmation:source:${f.id}`,row.sourceValue]);
  let providerReads=0,posts=0;
  await runOrderConfirmationMail(f.runtime.now!()+30_000,async()=>{posts++;return "accepted";},
    {...f.runtime,provider:async()=>{providerReads++;return f.session;}},f.id);
  assert.equal(providerReads,0);assert.equal(posts,0);assert.ok(await readConfirmationOrigin(f.id,f.runtime));
});
