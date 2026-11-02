import assert from "node:assert/strict";
import { test } from "node:test";
import { EU_WITHDRAWAL_CONSENT_VERSION } from "@/lib/digital-consent";
import { createCheckout } from "@/lib/store-checkout";
import { singleDigitalFixture } from "./single-digital-confirmation-world";

test("single digital checkout cannot bypass durable admission when never activated or unfunded", async () => {
  for (const lifecycle of ["never_activated", "active"] as const) {
    const f = await singleDigitalFixture();
    let posts = 0;
    process.env.STRIPE_SECRET_KEY = "sk_test_SYNTHETIC_ONLY";
    globalThis.fetch = async (_url, init) => {
      if (init?.method === "POST") posts++;
      return Response.json({ id: "cs_test_SyntheticLegacyDigital001", url: "https://checkout.stripe.com/c/pay/synthetic" });
    };
    let returned = false;
    try { await createCheckout(f.store, f.product, "https://example.test", undefined, { digitalConsent: { version: EU_WITHDRAWAL_CONSENT_VERSION, at: Math.floor(f.created / 1000) } }, { ...f.runtime, lifecycle, policy: null }); returned = true; } catch { /* Fail closed is required. */ }
    assert.equal(f.commands.length, 0, "blocked producer spends no durable source commands");
    assert.equal(posts, 0, "no legacy payment POST before funded durable admission");
    assert.equal(returned, false, "no unprotected payment URL");
  }
});

import { reserveDigital } from "./single-digital-confirmation-world";
import { confirmationOriginRowKey, readConfirmationOrigin, reserveSingleDigitalConfirmationOrigin, runOrderConfirmationMail,
  openConfirmationOrigin, forgetOrderConfirmationMail } from "@/lib/order-confirmation-outbox";
import { store as redis } from "./redis-stub";
import { shipmentMailPolicy, CURRENT_SHIPMENT_MAIL_POLICY } from "@/lib/shipment-mail-outbox";
import { confirmPurchase } from "@/lib/purchase-email";

test("even synthetic funding cannot open payment before original-file access is proved", async () => {
  const f = await singleDigitalFixture();
  await assert.rejects(createCheckout(f.store, f.product, "https://example.test", undefined,
    { digitalConsent: { version: EU_WITHDRAWAL_CONSENT_VERSION, at: Math.floor(f.created / 1000) } }, f.runtime));
  assert.equal(f.calls.filter(c => c.method === "POST").length, 0);
  assert.equal(f.commands.length, 0, "access failure precedes reservation and admission writes");
  assert.equal([...redis.keys()].some(k => k.startsWith("nl:order-confirmation:row:")), false);
});

test("real funded reservation retains original rights over restart25h without payment or receipt", async () => {
  const f = await singleDigitalFixture(), reserved = await reserveDigital(f);
  assert.ok(reserved.result.ok); const id = reserved.result.id;
  const original = await readConfirmationOrigin(id, f.runtime); assert.ok(original);
  assert.equal(original.row.originKind, "single_digital");
  assert.equal(redis.run(["TTL", confirmationOriginRowKey(id)]), -1);
  assert.ok(original.payload.preintentToken); assert.ok(original.payload.snapshot.product);
  assert.equal(original.payload.body, reserved.body.toString());
  assert.equal(await openConfirmationOrigin(id, f.runtime), null);
  f.store.name = "Changed store"; f.store.currency = "eur"; f.product.file!.pathname = "changed.pdf"; f.product.title = "Changed title";
  f.advance(25 * 3_600_000);
  let receipts = 0;
  // New runtime object; only the saved Redis source crosses this boundary.
  const restarted = { ...f.runtime };
  const counts = await runOrderConfirmationMail(restarted.now!() + 30_000, async () => { receipts++; return "accepted"; }, restarted);
  assert.equal(counts.waiting, 1); assert.equal(receipts, 0);
  const retained = await readConfirmationOrigin(id, restarted); assert.ok(retained);
  assert.deepEqual(retained.payload, original.payload);
  assert.equal(retained.row.sourceValue, original.row.sourceValue);
  assert.equal(redis.run(["TTL", confirmationOriginRowKey(id)]), -1);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 0);
});

