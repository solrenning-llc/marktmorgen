import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMIT_ORDER_CONFIRMATION } from "@/lib/orders";
import { createCheckout } from "@/lib/store-checkout";
import { readConfirmationOrigin, runOrderConfirmationMail } from "@/lib/order-confirmation-outbox";
import { physicalPaidFixture, originId } from "./order-confirmation-paid-fixture";

async function paid() {
  const f = await physicalPaidFixture();
  const checkout = await createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime);
  const session = f.sessions.get(checkout.id)!;
  Object.assign(session, { status: "complete", payment_status: "paid", amount_total: 4000, customer_details: { email: "buyer@example.test" },
    payment_intent: { object: "payment_intent", status: "succeeded", amount_received: 4000, currency: "usd",
      latest_charge: { object: "charge", paid: true, amount: 4000, amount_refunded: 0, currency: "usd", refunded: false, disputed: false } },
    shipping_details: { name: "Original Buyer", address: { line1: "1 Original Street", city: "Test City", country: "US" } } });
  f.advance(61_000);
  return { ...f, id: originId(), session, checkout };
}

for (const late of [true, null, undefined, "false"] as const) test(`a dispute (${String(late)}) seen only at the dispatch barrier stops the POST`, async () => {
  const f = await paid();
  const charge = (f.session.payment_intent as { latest_charge: Record<string, unknown> }).latest_charge;
  let posts = 0, barrierResult: boolean | null = null;
  await runOrderConfirmationMail(f.runtime.now!() + 30_000, async (_m, barrier) => {
    if (late === undefined) delete charge.disputed; else charge.disputed = late;
    barrierResult = await barrier();
    if (barrierResult) posts++;
    return barrierResult ? "accepted" : "waiting";
  }, f.runtime, f.id);
  assert.equal(barrierResult, false);
  assert.equal(posts, 0);
  const kept = await readConfirmationOrigin(f.id, f.runtime);
  assert.ok(kept, "source retained");
  assert.notEqual(kept.row.phase, "accepted");
  void COMMIT_ORDER_CONFIRMATION;
});
