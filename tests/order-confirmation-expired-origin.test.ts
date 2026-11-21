/** Regression (mail-queue hunt): an abandoned physical checkout reserves a pool
 * slot and a ~148 KB row envelope (reserveOrigin) before its payment URL, but
 * nothing ever releases it once Stripe says the session expired unpaid: the
 * worker only defers it until `maximumChecks`, then holds it forever. Every
 * abandoned "Buy" click therefore leaks storeItems/globalItems until the pool
 * is full and createCheckout refuses all new physical checkouts.
 * Synthetic only: fixture provider/ACK boundary, no real Stripe or email.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCheckout } from "@/lib/store-checkout";
import { readConfirmationOrigin, runOrderConfirmationMail } from "@/lib/order-confirmation-outbox";
import { store as redis } from "./redis-stub";
import { physicalPaidFixture, originId } from "./order-confirmation-paid-fixture";

test("an expired, never-paid checkout releases its reserved confirmation origin", async () => {
  const f = await physicalPaidFixture();
  const checkout = await createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime);
  const id = originId(), session = f.sessions.get(checkout.id)!;
  // Stripe's definitive terminal answer: the session expired and can never be paid.
  Object.assign(session, { status: "expired", payment_status: "unpaid", amount_total: 4000 });
  let posts = 0;
  for (let at = 25 * 3_600_000; at < 40 * 3_600_000; at += 5 * 60_000) {
    f.advance(at);
    await runOrderConfirmationMail(f.runtime.now!() + 30_000, async () => { posts++; return "accepted"; }, f.runtime);
  }
  assert.equal(posts, 0);
  const left = await readConfirmationOrigin(id, f.runtime);
  assert.equal(left, null, `expired origin still reserved: phase=${left?.row.phase} state=${left?.row.state} checks=${left?.row.checks}`);
  assert.equal(redis.run(["SISMEMBER", `nl:order-confirmation:store:${f.store.statsId}`, id]), 0, "store capacity index still counts the abandoned checkout");
});
