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
import { signedOf } from "@/lib/redis-count";
import { repliesFor } from "@/lib/redis-reply";
import { type Store, storeFolder, storeRef } from "@/lib/store";
import { type PaidPeriod, REFUNDS_PER_REQUEST, stillToGive, totalsOf, unusedOf } from "@/lib/closing-buyers-rules";
import { paidPeriods, savePaidPeriod, takeCalls, workKey } from "@/lib/closing-holds";

const INTENT_ID = /^pi_[A-Za-z0-9]{6,64}$/;
const REFUND_ID = /^re_[A-Za-z0-9]{3,252}$/;
const lockKey = (folder: string) => `nl:closing:refund:${folder}`;
const LOCK_SECONDS = 120;

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

/** The payment intent an invoice was paid by, whichever way this account's API version names it. */
async function intentOf(account: string, invoice: string, count: () => void): Promise<string> {
  count();
  const read = await onAccount("GET", account, `/invoices/${encodeURIComponent(invoice)}`);
  const direct = typeof read.payment_intent === "string" ? read.payment_intent : (read.payment_intent as { id?: unknown } | null)?.id;
  if (typeof direct === "string" && INTENT_ID.test(direct)) return direct;
  count();
  const listed = await onAccount("GET", account, `/invoice_payments?${new URLSearchParams({ invoice, limit: "10" })}`);
  for (const row of Array.isArray(listed.data) ? (listed.data as Record<string, unknown>[]) : []) {
    if (row.status !== "paid") continue;
    const pi = (row.payment as { payment_intent?: unknown } | null)?.payment_intent;
    const id = typeof pi === "string" ? pi : (pi as { id?: unknown } | null)?.id;
    if (typeof id === "string" && INTENT_ID.test(id)) return id;
  }
  return "";
}

/** The account's available balance, by currency, in the smallest unit. */
async function available(account: string): Promise<Map<string, number>> {
  const balance = await onAccount("GET", account, "/balance");
  const out = new Map<string, number>();
  for (const row of Array.isArray(balance.available) ? (balance.available as { amount?: unknown; currency?: unknown }[]) : []) {
    if (typeof row.currency === "string" && typeof row.amount === "number") out.set(row.currency.toLowerCase(), (out.get(row.currency.toLowerCase()) ?? 0) + row.amount);
  }
  return out;
}

/**
 * What a refund of `give` (in the charge's currency) takes from the
 * balance, in the currency the charge settled in: an account in Europe or
 * Canada that sold in dollars holds euros or Canadian dollars. Read from the
 * charge's balance transaction, rounded up; the charge's own currency when
 * Stripe names none.
 */
export function settledCost(give: number, charge: { amount?: unknown; currency?: unknown; balance_transaction?: unknown }): { cur: string; amount: number } {
  const bt = charge.balance_transaction && typeof charge.balance_transaction === "object" ? (charge.balance_transaction as { amount?: unknown; currency?: unknown }) : null;
  const paid = Number(charge.amount);
  if (bt && typeof bt.currency === "string" && Number(bt.amount) > 0 && paid > 0) return { cur: bt.currency.toLowerCase(), amount: Math.ceil((give * Number(bt.amount)) / paid) };
  return { cur: typeof charge.currency === "string" ? charge.currency.toLowerCase() : "", amount: give };
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
  const [got] = await redisPipeline([["SET", lockKey(folder), "1", "NX", "EX", LOCK_SECONDS]]);
  if (got === null) return "busy";
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
        const charge = pi.latest_charge && typeof pi.latest_charge === "object" ? (pi.latest_charge as Record<string, unknown>) : {};
        if (charge.disputed === true) {
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
        const refunded = typeof charge.amount_refunded === "number" ? charge.amount_refunded : 0;
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
    await redisPipeline([["DEL", lockKey(folder)]]).catch(() => {});
  }
}
