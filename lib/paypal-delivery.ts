/**
 * Hands over what a PayPal payment bought (lib/paypal-sales.ts) with the same
 * pieces a Stripe sale uses: the store's sender and address, the course
 * dated from the payment, and a signed link to the list of purchases. And,
 * as for a Stripe sale (added 13 October 2026), the affiliate and partners
 * credited, and the store's webhooks told: "sale.completed" with
 * `paid_with: "paypal"`, and "refund.issued" when PayPal refunds it in full.
 */
import { ordersLinkFor } from "@/lib/buyer-orders";
import { type Listing, readListing, readListings } from "@/lib/catalog";
import { dropEnrollment, recordOpenEnrollment } from "@/lib/learn";
import { type Paid, deliverPayPal, handOverKey, readPaidExact, refundSeen, watchPayPal } from "@/lib/paypal-sales";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { fromStore, storeBase } from "@/lib/purchase-email";
import type { Store } from "@/lib/store";
import { creditPayPalSale } from "@/lib/affiliates";
import { emitEvent } from "@/lib/webhooks";

/**
 * Paid PayPal orders still owed their hand-over (handOverKey in lib/paypal-sales.ts): settle puts each one there with
 * the writes that take it off pending, before anything is handed over, and handOverPayPal takes it out once it is
 * handed over (Claude 5's MEDIUM on #2909). The sweep tries again (handOverAgain) those whose score is
 * HAND_OVER_GRACE_SECONDS old, so it does not hand over an order whose return is handing it over at that moment.
 */
const HAND_OVER_GRACE_SECONDS = 600;
/** How many of them one sweep of a store tries (NOT_A_COST.HAND_OVER_BATCH and PAYPAL_HAND_OVER_RETRY in tests/plan-cost-registry.ts). */
export const HAND_OVER_BATCH = 25;
/** The score of an order to be tried at the next sweep: due now, behind those due before it. */
const dueNow = () => String(Math.floor(Date.now() / 1000) - HAND_OVER_GRACE_SECONDS);

/** Takes a handed-over order out of the list. Not known whether it left: it stays, and the next try finds it handed over. */
async function handedOver(statsId: string, order: string): Promise<void> {
  await redisPipeline([["ZREM", handOverKey(statsId), order]]).catch((error) => console.error("taking a handed-over PayPal order out of the list failed", order, error));
}

/**
 * Gives the buyer what they paid for and emails the receipt. False when the product is gone (Redis answered that
 * its record is not there). Everything it hands over is read first, a bundle's products too; a read that is
 * unknown throws before anything is handed over, and the order is kept for the sweep to hand over, never taken
 * for a product that is gone.
 */
export async function handOverPayPal(store: Store, paid: Paid): Promise<boolean> {
  let product: Listing | null;
  let bundled: Map<string, Listing>;
  try {
    product = await readListing(store, paid.product);
    bundled = new Map(product?.bundle?.length ? (await readListings(store, product.bundle)).map((listing) => [listing.id, listing]) : []);
  } catch (error) {
    // Already in the list since it was written down (settle): this only makes it due at the next sweep, and the
    // read's own error is the one thrown, whatever this answers.
    if (store.statsId && isRedisConfigured()) await redisPipeline([["ZADD", handOverKey(store.statsId), dueNow(), paid.order]]).catch(() => undefined);
    throw error;
  }
  if (!product) {
    console.error("a PayPal purchase named a product the store no longer has", store.handle, paid.order);
    if (store.statsId) await handedOver(store.statsId, paid.order);
    return false;
  }
  const base = storeBase(store);
  await deliverPayPal({
    store,
    paid,
    product,
    base,
    from: fromStore(store),
    recordStart: async (email, productId, start) => {
      const course = productId === product.id ? product : bundled.get(productId);
      if (course?.course) await recordOpenEnrollment(store, email, productId, start); // no end date was shown (24 [E7])
    },
    ordersLink: (email) => ordersLinkFor(store, email, base),
  });
  await creditPayPalSale(store, paid, product.title).catch((error) => console.error("crediting a PayPal sale failed", error));
  await emitEvent(store, "sale.completed", `paypal:${paid.order}`, {
    paypal_order: paid.order,
    paypal_capture: paid.capture,
    paid_with: "paypal",
    kind: "one_time",
    product: { id: product.id, title: product.title },
    bundle_items: product.bundle?.length ? product.bundle.map((id) => ({ id, title: null })) : null,
    amount_cents: paid.cents,
    discount_cents: paid.off ?? 0,
    currency: paid.currency,
    buyer: { email: paid.email, name: null },
    channel: paid.meta?.channel ?? null,
    paid_at: new Date(paid.at * 1000).toISOString(),
  }, paid.at * 1000).catch((error) => console.error("telling the webhooks of a PayPal sale failed", error));
  if (store.statsId) await handedOver(store.statsId, paid.order);
  return true;
}

