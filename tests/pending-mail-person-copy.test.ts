import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { enqueueShipmentMail, shipmentMailOf } from "@/lib/shipment-mail-outbox";
import { orderConfirmationMailOf, runOrderConfirmationMail } from "@/lib/order-confirmation-outbox";
import { createCheckout } from "@/lib/store-checkout";
import { shipmentOutboxFixture, shipmentPolicy } from "./shipment-mail-outbox-fixture";
import { physicalPaidFixture } from "./order-confirmation-paid-fixture";
import { store as redis } from "./redis-stub";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const reads = new Set(["TYPE", "SCARD", "SMEMBERS", "GET", "GETRANGE"]);

test("never-activated copies read nothing, even with an unavailable storage adapter", async () => {
  const runtime = { pipeline: async () => { throw Error("must not read"); } };
  assert.deepEqual(await shipmentMailOf("stats", "buyer@example.test", runtime), []);
  assert.deepEqual(await orderConfirmationMailOf("stats", "buyer@example.test", runtime), []);
});

test("shipping copy decrypts only the scoped person's original message, retired too, without writes", async () => {
  redis.clear(); process.env.NIMBUS_DATA_KEY = "SYNTHETIC_SHIPMENT_DATA_KEY_1234567890";
  const now = Date.now(), world = shipmentOutboxFixture();
  const runtime = { lifecycle: "active" as const, policy: shipmentPolicy(now), pipeline: world.pipeline, now: () => now };
  const input = { statsId: "copy_store", session: "cs_test_copyshipment001", authorizedAt: now, shipped: { at: Math.floor(now / 1000), tracking: "https://example.test/track" },
    message: { from: "Store <sender@example.test>", to: "buyer@example.test", subject: "Shipped", text: "Your address: 1 Original Street", replyTo: "team@example.test" } };
  assert.equal((await enqueueShipmentMail(input, runtime)).ok, true);
  world.commands.length = 0;
  for (const lifecycle of ["active", "retired"] as const) {
    const rows = await shipmentMailOf(input.statsId, " BUYER@example.test ", { ...runtime, lifecycle });
    assert.deepEqual(rows, [{ checkout: input.session, state: "queued", created: now, subject: "Shipped", text: input.message.text }]);
    assert.equal(JSON.stringify(rows).includes("team@example.test"), false);
  }
  assert.deepEqual(await shipmentMailOf(input.statsId, "other@example.test", runtime), []);
  assert.deepEqual(await shipmentMailOf("other_store", input.message.to, runtime), []);
  assert.ok(world.commands.every(c => reads.has(String(c[0]))));
  const index = `nl:ship:mail:person:${input.statsId}:${hash(input.message.to)}`;
  const ids = redis.run(["SMEMBERS", index]) as string[];
  redis.run(["SADD", `nl:ship:mail:person:other_store:${hash(input.message.to)}`, ids[0]]);
  await assert.rejects(shipmentMailOf("other_store", input.message.to, runtime), /ownership|source/);
  redis.run(["SET", `nl:ship:mail:row:${ids[0]}`, "corrupt"]);
  await assert.rejects(shipmentMailOf(input.statsId, input.message.to, runtime), /source/);
});

test("confirmation copy reads the persisted buyer message without provider calls, accounting or leases", async () => {
  const f = await physicalPaidFixture();
  const checkout = await createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime);
  Object.assign(f.sessions.get(checkout.id)!, { status: "complete", payment_status: "paid", amount_total: 4000, customer_details: { email: "buyer@example.test" },
    payment_intent: { object: "payment_intent", status: "succeeded", amount_received: 4000, currency: "usd", latest_charge: { object: "charge", paid: true, amount: 4000, amount_refunded: 0, currency: "usd", refunded: false, disputed: false } },
    shipping_details: { name: "Original Buyer", address: { line1: "1 Original Street", city: "Test City", country: "US" } } });
  f.advance(61000);
  await runOrderConfirmationMail(f.runtime.now!() + 30000, async () => "not_accepted", f.runtime);
  const commands: (string | number)[][] = [], before = f.calls.length;
  const runtime = { ...f.runtime, lifecycle: "retired" as const, pipeline: async (batch: (string | number)[][]) => { commands.push(...batch); return f.runtime.pipeline!(batch); } };
  const rows = await orderConfirmationMailOf(f.store.statsId!, "buyer@example.test", runtime);
  assert.equal(rows.length, 1); const text = JSON.stringify(rows);
  assert.ok(text.includes("1 Original Street")); assert.ok(text.includes(checkout.id));
  assert.equal(/preintentToken|settlementToken|sealed|intentFingerprint/.test(text), false);
  assert.equal(f.calls.length, before); assert.ok(commands.every(c => reads.has(String(c[0]))));
  assert.deepEqual(await orderConfirmationMailOf(f.store.statsId!, "other@example.test", runtime), []);
});

test("unknown or oversized index replies fail the whole copy", async () => {
  for (const indexReply of [["hash", 0], ["set", 10001], ["set", "0"], ["set", -1]]) {
    const runtime = { lifecycle: "retired" as const, pipeline: async () => indexReply };
    await assert.rejects(shipmentMailOf("stats", "buyer@example.test", runtime));
    await assert.rejects(orderConfirmationMailOf("stats", "buyer@example.test", runtime));
  }
});

test("four genuine pending shipping messages stay inside the personal copy's supported index", async () => {
  redis.clear(); process.env.NIMBUS_DATA_KEY = "SYNTHETIC_SHIPMENT_DATA_KEY_1234567890";
  const now = Date.now(), world = shipmentOutboxFixture();
  const runtime = { lifecycle: "active" as const, policy: shipmentPolicy(now), pipeline: world.pipeline, now: () => now };
  for (let i = 0; i < 4; i++) {
    assert.equal((await enqueueShipmentMail({ statsId: "copy_four", session: `cs_test_copyfour00000${i}`, authorizedAt: now,
      shipped: { at: Math.floor(now / 1000), tracking: "https://example.test/track" },
      message: { from: "Store <sender@example.test>", to: "buyer@example.test", subject: `Parcel ${i}`, text: `Original parcel ${i}`, replyTo: "team@example.test" } }, runtime)).ok, true);
  }
  world.commands.length = 0;
  const rows = await shipmentMailOf("copy_four", "buyer@example.test", { ...runtime, lifecycle: "retired" });
  assert.equal(rows.length, 4);
  assert.deepEqual(new Set(rows.map(r => (r as {subject: string}).subject)), new Set(["Parcel 0", "Parcel 1", "Parcel 2", "Parcel 3"]));
  assert.ok(world.commands.every(c => reads.has(String(c[0]))));
});
