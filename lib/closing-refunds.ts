/**
 * Time members paid for past a store's closing day, given back from the
 * creator's own Stripe account (queue item 307 [EC1], part 4, and its
 * complement of 30 October 2026, 13h12 Fortaleza).
 *
 * Two ways in, one calculation (lib/closing-buyers-rules.ts, unusedOf and
 * stillToGive) and one function:
 *
 *   - the creator's button, after a review screen (app/studio/closing-refunds):
 *     every member's amount shown before it is confirmed, and refused if what
 *     Stripe says changed since the screen was drawn;
 *   - the closing day (lib/plan-closing.ts): whatever was not given back by
 *     then is given back that day, the same amounts, by the code.
 *
 * Read on 30 October 2026 in Stripe's documentation:
 * docs.stripe.com/connect/saas/tasks/refunds-disputes ("Create a refund using
 * your platform's secret key with charge_write permission for connected
 * accounts when authenticated as the connected account"; "With direct
 * charges ... Stripe debits refunds and disputed amounts from that account's
 * balance"); docs.stripe.com/connect/account-balances (a connected account's
 * negative balance can fall on the platform when controller.losses.payments
 * is "application"); docs.stripe.com/errors (balance_insufficient,
 * charge_disputed, refund_disputed_payment, charge_already_refunded);
 * docs.stripe.com/changelog/basil/2025-04-30/refund-pending-reason (a refund
 * pending for insufficient_funds).
 *
 * So the platform never pays and never owes: each refund is made only when
 * the account's available balance in that currency, read first, covers it,
 * and is counted off as it goes; one that does not fit is not attempted.
 *
 * Never twice: each refund carries the invoice it gives back for in its
 * metadata and in its idempotency key; before one is made Stripe is asked
 * for the refunds already made on that payment, and whatever was given back
 * already (here, by the creator at Stripe, for any reason) is taken off the
 * unused part (stillToGive). A lock keeps two requests from running at once.
 */
import { createHash } from "node:crypto";
import { onAccount, StripeError } from "@/lib/stripe-account";
import { redisPipeline } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { signedOf } from "@/lib/redis-count";
import { repliesFor } from "@/lib/redis-reply";
import { type Store, storeFolder, storeRef } from "@/lib/store";
import { type PaidPeriod, REFUNDS_PER_REQUEST, stillToGive, totalsOf, unusedOf } from "@/lib/closing-buyers-rules";
import { paidPeriods, savePaidPeriod, takeCalls, workKey } from "@/lib/closing-holds";
import { disputeTakes } from "@/lib/retained-revenue";

const INTENT_ID = /^pi_[A-Za-z0-9]{6,64}$/;
const REFUND_ID = /^re_[A-Za-z0-9]{3,252}$/;
const lockKey = (folder: string) => `nl:closing:refund:${folder}`;
const LOCK_SECONDS = 120;
type Row = Record<string, unknown>;
const objectOf = (value: unknown): Row | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null);

export type UnusedRow = { sub: string; paid: PaidPeriod; unused: number };
/**
 * What Stripe's answer to POST /refunds says, read exactly: "done" (succeeded), "pending" (pending or
 * requires_action), "failed" (failed or canceled), or "unknown" for anything that is not a refund of this payment for
 * this amount in one of Stripe's own states.
 */
/**
 * The refund made here before under this invoice, from Stripe's list read exactly: null when the whole list holds
 * none that stands (failed and canceled ones do not), or "unknown" when the list is not whole or a row under this
 * invoice does not read as a refund of this payment.
 */
export function priorRefund(list: unknown, intent: string, invoice: string, currency: string): { state: "done" | "pending"; amount: number } | null | "unknown" {
  if (!list || typeof list !== "object" || Array.isArray(list)) return "unknown";
  const field = (value: unknown, key: string): unknown =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  const rows = field(list, "data");
  if (field(list, "object") !== "list" || !Array.isArray(rows) || field(list, "has_more") !== false) return "unknown";
  for (const row of rows) {
    // Every row must read as a refund with its own id and metadata (an object, or null for none): a row that does not
    // read could be this invoice's, so the list is unknown and nothing is sent (Codex G on #2699).
    if (!row || typeof row !== "object" || Array.isArray(row) || field(row, "object") !== "refund") return "unknown";
    const id = field(row, "id");
    const meta = field(row, "metadata");
    if (typeof id !== "string" || !REFUND_ID.test(id)) return "unknown";
    if (meta !== null && (!meta || typeof meta !== "object" || Array.isArray(meta))) return "unknown";
    const mark = field(meta, "closing_refund");
    if (mark !== undefined && typeof mark !== "string") return "unknown";
    if (mark !== invoice) continue;
    const amount = field(row, "amount");
    if (!Number.isSafeInteger(amount) || (amount as number) <= 0) return "unknown";
    const state = refundState(row, intent, amount as number, currency);
    if (state === "unknown") return "unknown";
    if (state === "failed") continue;
    return { state, amount: amount as number };
  }
  return null;
}

