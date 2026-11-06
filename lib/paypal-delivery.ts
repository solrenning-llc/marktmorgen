/**
 * Hands over what a PayPal payment bought (lib/paypal-sales.ts) with the same
 * pieces a Stripe sale uses: the store's sender and address, the course
 * dated from the payment, and a signed link to the list of purchases. And,
 * as for a Stripe sale (added 13 October 2026), the affiliate and partners
 * credited, and the store's webhooks told: "sale.completed" with
 * `paid_with: "paypal"`, and "refund.issued" when PayPal refunds it in full.
 */
import { ordersLinkFor } from "@/lib/buyer-orders";
import { readListing } from "@/lib/catalog";
import { dropEnrollment, recordEnrollment } from "@/lib/learn";
import { type Paid, deliverPayPal, watchPayPal } from "@/lib/paypal-sales";
import { fromStore, storeBase } from "@/lib/purchase-email";
import type { Store } from "@/lib/store";
import { creditPayPalSale } from "@/lib/affiliates";
import { emitEvent } from "@/lib/webhooks";

/** Gives the buyer what they paid for and emails the receipt. False when the product is gone. */
export async function handOverPayPal(store: Store, paid: Paid): Promise<boolean> {
  const product = await readListing(store, paid.product);
  if (!product) {
    console.error("a PayPal purchase named a product the store no longer has", store.handle, paid.order);
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
      const course = productId === product.id ? product : await readListing(store, productId);
      if (course?.course) await recordEnrollment(store, email, productId, start);
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
  return true;
}

/** The checkout sweep's PayPal part for one store: pending payments cleared, refunds taken back. */
export function sweepPayPal(store: Store, deadline: number): Promise<{ cleared: number; revoked: number }> {
  return watchPayPal(store, deadline, {
    handOver: async (paid) => {
      await handOverPayPal(store, paid);
    },
    dropStart: (email, productId) => dropEnrollment(store, email, productId),
    // A course put back for a payment that keeps the purchase (Codex G's M1 on #2791): HSETNX, so nothing for one
    // still there, and no email; only for a product that is a course, as handing over does.
    restoreStart: async (email, productId, start) => {
      const course = await readListing(store, productId);
      if (course?.course) await recordEnrollment(store, email, productId, start);
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
}
