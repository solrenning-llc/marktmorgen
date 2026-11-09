/**
 * Payments a plan took after its own end, given back (the owner's decision of 9 November 2026, item 12: "Parcela
 * cobrada depois da data final: reembolso automático, idempotente, e cancelar o que restar do agendamento. A data
 * foi prometida ao comprador.").
 *
 * The daily plans job (lib/plans.ts) gives every plan its end at Stripe. A plan it could not reach in time (its
 * account refused us, the job did not run) may have been charged past that end. Once the job ends such a plan's
 * subscription, it asks Stripe for the subscription's paid invoices created at or after the end (each one a payment
 * the buyer never agreed to) and refunds each one in full, from the creator's own account, the way a closing store's
 * refunds are made (lib/closing-refunds.ts), whose readers this reuses:
 *
 *   - never twice: each refund names its invoice in its metadata (plan_late_refund) and in its idempotency key, and
 *     before one is made Stripe is asked for the refunds already made on that payment (priorRefund);
 *   - given back only when Stripe says so: a refund that reads pending or requires_action is not money given back
 *     yet (the owner's decision 18; the reviews of #3367 at 9489992283, Claude 3 MEDIUM 2 and Claude 6 N1), so the plan
 *     stays "owed" and is read again; a payment already refunded in full is read for its refunds' states too (expanded
 *     on its charge, or read by its payment intent), and settles only when none is still pending. One that fails later
 *     no longer counts in the charge's amount refunded, so it is made again;
 *   - one refusal blocks nothing else: Stripe refusing one payment's refund for good (a 4xx such as
 *     charge_expired_for_refund, Claude 3 MEDIUM 1) leaves that payment owed, named in `short` for its creator, and
 *     the others are still given back in the same try;
 *   - never on a disputed payment: the buyer's bank already gives it back;
 *   - never paid by the platform: the account's available balance, read first, must cover it (available,
 *     settledCost), and is counted off as it goes; one it does not cover is not attempted, and the plan is tried
 *     again ("owed");
 *   - read exactly: a list that is not whole, an invoice or charge that does not read, a refund's reply that is not
 *     this payment's refund in one of Stripe's own states throws, so the plan is not settled and nothing is sent on a
 *     guess; the next pass reads what Stripe made under the same mark.
 *
 * Read at API version AT, where an invoice names its `charge`, which the list expands with its balance transaction,
 * so one call reads every payment's dispute, amount, refunds and settlement currency (docs.stripe.com/api/invoices/list:
 * `subscription`, `status`, `created[gte]`, `limit` up to 100; docs.stripe.com/api/refunds/create; read 09/11/2026).
 * Bounded: one list, one balance and, for at most LATE_REFUNDS_PER_TRY payments, the refunds read and, for one still to
 * give back, the refund itself (PLAN_SETTLE_RUN in tests/plan-cost-registry.ts); more wait for the next pass.
 */
import { StripeError, onAccount } from "@/lib/stripe-account";
import { available, priorRefund, refundState, settledCost } from "@/lib/closing-refunds";

const AT = "2024-06-20";
/** The most late payments one try gives back (two calls each), the rest left for the next pass. */
export const LATE_REFUNDS_PER_TRY = 3;
/** Stripe calls one try of a plan's late payments makes at the most: the list, the balance, and two a payment. */
export const LATE_REFUND_CALLS = 2 + 2 * LATE_REFUNDS_PER_TRY;
/** The metadata key a late payment's refund names its invoice under. */
export const LATE_MARK = "plan_late_refund";
/** The idempotency key of a late payment's refund: one per invoice, whatever pass makes it. */
export const lateRefundKey = (invoice: string): string => `plan-late-refund:${invoice}`;

const INVOICE_ID = /^in_[A-Za-z0-9]{6,128}$/;
const CHARGE_ID = /^(ch|py)_[A-Za-z0-9]{6,128}$/;
const INTENT_ID = /^pi_[A-Za-z0-9]{6,64}$/;
const CURRENCY = /^[a-z]{3}$/;
type Row = Record<string, unknown>;
const objectOf = (value: unknown): Row | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null);
const idOf = (value: unknown): unknown => (value !== null && typeof value === "object" ? (value as { id?: unknown }).id : value);
const whole = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** One late payment still to give back. */
type Owed = { invoice: string; intent: string; currency: string; give: number; charge: Row; paid: Given };
/** One late payment refunded in full whose refunds' states are still to be read by its payment intent. */
type Check = { intent: string; paid: Given };
/**
 * A late payment given back in full (by a refund made here, now or before, or already refunded at Stripe), for the
 * buyer's email (lib/plan-late-notice.ts): its invoice, the address Stripe holds on it (null when none reads), the
 * amount taken, its currency and when it was taken (seconds).
 */