export function refundState(refund: unknown, intent: string, amount: number, currency: string): "done" | "pending" | "failed" | "unknown" {
  if (!refund || typeof refund !== "object" || Array.isArray(refund)) return "unknown";
  const own = (key: string): unknown => Object.getOwnPropertyDescriptor(refund, key)?.value;
  const id = own("id");
  if (own("object") !== "refund" || typeof id !== "string" || !REFUND_ID.test(id) || own("payment_intent") !== intent) return "unknown";
  if (own("amount") !== amount || !Number.isSafeInteger(amount) || own("currency") !== currency.toLowerCase()) return "unknown";
  const status = own("status");
  if (status === "succeeded") return "done";
  if (status === "pending" || status === "requires_action") return "pending";
  if (status === "failed" || status === "canceled") return "failed";
  return "unknown";
}


/** A refund's outcome that is final: nothing more is tried for it. A short one is tried again until the closing day makes it final. */
const settled = (paid: PaidPeriod) => paid.r === "done" || paid.r === "none" || paid.r === "disputed" || paid.r === "over" || (paid.r === "short" && paid.f === 1);

/** Every member who paid for time past `day` (ms) and has not been settled yet, with what that time is worth. */
export async function unusedRows(store: Store, day: number): Promise<UnusedRow[]> {
  const rows: UnusedRow[] = [];
  for (const [sub, paid] of await paidPeriods(store)) {
    if (settled(paid)) continue;
    const unused = unusedOf(paid, day);
    if (unused > 0) rows.push({ sub, paid, unused });
  }
  return rows.sort((a, b) => b.paid.pe - a.paid.pe || a.sub.localeCompare(b.sub));
}

/** The figure the creator reads: how many members, and what in all, by currency. */
export async function unusedSummary(store: Store, day: number): Promise<{ members: number; totals: { cur: string; amount: number }[]; rows: UnusedRow[] }> {
  const rows = await unusedRows(store, day);
  return { members: rows.length, totals: totalsOf(rows.map((r) => ({ amount: r.unused, cur: r.paid.cur }))), rows };
}

/** A fingerprint of what a review screen showed: the rows and their amounts, as it was drawn. */
export function reviewMark(rows: UnusedRow[]): string {
  return createHash("sha256").update(rows.slice(0, REFUNDS_PER_REQUEST).map((r) => `${r.sub}:${r.unused}:${r.paid.cur}`).join("|")).digest("hex");
}

export type Settled = {
  done: { sub: string; amount: number; cur: string }[];
  short: { sub: string; amount: number; cur: string; email: string }[];
  /** On the closing day, refunds the call budget could not cover: not made, and told so honestly. */
  unmade: { sub: string; amount: number; cur: string; email: string }[];
  pending: number;
  disputed: number;
  none: number;
  /** Past the closing's call budget (counted for the creator). */
  over: number;
  /** Not reached: Stripe could not be asked, or the time ran out. Tried again. */
  failed: number;
  left: number;
};

/**
/**
 * Rule 30 (Claude 6's money review of #3097): a Stripe reply decides only when it is the object asked for. Null-safe,
 * so a 200 whose JSON body is null, a string or a number is not the object asked for either.
 */
const isOwnReply = (reply: unknown, id: string): boolean =>
  reply !== null && typeof reply === "object" && Object.hasOwn(reply, "id") && (reply as { id?: unknown }).id === id;
/** The id a field names, whether Stripe sent it as an id or expanded it as an object; undefined when it names none. */
const idOf = (value: unknown): unknown => (value !== null && typeof value === "object" ? (value as { id?: unknown }).id : value);

/**
 * The invoice-payment statuses that prove a row was not paid: Stripe documents an invoice payment's status as one of
 * "open", "paid" or "canceled" (https://docs.stripe.com/api/invoice-payment/object). Anything else is unknown, including
 * "failed", which that list does not hold (Codex G's focal return on #3120, review 5816998291).
 */
const KNOWN_UNPAID: ReadonlySet<unknown> = new Set(["open", "canceled"]);

/** A charge's id as Stripe gives one (lib/refunds.ts). */
const CHARGE_ID = /^(ch|py)_[A-Za-z0-9]{6,255}$/;

