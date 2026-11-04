/**
 * What a store's plan refund would be today, read from our own Stripe
 * account (305 [SY1] unit 1). Read-only: it asks Stripe and answers with the
 * amount the rules in lib/plan-refund-rules.ts give, and which payment it is
 * for. It writes nothing anywhere, and nothing calls it yet; the button, its
 * review page and the refund itself come in the next units.
 *
 * Which payment is looked at (app/refunds/page.tsx, sections 2, 3 and 5):
 *   - the guarantee is for "the first charge we make to you, on any plan,
 *     monthly or yearly, for any of your stores", once per person. So the
 *     first payment is the oldest succeeded charge of this store's customer,
 *     and only when no earlier succeeded charge exists for the same person:
 *     another of our customers with the same email address (the store's or
 *     the customer's), or the same card (Stripe's card fingerprint). It is
 *     this store's only when it paid one of this store's plan invoices;
 *   - otherwise the store's latest paid plan invoice, for a yearly plan's
 *     months not started (a monthly renewal gives nothing).
 *
 * Never a silent no: whatever cannot be read or decided whole (a list longer
 * than one page, more same-address customers than MAX_OTHER_CUSTOMERS, a
 * failed request, the time or request budget spent) answers "unknown", for
 * the page to send the creator to support instead of showing a button that
 * would fail or hiding one the policy promises.
 *
 * Bounded: at most MAX_CALLS requests to Stripe and READ_BUDGET_MS in all.
 * Stripe's search can lag "under 1 minute" behind a new charge
 * (docs.stripe.com/search, "Data freshness", read 31/10/2026); it is used
 * only for charges older than the one being judged. Query fields read on the
 * same page: customers by `email`, charges by
 * `payment_method_details.card.fingerprint`, `status` and `created`.
 * Lists read: GET /v1/charges (customer, newest first, limit up to 100,
 * docs.stripe.com/api/charges/list), GET /v1/disputes (charge,
 * docs.stripe.com/api/disputes/list), both read 31/10/2026; GET
 * /v1/invoices by subscription and status as lib/closing-plan-guard.ts does.
 * Every read is at API version AT, where an invoice names its `charge` and
 * `tax` and a charge names its `invoice`.
 */
import { normaliseEmail } from "@/lib/auth";
import { customerOf, isAddOn, isBillingConfigured, onPlatformAt, ownedBy, planOf } from "@/lib/billing";
import { LEGACY_PLAN_PRICES, PLAN_PRICES, PRICES_WITH_COMMISSION, PRICES_WITHOUT_COMMISSION, REFUND_DAYS } from "@/lib/plan";
import { type PlanRefund, type PlanRefundCharge, planRefund } from "@/lib/plan-refund-rules";
import { CUSTOMER_PATTERN, SUBSCRIPTION_PATTERN, type Store } from "@/lib/store";

const AT = "2024-06-20";
/** The most requests to Stripe one reading makes. */
export const MAX_CALLS = 18;
/** The most other customers with the same address whose charges are read. */
export const MAX_OTHER_CUSTOMERS = 5;
/** The whole reading's time, in milliseconds. */
export const READ_BUDGET_MS = 25_000;
const DAY_SECONDS = 86_400;
const CHARGE_ID = /^(ch|py)_[A-Za-z0-9]{6,128}$/;
const INVOICE_ID = /^in_[A-Za-z0-9]{6,128}$/;
const INTENT_ID = /^pi_[A-Za-z0-9]{6,128}$/;