export type Given = { invoice: string; email: string | null; amount: number; currency: string; paidAt: number };
/** What one try did: see refundLatePayments. */
export type LateOutcome = { state: "done" | "owed"; refunded: number; disputed: number; given: Given[]; short: string[] };

/**
 * Whether every refund of a payment reads succeeded (or failed or canceled, which give nothing back and are no longer
 * in the charge's amount refunded): "done"; "pending" when one is still pending or requires action; "unknown" when
 * the list is not whole or a row does not read as this payment's refund in one of Stripe's own states.
 */
export function refundsSettled(list: unknown, intent: string): "done" | "pending" | "unknown" {
  const read = objectOf(list);
  if (!read || read.object !== "list" || !Array.isArray(read.data) || read.has_more !== false) return "unknown";
  let pending = false;
  for (const item of read.data) {
    const row = objectOf(item);
    if (!row || row.object !== "refund" || typeof row.id !== "string" || idOf(row.payment_intent) !== intent) return "unknown";
    if (row.status === "pending" || row.status === "requires_action") pending = true;
    else if (row.status !== "succeeded" && row.status !== "failed" && row.status !== "canceled") return "unknown";
  }
  return pending ? "pending" : "done";
}

/** A refusal of the refund itself, for good: a 4xx that is not the account's (401, 403) nor too many requests (429). */
const refusedForGood = (error: unknown): error is StripeError =>
  error instanceof StripeError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 403 && error.status !== 429;

/**
 * "done": every payment taken at or after `end` is given back (or disputed, or had nothing left to give);
 * "owed": one is still to be given back (the balance did not cover it, Stripe refused it, or more than one try
 * reaches), so the plan is tried again. `given` lists the late payments refunded in full, whoever refunded them and
 * whenever, for the buyer's email; `short` names the invoices this try could not give back because the balance did
 * not cover them or Stripe refused the refund (what only the creator can put right), never those merely left for the
 * next try. Anything that does not read throws.
 */