/** Every status Stripe gives a dispute (lib/refunds.ts); anything else does not read. */
const DISPUTE_STATUSES: ReadonlySet<unknown> = new Set(["warning_needs_response", "warning_under_review", "warning_closed", "needs_response", "under_review", "won", "lost", "prevented", "charge_refunded"]);

/**
 * The payment intent an invoice was paid by, whichever way this account's API version names it; "" only when this
 * invoice's own whole list of payments holds none paid. A reply for another invoice, a list that is not one, a row of
 * another invoice, a list that is not whole, or a paid row whose payment does not read as a payment intent (missing,
 * null, off-pattern, or of another type: Codex G on #3120, Claude 6 on #3097) is unknown and throws, so the member is
 * counted failed and tried again, never refunded on another payment and never settled as owed nothing. So is a row whose
 * status is not one this code knows (missing, null, not a string, or a value Stripe does not document: Codex G's residual
 * finding on #3120): only "paid" decides paid, and only KNOWN_UNPAID decides not paid.
 */
async function intentsOf(account: string, invoice: string, count: () => void): Promise<{ intents: string[]; whole: boolean }> {
  count();
  const read = await onAccount("GET", account, `/invoices/${encodeURIComponent(invoice)}`);
  if (!isOwnReply(read, invoice)) throw new Error("Stripe answered for another invoice");
  // The invoice's own payment_intent names a payment, never that it is the only one (Codex P on #4428): an invoice paid
  // in parts may still name its first. So the whole list of its payments is always read, and the payment the invoice
  // names must be among the paid ones it holds.
  const direct = idOf(read.payment_intent);
  const named = typeof direct === "string" && INTENT_ID.test(direct) ? direct : "";
  count();
  const listed = await onAccount("GET", account, `/invoice_payments?${new URLSearchParams({ invoice, limit: "10" })}`);
  const rows = objectOf(listed)?.data;
  if (!Array.isArray(rows)) throw new Error("an invoice's payments did not come as a list");
  // A paid row is a payment made, whatever it reads as: one that does not name a readable intent proves no absence.
  // A readable paid intent of this invoice is still found whatever the row order.
  // A status this code does not know proves nothing either, so it never lets the list settle none.
  let unread = false;
  let unknownStatus = false;
  // Every paid payment of the invoice (#4411): one paid in two charges is given back over both, so all are needed.
  const paid: string[] = [];
  for (const item of rows) {
    const row = objectOf(item);
    if (!row || idOf(row.invoice) !== invoice) throw new Error("a payment listed is not this invoice's");
    if (row.status !== "paid") {
      if (!KNOWN_UNPAID.has(row.status)) unknownStatus = true;
      continue;
    }
    const id = idOf(objectOf(row.payment)?.payment_intent);
    if (typeof id === "string" && INTENT_ID.test(id)) {
      if (!paid.includes(id)) paid.push(id);
      continue;
    }
    unread = true;
  }
  // A readable paid payment is found whatever the row order. Beside a row that does not read (a paid row naming no
  // readable intent, a status this code does not know, or more pages), the readable ones are not known to be all
  // of them: `whole` says so, and the caller never settles a member owed more than they can give back (#4411).
  const whole = !unread && !unknownStatus && objectOf(listed)?.has_more === false;
  // A paid payment that does not read, or a list that may hold more, may already have been given back or disputed:
  // nothing is given back on the readable ones beside it (Codex L on #4428; a deliberate tightening of the decision
  // reviewed on #3120). A row whose status is not paid (processing and the like) has no refund and no dispute yet,
  // so the readable ones may still be given back over (`whole` false keeps such a member from settling short).
  // A status this code does not know beside a paid one is no better (Codex P on #4428): it may be a payment made, given
  // back or disputed under a state not read here, so it bars every refund as an unread row does, whether or not the
  // readable ones could cover all that is owed.
  if (paid.length && (unread || unknownStatus || objectOf(listed)?.has_more !== false)) throw new Error("a paid payment of this invoice, or a page of its payments, did not read; nothing is given back until it does");
  if (paid.length) {
    if (named && !paid.includes(named)) throw new Error("the payment the invoice names is not among the paid payments it lists");
    return { intents: paid, whole };
  }
  if (unread) throw new Error("an invoice's paid payment did not read as a payment intent");
  if (unknownStatus) throw new Error("an invoice's payment has a status that does not read as paid or not paid");
  // "None" only from a whole list: one that says, exactly, that there is no more.
  if (!whole) throw new Error("an invoice's payments could not be read whole");
  // An exact, empty list beside the payment the invoice names: an invoice from before it listed its payments, paid by
  // that one payment (Codex X5's fallback on #4428). A list holding rows none of which is paid stays "none paid".
  if (named && rows.length === 0) return { intents: [named], whole: true };
  // Rows listed, none of them paid, beside a payment the invoice names as its own: the two do not agree, so nothing is
  // taken as either.
  if (named) throw new Error("the invoice names a payment that its list of payments does not hold as paid");
  return { intents: [], whole };
}