/** One payment the refund gives back: its charge, the amount for it, and when it was paid (seconds). */
export type PlanRefundPart = { chargeId: string; paymentIntent: string; invoiceId: string; cents: number; paidAtSeconds: number };
export type PlanRefundFound = {
  /** `cents` is the whole refund: the sum of `parts`. */
  refund: Extract<PlanRefund, { kind: "guarantee" | "unstarted_months" }>;
  /** The first part's charge (the payment the refund is for, or the first of them). */
  chargeId: string;
  paymentIntent: string;
  invoiceId: string;
  currency: string;
  /**
   * Every payment given back, oldest first. Under the guarantee, the first payment and every plan payment made since
   * within REFUND_DAYS of it (the owner's decision of 31/10/2026 15h41); otherwise the one payment.
   */
  parts: PlanRefundPart[];
};
/** The most payments one guarantee gives back (a month's renewal and a few plan switches inside the window). */
export const MAX_PARTS = 6;
export type PlanRefundReading =
  | PlanRefundFound
  | { refund: Extract<PlanRefund, { kind: "none" | "unknown" }> }
  | { refund: { kind: "none"; reason: "no_plan_payment" | "guarantee_used" } }
  | { refund: { kind: "unknown"; reason: "stripe_unread" | "too_many" | "not_this_store" | "customer_credit" } };

type Row = Record<string, unknown>;
const obj = (v: unknown): Row | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null);
const idOf = (v: unknown): string => (typeof v === "string" ? v : typeof obj(v)?.id === "string" ? String(obj(v)!.id) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number.NaN);

class Spent extends Error {}

/** The plan's monthly price when a yearly price of `unitCents` was charged, from every list ever published; null if none or not one answer. */
export function monthlyForYearly(unitCents: number): number | null {
  const lists = [PLAN_PRICES, PRICES_WITHOUT_COMMISSION, PRICES_WITH_COMMISSION, ...LEGACY_PLAN_PRICES];
  const found = new Set<number>();
  for (const list of lists) for (const tier of Object.keys(list) as (keyof typeof list)[]) if (list[tier].year === unitCents) found.add(list[tier].month);
  return found.size === 1 ? [...found][0] : null;
}

