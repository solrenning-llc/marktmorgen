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
 *      (`auto_advance=false`) and is read once more: a year paid meanwhile is
 *      never moved.
 *   3. The membership moves to the product's monthly price with the period
 *      starting now (`billing_cycle_anchor=now`) and no proration: the year
 *      was never paid, so none of it is credited. The API version is pinned,
 *      and every try has an idempotency key of its own, so a second try with
 *      a new card is never Stripe's saved answer to a decline.
 *   4. Declined (a `pending_update` left): the month's invoice is voided and
 *      the year retried again as before. Refused for certain (a 4xx): the
 *      same. No answer or Stripe's own failure: the move may have been made,
 *      so the year is never turned back on; it waits for the daily job
 *      (FALLBACK_CHECK_KEY), which reads the membership again.
 *   5. Moved with the month paid: the yearly invoice is voided, so it can
 *      never be paid as well. If voiding fails it waits, with no automatic
 *      retry, for the daily job (FALLBACK_VOID_KEY); if it turns out it was
 *      paid in those seconds, the month is refunded (FALLBACK_BOTH_KEY), never
 *      both kept. Moved with the month not paid yet: the year is voided only
 *      once the month is (FALLBACK_CHECK_KEY).
 *
 * The daily job behind those three lists is settleFallbacks (unit 2c,
 * lib/yearly-fallback-sweep.ts), run first by the daily recovery job. Nothing
 * offers the move to a member yet (the email and its page are the next unit).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { readListings } from "@/lib/catalog";
import { canSellProduct } from "@/lib/store-checkout";
import { productOfSub } from "@/lib/tier-rules";
import { tierPrice } from "@/lib/tier-switch";
import { withLock } from "@/lib/redis-lock";
import { type FallbackSub, type MonthlyFallback, monthlyFallback } from "@/lib/yearly-fallback-rules";
import type { Listing, Store } from "@/lib/store";

const SUB_PATTERN = /^sub_[A-Za-z0-9]{6,64}$/;
const INVOICE_PATTERN = /^in_[A-Za-z0-9]{6,64}$/;

/**
 * The API version every call here is made at, as lib/stripe-connect.ts makes its own: from 2026-09-30.endive,
 * `billing_cycle_anchor` takes an object instead of "now" (Stripe's changelog), so the version is never left to the
 * account's default.
 */
export const FALLBACK_STRIPE_VERSION = "2026-08-26.dahlia";

/**
 * Left for the daily recovery job (unit 2c), each "account|…":
 *   - VOID: a yearly invoice to void again after a paid move whose void failed, with the month's invoice that paid
 *     the move, so a year found paid meanwhile has its month refunded ("account|yearly|monthly");
 *   - CHECK: a move whose outcome is not known yet (Stripe did not answer, or it applied with the first month not
 *     paid yet): the year stays with no automatic retry until the job reads the membership again
 *     ("account|subscription|invoice");
 *   - BOTH: the year was paid while the month was charged; the month is refunded ("account|yearly|monthly").
 * The daily job is settleFallbacks (lib/yearly-fallback-sweep.ts).
 */
export const FALLBACK_VOID_KEY = "nl:yearly:fallback:void";
export const FALLBACK_CHECK_KEY = "nl:yearly:fallback:check";
export const FALLBACK_BOTH_KEY = "nl:yearly:fallback:both";
/** The same lock as a switch between plans or to yearly: one change to a membership at a time (lib/tier-switch.ts). */
export const fallbackLockKey = (subscription: string) => `nl:tier:${subscription}:lock`;
/** One try at a move counted per failed invoice, so a second try after a decline is never Stripe's saved answer to the first. */
const tryKey = (invoice: string) => `nl:yearly:fallback:try:${invoice}`;
/** Longer than every Stripe call here at its ceiling, in a row (lib/stripe-account.ts, STRIPE_TIMEOUT_MS). */
export const FALLBACK_LOCK_SECONDS = 150;

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
  | { ok: false; reason: "gone" | "fallback" | "declined" | "busy" | "unknown" | "error" };

type SubRead = FallbackSub & { id?: unknown; customer?: unknown; latest_invoice?: unknown; items?: { data?: { id?: unknown }[] } };