/** Stripe's currency codes: three lowercase letters (https://docs.stripe.com/currencies). */
const CURRENCY = /^[a-z]{3}$/;

/**
 * The account's available balance, by currency, in the smallest unit, read exactly (CX-123 rule 24; audit R24 round 6,
 * finding 1; https://docs.stripe.com/api/balance/balance_object): only Stripe's balance object, whose `available` is a
 * list of rows, each one currency with a whole amount. Another shape, a row that does not read, or a currency listed
 * twice throws, so the run counts its members failed and tries again; it is never an empty balance, which on the
 * closing day would record every member as a final "short" and tell them the creator's balance did not cover it.
 */
async function available(account: string): Promise<Map<string, number>> {
  const balance = objectOf(await onAccount("GET", account, "/balance"));
  if (!balance || balance.object !== "balance" || !Array.isArray(balance.available)) throw new Error("the account's balance did not read");
  const out = new Map<string, number>();
  for (const item of balance.available) {
    const row = objectOf(item);
    if (!row || !Number.isSafeInteger(row.amount) || typeof row.currency !== "string" || !CURRENCY.test(row.currency) || out.has(row.currency)) {
      throw new Error("a row of the account's balance did not read");
    }
    out.set(row.currency, row.amount as number);
  }
  return out;
}

/**
 * What a refund of `give` (in the charge's currency) takes from the
 * balance, in the currency the charge settled in: an account in Europe or
 * Canada that sold in dollars holds euros or Canadian dollars. Read from the
 * charge's balance transaction, rounded up; the charge's own currency when
 * Stripe names none (null).
 *
 * Read exactly (CX-123 rule 24; audit R24 round 6, finding 1): a balance
 * transaction that is neither null nor an object with a whole positive amount
 * and a currency (missing, an id Stripe did not expand, an amount that does
 * not read), or a charge whose amount or currency does not read, throws, so
 * the member is tried again; the cost is never weighed in another currency.
 */
export function settledCost(give: number, charge: { amount?: unknown; currency?: unknown; balance_transaction?: unknown }): { cur: string; amount: number } {
  const paid = charge.amount;
  if (!Number.isSafeInteger(paid) || (paid as number) <= 0) throw new Error("what this payment's charge took could not be read");
  if (!Object.hasOwn(charge, "balance_transaction")) throw new Error("this payment's charge did not say what it settled as");
  const bt = charge.balance_transaction;
  if (bt === null) {
    if (typeof charge.currency !== "string" || !CURRENCY.test(charge.currency)) throw new Error("this payment's charge currency could not be read");
    return { cur: charge.currency, amount: give };
  }
  const row = objectOf(bt);
  if (!row || !Number.isSafeInteger(row.amount) || (row.amount as number) <= 0 || typeof row.currency !== "string" || !CURRENCY.test(row.currency)) {
    throw new Error("what this payment's charge settled as could not be read");
  }
  return { cur: row.currency, amount: Math.ceil((give * (row.amount as number)) / (paid as number)) };
}

/**
 * A payment's own charge, read exactly (rules 24 and 30): only this payment's own reply and its own charge decide
 * "disputed", what was refunded and the fee; anything else throws, so the member is counted failed and tried again.
 */
async function readCharge(account: string, intent: string, count: () => void): Promise<Record<string, unknown>> {
  count();
  const pi = await onAccount("GET", account, `/payment_intents/${encodeURIComponent(intent)}?expand[]=latest_charge.balance_transaction`);
  if (!isOwnReply(pi, intent)) throw new Error("Stripe answered for another payment");
  const charge = objectOf(pi.latest_charge);
  if (!charge) throw new Error("this payment's charge could not be read");
  if (Object.hasOwn(charge, "payment_intent") && idOf(charge.payment_intent) !== intent) throw new Error("Stripe answered with another payment's charge");
  if (typeof charge.disputed !== "boolean") throw new Error("this payment's charge did not read");
  if (!Number.isSafeInteger(charge.amount) || (charge.amount as number) <= 0) throw new Error("what this payment's charge took could not be read");
  if (!Number.isSafeInteger(charge.amount_refunded) || (charge.amount_refunded as number) < 0 || (charge.amount_refunded as number) > (charge.amount as number)) {
    throw new Error("what this payment's charge gave back could not be read");
  }
  return charge;
}

