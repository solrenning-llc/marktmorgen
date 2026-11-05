import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createCheckout } from "@/lib/store-checkout";
import { CONFIRMATION_ERASURE_SCRIPT, confirmationOriginRowKey, forgetOrderConfirmationMail, readConfirmationOrigin, runOrderConfirmationMail } from "@/lib/order-confirmation-outbox";
import { SHIPMENT_MAIL_SCRIPT, forgetShipmentMail } from "@/lib/shipment-mail-outbox";
import { store as redis } from "./redis-stub";
import { physicalPaidFixture, originId, confirmationLocalPipeline } from "./order-confirmation-paid-fixture";

const person = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
async function source() {
  const f = await physicalPaidFixture();
  const checkout = await createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime);
  const session = f.sessions.get(checkout.id)!;
  f.advance(61_000);
  return { ...f, checkout, session, id: originId() };
}
function pay(session: Record<string, unknown>, email = "buyer@example.test") {
  Object.assign(session, { status: "complete", payment_status: "paid", amount_total: 4000, customer_details: { email },
    payment_intent: { object: "payment_intent", status: "succeeded", amount_received: 4000, currency: "usd",
      latest_charge: { object: "charge", paid: true, amount: 4000, amount_refunded: 0, currency: "usd", refunded: false } },
    shipping_details: { name: "Original Buyer", address: { line1: "1 Original Street", city: "Test City", country: "US" } } });
}

test("an unresolved older purchase cannot learn an erased recipient and send after the ten-minute fence expires", async () => {
  const realNow = Date.now; let clock = realNow(); Date.now = () => clock;
  try {
    const f = await source(), before = await readConfirmationOrigin(f.id, f.runtime); assert.ok(before);
    assert.equal(before.payload.message, undefined);
    assert.equal(await forgetOrderConfirmationMail(f.store.statsId, "buyer@example.test", f.runtime), 0);
    const marked = await readConfirmationOrigin(f.id, f.runtime); assert.ok(marked);
    assert.equal(marked.row.erasedPeople, person("buyer@example.test")); assert.equal(marked.row.bytes, before.row.bytes);
    assert.equal(marked.raw.includes("buyer@example.test"), false); assert.equal(redis.run(["TTL", confirmationOriginRowKey(f.id)]), -1);
    const fence = `nl:order-confirmation:erased:${f.store.statsId}:${person("buyer@example.test")}`;
    assert.ok(Number(redis.run(["TTL", fence])) <= 600);
    clock += 73 * 3_600_000; assert.equal(redis.run(["EXISTS", fence]), 0); pay(f.session);
    let posts = 0;
    await runOrderConfirmationMail(f.runtime.now!() + 30_000, async (_message, barrier) => { if (await barrier()) posts++; return "accepted"; }, f.runtime, f.id);
    assert.equal(posts, 0); assert.equal(await readConfirmationOrigin(f.id, f.runtime), null);
    assert.ok(Number(redis.run(["TTL",`nl:order-confirmation:source:${f.id}`]))>399*86_400);
  } finally { Date.now = realNow; }
});

test("the unresolved origin still delivers to a different buyer without discarding their paid right", async () => {
  const f = await source(); await forgetOrderConfirmationMail(f.store.statsId, "erased@example.test", f.runtime);
  pay(f.session, "other@example.test"); f.advance(73 * 3_600_000); let posts = 0;
  const result = await runOrderConfirmationMail(f.runtime.now!() + 30_000, async (message, barrier) => {
    assert.equal(message.to, "other@example.test"); assert.equal(await barrier(), true); posts++; return "accepted";
  }, f.runtime, f.id);
  assert.equal(posts, 1); assert.equal(result.accepted, 1); assert.equal(await readConfirmationOrigin(f.id, f.runtime), null);
});

test("a genuinely new purchase after erasure does not inherit an older origin's recipient marks", async () => {
  const realNow = Date.now; let clock = realNow(); Date.now = () => clock;
  try {
    const f = await source(); await forgetOrderConfirmationMail(f.store.statsId, "buyer@example.test", f.runtime);
    clock += 11 * 60_000;
    const fresh = await createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime);
    const freshRowKey = [...redis.keys()].filter(k => k.startsWith("nl:order-confirmation:row:")).find(k => JSON.parse(String(redis.run(["GET", k]))).session === fresh.id)!;
    assert.ok(freshRowKey); const id = freshRowKey.slice("nl:order-confirmation:row:".length);
    assert.notEqual(id, f.id); assert.equal((await readConfirmationOrigin(id, f.runtime))?.row.erasedPeople, "");
    pay(f.sessions.get(fresh.id)!); f.advance(122_000); let posts = 0;
    const result = await runOrderConfirmationMail(f.runtime.now!() + 30_000, async (_message, barrier) => { assert.equal(await barrier(), true); posts++; return "accepted"; }, f.runtime, id);
    assert.equal(result.accepted, 1); assert.equal(posts, 1); assert.ok(await readConfirmationOrigin(f.id, f.runtime));
  } finally { Date.now = realNow; }
});

