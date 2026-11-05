import assert from "node:assert/strict";
import test from "node:test";
import { claimHandle, ensureStatsId, addProduct, setProductLink, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { deliverGift, readGift, startGift } from "@/lib/gifts";
import { importedFor } from "@/lib/imported-purchases";
import { sendEmail } from "@/lib/email";
import { store as redis } from "./redis-stub";

// Real gift/grant/email functions; MemoryRedis and no-provider configuration.
// This is a positive runtime boundary control, not an additional product RED.
test("a gift remains granted when the actual email sender returns false before provider IO", async () => {
  redis.clear();
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_CREATORS_API_KEY;
  delete process.env.SES_REGION;
  delete process.env.SES_ACCESS_KEY_ID;
  delete process.env.SES_SECRET_ACCESS_KEY;
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; throw new Error("Unexpected provider IO"); };
  await claimHandle("owner@example.com", "reviewgift", "Review Gift", "");
  await ensureStatsId("owner@example.com");
  const made = await addProduct("owner@example.com", "Review download", "", "27", null);
  assert.equal(made.ok, true);
  if (!made.ok) throw new Error("Missing synthetic listing");
  await setProductLink("owner@example.com", made.product.id, "https://example.com/download");
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;
  const started = await startGift(store, product, { to: "recipient@example.com", from: "Sender", message: "A gift" });
  assert.equal(started.ok, true);
  if (!started.ok) throw new Error("Missing synthetic gift");
  assert.equal(await sendEmail({ meter: { by: "order" }, from: "hello@marktmorgen.com", to: "recipient@example.com", subject: "Synthetic control", text: "Control" }), false);
  const outcome = await deliverGift({ store, product, session: { id: "cs_test_synthetic_gift", payment_intent: "pi_SyntheticGift", created: 1_900_000_000, metadata: { gift: started.gift.id }, customer_details: { email: "buyer@example.com" } }, base: "https://example.com", from: "hello@marktmorgen.com", recordStart: async () => {}, ordersLink: async () => null });
  assert.equal(outcome, "given");
  const refreshed = (await storeForEmail("owner@example.com"))!;
  assert.deepEqual((await importedFor(refreshed, "recipient@example.com")).map(p => p.productId), [product.id]);
  assert.equal(typeof (await readGift(started.gift.id))?.given, "number");
  assert.equal(providerCalls, 0);
});
