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
  /**
   * What made those fail, as thrown (Claude 6's N1 on #3463): the closing reads it with lib/stripe-silence.ts, so the
   * creator's account giving no answer, or refusing us, counts toward the closing's deadline as on its renewals.
   */
  errors?: unknown[];
  /** Whether the creator's account answered on this run (its balance was read): a run of silence or refusals is over. */
  answered?: boolean;
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

/**
 * The payment intent an invoice was paid by, whichever way this account's API version names it; "" only when this
 * invoice's own whole list of payments holds none paid. A reply for another invoice, a list that is not one, a row of
 * another invoice, a list that is not whole, or a paid row whose payment does not read as a payment intent (missing,
 * null, off-pattern, or of another type: Codex G on #3120, Claude 6 on #3097) is unknown and throws, so the member is
 * counted failed and tried again, never refunded on another payment and never settled as owed nothing. So is a row whose
 * status is not one this code knows (missing, null, not a string, or a value Stripe does not document: Codex G's residual
 * finding on #3120): only "paid" decides paid, and only KNOWN_UNPAID decides not paid.
 */
async function intentOf(account: string, invoice: string, count: () => void): Promise<string> {
  count();
  const read = await onAccount("GET", account, `/invoices/${encodeURIComponent(invoice)}`);
  if (!isOwnReply(read, invoice)) throw new Error("Stripe answered for another invoice");
  const direct = idOf(read.payment_intent);
  if (typeof direct === "string" && INTENT_ID.test(direct)) return direct;
  count();
  const listed = await onAccount("GET", account, `/invoice_payments?${new URLSearchParams({ invoice, limit: "10" })}`);
  const rows = objectOf(listed)?.data;
  if (!Array.isArray(rows)) throw new Error("an invoice's payments did not come as a list");
  // A paid row is a payment made, whatever it reads as: one that does not name a readable intent proves no absence.
  // A readable paid intent of this invoice is still found whatever the row order.
  // A status this code does not know proves nothing either, so it never lets the list settle none.
  let unread = false;
  let unknownStatus = false;
  for (const item of rows) {
    const row = objectOf(item);
    if (!row || idOf(row.invoice) !== invoice) throw new Error("a payment listed is not this invoice's");
    if (row.status !== "paid") {
      if (!KNOWN_UNPAID.has(row.status)) unknownStatus = true;
      continue;
    }
    const id = idOf(objectOf(row.payment)?.payment_intent);
    if (typeof id === "string" && INTENT_ID.test(id)) return id;
    unread = true;
  }
  if (unread) throw new Error("an invoice's paid payment did not read as a payment intent");
  if (unknownStatus) throw new Error("an invoice's payment has a status that does not read as paid or not paid");
  // "None" only from a whole list: one that says, exactly, that there is no more.
  if (objectOf(listed)?.has_more !== false) throw new Error("an invoice's payments could not be read whole");
  return "";
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
    const out: Settled = { done: [], short: [], unmade: [], pending: 0, disputed: 0, none: 0, over: 0, failed: 0, left: Math.max(0, rows.length - REFUNDS_PER_REQUEST), errors: [], answered: false };
    rows = rows.slice(0, REFUNDS_PER_REQUEST);
    if (!rows.length) return out;
    let funds: Map<string, number>;
    try {
      funds = await available(account);
    } catch (error) {
      console.error("reading a closing store's Stripe balance failed", error);
      return { ...out, failed: rows.length, errors: [error] };
    }
    out.answered = true;
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
      // Its payment, the refunds already made on it and the refund itself, and two more when Stripe did not name its
      // payment when it was held. Before the closing day they come from the budget; only the closing day uses the
      // calls set aside when it was held (rcalls), so pressing the button again can never drain them. Every call not
      // made is given back to where it was taken from.
      const need = row.paid.pi ? 3 : 5;
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
      if (!have) {
        await giveCallsBack();
        // On the closing day it is final, and its member is told honestly that it was not made automatically (not
        // that the balance did not cover it), with what is left to give and the creator's contact.
        if (options.final) {
          const amount = stillToGive(row.unused, row.paid.back ?? 0);
          await settle("over", amount);
          out.unmade.push({ sub: row.sub, amount, cur: row.paid.cur, email: row.paid.e });
        } else out.over += 1;
        continue;
      }
      try {
        const intent = row.paid.pi ?? (await intentOf(account, row.paid.inv, count));
        if (!intent) {
          await settle("none");
          out.none += 1;
          continue;
        }
        count();
        const pi = await onAccount("GET", account, `/payment_intents/${encodeURIComponent(intent)}?expand[]=latest_charge.balance_transaction`);
        // Read exactly (rules 24 and 30): only this payment's own reply, and its own charge, decide "disputed", what was
        // refunded and the fee. Another payment's reply, one with no id, a charge not expanded or naming another payment,
        // or a charge whose dispute, amount or refunds do not read decides nothing; the member is counted failed and tried
        // again, never settled as disputed, refunded or owed nothing from someone else's charge.
        if (!isOwnReply(pi, intent)) throw new Error("Stripe answered for another payment");
        const charge = objectOf(pi.latest_charge);
        if (!charge) throw new Error("this payment's charge could not be read");
        if (Object.hasOwn(charge, "payment_intent") && idOf(charge.payment_intent) !== intent) throw new Error("Stripe answered with another payment's charge");
        if (typeof charge.disputed !== "boolean") throw new Error("this payment's charge did not read");
        if (!Number.isSafeInteger(charge.amount) || (charge.amount as number) <= 0) throw new Error("what this payment's charge took could not be read");
        // What was already given back is read exactly (Codex G's second money review of #3097): an amount_refunded that is
        // not a whole, non-negative number, or more given back than the charge took (Codex G's focal on #3097), would read
        // as 0 or as a reading of this charge and give it back again.
        if (!Number.isSafeInteger(charge.amount_refunded) || (charge.amount_refunded as number) < 0 || (charge.amount_refunded as number) > (charge.amount as number)) {
          throw new Error("what this payment's charge gave back could not be read");
        }
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
        out.errors?.push(error);
      } finally {
        await giveCallsBack();
      }
    }
    return out;
  } finally {
    await releaseMark(lockKey(folder), lock);
  }
}
