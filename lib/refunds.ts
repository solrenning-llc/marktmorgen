/**
 * What a refund takes back, decided in one place.
 *
 * A buyer who is refunded in full has been given their money back, and what
 * they bought closes for them the same way everywhere Marktmorgen hands it over:
 *
 *   - the download on the thanks page, and the emailed link to it, stop
 *     working on the next request (lib/store-checkout.ts, readOrder, which
 *     reads the payment from Stripe every time);
 *   - the list of purchases leaves it off (lib/buyer-orders.ts);
 *   - the course closes within ten minutes, the time Stripe's answer about a
 *     student is kept (lib/learn.ts);
 *   - the community closes within five, for the same reason
 *     (lib/community-access.ts);
 *   - a license key given for it is marked revoked by the five-minute job,
 *     which reads the refunds made on the creator's account
 *     (lib/licence-keys.ts, revokeRefunded), so the creator's own software
 *     hears "revoked" from the public check.
 *
 * The rule is the same for all of them: the payment was refunded in full,
 * as Stripe says on the charge, or the bank took it back for good, a dispute
 * Stripe closed as lost (queue 388 [TB14], F38; audit MM-SA-18). A buyer who
 * won a chargeback has their money back exactly as a refunded one has, so
 * the same doors close, after the same delays as above (the jobs that revoke
 * keys, end call meetings and mark reviews read the disputes closed since
 * their last run, as they read refunds). A dispute still open (needs_response,
 * under_review, the warning_ stages) or won by the creator closes nothing:
 * only the final "lost" does. A partial refund keeps access, because the
 * creator chose to keep part of the price, and the buyer keeps what it paid
 * for; a dispute lost for less than the charge (with what was refunded) is
 * read the same way, as a partial refund.
 *
 * On the current API Stripe does not send a charge's dispute with it, so
 * refundedInFull() alone sees refunds only. Disputes are seen only through
 * disputeLost() and what is built on it: givenBack(), keptUnlessLost(),
 * purchaseRefunded(), and the jobs' lostDisputesSince(). Doors still judged
 * on refunds only (queue 388): a booking's own row in lib/calls.ts
 * (callFromRow, reserved by another lane), and the jobs that take back
 * gifts (lib/gifts.ts), group places (lib/group-buy.ts) and pre-orders
 * already handed over (lib/preorders.ts, revokeRefundedPreorders). A payment added in one click after checkout is its own payment and
 * is judged on its own; a product ticked at checkout is part of the
 * checkout's payment and goes with it.
 *
 * What a refund cannot take back: a file already saved, and a product
 * delivered as a link to somewhere else — once the buyer has the address,
 * only the creator can close it there.
 */
import { onAccount } from "@/lib/stripe-account";

type ChargeLike = {
  id?: unknown;
  refunded?: unknown;
  amount?: unknown;
  amount_refunded?: unknown;
  disputed?: unknown;
  /**
   * Never sent by Stripe on the current API, and not expandable: written
   * here only by lostDisputesSince() from a lost dispute it read, so
   * refundedInFull() on a charge Stripe sent says nothing about disputes.
   */
  dispute?: unknown;
};

/**
 * Whether what was lost to disputes, with what was refunded, covers the
 * whole charge. A lost amount Stripe did not give counts as the whole.
 */
function coversCharge(charge: ChargeLike, lost: number | null): boolean {
  const amount = typeof charge.amount === "number" ? charge.amount : 0;
  if (lost === null || amount <= 0) return true;
  const back = typeof charge.amount_refunded === "number" ? charge.amount_refunded : 0;
  return lost + back >= amount;
}

/** A dispute lost for the whole charge, as lostDisputesSince() writes it on the charge. */
function lostOnCharge(charge: ChargeLike): boolean {
  const dispute = charge.dispute as { status?: unknown; amount?: unknown } | null | undefined;
  if (charge.disputed !== true || !dispute || typeof dispute !== "object" || dispute.status !== "lost") return false;
  return coversCharge(charge, typeof dispute.amount === "number" ? dispute.amount : null);
}

function chargeRefunded(charge: ChargeLike): boolean {
  if (charge.refunded === true) return true;
  if (lostOnCharge(charge)) return true;
  const amount = typeof charge.amount === "number" ? charge.amount : 0;
  const back = typeof charge.amount_refunded === "number" ? charge.amount_refunded : 0;
  return amount > 0 && back >= amount;
}

/** The charge of a PaymentIntent read with its latest charge expanded, or a Charge itself. */
function chargeOf(payment: unknown): ChargeLike | null {
  if (!payment || typeof payment !== "object") return null;
  const value = payment as { object?: unknown; latest_charge?: unknown } & ChargeLike;
  if (value.object === "charge") return value;
  const charge = value.latest_charge;
  return charge && typeof charge === "object" ? (charge as ChargeLike) : null;
}

