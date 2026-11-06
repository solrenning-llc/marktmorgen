/**
 * Turning invited creators' payments into credit on a plan, once a day.
 *
 * This app receives no events from Stripe, so it asks, the way every other
 * sweep here does (app/api/cron/plans). Two steps:
 *
 *   1. Earn. For every invited store, the paid invoices of the customer it
 *      pays us from are read. Each one paid at least INVITE_HOLD_DAYS ago —
 *      past the window in which our Refund Policy gives the money back — earns
 *      whoever invited it INVITE_SHARE_PERCENT of what was actually paid,
 *      less anything refunded or credited back. The first one that earns
 *      also earns the invited creator INVITE_BONUS_CENTS on their own plan.
 *      An account that had paid us before it was invited earns nothing: it
 *      was not brought to us.
 *   2. Put on the plan. Every credit earned and not yet at Stripe becomes a
 *      credit on the customer balance of the store it is for — Stripe's own
 *      account credit, which it takes off that customer's next invoices on
 *      its own, until it is used up. A store that has not started paying us
 *      yet keeps its credit here until it does.
 *
 * Nothing is ever credited twice. An invoice is written down here the moment
 * it is read, with SET NX. And before a credit is sent to Stripe, the
 * customer's balance history is read for one already carrying that credit's
 * id, so even a credit that reached Stripe and then failed to be written
 * down here is found and not sent again. The request itself carries the
 * credit's id as its idempotency key as well.
 *
 * Checked against Stripe's API reference (30 September 2026): a negative
 * `amount` on /v1/customers/{id}/balance_transactions is a credit; it applies
 * to the customer's next finalized invoices; an invoice's paid amount already
 * leaves out any credit used on it, so credit is never earned on credit;
 * an invoice's subscription and payments sit under `parent` and `payments`
 * from 2025 on, which is why the version is pinned here.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { claimMark } from "@/lib/claim-mark";
import { isBillingConfigured, onPlatformAt } from "@/lib/billing";
import { type Store, storeForEmail, storeForId } from "@/lib/store";
import {
  ALL_KEY,
  type Credit,
  OWED_KEY,
  byKey,
  creditKey,
  mineKey,
  parseBy,
  parseCredit,
} from "@/lib/creator-invites";
import { INVITE_HOLD_DAYS, inviteShare, readInviteTerms } from "@/lib/creator-invite-rules";

export const INVITE_STRIPE_VERSION = "2026-08-26.dahlia";

const CURSOR_KEY = "nl:ref:cursor";
const CUSTOMER_PATTERN = /^cus_[A-Za-z0-9]{6,64}$/;
const INVOICE_PATTERN = /^in_[A-Za-z0-9]{6,64}$/;

type Invoice = {
  id?: unknown;
  status?: unknown;
  amount_paid?: unknown;
  post_payment_credit_notes_amount?: unknown;
  currency?: unknown;
  created?: unknown;
  status_transitions?: { paid_at?: unknown } | null;
  parent?: { type?: unknown } | null;
  payments?: { object?: unknown; has_more?: unknown; data?: { payment?: { type?: unknown; payment_intent?: unknown; charge?: unknown } | null }[] } | null;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export type InviteCounts = { invited: number; earned: number; added: number; failed: number; complete: boolean };

/** The customer a store's credit goes on: its own, or its account's first store's. */
async function customerFor(store: Store): Promise<string | null> {
  if (store.stripeCustomerId && CUSTOMER_PATTERN.test(store.stripeCustomerId)) return store.stripeCustomerId;
  if (!store.extra) return null;
  const first = await storeForEmail(store.email);
  return first?.stripeCustomerId && CUSTOMER_PATTERN.test(first.stripeCustomerId) ? first.stripeCustomerId : null;
}