export async function refundLatePayments(account: string, subscription: string, end: number): Promise<LateOutcome> {
  const query = new URLSearchParams({ subscription, status: "paid", "created[gte]": String(end), limit: "100" });
  query.append("expand[]", "data.charge.balance_transaction");
  // Its refunds too, so a payment refunded in full is known settled (every refund succeeded) without a read of its own.
  query.append("expand[]", "data.charge.refunds");
  const list = objectOf(await onAccount("GET", account, `/invoices?${query}`, undefined, AT));
  if (!list || list.object !== "list" || !Array.isArray(list.data) || list.has_more !== false) throw new Error("a plan's late invoices could not be read whole");
  const owed: Owed[] = [];
  const checks: Check[] = [];
  const given: Given[] = [];
  const short: string[] = [];
  let disputed = 0;
  let left = false;
  for (const item of list.data) {
    const row = objectOf(item);
    if (!row || row.object !== "invoice" || typeof row.id !== "string" || !INVOICE_ID.test(row.id)) throw new Error("a plan's invoice did not read");
    if (idOf(row.subscription) !== subscription || row.status !== "paid" || !whole(row.created) || !whole(row.amount_paid)) throw new Error("a plan's invoice did not read as this subscription's paid one");
    // Inside the plan's term: agreed, never given back, whatever the list holds.
    if (row.created < end || row.amount_paid === 0) continue;
    if (row.paid_out_of_band === true) {
      // Marked paid outside Stripe by the creator: nothing went through Stripe to give back from here.
      console.error("a plan's payment after its end was marked paid outside Stripe; not refunded from here", row.id);
      continue;
    }
    const charge = objectOf(row.charge);
    if (!charge || typeof charge.id !== "string" || !CHARGE_ID.test(charge.id)) throw new Error("a plan's late payment's charge did not read");
    if (Object.hasOwn(charge, "invoice") && charge.invoice !== null && idOf(charge.invoice) !== row.id) throw new Error("a plan's late invoice answered with another invoice's charge");
    const intent = idOf(charge.payment_intent);
    if (typeof intent !== "string" || !INTENT_ID.test(intent)) throw new Error("a plan's late payment did not name its payment intent");
    if (typeof charge.disputed !== "boolean" || !whole(charge.amount) || charge.amount === 0 || !whole(charge.amount_refunded) || charge.amount_refunded > charge.amount) {
      throw new Error("a plan's late payment's charge did not read");
    }
    if (typeof charge.currency !== "string" || !CURRENCY.test(charge.currency)) throw new Error("a plan's late payment's currency did not read");
    // Disputed: the bank gives it back; never a second time from here.
    if (charge.disputed) {
      disputed += 1;
      continue;
    }
    const email = typeof row.customer_email === "string" ? row.customer_email : null;
    const paid: Given = { invoice: row.id, email, amount: charge.amount, currency: charge.currency, paidAt: row.created };
    const give = charge.amount - charge.amount_refunded;
    if (give > 0) {
      owed.push({ invoice: row.id, intent, currency: charge.currency, give, charge, paid });
      continue;
    }
    // Refunded in full: given back only once no refund of it is still pending. Its refunds expanded on the charge
    // decide here; when they are not (or not whole), they are read by its payment intent below.
    const settled = Object.hasOwn(charge, "refunds") ? refundsSettled(charge.refunds, intent) : "unknown";
    if (settled === "done") given.push(paid);
    else if (settled === "pending") left = true;
    else checks.push({ intent, paid });
  }
  if (!owed.length && !checks.length) return { state: left ? "owed" : "done", refunded: 0, disputed, given, short };
  // At most LATE_REFUNDS_PER_TRY payments a try, those still to give back first; a payment refunded in full whose
  // refunds are read here takes one of those places (one call, where one to give back takes two).
  const slots = LATE_REFUNDS_PER_TRY;
  if (owed.length + checks.length > slots) left = true;
  for (const one of checks.slice(0, Math.max(0, slots - owed.length))) {
    const read = refundsSettled(await onAccount("GET", account, `/refunds?${new URLSearchParams({ payment_intent: one.intent, limit: "100" })}`, undefined, AT), one.intent);
    if (read === "unknown") throw new Error("the refunds of a plan's late payment could not be read whole");
    if (read === "done") given.push(one.paid);
    else left = true;
  }
  if (!owed.length) return { state: left ? "owed" : "done", refunded: 0, disputed, given, short };
  const funds = await available(account);
  let refunded = 0;
  for (const one of owed.slice(0, slots)) {
    const made = await onAccount("GET", account, `/refunds?${new URLSearchParams({ payment_intent: one.intent, limit: "100" })}`, undefined, AT);
    const prior = priorRefund(made, one.intent, one.invoice, one.currency, LATE_MARK);
    if (prior === "unknown") throw new Error("the refunds already made for a plan's late payment could not be read whole");
    // Made here before: never a second. Given back once it reads succeeded; while pending at Stripe, read again.
    if (prior) {
      if (prior.state === "done") given.push(one.paid);
      else left = true;
      continue;
    }
    const cost = settledCost(one.give, one.charge);
    if ((funds.get(cost.cur) ?? 0) < cost.amount) {
      left = true;
      short.push(one.invoice);
      continue;
    }
    let refund: Record<string, unknown>;
    try {
      refund = await onAccount(
        "POST",
        account,
        "/refunds",
        new URLSearchParams({ payment_intent: one.intent, amount: String(one.give), [`metadata[${LATE_MARK}]`]: one.invoice, "metadata[plan_subscription]": subscription }),
        AT,
        lateRefundKey(one.invoice),
      );
    } catch (error) {
      if (error instanceof StripeError && error.code === "balance_insufficient") {
        left = true;
        short.push(one.invoice);
        continue;
      }
      if (error instanceof StripeError && (error.code === "charge_disputed" || error.code === "refund_disputed_payment")) {
        disputed += 1;
        continue;
      }
      if (error instanceof StripeError && error.code === "charge_already_refunded") {
        // Its refunds are read on the next pass, as any payment refunded in full is.
        left = true;
        continue;
      }
      if (refusedForGood(error)) {
        // Refused for good (charge_expired_for_refund, say): this payment stays owed, its creator told after
        // PLAN_OWED_TELL_DAYS (lib/plans.ts), and the others are still given back.
        console.error(`a plan's late refund was refused by Stripe (${error.code || error.status}); left owed`, one.invoice);
        left = true;
        short.push(one.invoice);
        continue;
      }
      throw error;
    }
    // Read exactly: only this payment's refund, for this amount, in one of Stripe's own states, counts. Anything else
    // throws; the next pass reads the refund made under this invoice's mark, and the same key answers with it.
    const state = refundState(refund, one.intent, one.give, one.currency);
    if (state === "unknown") throw new Error("a plan's late refund's answer was not this payment's refund");
    if (state === "failed") {
      // Refused by Stripe (a closed card, say): nothing was given back; tried again on the next pass.
      console.error("a plan's late refund was refused by Stripe; tried again", one.invoice);
      left = true;
      short.push(one.invoice);
      continue;
    }
    funds.set(cost.cur, (funds.get(cost.cur) ?? 0) - cost.amount);
    refunded += 1;
    // Pending (or requiring action) at Stripe: not given back yet; the plan is read again until it succeeds.
    if (state === "done") given.push(one.paid);
    else left = true;
  }
  return { state: left ? "owed" : "done", refunded, disputed, given, short };
}