test("bounded marker saturation keeps the original payload and hold without dispatching or growing the row", async () => {
  const f = await source(), before = await readConfirmationOrigin(f.id, f.runtime); assert.ok(before);
  for (let i = 0; i < 65; i++) await forgetOrderConfirmationMail(f.store.statsId, `erased-${i}@example.test`, f.runtime);
  const marked = await readConfirmationOrigin(f.id, f.runtime); assert.ok(marked);
  assert.equal(marked.row.erasedPeople.length, 64 * 64); assert.equal(marked.row.erasureSaturated, true);
  assert.equal(marked.row.bytes, before.row.bytes); assert.deepEqual(marked.payload, before.payload);
  assert.ok(Buffer.byteLength(marked.raw) <= marked.row.bytes); assert.equal(redis.run(["TTL", confirmationOriginRowKey(f.id)]), -1);
  pay(f.session, "another@example.test"); let posts = 0;
  await runOrderConfirmationMail(f.runtime.now!() + 30_000, async () => { posts++; return "accepted"; }, f.runtime, f.id);
  assert.equal(posts, 0); assert.ok(await readConfirmationOrigin(f.id, f.runtime));
  assert.equal([...redis.keys()].filter(k => k.startsWith("nl:order-confirmation:row:")).length, 1);
});

test("lost durable-marker acknowledgement retains the fence; an idempotent erasure retry completes it", async () => {
  const f = await source(); f.loseNext("erasure-mark");
  await assert.rejects(forgetOrderConfirmationMail(f.store.statsId, "buyer@example.test", f.runtime));
  const fence = `nl:order-confirmation:erased:${f.store.statsId}:${person("buyer@example.test")}`;
  assert.equal(redis.run(["TTL", fence]), -1);
  assert.equal((await readConfirmationOrigin(f.id, f.runtime))?.row.erasedPeople, person("buyer@example.test"));
  assert.equal(await forgetOrderConfirmationMail(f.store.statsId, "buyer@example.test", f.runtime), 0);
  assert.equal((await readConfirmationOrigin(f.id, f.runtime))?.row.erasedPeople.length, 64);
  assert.ok(Number(redis.run(["TTL", fence])) <= 600);
});

test("unknown erased-payload cancellation never dispatches and can finish on a later acknowledged retry", async () => {
  const realNow=Date.now;let clock=realNow();Date.now=()=>clock;
  try {
    const f=await source();await forgetOrderConfirmationMail(f.store.statsId,"buyer@example.test",f.runtime);
    clock+=73*3_600_000;pay(f.session);
    const pipeline=f.runtime.pipeline!;let fail=true,posts=0;
    f.runtime.pipeline=async commands=>{
      if(fail && commands.some(c=>c[0]==="EVAL" && c[1]===SHIPMENT_MAIL_SCRIPT && c[13]==="cancel")){fail=false;throw Error("Cancellation unknown before Redis");}
      return pipeline(commands);
    };
    const send=async()=>{posts++;return "accepted" as const;};
    await runOrderConfirmationMail(f.runtime.now!()+30_000,send,f.runtime,f.id);
    assert.equal(posts,0);assert.ok(await readConfirmationOrigin(f.id,f.runtime));
    clock+=61_000;await runOrderConfirmationMail(f.runtime.now!()+30_000,send,f.runtime,f.id);
    assert.equal(posts,0);assert.equal(await readConfirmationOrigin(f.id,f.runtime),null);
  } finally {Date.now=realNow;}
});