/** A Stripe answer that says for certain the request was refused and nothing was done. */
const refused = (error: unknown) => error instanceof StripeError && error.status >= 400 && error.status < 500;

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
  const v = FALLBACK_STRIPE_VERSION;
  try {
    // The same lock as a switch between plans or to yearly: one change to a membership at a time.
    return await withLock(fallbackLockKey(subscription), FALLBACK_LOCK_SECONDS, 5_000, async (): Promise<FallbackResult> => {
      const sub = (await onAccount("GET", account, `/subscriptions/${encodeURIComponent(subscription)}`, undefined, v)) as SubRead;
      if (sub.customer !== customer) return { ok: false, reason: "gone" };
      const invoice = await onAccount("GET", account, `/invoices/${encodeURIComponent(failedInvoice)}`, undefined, v);
      const itemId = typeof sub.items?.data?.[0]?.id === "string" ? (sub.items.data[0].id as string) : "";
      if (!itemId) return { ok: false, reason: "gone" };
      const productId = productOfSub(sub as Parameters<typeof productOfSub>[0]);
      const [product] = productId ? await readListings(store, [productId]).catch(() => [] as Listing[]) : [];
      if (!product || !canSellProduct(store, product)) return { ok: false, reason: "fallback" };
      const offer = monthlyFallback(subscription, sub, invoice, product, store.tiers, store.currency, Math.floor(Date.now() / 1000));
      if (!offer) return { ok: false, reason: "fallback" };
      const price = await tierPrice(store, product);

      // Never charged for the year while the month is; then read once more, so a year paid meanwhile is never moved.
      await onAccount("POST", account, `/invoices/${encodeURIComponent(failedInvoice)}`, new URLSearchParams({ auto_advance: "false" }), v);
      const still = await onAccount("GET", account, `/invoices/${encodeURIComponent(failedInvoice)}`, undefined, v);
      if (still.status !== "open") {
        if (still.status !== "paid") await retryYear(account, failedInvoice);
        return { ok: false, reason: "fallback" };
      }

      const [attempt] = await redisPipeline([["INCR", tryKey(failedInvoice)], ["EXPIRE", tryKey(failedInvoice), 2 * 86_400]]);
      let updated: Record<string, unknown>;
      try {
        updated = await onAccount("POST", account, `/subscriptions/${encodeURIComponent(subscription)}`, fallbackBody(itemId, price, failedInvoice), v, `fallback:${failedInvoice}:${Number(attempt) || 1}`);
      } catch (error) {
        if (refused(error)) {
          // Refused for certain: nothing was done, and the year is retried as before.
          await retryYear(account, failedInvoice);
          throw error;
        }
        // No answer, or Stripe's own failure: the move may have been made and the month charged. The year stays with
        // no automatic retry, and the daily job reads the membership again before anything else.
        await redisPipeline([["SADD", FALLBACK_CHECK_KEY, `${account}|${subscription}|${failedInvoice}`]]).catch(() => {});
        return { ok: false, reason: "unknown" };
      }
      const latest = updated.latest_invoice as { id?: unknown; status?: unknown; amount_paid?: unknown; currency?: unknown } | null;
      if (updated.pending_update) {
        // Declined: the month's invoice is voided, the year is retried as before, nothing changed.
        if (latest && typeof latest.id === "string" && latest.status === "open") {
          await onAccount("POST", account, `/invoices/${encodeURIComponent(latest.id)}/void`, new URLSearchParams(), v).catch((error) => console.error("voiding a declined monthly move failed", error));
        }
        await retryYear(account, failedInvoice);
        return { ok: false, reason: "declined" };
      }
      const paid = latest?.status === "paid";
      const result: FallbackResult = {
        ok: true,
        title: product.title,
        charged: paid && typeof latest?.amount_paid === "number" ? latest.amount_paid : 0,
        currency: typeof latest?.currency === "string" ? latest.currency : store.currency,
        offer,
        paid,
      };
      if (!paid) {
        // Applied with the first month not paid yet (a payment still processing): the year is voided only once the
        // month is, by the daily job; until then it is never retried by itself.
        await redisPipeline([["SADD", FALLBACK_CHECK_KEY, `${account}|${subscription}|${failedInvoice}`]]).catch(() => {});
        return result;
      }
      // Moved and the month paid: the year can never be paid as well.
      try {
        await onAccount("POST", account, `/invoices/${encodeURIComponent(failedInvoice)}/void`, new URLSearchParams(), v);
      } catch (error) {
        const again = await onAccount("GET", account, `/invoices/${encodeURIComponent(failedInvoice)}`, undefined, v).catch(() => null);
        if (again?.status === "paid") {
          // Paid in the seconds the month was: the month is refunded, never both kept.
          console.error("a yearly invoice was paid while the monthly move was made; the month is refunded by the daily job", error);
          await redisPipeline([["SADD", FALLBACK_BOTH_KEY, `${account}|${failedInvoice}|${String(latest?.id ?? "")}`]]).catch(() => {});
        } else if (again?.status !== "void") {
          console.error("voiding the yearly invoice after a monthly move failed; kept for the daily job", error);
          await redisPipeline([["SADD", FALLBACK_VOID_KEY, `${account}|${failedInvoice}|${String(latest?.id ?? "")}`]]).catch(() => {});
        }
      }
      return result;
    });
  } catch (error) {
    if (error instanceof Error && error.name === "LockBusyError") return { ok: false, reason: "busy" };
    if (!(error instanceof StripeError)) console.error("moving a yearly membership to monthly failed", error);
    return { ok: false, reason: "error" };
  }
}

/** The yearly invoice is retried by itself again, as before the member tried to move. */
async function retryYear(account: string, invoice: string): Promise<void> {
  await onAccount("POST", account, `/invoices/${encodeURIComponent(invoice)}`, new URLSearchParams({ auto_advance: "true" }), FALLBACK_STRIPE_VERSION).catch((error) =>
    console.error("letting a yearly invoice retry again failed", error),
  );
}
