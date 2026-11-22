/** Regression (mail-queue hunt): the payment wait of a physical confirmation origin
 * spends the same `checks` budget that bounds its email delivery. A buyer who
 * pays inside Stripe's normal 24h checkout window, but after the worker has
 * polled the open session `maximumChecks` times, never gets the confirmation
 * (and the order's original accounting is never committed): the row is put
 * on hold and the legacy sender skips physical-v1 sessions (purchase-email.ts).
 * Synthetic only: fixture provider/ACK boundary, no real Stripe or email.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCheckout } from "@/lib/store-checkout";
import { readConfirmationOrigin, runOrderConfirmationMail } from "@/lib/order-confirmation-outbox";
import { physicalPaidFixture, originId } from "./order-confirmation-paid-fixture";

test("a buyer paying 9h after opening a 24h checkout still gets the original confirmation", async () => {
  const f = await physicalPaidFixture();
  const checkout = await createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime);
  const id = originId(), session = f.sessions.get(checkout.id)!;
  let posts = 0;
  const send = async (_message: unknown, barrier: () => Promise<boolean>) => { if (await barrier()) posts++; return "accepted" as const; };
  // The cron runs every five minutes while the buyer has the open page.
  let at = 61_000;
  for (; at < 9 * 3_600_000; at += 5 * 60_000) {
    f.advance(at);
    await runOrderConfirmationMail(f.runtime.now!() + 30_000, send, f.runtime);
  }
  assert.equal(posts, 0, "nothing is sent before payment");
  // The buyer pays at 9h, well inside Stripe's default 24h session lifetime.
  Object.assign(session, { status: "complete", payment_status: "paid", amount_total: 4000, customer_details: { email: "buyer@example.test" },
    payment_intent: { object: "payment_intent", status: "succeeded", amount_received: 4000, currency: "usd",
      latest_charge: { object: "charge", paid: true, amount: 4000, amount_refunded: 0, currency: "usd", refunded: false, disputed: false } },
    shipping_details: { name: "Original Buyer", address: { line1: "1 Original Street", city: "Test City", country: "US" } } });
  for (const later of [5, 10, 60, 24 * 60]) {
    f.advance(at + later * 60_000);
    await runOrderConfirmationMail(f.runtime.now!() + 30_000, send, f.runtime);
  }
  const row = await readConfirmationOrigin(id, f.runtime);
  assert.equal(posts, 1, `the paid buyer's confirmation must be sent; row phase=${row?.row.phase} state=${row?.row.state} checks=${row?.row.checks}`);
});