/**
 * Tries again the orders still owed their hand-over, oldest try first, a few a sweep, once their grace is over. One
 * handed over, whose product Redis answers is gone, or that PayPal refunded in full meanwhile, leaves the list; one
 * whose paid record Redis answers is not there any more (erased, or past its time) leaves it too, with nothing to hand
 * over; one whose paid record, refund mark or product does not read, or reads in another shape, is kept and tried
 * again at the next sweep (Claude 6's MEDIUM on #2909: unknown is never "no paid record"). The list itself read in
 * another shape throws UnknownReplyError. Returns how many were handed over.
 */
async function handOverAgain(store: Store, deadline: number): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const key = handOverKey(store.statsId);
  const read = repliesFor(await redisPipeline([["ZRANGEBYSCORE", key, "-inf", dueNow(), "LIMIT", 0, HAND_OVER_BATCH]]), 1);
  const orders = read ? stringList(read[0]) : null;
  if (!orders) throw new UnknownReplyError("the PayPal orders waiting to be handed over");
  let handed = 0;
  for (const order of orders) {
    if (Date.now() >= deadline) break;
    try {
      const paid = await readPaidExact(order);
      if (paid === "unknown") throw new UnknownReplyError("a PayPal order's paid record");
      if (paid === null) {
        console.error("a PayPal order waiting to be handed over has no paid record any more", store.handle, order);
        await redisPipeline([["ZREM", key, order]]);
        continue;
      }
      // Refunded in full meanwhile (the refund watch saw it before anything was granted, and looks at it no more):
      // never handed over, it leaves the list. Unknown throws below and it is kept (Claude 5's MEDIUM on #2909). A
      // refund seen after a hand-over is taken back by the watch, as for any other order. One ZSCORE an order tried.
      if (await refundSeen(store.statsId, order)) {
        console.error("a PayPal order waiting to be handed over was refunded in full; nothing handed over", store.handle, order);
        await redisPipeline([["ZREM", key, order]]);
        continue;
      }
      // Handed over, or its product gone: handOverPayPal takes it out of the list.
      if (await handOverPayPal(store, paid)) handed += 1;
    } catch (error) {
      // Still unknown: kept, moved behind the others, tried at the next sweep.
      console.error("handing over a PayPal purchase again failed; tried again at the next sweep", store.handle, order, error);
      await redisPipeline([["ZADD", key, dueNow(), order]]).catch(() => undefined);
    }
  }
  return handed;
}

/**
 * The checkout sweep's PayPal part for one store: pending payments cleared, refunds taken back, and paid orders
 * whose product could not be read handed over (counted as cleared).
 */
export async function sweepPayPal(store: Store, deadline: number): Promise<{ cleared: number; revoked: number }> {
  const done = await watchPayPal(store, deadline, {
    handOver: async (paid) => {
      await handOverPayPal(store, paid);
    },
    dropStart: (email, productId) => dropEnrollment(store, email, productId),
    // A course put back for a payment that keeps the purchase (Codex G's M1 on #2791): HSETNX, so nothing for one
    // still there, and no email; only for a product that is a course, as handing over does.
    restoreStart: async (email, productId, start) => {
      const course = await readListing(store, productId);
      if (course?.course) await recordOpenEnrollment(store, email, productId, start); // no end date was shown (24 [E7])
    },
    refunded: async (paid) => {
      const product = await readListing(store, paid.product).catch(() => null);
      await emitEvent(store, "refund.issued", `paypal:${paid.capture}`, {
        paypal_capture: paid.capture,
        paid_with: "paypal",
        product: { id: paid.product, title: product?.title ?? null },
        amount_refunded_cents: paid.cents,
        total_refunded_cents: paid.cents,
        amount_cents: paid.cents,
        fully_refunded: true,
        currency: paid.currency,
        buyer: { email: paid.email, name: null },
        refunded_at: new Date().toISOString(),
      });
    },
  });
  done.cleared += await handOverAgain(store, deadline);
  return done;
}