/** What was given back on one invoice's payments: refunds made or on their way. */
async function refundedOn(invoice: Invoice): Promise<number> {
  let total = 0;
  // The invoice's own payments read whole first (Revisor 1 and Codex C2 on #2722): Stripe's list with every row, each
  // a payment of a known shape. Missing, cut short or odd is not "no payment": the store fails this run.
  const payments = invoice.payments as unknown;
  const list = payments && typeof payments === "object" ? (payments as { object?: unknown; data?: unknown; has_more?: unknown }) : null;
  if (!list || list.object !== "list" || list.has_more !== false || !Array.isArray(list.data) || list.data.length > 100) {
    throw new UnknownReplyError("invite credits: the payments of an invoice");
  }
  for (const row of list.data as { payment?: { type?: unknown; payment_intent?: unknown; charge?: unknown } | null }[]) {
    // Only a payment whose refunds can be read (Codex C2 on #2722): a payment intent or a charge, naming its own
    // reference. A payment record (paid outside Stripe's charges), a type not known here or a type without its own
    // reference has no refund list to read, so its refunds are unknown, not none: the store fails this run.
    const payment = row && typeof row === "object" && row.payment && typeof row.payment === "object" ? row.payment : null;
    const type = payment?.type;
    const ref = type === "payment_intent" ? payment?.payment_intent : type === "charge" ? payment?.charge : undefined;
    if (typeof ref !== "string" || !ref) throw new UnknownReplyError("invite credits: a payment of an invoice");
    const query = new URLSearchParams({ limit: "100" });
    query.set(type as string, ref);
    const list = await onPlatformAt(INVITE_STRIPE_VERSION, "GET", `/refunds?${query}`);
    // Read exactly (Codex C2 on #2722): a whole list, at most the hundred asked for, each refund with a whole
    // non-negative amount and a status in words. Anything else is not "no refund": the store fails this run and no
    // credit is written (earnFrom lets the error through).
    const rows = list && list.object === "list" && list.has_more === false && Array.isArray(list.data) && list.data.length <= 100 ? list.data : null;
    if (!rows) throw new UnknownReplyError("invite credits: the refunds of a payment");
    for (const refund of rows as unknown[]) {
      if (!refund || typeof refund !== "object") throw new UnknownReplyError("invite credits: a refund");
      const { amount, status } = refund as { amount?: unknown; status?: unknown };
      if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0 || typeof status !== "string") {
        throw new UnknownReplyError("invite credits: a refund");
      }
      if (status === "succeeded" || status === "pending" || status === "requires_action") total += amount;
    }
  }
  return total;
}

/**
 * What one invoice earns: the amount paid, less refunds and credit notes
 * issued after it was paid, of which the share is taken. Exported for the
 * tests, which feed it Stripe-shaped invoices.
 */
export function paidOn(invoice: Invoice, refunded: number): number {
  return Math.max(0, num(invoice.amount_paid) - num(invoice.post_payment_credit_notes_amount) - refunded);
}

/**
 * Puts credits already written, and still owed, back on the lists they are paid from: their inviter's credits and
 * the owed set. Both are sets, so a credit listed already is unchanged. The invited store's own bonus is relisted
 * with them, since it was listed by the same write. One read and one write for all of them (Claude 4 on #2722).
 * Throws UnknownReplyError when it cannot be sure (Codex N on #2722): the read not answered exactly, a credit
 * written before that does not read back whole (only the bonus may be absent: it is written only with a paid
 * first invoice), or the write not answered exactly. The run then counts the store as failed and not complete,
 * and pays nothing on what it could not read; the next run tries again.
 */
async function relist(ids: string[], sid: string): Promise<void> {
  if (!ids.length) return;
  const keys = [...ids, `bonus_${sid}`].map((id) => creditKey(id));
  const read = repliesFor(await redisPipeline(keys.map((key) => ["GET", key])), keys.length);
  if (!read) throw new UnknownReplyError("relisting invite credits: the read");
  const writes: (string | number)[][] = [];
  read.forEach((raw, i) => {
    const bonus = i === ids.length;
    if (bonus && raw === null) return;
    const credit = parseCredit(raw);
    if (!credit) throw new UnknownReplyError(`relisting invite credits: ${bonus ? "the bonus" : ids[i]} does not read back`);
    if (credit.state === "owed" && credit.cents > 0) writes.push(["ZADD", mineKey(credit.to), credit.at, credit.id], ["SADD", OWED_KEY, credit.id]);
  });
  if (!writes.length) return;
  const wrote = repliesFor(await redisPipeline(writes), writes.length);
  if (!wrote || wrote.some((reply) => countOf(reply) === null)) throw new UnknownReplyError("relisting invite credits: the write");
}

