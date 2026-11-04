/**
 * Keeping a yearly member whose renewal failed, at the same membership's
 * monthly price (630 [HN6](14), unit 2a; added 4 November 2026), on the
 * creator's own Stripe account. The rules are in lib/yearly-fallback-rules.ts;
 * the email that offers it and its page are the next unit. Nothing calls
 * this yet.
 *
 * Checked against Stripe's own documentation (Pending updates, read 4
 * November 2026, docs.stripe.com/billing/subscriptions/pending-updates):
 * `payment_behavior=pending_if_incomplete` applies a change only when the
 * invoice it makes is paid, accepts `billing_cycle_anchor` and `items`, and
 * leaves a `pending_update` on the subscription when the payment fails, whose
 * invoice is voided to cancel it. So:
 *
 *   1. Under the same lock as every other change to a membership, the
 *      subscription and the failed invoice are read again from Stripe and the
 *      rules are asked again: nothing typed or kept elsewhere decides.
 *   2. The failed yearly invoice stops being retried by itself
 *      (`auto_advance=false`), so the card is never charged for the year in
 *      the seconds while the month is.
 *   3. The membership moves to the product's monthly price with the period
 *      starting now (`billing_cycle_anchor=now`) and no proration: the year
 *      was never paid, so none of it is credited. The first month is
 *      invoiced and charged at once, and the move only happens if it is paid.
 *   4. Moved (no `pending_update` left): the yearly invoice is voided, so it
 *      can never be paid as well, even from the link in the first email; a
 *      first month still open is retried by Stripe like any monthly payment.
 *      Declined (a `pending_update` left): the month's invoice is voided, the
 *      yearly one is retried again as before, and nothing changed.
 *
 * If voiding the yearly invoice fails after the month was paid, it stays
 * with no automatic retry and is kept in a list the daily recovery job tries
 * again (FALLBACK_VOID_KEY; unit 2c), so the member is never asked for both.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { readListings } from "@/lib/catalog";
import { canSellProduct } from "@/lib/store-checkout";
import { productOfSub } from "@/lib/tier-rules";
import { tierPrice } from "@/lib/tier-switch";
import { withLock } from "@/lib/redis-lock";
import { type MonthlyFallback, monthlyFallback } from "@/lib/yearly-fallback-rules";
import type { YearlySub } from "@/lib/yearly-switch-rules";
import type { Listing, Store } from "@/lib/store";

const SUB_PATTERN = /^sub_[A-Za-z0-9]{6,64}$/;
const INVOICE_PATTERN = /^in_[A-Za-z0-9]{6,64}$/;

/** Yearly invoices left open after a paid move, voided again by the daily recovery job (unit 2c). */
export const FALLBACK_VOID_KEY = "nl:yearly:fallback:void";

/** The move itself: the product's monthly price from now, no proration, made only if the first month is paid. */
export function fallbackBody(itemId: string, monthlyPrice: string, failedInvoice: string): URLSearchParams {
  const body = new URLSearchParams({
    "items[0][id]": itemId,
    "items[0][price]": monthlyPrice,
    billing_cycle_anchor: "now",
    proration_behavior: "none",
    payment_behavior: "pending_if_incomplete",
    // As a membership bought monthly says it, and which yearly invoice it replaced.
    "metadata[every]": "month",
    "metadata[monthly_from]": "year",
    "metadata[monthly_replaced]": failedInvoice,
  });
  body.append("expand[]", "latest_invoice");
  return body;
}

export type FallbackResult =
  | { ok: true; title: string; charged: number; currency: string; offer: MonthlyFallback; paid: boolean }
  | { ok: false; reason: "gone" | "fallback" | "declined" | "busy" | "error" };

type SubRead = YearlySub & { id?: unknown; customer?: unknown; latest_invoice?: unknown; items?: { data?: { id?: unknown }[] } };

/**
 * Moves one yearly membership whose renewal `failedInvoice` did not go through
 * to its product's monthly price. `customer` is the member's own Stripe
 * customer, read from their link by the caller: a subscription of anyone else
 * is refused.
 */