test("later shipment erasure cannot expire an incomplete confirmation barrier before its first marker", async () => {
  const realNow=Date.now;let clock=realNow();Date.now=()=>clock;
  try {
    const f=await source(), rawPipeline=f.runtime.pipeline!;let fail=true;
    f.runtime.pipeline=async commands=>{
      if(fail && commands.some(c=>c[0]==="EVAL" && c[1]===CONFIRMATION_ERASURE_SCRIPT && c[6]==="mark")){fail=false;throw Error("Synthetic interruption BEFORE first marker");}
      return rawPipeline(commands);
    };
    await assert.rejects(forgetOrderConfirmationMail(f.store.statsId,"buyer@example.test",f.runtime));
    assert.equal((await readConfirmationOrigin(f.id,f.runtime))?.row.erasedPeople,"");
    assert.equal(await forgetShipmentMail(f.store.statsId,"buyer@example.test",f.runtime),0);
    const fence=`nl:order-confirmation:erased:${f.store.statsId}:${person("buyer@example.test")}`;
    assert.equal(redis.run(["TTL",fence]),-1,"the other eraser cannot shorten this incomplete cleanup");
    clock+=73*3_600_000;pay(f.session);let posts=0;
    await runOrderConfirmationMail(f.runtime.now!()+30_000,async()=>{posts++;return "accepted";},f.runtime,f.id);
    assert.equal(posts,0);assert.ok(await readConfirmationOrigin(f.id,f.runtime));
    assert.equal(await forgetOrderConfirmationMail(f.store.statsId,"buyer@example.test",f.runtime),0);
    assert.equal((await readConfirmationOrigin(f.id,f.runtime))?.row.erasedPeople,person("buyer@example.test"));
    assert.ok(Number(redis.run(["TTL",fence]))<=600);
  } finally {Date.now=realNow;}
});

test("an invalid origin index keeps a dedicated barrier and cannot permit late recipient binding", async () => {
  for(const wrongType of [false,true]) {
    const f=await source(),index=`nl:order-confirmation:store:${f.store.statsId}`;
    if(wrongType){redis.run(["DEL",index]);redis.run(["RPUSH",index,"wrong-type"]);}else redis.run(["SADD",index,"invalid-member"]);
    await assert.rejects(forgetOrderConfirmationMail(f.store.statsId,"buyer@example.test",f.runtime));
    const fence=`nl:order-confirmation:erased:${f.store.statsId}:${person("buyer@example.test")}`;
    assert.equal(redis.run(["TTL",fence]),-1);pay(f.session);f.advance(73*3_600_000);let posts=0;
    await runOrderConfirmationMail(f.runtime.now!()+30_000,async()=>{posts++;return "accepted";},f.runtime,f.id);
    assert.equal(posts,0);assert.ok(await readConfirmationOrigin(f.id,f.runtime));
  }
});

if (process.env.MARKTMORGEN_REDIS_INTEGRATION === "1") test("production recipient-erasure Lua rejects the old buyer after an expired fence on disposable Redis", async () => {
  const f = await source(), found = await readConfirmationOrigin(f.id, f.runtime); assert.ok(found); pay(f.session);
  const row = found.row, prefix = `nl:order-confirmation:`, buyer = person("buyer@example.test");
  const keys = [confirmationOriginRowKey(row.id), `${prefix}source:${row.id}`, `${prefix}due`, `${prefix}store:${row.statsId}`,
    `${prefix}person:${row.statsId}:${row.person}`, "nl:ship:mail:pool", `nl:ship:mail:pool:${row.statsId}`, "nl:ship:mail:all",
    `nl:order-confirmation:closed:${row.statsId}`, `nl:order-confirmation:erased:${row.statsId}:${buyer}`, `${prefix}person:${row.statsId}:${buyer}`];
  try {
    await confirmationLocalPipeline([["SET", keys[0], JSON.stringify({...row,next:0})], ["SET", keys[1], row.sourceValue], ["ZADD", keys[2], row.next, row.id],
      ...[3, 4, 7].map(i => ["SADD", keys[i], row.id]), ["HSET", keys[5], "items", 1, "bytes", row.bytes], ["HSET", keys[6], "items", 1, "bytes", row.bytes]]);
    const runtime = { ...f.runtime, now: Date.now, pipeline: confirmationLocalPipeline };
    assert.equal(await forgetOrderConfirmationMail(row.statsId, "buyer@example.test", runtime), 0);
    const marked = await readConfirmationOrigin(row.id, runtime); assert.ok(marked);
    assert.equal(marked.row.erasedPeople, buyer);
    // Expire the fence in Redis itself; suppression must come from the row.
    await confirmationLocalPipeline([["PEXPIREAT", keys[9], 1], ["ZADD", keys[2], 0, row.id]]);
    assert.deepEqual(await confirmationLocalPipeline([["EXISTS", keys[9]]]), [0]);
    let posts = 0;
    await runOrderConfirmationMail(Date.now() + 30_000, async () => { posts++; return "accepted"; }, runtime, row.id);
    assert.equal(posts, 0); assert.equal(await readConfirmationOrigin(row.id, runtime),null);
    assert.deepEqual(await confirmationLocalPipeline([["HGET", keys[5], "items"], ["TTL", keys[0]]]), ["0", -2]);
    assert.ok(Number((await confirmationLocalPipeline([["TTL",keys[1]]]))[0])>399*86_400);
  } finally { await confirmationLocalPipeline([["DEL", ...keys]]); }
});