/** Step 1 for one invited store. Returns how many credits it wrote. */
async function earnFrom(sid: string, nowSeconds: number): Promise<number> {
  const [rawBy] = await redisPipeline([["GET", byKey(sid)]]);
  const by = parseBy(rawBy);
  if (!by || by.back) return 0;
  const terms = readInviteTerms(by.terms);
  if (!terms) return 0;
  const store = await storeForId(sid);
  if (!store) return 0;
  const customer = await customerFor(store);
  if (!customer) return 0;

  const query = new URLSearchParams({ customer, status: "paid", limit: "100" });
  query.append("expand[]", "data.payments");
  const list = await onPlatformAt(INVITE_STRIPE_VERSION, "GET", `/invoices?${query}`);
  const invoices = ((list.data as Invoice[] | undefined) ?? []).filter(
    (inv) => typeof inv.id === "string" && INVOICE_PATTERN.test(inv.id) && inv.status === "paid",
  );

  // Paid us before the invite: not brought to us by anyone.
  if (invoices.some((inv) => num(inv.amount_paid) > 0 && num(inv.created) < by.at)) {
    await redisPipeline([["SET", byKey(sid), JSON.stringify({ ...by, back: true })]]);
    return 0;
  }

  const ripe = nowSeconds - INVITE_HOLD_DAYS * 86_400;
  let wrote = 0;
  // Oldest first, so the first payment is the one that earns the new
  // creator's own credit.
  const ordered = invoices
    .filter((inv) => inv.parent?.type === "subscription_details")
    .filter((inv) => {
      const paidAt = num(inv.status_transitions?.paid_at);
      return paidAt > 0 && paidAt <= ripe;
    })
    .sort((a, b) => num(a.status_transitions?.paid_at) - num(b.status_transitions?.paid_at));
  if (!ordered.length) return 0;

  // Read exactly (CX-123 rule 24, L9): one reply per invoice, each 0 or 1; anything else fails the store this run.
  const seen = repliesFor(await redisPipeline(ordered.map((inv) => ["EXISTS", creditKey(String(inv.id))])), ordered.length);
  // Not one exact 0 or 1 for each: unknown, so the store fails this run and nothing is relisted or written (Codex N on #2722).
  if (!seen || seen.some((reply) => countOf(reply) !== 0 && countOf(reply) !== 1)) throw new UnknownReplyError("invite credits: EXISTS");
  // Written before: a credit still owed is put back on the lists it is paid from (both idempotent), so one whose
  // listing failed after its record was written is never left unpaid (L9).
  await relist(ordered.filter((_, i) => countOf(seen[i]) === 1).map((inv) => String(inv.id)), sid);
  for (let i = 0; i < ordered.length; i += 1) {
    const mark = countOf(seen[i]);
    if (mark !== 0) continue;
    const inv = ordered[i];
    const id = String(inv.id);
    const paidAt = num(inv.status_transitions?.paid_at);
    const cur = typeof inv.currency === "string" ? inv.currency : "usd";
    const paid = num(inv.amount_paid) > 0 ? paidOn(inv, await refundedOn(inv)) : 0;
    const cents = inviteShare(paid, terms);
    const share: Credit = { id, kind: "share", to: by.r, from: sid, cents, cur, at: paidAt, state: cents > 0 ? "owed" : "none" };
    // Written once, for good: ours only on OK or this record read back (CX-123 rule 24, L9).
    if ((await claimMark(creditKey(id), null, JSON.stringify(share))) !== "ours") continue;
    const writes: (string | number)[][] = [["ZADD", mineKey(by.r), paidAt, id]];
    if (cents > 0) writes.push(["SADD", OWED_KEY, id]);
    wrote += 1;

    if (paid > 0 && terms.bonusCents > 0) {
      const bonusId = `bonus_${sid}`;
      const bonus: Credit = { id: bonusId, kind: "bonus", to: sid, from: sid, cents: terms.bonusCents, cur, at: paidAt, state: "owed" };
      if ((await claimMark(creditKey(bonusId), null, JSON.stringify(bonus))) === "ours") {
        writes.push(["ZADD", mineKey(sid), paidAt, bonusId], ["SADD", OWED_KEY, bonusId]);
        wrote += 1;
      }
    }
    await redisPipeline(writes);
  }
  return wrote;
}

/** The credits already on a customer's balance, by the credit id each carries. */
async function creditedAt(customer: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let after = "";
  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams({ limit: "100" });
    if (after) query.set("starting_after", after);
    const list = await onPlatformAt(INVITE_STRIPE_VERSION, "GET", `/customers/${customer}/balance_transactions?${query}`);
    const rows = (list.data as { id?: unknown; metadata?: Record<string, string> | null }[] | undefined) ?? [];
    for (const row of rows) {
      const credit = row.metadata?.nimbus_invite_credit;
      if (credit && typeof row.id === "string") found.set(credit, row.id);
    }
    if (list.has_more !== true || !rows.length) break;
    after = String(rows[rows.length - 1].id ?? "");
    if (!after) break;
  }
  return found;
}