/**
 * Gives back each member's unused part, from the creator's own account.
 * `subs` limits it to the rows a review screen showed; `mark` is that
 * screen's reviewMark, and nothing is done when the rows changed since.
 * `final` is the closing day's: a refund the balance does not cover is then
 * final (its member is emailed by the caller); before it, it is tried again.
 * Bounded by `until`: what is not reached is counted in `left`.
 */
export async function giveBackUnused(
  store: Store,
  day: number,
  options: { subs?: string[]; mark?: string; until?: number; final?: boolean } = {},
): Promise<Settled | "changed" | "busy" | "unavailable"> {
  const account = store.stripeAccountId;
  if (!account) return "unavailable";
  const until = options.until ?? Number.POSITIVE_INFINITY;
  const folder = await storeFolder(storeRef(store));
  // One run at a time, on an exact claim (lib/claim-mark.ts, CX-123 rule 24): held by another run, or not known to be
  // ours, is busy and tried again; the lock is let go only while it still holds this run's own value.
  const lock = claimValue();
  if ((await claimMark(lockKey(folder), LOCK_SECONDS, lock)) !== "ours") return "busy";
  try {
    let rows = await unusedRows(store, day);
    if (options.subs) {
      const wanted = new Set(options.subs);
      rows = rows.filter((r) => wanted.has(r.sub));
    }
    if (options.mark !== undefined && options.mark !== reviewMark(rows)) return "changed";
    const out: Settled = { done: [], short: [], unmade: [], pending: 0, disputed: 0, none: 0, over: 0, failed: 0, left: Math.max(0, rows.length - REFUNDS_PER_REQUEST) };
    rows = rows.slice(0, REFUNDS_PER_REQUEST);
    if (!rows.length) return out;
    let funds: Map<string, number>;
    try {
      funds = await available(account);
    } catch (error) {
      console.error("reading a closing store's Stripe balance failed", error);
      return { ...out, failed: rows.length };
    }
    /**
     * What one charge's disputes took to the buyer: 0 for a charge not disputed. For a disputed one, its own disputes,
     * read whole (rules 24 and 30): each one in a status Stripe gives and that takes the creator's money
     * (lib/retained-revenue.ts disputeTakes: open, lost, or prevented with its money gone) counts at its own amount in
     * the charge's currency; one won, an inquiry or a prevented one whose money came back counts nothing. Anything that
     * does not read throws, so the member is tried again.
     */
    const disputedAway = async (charge: Record<string, unknown>, count: () => void): Promise<number> => {
      if (charge.disputed !== true) return 0;
      const id = typeof charge.id === "string" ? charge.id : "";
      if (!CHARGE_ID.test(id)) throw new Error("a disputed charge's id could not be read");
      count();
      const listed = objectOf(await onAccount("GET", account, `/disputes?${new URLSearchParams({ charge: id, limit: "10" })}`));
      const rows = listed?.data;
      if (!listed || !Array.isArray(rows) || listed.has_more !== false) throw new Error("a charge's disputes could not be read whole");
      let away = 0;
      for (const item of rows) {
        const row = objectOf(item);
        if (!row || row.object !== "dispute" || idOf(row.charge) !== id || !DISPUTE_STATUSES.has(row.status)) throw new Error("a dispute listed for this charge could not be read");
        const takes = disputeTakes(row as { status?: unknown; balance_transactions?: unknown });
        if (takes === null) throw new Error("a prevented dispute's money could not be read");
        if (!takes) continue;
        if (!Number.isSafeInteger(row.amount) || (row.amount as number) <= 0 || row.currency !== charge.currency) throw new Error("a dispute's amount could not be read");
        away += row.amount as number;
      }
      return Math.min(away, charge.amount as number);
    };

    /**
     * One member's unused part given back over every paid charge of an invoice paid in more than one (#4411), in the
     * order Stripe lists them, each within what its charge can still give back.
     *
     * Every charge, its refunds and its disputes are read again before each refund (Codex G on #4428): a refund made
     * elsewhere on any of them between two of ours is taken off what is owed, never added to it on old figures. What
     * was already given back on any charge (every refund, ours under this invoice or not) and what a dispute took to
     * the buyer (Codex U and N1 on #4428) are taken off what is owed, and the rest goes back through the charges that
     * are not disputed; a charge already given back under this invoice is never asked again. Each refund has its own
     * idempotency key. Any answer that does not read throws, and the member is tried again.
     */
    const giveSplit = async (
      row: UnusedRow,
      intents: string[],
      whole: boolean,
      ops: { settle: (r: PaidPeriod["r"], amount?: number) => Promise<void>; short: (give: number) => Promise<void>; count: () => void; final: boolean },
    ) => {
      type Read = { intent: string; charge: Record<string, unknown>; refunded: number; away: number; prior: { state: "done" | "pending"; amount: number } | null };
      const readAll = async (): Promise<Read[]> => {
        const reads: Read[] = [];
        for (const intent of intents) {
          const charge = await readCharge(account, intent, ops.count);
          ops.count();
          const list = await onAccount("GET", account, `/refunds?${new URLSearchParams({ payment_intent: intent, limit: "100" })}`);
          const prior = priorRefund(list, intent, row.paid.inv, row.paid.cur);
          if (prior === "unknown") throw new Error("the refunds already made for this payment could not be read whole");
          const away = await disputedAway(charge, ops.count);
          // Never less than ours already made on it, whether or not the charge counts a pending refund yet.
          reads.push({ intent, charge, refunded: Math.max(charge.amount_refunded as number, prior?.amount ?? 0), away, prior });
        }
        return reads;
      };
      // At most one refund per charge, so at most as many rounds as charges, each on figures read just before it.
      let given = 0;
      let pending = false;
      let left = 0;
      let disputed = false;
      for (let round = 0; ; round += 1) {
        const charges = await readAll();
        given = charges.reduce((sum, c) => sum + (c.prior?.amount ?? 0), 0);
        pending = pending || charges.some((c) => c.prior?.state === "pending");
        disputed = charges.some((c) => c.charge.disputed === true);
        const gone = charges.reduce((sum, c) => sum + c.refunded + c.away, 0);
        left = Math.min(stillToGive(row.unused, gone), Math.max(0, (row.paid.tot ?? row.paid.amt) - gone));
        // One refund of ours per charge under this invoice, and none on a disputed charge (Stripe refuses it).
        const next = left > 0 && round < intents.length ? charges.find((c) => !c.prior && c.charge.disputed !== true && (c.charge.amount as number) - c.refunded > 0) : undefined;
        if (!next) break;
        const give = Math.min(left, (next.charge.amount as number) - next.refunded);
        const cost = settledCost(give, next.charge);
        if ((funds.get(cost.cur) ?? 0) < cost.amount) {
          await ops.short(left);
          return;
        }
        let refund: Record<string, unknown>;
        try {
          ops.count();
          refund = await onAccount(
            "POST",
            account,
            "/refunds",
            new URLSearchParams({ payment_intent: next.intent, amount: String(give), reason: "requested_by_customer", "metadata[closing_refund]": row.paid.inv, "metadata[store_closing]": "unused_time" }),
            undefined,
            `closing-refund:${row.paid.inv}:${next.intent}`,
          );
        } catch (error) {
          if (error instanceof StripeError && error.code === "balance_insufficient") {
            await ops.short(left);
            return;
          }
          // Disputed or refunded elsewhere since it was read (Codex P on #4428): the figures this split was worked out
          // from are stale, so nothing more is sent on them. The member is tried again, and the next run reads every
          // charge, its refunds and its disputes anew and gives only what is still owed.
          if (error instanceof StripeError && (error.code === "charge_already_refunded" || error.code === "charge_disputed" || error.code === "refund_disputed_payment")) {
            throw new Error("a charge of this invoice was refunded or disputed since it was read; the member is tried again on fresh figures");
          }
          throw error;
        }
        const state = refundState(refund, next.intent, give, row.paid.cur);
        if (state === "unknown") throw new Error("a closing refund's answer was not one this payment's refund gives");
        if (state === "failed") {
          if (ops.final) {
            const amount = stillToGive(row.unused, row.paid.back ?? 0);
            await ops.settle("over", amount);
            out.unmade.push({ sub: row.sub, amount, cur: row.paid.cur, email: row.paid.e });
          } else {
            console.error("a closing refund was refused by Stripe; the member stays to be reconciled");
            out.failed += 1;
          }
          return;
        }
        funds.set(cost.cur, (funds.get(cost.cur) ?? 0) - cost.amount);
        if (state === "pending") pending = true;
        // Nothing more to give, or no other charge to give it through: settled on what was just made, without reading
        // everything once more.
        if (give >= left || !charges.some((c) => c !== next && !c.prior && c.charge.disputed !== true && (c.charge.amount as number) - c.refunded > 0)) {
          given += give;
          left -= give;
          break;
        }
      }
      // Owed more than the readable charges can give back while some of the invoice's payments did not read: the rest
      // may be on those, so the member is tried again (what was given now is counted then), never settled short.
      if (left > 0 && !whole) throw new Error("part of an invoice's payments did not read, and the readable ones cannot give back all that is owed");
      // What could be given is given: a charge with nothing left to give back, or a disputed one, cannot be asked for
      // more. A member who got nothing from this closing because a dispute had already taken it is settled disputed.
      if (given <= 0 && disputed) {
        await ops.settle("disputed");
        out.disputed += 1;
      } else if (given <= 0) {
        await ops.settle("none");
        out.none += 1;
      } else if (pending) {
        await ops.settle("pending", given);
        out.pending += 1;
      } else {
        await ops.settle("done", given);
        out.done.push({ sub: row.sub, amount: given, cur: row.paid.cur });
      }
    };

    // One at a time: each refund is counted off the balance before the next is weighed.
    for (const row of rows) {
      if (Date.now() > until) {
        out.left += 1;
        continue;
      }
      const settle = async (r: PaidPeriod["r"], amount?: number) =>
        savePaidPeriod(store, row.sub, { ...row.paid, r, ...((r === "short" || r === "over") && options.final ? { f: 1 as const } : {}), ...(amount ? (r === "short" || r === "over" ? { want: amount } : { back: amount }) : {}) });
      const short = async (give: number) => {
        await settle("short", give);
        out.short.push({ sub: row.sub, amount: give, cur: row.paid.cur, email: row.paid.e });
      };
      // Its payment, the refunds already made on it and the refund itself, and two more (the invoice and its list of
      // payments) unless the payment kept when it was held was proven its only one then (`one`, #4428). A payment kept
      // without that proof, by a period held before #4428 that kept the first of several, is a hint only, and the
      // invoice's payments are read again (Codex X5 on #4428). Before the closing day they come from the budget; only
      // the closing day uses the calls set aside when it was held (rcalls), so pressing the button again can never
      // drain them. Every call not made is given back to where it was taken from.
      const proven = row.paid.pi && row.paid.one === 1 ? row.paid.pi : "";
      const need = proven ? 3 : 5;
      const taken: ["calls" | "rcalls", number][] = [];
      const take = async (from: "calls" | "rcalls", n: number) => {
        if (!(await takeCalls(folder, n, from))) return false;
        taken.push([from, n]);
        return true;
      };
      let used = 0;
      const count = () => {
        used += 1;
      };
      const giveCallsBack = async () => {
        let left = taken.reduce((sum, [, n]) => sum + n, 0) - used;
        for (const [from, n] of [...taken].reverse()) {
          const back = Math.min(n, left);
          if (back > 0) {
            // Once: a total in an unknown shape may or may not have been added, so it is logged, never sent again.
            const replies = repliesFor(await redisPipeline([["HINCRBY", workKey(folder), from, back]]), 1);
            if ((replies ? signedOf(replies[0]) : null) === null) console.error(`giving back ${back} of a closing's ${from} calls answered in an unknown shape; not tried again`);
          }
          left -= back;
        }
        taken.length = 0;
      };
      let have: boolean;
      try {
        have = options.final
          ? (await take("rcalls", 3))
            ? need === 3 || (await take("calls", need - 3)) || (await take("rcalls", need - 3))
            : await take("calls", need)
          : await take("calls", need);
      } catch (error) {
        // A take whose reply was unknown (review 1 of SG2 L8): what was taken before it with an exact reply is given
        // back, never the unknown one, and the run stops as before.
        await giveCallsBack().catch((failed) => console.error("giving back a closing's calls failed; not tried again", failed));
        throw error;
      }
      // Past the call budget: on the closing day it is final, and its member is told honestly that it was not made
      // automatically (not that the balance did not cover it), with what is left to give and the creator's contact.
      const notMade = async () => {
        if (options.final) {
          const amount = stillToGive(row.unused, row.paid.back ?? 0);
          await settle("over", amount);
          out.unmade.push({ sub: row.sub, amount, cur: row.paid.cur, email: row.paid.e });
        } else out.over += 1;
      };
      if (!have) {
        await giveCallsBack();
        await notMade();
        continue;
      }
      try {
        const { intents, whole } = proven ? { intents: [proven], whole: true } : await intentsOf(account, row.paid.inv, count);
        if (!intents.length) {
          await settle("none");
          out.none += 1;
          continue;
        }
        if (intents.length > 1 || !whole) {
          // An invoice paid in more than one charge (#4411): at most one refund for each charge, each after every
          // charge's three reads (its payment, its refunds, its disputes) are made again (Codex G on #4428), beyond the
          // five already taken (the invoice, its list and one charge's three). Taken before any is made.
          const extra = intents.length * (3 * intents.length + 1) - 3;
          const more = (await take("calls", extra)) || (options.final === true && (await take("rcalls", extra)));
          if (!more) {
            await notMade();
            continue;
          }
          await giveSplit(row, intents, whole, { settle, short, count, final: options.final === true });
          continue;
        }
        const intent = intents[0];
        // Read exactly (rules 24 and 30; Codex G's money reviews of #3097): readCharge throws on anything that is not
        // this payment's own reply and charge, so the member is counted failed and tried again.
        const charge = await readCharge(account, intent, count);
        if (charge.disputed) {
          await settle("disputed");
          out.disputed += 1;
          continue;
        }
        // One made here before, under this invoice: never a second.
        count();
        const made = await onAccount("GET", account, `/refunds?${new URLSearchParams({ payment_intent: intent, limit: "100" })}`);
        // Read exactly (Codex G on #2699): a refund made here before counts only as a whole refund of this payment, in
        // its currency, in one of Stripe's own states; a list that is not whole, or a row under this invoice that does
        // not read, is unknown, and nothing is sent, so a second refund is never made on a guess.
        const prior = priorRefund(made, intent, row.paid.inv, row.paid.cur);
        if (prior === "unknown") throw new Error("the refunds already made for this payment could not be read whole");
        if (prior) {
          await settle(prior.state, prior.amount);
          if (prior.state === "pending") out.pending += 1;
          else out.done.push({ sub: row.sub, amount: prior.amount, cur: row.paid.cur });
          continue;
        }
        const refunded = charge.amount_refunded as number;
        const give = Math.min(stillToGive(row.unused, refunded), Math.max(0, (row.paid.tot ?? row.paid.amt) - refunded));
        if (give <= 0) {
          await settle("none");
          out.none += 1;
          continue;
        }
        const cost = settledCost(give, charge);
        if ((funds.get(cost.cur) ?? 0) < cost.amount) {
          await short(give);
          continue;
        }
        let refund: Record<string, unknown>;
        try {
          count();
          refund = await onAccount(
            "POST",
            account,
            "/refunds",
            new URLSearchParams({ payment_intent: intent, amount: String(give), reason: "requested_by_customer", "metadata[closing_refund]": row.paid.inv, "metadata[store_closing]": "unused_time" }),
            undefined,
            `closing-refund:${row.paid.inv}`,
          );
        } catch (error) {
          if (error instanceof StripeError && error.code === "balance_insufficient") {
            await short(give);
            continue;
          }
          if (error instanceof StripeError && (error.code === "charge_disputed" || error.code === "refund_disputed_payment")) {
            await settle("disputed");
            out.disputed += 1;
            continue;
          }
          if (error instanceof StripeError && error.code === "charge_already_refunded") {
            await settle("none");
            out.none += 1;
            continue;
          }
          throw error;
        }
        // Read exactly (Codex G on #2699; https://docs.stripe.com/api/refunds/object, read 06/11/2026): only a refund of
        // this payment, for this amount, in one of Stripe's own states counts. Succeeded is done; pending or
        // requires_action is made and waiting; failed or canceled gave nothing back and the member stays to be
        // reconciled; any other answer is unknown, never "done", and is tried again under the same idempotency key, so
        // Stripe answers with the same refund instead of making a second one.
        const state = refundState(refund, intent, give, row.paid.cur);
        if (state === "unknown") throw new Error("a closing refund's answer was not one this payment's refund gives");
        if (state === "failed") {
          // Refused by Stripe (a closed card, say). Before the closing day it is tried again; on the closing day it is
          // final and goes the same way as one not made automatically (Revisor 1 on #2699): the member is told
          // honestly, with what is left to give and the creator's contact, and the closing can finish.
          if (options.final) {
            const amount = stillToGive(row.unused, row.paid.back ?? 0);
            await settle("over", amount);
            out.unmade.push({ sub: row.sub, amount, cur: row.paid.cur, email: row.paid.e });
          } else {
            console.error("a closing refund was refused by Stripe; the member stays to be reconciled");
            out.failed += 1;
          }
          continue;
        }
        funds.set(cost.cur, (funds.get(cost.cur) ?? 0) - cost.amount);
        // Pending for want of funds is Stripe holding it on the creator's account until they come: made, never Marktmorgen's.
        if (state === "pending") {
          await settle("pending", give);
          out.pending += 1;
        } else {
          await settle("done", give);
          out.done.push({ sub: row.sub, amount: give, cur: row.paid.cur });
        }
      } catch (error) {
        console.error("giving a member's unused time back failed; tried again", error);
        out.failed += 1;
      } finally {
        await giveCallsBack();
      }
    }
    return out;
  } finally {
    await releaseMark(lockKey(folder), lock);
  }
}