export async function readPlanRefund(store: Store, nowSeconds = Math.floor(Date.now() / 1000)): Promise<PlanRefundReading> {
  if (!isBillingConfigured()) return { refund: { kind: "unknown", reason: "stripe_unread" } };
  const subscriptionId = store.subscriptionId ?? "";
  if (!SUBSCRIPTION_PATTERN.test(subscriptionId) || !CUSTOMER_PATTERN.test(store.stripeCustomerId ?? "")) return { refund: { kind: "none", reason: "no_plan_payment" } };
  // Known already from the daily reading of disputes: no request needed.
  if ((store.planDisputes ?? []).some((d) => d.status === "open")) return { refund: { kind: "none", reason: "dispute_open" } };

  const deadline = Date.now() + READ_BUDGET_MS;
  let calls = 0;
  const get = async (path: string): Promise<Row> => {
    calls += 1;
    if (calls > MAX_CALLS || Date.now() > deadline) throw new Spent();
    return onPlatformAt(AT, "GET", path);
  };
  const list = (page: Row): Row[] => (Array.isArray(page.data) ? (page.data as unknown[]).map(obj).filter((r): r is Row => r !== null) : []);

  try {
    const sub = await get(`/subscriptions/${encodeURIComponent(subscriptionId)}?expand[]=customer`);
    if (sub.id !== subscriptionId || isAddOn(sub) || !ownedBy(store, sub)) return { refund: { kind: "unknown", reason: "not_this_store" } };
    const customer = customerOf(sub);
    if (!CUSTOMER_PATTERN.test(customer.id)) return { refund: { kind: "unknown", reason: "not_this_store" } };
    // A credit on the customer's balance (negative), left by a downgrade's proration (lib/billing.ts switches with
    // "always_invoice") or given by hand, pays later invoices: refunding the whole payment on top of it would give back
    // more than was paid. Not decided here, for support to settle. An amount owed (positive) changes nothing.
    const balance = obj(sub.customer)?.balance;
    if (typeof balance !== "number" || !Number.isSafeInteger(balance)) return { refund: { kind: "unknown", reason: "unreadable" } };
    if (balance < 0) return { refund: { kind: "unknown", reason: "customer_credit" } };

    const paidPage = await get(`/invoices?${new URLSearchParams({ subscription: subscriptionId, status: "paid", limit: "100" })}`);
    // A trial's invoice is paid with no charge: not a payment.
    const paid = list(paidPage).filter((r) => idOf(r.subscription) === subscriptionId && idOf(r.charge) !== "");
    if (!paid.length) return { refund: { kind: "none", reason: "no_plan_payment" } };

    /** Reads an invoice's charge and judges it by the rules. */
    const judge = async (invoice: Row, firstPayment: boolean): Promise<PlanRefundReading> => {
      const invoiceId = idOf(invoice.id);
      const chargeId = idOf(invoice.charge);
      if (!INVOICE_ID.test(invoiceId) || !CHARGE_ID.test(chargeId)) return { refund: { kind: "unknown", reason: "unreadable" } };
      const charge = await get(`/charges/${encodeURIComponent(chargeId)}?expand[]=balance_transaction`);
      if (charge.id !== chargeId || idOf(charge.invoice) !== invoiceId || idOf(charge.customer) !== customer.id) return { refund: { kind: "unknown", reason: "unreadable" } };
      let disputeStatus: string | null = null;
      let disputedCents: number | null = null;
      if (charge.disputed === true) {
        const disputes = list(await get(`/disputes?${new URLSearchParams({ charge: chargeId, limit: "10" })}`));
        // More than one, or none listed although the charge says disputed: not decided here.
        if (disputes.length !== 1) return { refund: { kind: "unknown", reason: "unreadable" } };
        disputeStatus = typeof disputes[0].status === "string" ? disputes[0].status : "unknown";
        disputedCents = num(disputes[0].amount);
      }
      const lines = list(obj(invoice.lines) ?? {});
      const line = lines.find((l) => l.type === "subscription");
      const price = obj(line?.price);
      const interval = obj(price?.recurring)?.interval;
      const cycle = interval === "year" ? "year" : interval === "month" ? "month" : planOf(sub).cycle;
      const fee = obj(charge.balance_transaction);
      const paidAt = num(obj(invoice.status_transitions)?.paid_at);
      const input: PlanRefundCharge = {
        currency: typeof charge.currency === "string" ? charge.currency : "",
        succeeded: charge.status === "succeeded" && charge.paid === true,
        amountCents: num(charge.amount_captured),
        invoiceTotalCents: num(invoice.total),
        billingReason: typeof invoice.billing_reason === "string" ? invoice.billing_reason : "",
        refundedCents: num(charge.amount_refunded),
        taxCents: invoice.tax === null || invoice.tax === undefined ? 0 : num(invoice.tax),
        feeCents: fee ? num(fee.fee) : null,
        feeCurrency: fee && typeof fee.currency === "string" ? fee.currency : null,
        paidAtSeconds: Number.isFinite(paidAt) ? paidAt : num(charge.created),
        disputeStatus,
        disputedCents,
      };
      const refund = planRefund({
        cycle,
        firstPayment,
        periodStartSeconds: num(obj(line?.period)?.start),
        monthlyCents: cycle === "year" && Number.isSafeInteger(price?.unit_amount) ? monthlyForYearly(price!.unit_amount as number) : null,
        monthlyCurrency: typeof price?.currency === "string" ? price.currency : undefined,
        nowSeconds,
        charge: input,
      });
      if (refund.kind !== "guarantee" && refund.kind !== "unstarted_months") return { refund };
      const paymentIntent = idOf(charge.payment_intent);
      if (!INTENT_ID.test(paymentIntent)) return { refund: { kind: "unknown", reason: "unreadable" } };
      return { refund, chargeId, paymentIntent, invoiceId, currency: input.currency, parts: [{ chargeId, paymentIntent, invoiceId, cents: refund.cents, paidAtSeconds: input.paidAtSeconds }] };
    };

    // The customer's first succeeded charge, if the list shows them all.
    const chargesPage = await get(`/charges?${new URLSearchParams({ customer: customer.id, limit: "100" })}`);
    const succeeded = list(chargesPage).filter((c) => c.status === "succeeded" && c.paid === true && Number.isFinite(num(c.created)));
    const windowStart = nowSeconds - REFUND_DAYS * DAY_SECONDS;
    const oldestListed = succeeded.reduce<Row | null>((a, c) => (!a || num(c.created) < num(a.created) ? c : a), null);
    let first: Row | null = null;
    if (chargesPage.has_more === true) {
      // Over a page: every charge not listed is older than the oldest listed, of any status (a page of declined charges
      // holds no succeeded one, and the first payment may be on the next page). Inside the window if that one is.
      const listedTimes = list(chargesPage).map((c) => num(c.created));
      if (!listedTimes.length || listedTimes.some((t) => !Number.isFinite(t)) || Math.min(...listedTimes) >= windowStart) {
        return { refund: { kind: "unknown", reason: "too_many" } };
      }
      // A succeeded charge inside the window may be the first payment, or there may be one before it on a page not
      // read: whether the guarantee applies cannot be told, never a silent no.
      // A succeeded charge already listed from before the window settles it: the one inside is not the first payment.
      if (succeeded.some((c) => num(c.created) >= windowStart) && !succeeded.some((c) => num(c.created) < windowStart)) {
        return { refund: { kind: "unknown", reason: "too_many" } };
      }
    } else if (chargesPage.has_more === false) first = oldestListed;
    else return { refund: { kind: "unknown", reason: "unreadable" } };

    let personPaidBefore = false;
    if (first && num(first.created) >= windowStart) {
      const before = num(first.created);
      // The same person: another customer with the same address…
      const emails = [...new Set([customer.email, store.email].filter(Boolean).map((e) => normaliseEmail(e)))];
      const others = new Set<string>();
      for (const email of emails) {
        const found = await get(`/customers/search?${new URLSearchParams({ query: `email:"${email.replace(/["\\]/g, "")}"`, limit: "100" })}`);
        if (found.has_more === true) return { refund: { kind: "unknown", reason: "too_many" } };
        for (const c of list(found)) if (typeof c.email === "string" && normaliseEmail(c.email) === email && idOf(c.id) !== customer.id) others.add(idOf(c.id));
      }
      if (others.size > MAX_OTHER_CUSTOMERS) return { refund: { kind: "unknown", reason: "too_many" } };
      for (const other of others) {
        if (!CUSTOMER_PATTERN.test(other)) return { refund: { kind: "unknown", reason: "unreadable" } };
        const page = await get(`/charges?${new URLSearchParams({ customer: other, "created[lt]": String(before), limit: "100" })}`);
        if (list(page).some((c) => c.status === "succeeded" && c.paid === true)) personPaidBefore = true;
        else if (page.has_more === true) return { refund: { kind: "unknown", reason: "too_many" } };
      }
      // …or the same card.
      const fingerprint = obj(obj(first.payment_method_details)?.card)?.fingerprint;
      if (!personPaidBefore && typeof fingerprint === "string" && /^[A-Za-z0-9]{4,64}$/.test(fingerprint)) {
        const found = await get(`/charges/search?${new URLSearchParams({ query: `payment_method_details.card.fingerprint:"${fingerprint}" AND status:"succeeded" AND created<${before}`, limit: "10" })}`);
        if (list(found).some((c) => idOf(c.id) !== idOf(first!.id) && num(c.created) < before)) personPaidBefore = true;
      }
      if (!personPaidBefore) {
        const invoiceId = idOf(first.invoice);
        const own = paid.find((r) => idOf(r.id) === invoiceId);
        if (own) {
          // The guarantee covers the first payment and every plan payment of this subscription made since: asked
          // within REFUND_DAYS of the first, each of them is inside the window too (owner, 31/10/2026 15h41).
          const firstPaid = num(obj(own.status_transitions)?.paid_at);
          // Only while the first payment's window is open (the rule's own measure, lib/plan-refund-rules.ts): asked later,
          // a renewal is never judged as a first payment.
          const windowOpen = nowSeconds <= firstPaid + REFUND_DAYS * DAY_SECONDS;
          // A paid invoice whose time cannot be read is never left out silently: less would be refunded and the plan
          // still ended (independent review, 31/10/2026); the whole is then not decided here.
          if (windowOpen && paid.some((r) => r !== own && !Number.isFinite(num(obj(r.status_transitions)?.paid_at)))) return { refund: { kind: "unknown", reason: "unreadable" } };
          const since = windowOpen ? paid.filter((r) => r === own || num(obj(r.status_transitions)?.paid_at) >= firstPaid) : [own];
          if (!Number.isFinite(firstPaid) || since.length > MAX_PARTS) return { refund: { kind: "unknown", reason: "too_many" } };
          const parts: PlanRefundPart[] = [];
          let main: PlanRefundFound | null = null;
          let ownReading: PlanRefundReading | null = null;
          for (const invoice of since) {
            const reading = await judge(invoice, true);
            if (invoice === own) ownReading = reading;
            // Not decidable for one of them: not decided for the whole, never a part of it given silently.
            if (reading.refund.kind === "unknown") return reading;
            if (reading.refund.kind !== "guarantee" || !("parts" in reading)) continue;
            if (main && reading.currency !== main.currency) return { refund: { kind: "unknown", reason: "unreadable" } };
            main ??= reading;
            parts.push(...reading.parts);
          }
          if (main && parts.length) {
            parts.sort((a, b) => a.paidAtSeconds - b.paidAtSeconds);
            const cents = parts.reduce((sum, part) => sum + part.cents, 0);
            const head = parts[0];
            return { ...main, refund: { kind: "guarantee", cents }, chargeId: head.chargeId, paymentIntent: head.paymentIntent, invoiceId: head.invoiceId, parts };
          }
          // Nothing given under the guarantee (refunded already, a dispute): the first payment's answer, as before,
          // goes on to the latest payment.
          if (ownReading && ownReading.refund.kind !== "none") return ownReading;
        } else if (paidPage.has_more === true) return { refund: { kind: "unknown", reason: "too_many" } };
        else {
          // Another store's, or the add-on's: the guarantee is there, not here. But one of this store's
          // own earlier plans (started again since) is this store's: not decided here, never a silent no.
          if (!INVOICE_ID.test(invoiceId)) return { refund: { kind: "unknown", reason: "unreadable" } };
          const earlier = await get(`/invoices/${encodeURIComponent(invoiceId)}?expand[]=subscription`);
          const named = obj(obj(earlier.subscription)?.metadata)?.store;
          const handles = new Set([store.handle, ...store.previousHandles]);
          if (typeof named === "string" && handles.has(named)) return { refund: { kind: "unknown", reason: "not_this_store" } };
        }
      }
    }

    const latestIsFirst = first !== null && idOf(first.invoice) === idOf(paid[0].id);
    const latest = await judge(paid[0], latestIsFirst && !personPaidBefore);
    // This store's first payment, inside the window, not given because the same person had paid before.
    if (personPaidBefore && latestIsFirst && latest.refund.kind === "none" && (latest.refund.reason === "renewal" || latest.refund.reason === "outside_window")) {
      return { refund: { kind: "none", reason: "guarantee_used" } };
    }
    return latest;
  } catch (error) {
    if (!(error instanceof Spent)) console.error("reading a plan refund from Stripe failed", error);
    return { refund: { kind: "unknown", reason: "stripe_unread" } };
  }
}