/** Step 2 for one credit. True when it is now on the plan. */
async function putOnPlan(id: string, history: Map<string, Map<string, string>>, nowSeconds: number): Promise<boolean> {
  const [raw] = await redisPipeline([["GET", creditKey(id)]]);
  const credit = parseCredit(raw);
  if (!credit || credit.state !== "owed") {
    await redisPipeline([["SREM", OWED_KEY, id]]);
    return false;
  }
  const store = await storeForId(credit.to);
  if (!store) {
    await redisPipeline([["SET", creditKey(id), JSON.stringify({ ...credit, state: "gone" })], ["SREM", OWED_KEY, id]]);
    return false;
  }
  const customer = await customerFor(store);
  // Not paying us yet: the credit waits here for the day they start.
  if (!customer) return false;

  let known = history.get(customer);
  if (!known) {
    known = await creditedAt(customer);
    history.set(customer, known);
  }
  let txn = known.get(id) ?? "";
  if (!txn) {
    const body = new URLSearchParams({
      amount: String(-credit.cents),
      currency: credit.cur,
      description: credit.kind === "share" ? "Marktmorgen invite credit: a creator you invited paid" : "Marktmorgen invite credit: welcome",
      "metadata[nimbus_invite_credit]": id,
    });
    const made = await onPlatformAt(INVITE_STRIPE_VERSION, "POST", `/customers/${customer}/balance_transactions`, body, `nimbus-invite-${id}`);
    txn = typeof made.id === "string" ? made.id : "";
    known.set(id, txn);
  }
  await redisPipeline([
    ["SET", creditKey(id), JSON.stringify({ ...credit, state: "done", txn, doneAt: nowSeconds })],
    ["SREM", OWED_KEY, id],
  ]);
  return true;
}

/**
 * The daily run. Bounded by `deadline`; the walk through invited stores
 * carries on the next day from where it stopped.
 */
export async function settleInvites(deadline: number, now = Date.now()): Promise<InviteCounts> {
  const counts: InviteCounts = { invited: 0, earned: 0, added: 0, failed: 0, complete: false };
  if (!isRedisConfigured() || !isBillingConfigured()) return counts;
  const nowSeconds = Math.floor(now / 1000);

  const [all, cursor] = await redisPipeline([["ZREVRANGE", ALL_KEY, 0, -1], ["GET", CURSOR_KEY]]);
  const sids = Array.isArray(all) ? all.map(String) : [];
  const start = Math.min(Number(cursor) || 0, sids.length);
  let walked = 0;
  for (let n = 0; n < sids.length; n += 1) {
    if (Date.now() > deadline) break;
    const sid = sids[(start + n) % sids.length];
    try {
      counts.earned += await earnFrom(sid, nowSeconds);
    } catch (error) {
      counts.failed += 1;
      console.error("reading an invited creator's payments failed", error);
    }
    counts.invited += 1;
    walked += 1;
  }
  const walkedAll = walked === sids.length;
  await redisPipeline([["SET", CURSOR_KEY, walkedAll ? 0 : (start + walked) % Math.max(1, sids.length)]]);

  const [owed] = await redisPipeline([["SMEMBERS", OWED_KEY]]);
  const ids = Array.isArray(owed) ? owed.map(String) : [];
  const history = new Map<string, Map<string, string>>();
  let pushedAll = true;
  for (const id of ids) {
    if (Date.now() > deadline) {
      pushedAll = false;
      break;
    }
    try {
      if (await putOnPlan(id, history, nowSeconds)) counts.added += 1;
    } catch (error) {
      counts.failed += 1;
      console.error("putting an invite credit on a plan failed", error);
    }
  }
  // A store or credit that could not be read for sure is not a complete pass (Codex N on #2722).
  counts.complete = walkedAll && pushedAll && counts.failed === 0;
  return counts;
}

/** The credit on a store's account at Stripe right now, in cents; null when unknown. */
export async function creditOnPlan(store: Store): Promise<{ cents: number; currency: string } | null> {
  if (!isBillingConfigured()) return null;
  const customer = await customerFor(store);
  if (!customer) return null;
  const found = await onPlatformAt(INVITE_STRIPE_VERSION, "GET", `/customers/${customer}`);
  if (found.deleted === true) return null;
  const balance = num(found.balance);
  return { cents: balance < 0 ? -balance : 0, currency: typeof found.currency === "string" && found.currency ? found.currency : "usd" };
}