test("synthetic unknown create ACK is reconciled by original-account reads after25h, never another POST", async () => {
  const f = await singleDigitalFixture(), reserved = await reserveDigital(f); assert.ok(reserved.result.ok);
  const id = reserved.result.id, sessionId = "cs_test_SyntheticDigitalUnknown001";
  // External synthetic provider seed represents an existing payment whose
  // create ACK was lost. The application's blocked producer did NOT create it.
  f.sessions.set(sessionId, { object: "checkout.session", id: sessionId, mode: "payment", status: "complete",
    payment_status: "paid", created: Math.floor(f.created / 1000), currency: "usd", amount_total: 3500,
    metadata: Object.fromEntries([...reserved.body].flatMap(([k,v]) => /^metadata\[/.test(k) ? [[k.slice(9,-1),v]] : [])),
    line_items: { object: "list", has_more: false, data: [{ quantity: 1, price: { unit_amount: 3500, currency: "usd" } }] } });
  f.advance(25 * 3_600_000);
  let sent = 0;
  await runOrderConfirmationMail(f.runtime.now!() + 30_000, async () => { sent++; return "accepted"; }, f.runtime);
  const found = await readConfirmationOrigin(id, f.runtime); assert.ok(found);
  assert.equal(found.row.session, sessionId); assert.equal(found.row.phase, "awaiting_payment");
  f.advance(26 * 3_600_000);
  await runOrderConfirmationMail(f.runtime.now!() + 30_000, async () => { sent++; return "accepted"; }, { ...f.runtime });
  assert.equal(sent, 0); assert.equal(f.calls.filter(c => c.method === "POST").length, 0);
  assert.equal(f.commands.some(c => c[0] === "EVAL" && String(c[1]).includes("order-confirmation-settlement:v1")), false);
  assert.ok(f.calls.filter(c => c.method === "GET").every(c => c.account === "acct_TestOrigin01"));
  assert.equal(await confirmPurchase(f.store, sessionId, f.sessions.get(sessionId)!), "skip");
  // Financial horizon is not an expiry of the retained source.
  f.advance(450 * 86_400_000);
  await runOrderConfirmationMail(f.runtime.now!() + 30_000, async () => { sent++; return "accepted"; }, f.runtime);
  assert.ok(await readConfirmationOrigin(id, f.runtime)); assert.equal(sent, 0);
});

test("coverage, policy and corrupted original data cannot authorize digital work", async () => {
  const f = await singleDigitalFixture(), reserved = await reserveDigital(f); assert.ok(reserved.result.ok);
  for (const policy of [null, { ...f.runtime.policy!, coveredOrigins: undefined }]) {
    assert.deepEqual(await reserveSingleDigitalConfirmationOrigin(reserved.input, { ...f.runtime, policy }), { ok: false });
  }
  const id = reserved.result.id, source = `nl:order-confirmation:source:${id}`;
  redis.run(["SET", source, "corrupted"]); let calls = 0;
  await runOrderConfirmationMail(f.runtime.now!() + 30_000, async () => { calls++; return "accepted"; }, f.runtime);
  assert.equal(calls, 0); assert.equal(await readConfirmationOrigin(id, f.runtime), null);
  assert.equal(CURRENT_SHIPMENT_MAIL_POLICY, null);
  assert.equal(shipmentMailPolicy({ ...f.runtime.policy!, coveredOrigins: ["single-digital-confirmation", "single-digital-confirmation"] }), null);
});

test("store erasure removes the retained digital payload without a payment or receipt", async () => {
  const f = await singleDigitalFixture(), reserved = await reserveDigital(f); assert.ok(reserved.result.ok);
  assert.equal(await forgetOrderConfirmationMail(f.store.statsId, undefined, f.runtime), 1);
  assert.equal(await readConfirmationOrigin(reserved.result.id, f.runtime), null);
  assert.equal(f.calls.length, 0);
});