/**
 * Whether Stripe says this payment was refunded in full. On a charge Stripe
 * sent this is refunds only; a lost dispute is seen here only on a row
 * lostDisputesSince() built. Doors use givenBack() or purchaseRefunded().
 *
 * Takes a PaymentIntent read with its latest charge expanded, or a Charge
 * itself. Anything Stripe did not expand, or did not send, counts as not
 * refunded: only Stripe saying so closes a door.
 */
export function refundedInFull(payment: unknown): boolean {
  const charge = chargeOf(payment);
  return charge ? chargeRefunded(charge) : false;
}

const CHARGE_ID = /^(ch|py)_[A-Za-z0-9]{6,255}$/;

/**
 * Whether the bank took this payment back from the creator for good: a
 * dispute on its charge that Stripe has closed as lost, for the whole charge
 * with what was refunded (a partial one keeps access, as a partial refund
 * does). Takes what
 * refundedInFull() takes. Stripe marks a disputed charge with `disputed` but
 * no longer sends the dispute with it, and nothing can expand it, so only
 * for a charge marked disputed (rare) is Stripe asked for that charge's
 * disputes: a door reading an undisputed payment makes no extra request.
 * A charge not expanded, or not marked, counts as not lost, as with refunds.
 * Throws when Stripe cannot be asked.
 */
export async function disputeLost(account: string, payment: unknown): Promise<boolean> {
  const charge = chargeOf(payment);
  if (!charge || charge.disputed !== true) return false;
  if (lostOnCharge(charge)) return true;
  const id = typeof charge.id === "string" ? charge.id : "";
  if (!CHARGE_ID.test(id)) return false;
  const listed = await onAccount("GET", account, `/disputes?${new URLSearchParams({ charge: id, limit: "10" })}`);
  const rows = Array.isArray(listed.data) ? (listed.data as { status?: unknown; amount?: unknown }[]) : [];
  const lost = rows.filter((row) => row && row.status === "lost");
  if (!lost.length) return false;
  const amounts = lost.map((row) => (typeof row.amount === "number" ? row.amount : null));
  return coversCharge(charge, amounts.includes(null) ? null : (amounts as number[]).reduce((a, b) => a + b, 0));
}

/**
 * disputeLost() for a door that lets in: a dispute Stripe could not be asked
 * about counts as not lost, as a plan's first payment does in
 * purchaseRefunded(). The money is with the buyer either way, keeping access
 * a moment longer costs next to nothing and the next read corrects it, while
 * closing on a failed read would lock paying buyers out whenever Stripe is
 * slow.
 */
export async function keptUnlessLost(account: string, payment: unknown): Promise<boolean> {
  try {
    return await disputeLost(account, payment);
  } catch (error) {
    console.error("reading a payment's dispute failed", error);
    return false;
  }
}

/** Refunded in full, or lost to a dispute: given back either way. Throws when Stripe cannot be asked. */
export async function givenBack(account: string | null | undefined, payment: unknown): Promise<boolean> {
  if (refundedInFull(payment)) return true;
  return account ? disputeLost(account, payment) : false;
}

/**
 * A payment given back, as the jobs that take things back read them: a
 * refund from /refunds (its charge expanded), or a dispute closed as lost,
 * read by lostDisputesSince() in the same shape. `id` is what the job keeps
 * as read (re_… or the evt_… of the closing).
 */
export type GivenBackRow = Record<string, unknown>;

/** Whether one row of a job's reading takes its sale back: a full refund going through, or a dispute lost for the whole charge. */
export function rowGivesBack(row: GivenBackRow): boolean {
  if (row.object === "dispute") return row.status === "lost" && refundedInFull(row.charge);
  if (row.status !== "succeeded" && row.status !== "pending") return false;
  return refundedInFull(row.charge);
}

/**
 * The disputes on the creator's account that Stripe closed as lost since
 * `since` (seconds), read from the closing events, which Stripe keeps thirty
 * days: each as a row rowGivesBack() takes, `id` the event's, `created` the
 * time it closed, `payment_intent` the payment it took back, `charge` the
 * charge read for its amount (one read per lost dispute, which is rare).
 * `complete` is false when there were more than the pages read, so the
 * caller keeps its place and reads them again next time. Throws when Stripe
 * cannot be asked; the jobs use lostDisputesOrRetry().
 */