export async function moveToMonthly(store: Store, customer: string, subscription: string, failedInvoice: string): Promise<FallbackResult> {
  const account = store.stripeAccountId;
  if (!account || !isRedisConfigured()) return { ok: false, reason: "error" };
  if (!SUB_PATTERN.test(subscription) || !INVOICE_PATTERN.test(failedInvoice) || !customer) return { ok: false, reason: "gone" };
  try {
    // The same lock as a switch between plans or to yearly: one change to a membership at a time.
    return await withLock(`nl:tier:${subscription}:lock`, 60, 5_000, async (): Promise<FallbackResult> => {
      const sub = (await onAccount("GET", account, `/subscriptions/${encodeURIComponent(subscription)}`)) as SubRead;
      if (sub.customer !== customer) return { ok: false, reason: "gone" };
      const invoice = await onAccount("GET", account, `/invoices/${encodeURIComponent(failedInvoice)}`);
      const itemId = typeof sub.items?.data?.[0]?.id === "string" ? (sub.items.data[0].id as string) : "";
      if (!itemId) return { ok: false, reason: "gone" };
      const productId = productOfSub(sub as Parameters<typeof productOfSub>[0]);
      const [product] = productId ? await readListings(store, [productId]).catch(() => [] as Listing[]) : [];
      if (!product || !canSellProduct(store, product)) return { ok: false, reason: "fallback" };
      const offer = monthlyFallback(subscription, sub, invoice, product, store.tiers, store.currency, Math.floor(Date.now() / 1000));
      if (!offer) return { ok: false, reason: "fallback" };
      const price = await tierPrice(store, product);

      // Never charged for the year while the month is.
      await onAccount("POST", account, `/invoices/${encodeURIComponent(failedInvoice)}`, new URLSearchParams({ auto_advance: "false" }));
      let updated: Record<string, unknown>;
      try {
        updated = await onAccount("POST", account, `/subscriptions/${encodeURIComponent(subscription)}`, fallbackBody(itemId, price, failedInvoice), undefined, `fallback:${failedInvoice}`);
      } catch (error) {
        await retryYear(account, failedInvoice);
        throw error;
      }
      const latest = updated.latest_invoice as { id?: unknown; status?: unknown; amount_paid?: unknown; currency?: unknown } | null;
      if (updated.pending_update) {
        // Declined: the month's invoice is voided, the year is retried as before, nothing changed.
        if (latest && typeof latest.id === "string" && latest.status === "open") {
          await onAccount("POST", account, `/invoices/${encodeURIComponent(latest.id)}/void`, new URLSearchParams()).catch((error) => console.error("voiding a declined monthly move failed", error));
        }
        await retryYear(account, failedInvoice);
        return { ok: false, reason: "declined" };
      }
      // Moved (Stripe applied it, so there is no pending update): the year can never be paid as well. The first month
      // is normally paid at once; one still open is retried by Stripe as any monthly payment, never voided here.
      try {
        await onAccount("POST", account, `/invoices/${encodeURIComponent(failedInvoice)}/void`, new URLSearchParams());
      } catch (error) {
        console.error("voiding the yearly invoice after a monthly move failed; kept for the daily job", error);
        await redisPipeline([["SADD", FALLBACK_VOID_KEY, `${account}|${failedInvoice}`]]).catch(() => {});
      }
      return {
        ok: true,
        title: product.title,
        charged: latest?.status === "paid" && typeof latest.amount_paid === "number" ? latest.amount_paid : 0,
        currency: typeof latest?.currency === "string" ? latest.currency : store.currency,
        offer,
        paid: latest?.status === "paid",
      };
    });
  } catch (error) {
    if (error instanceof Error && error.name === "LockBusyError") return { ok: false, reason: "busy" };
    if (!(error instanceof StripeError)) console.error("moving a yearly membership to monthly failed", error);
    return { ok: false, reason: "error" };
  }
}

/** The yearly invoice is retried by itself again, as before the member tried to move. */
async function retryYear(account: string, invoice: string): Promise<void> {
  await onAccount("POST", account, `/invoices/${encodeURIComponent(invoice)}`, new URLSearchParams({ auto_advance: "true" })).catch((error) =>
    console.error("letting a yearly invoice retry again failed", error),
  );
}