export async function lostDisputesSince(
  account: string,
  since: number,
  pages = 3,
): Promise<{ rows: GivenBackRow[]; complete: boolean }> {
  const found: GivenBackRow[] = [];
  let after = "";
  for (let page = 0; page < pages; page += 1) {
    const query = new URLSearchParams({ type: "charge.dispute.closed", limit: "100", "created[gte]": String(Math.max(0, Math.floor(since))) });
    if (after) query.set("starting_after", after);
    const listed = await onAccount("GET", account, `/events?${query}`);
    const events = Array.isArray(listed.data) ? (listed.data as Record<string, unknown>[]) : [];
    for (const event of events) {
      const dispute = ((event.data as { object?: unknown } | null)?.object ?? null) as Record<string, unknown> | null;
      if (typeof event.id !== "string" || !dispute || dispute.status !== "lost") continue;
      const chargeId = idOf(dispute.charge);
      if (!CHARGE_ID.test(chargeId)) continue;
      const charge = await onAccount("GET", account, `/charges/${encodeURIComponent(chargeId)}`);
      found.push({
        object: "dispute",
        id: event.id,
        status: "lost",
        created: typeof event.created === "number" ? event.created : 0,
        payment_intent: idOf(dispute.payment_intent) || null,
        charge: {
          ...charge,
          object: "charge",
          id: chargeId,
          disputed: true,
          dispute: { status: "lost", ...(typeof dispute.amount === "number" ? { amount: dispute.amount } : {}) },
        },
      });
    }
    const last = events[events.length - 1];
    if (listed.has_more !== true || !last || typeof last.id !== "string") return { rows: found, complete: true };
    after = last.id;
  }
  return { rows: found, complete: false };
}

/**
 * lostDisputesSince() for the jobs that also read refunds: a failed read
 * (a restricted key without Events, a rate limit, a timeout) gives no rows
 * and `complete` false, so the job still handles its refunds and keeps its
 * place to read the disputes again next run. Stripe keeps events thirty
 * days: a job down longer than that misses lost disputes (not refunds).
 */
export async function lostDisputesOrRetry(account: string, since: number): Promise<{ rows: GivenBackRow[]; complete: boolean }> {
  try {
    return await lostDisputesSince(account, since);
  } catch (error) {
    console.error("reading the disputes closed as lost failed", error);
    return { rows: [], complete: false };
  }
}

type SessionLike = {
  mode?: unknown;
  invoice?: unknown;
  payment_intent?: unknown;
  metadata?: Record<string, string> | null | unknown;
};

const INVOICE_ID = /^in_[A-Za-z0-9]{8,255}$/;
const INTENT_ID = /^pi_[A-Za-z0-9]{8,255}$/;

const idOf = (value: unknown): string =>
  typeof value === "string"
    ? value
    : value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
      ? ((value as { id: string }).id)
      : "";

/**
 * Whether a payment plan's purchase was given back in full: a plan runs as a
 * subscription, so its checkout carries no payment of its own, and the one
 * that counts is its first invoice's. Read from Stripe; any answer it does
 * not give counts as not refunded, as everywhere else.
 */
async function planRefundedInFull(account: string, session: SessionLike): Promise<boolean> {
  const meta = (session.metadata ?? {}) as Record<string, unknown>;
  if (session.mode !== "subscription" || meta.kind !== "plan") return false;
  const invoice =
    typeof session.invoice === "string" ? session.invoice : (session.invoice as { id?: unknown } | null)?.id;
  if (typeof invoice !== "string" || !INVOICE_ID.test(invoice)) return false;
  try {
    // Whichever way this account's API version names it: on the invoice
    // itself (older versions), or as the invoice's payments (newer ones).
    const read = await onAccount("GET", account, `/invoices/${encodeURIComponent(invoice)}`);
    const intents: string[] = [];
    const direct = idOf(read.payment_intent);
    if (INTENT_ID.test(direct)) intents.push(direct);
    else {
      const listed = await onAccount("GET", account, `/invoice_payments?${new URLSearchParams({ invoice, limit: "10" })}`);
      for (const row of Array.isArray(listed.data) ? (listed.data as Record<string, unknown>[]) : []) {
        if (row.status !== "paid") continue;
        const payment = row.payment && typeof row.payment === "object" ? (row.payment as Record<string, unknown>) : null;
        const pi = idOf(payment?.payment_intent);
        if (INTENT_ID.test(pi)) intents.push(pi);
      }
    }
    if (!intents.length) return false;
    const checked = await Promise.all(
      intents.map(async (intent) =>
        givenBack(account, await onAccount("GET", account, `/payment_intents/${encodeURIComponent(intent)}?expand[]=latest_charge`)),
      ),
    );
    return checked.every(Boolean);
  } catch (error) {
    console.error("reading a payment plan's first payment failed", error);
    return false;
  }
}

/**
 * Whether a checkout's purchase was given back in full: its payment, or for a
 * payment plan its first invoice's, refunded in full or lost to a dispute.
 * The one rule for every door. A plan's later instalments, refunded or lost,
 * close nothing here, as before.
 */
export async function purchaseRefunded(account: string | null | undefined, session: SessionLike): Promise<boolean> {
  if (refundedInFull(session.payment_intent)) return true;
  if (!account) return false;
  // As for a plan's first payment below: what Stripe did not answer closes nothing.
  if (await keptUnlessLost(account, session.payment_intent)) return true;
  return planRefundedInFull(account, session);
}
