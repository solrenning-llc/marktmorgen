/**
 * The members of a store whose plan ended, on the creator's own Stripe
 * account (queue item 307 [EC1], parts 2 and 4; lib/closing-buyers-rules.ts
 * says why).
 *
 *   holdCharges     from the day the plan ended: every membership and payment
 *                   plan the store sold stops being charged (Stripe's pause of
 *                   collection, invoices voided, no day to resume); its open
 *                   invoices are voided and its drafts kept as drafts, so no
 *                   invoice from before is collected either; and each
 *                   member's last paid invoice is written down, for the time
 *                   they paid for past the closing day (lib/closing-refunds.ts).
 *                   Page by page from where the last run stopped; a member
 *                   that could not be held is written down and tried again
 *                   every day (retryHolds), and counted for the creator.
 *   releaseHolds    the plan was started again before the closing: each one
 *                   goes on exactly as it was, nothing charged for the days
 *                   between (voided invoices are never charged)
 *   releaseRestarted  the daily job's walk of the stores held, for the plans
 *                   started again since (the store record leaves the line of
 *                   ended plans the moment a plan runs, so the closing job
 *                   alone would never see it). A store whose closing day has
 *                   begun is not in it any more: from then on it closes.
 *
 * Read on 30 October 2026 in Stripe's documentation:
 * docs.stripe.com/billing/subscriptions/pause-payment ("the subscription
 * remains active and invoices continue to generate, but Stripe doesn't
 * collect payment"; void: "No record of charges is created for these
 * periods"; resume by unsetting pause_collection; "Invoices created before
 * you pause subscriptions continue to be retried unless you void them"; a
 * draft is not collected while its auto_advance is false);
 * docs.stripe.com/api/invoices/void ("Mark a finalized invoice as void").
 *
 *   nl:closing:paid:<folder>   hash  subscription -> its last payment (PaidPeriod), from the hold to the closing
 *   nl:closing:work:<folder>   hash  where the hold and the release stopped, the members not held yet
 *                                    ("f:<sub>"), those past the call budget ("o:<sub>"), and what is
 *                                    left of the budget ("calls")
 *   nl:closing:held            sorted set  a store's key -> when its plan ended, while its members are held
 *   nl:closing:final           sorted set  a store's key -> when its plan ended, from its closing day's start to its end
 *
 * Every write to Stripe carries an idempotency key and every call is taken
 * from the closing's budget first (STRIPE_CALLS_PER_MEMBER for each member
 * the cap allows). Nothing here is silent: what was not done is logged and
 * counted for the creator's notices.
 */
import { onAccount } from "@/lib/stripe-account";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { signedOf } from "@/lib/redis-count";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { type Store, saleHandles, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { standingOf } from "@/lib/plan-standing";
import { normaliseEmail } from "@/lib/auth";
import { forgetCredit } from "@/lib/closing-credit";
import {
  HOLD_PAGES_PER_RUN,
  type HeldSub,
  MEMBERS_AT_ONCE,
  type PaidPeriod,
  REFUND_CALLS_PER_MEMBER,
  chargeable,
  holdBody,
  isPaymentPlan,
  membershipLineOf,
  releaseBody,
} from "@/lib/closing-buyers-rules";

export const paidKey = (folder: string) => `nl:closing:paid:${folder}`;
export const workKey = (folder: string) => `nl:closing:work:${folder}`;
export const HELD_INDEX = "nl:closing:held";
/** Stores whose closing day has begun (their memberships ended at Stripe): seen through to the end, whatever the plan does since. */
export const FINAL_INDEX = "nl:closing:final";
const SUB_ID = /^sub_[A-Za-z0-9]{6,64}$/;
const INVOICE_ID = /^in_[A-Za-z0-9]{6,64}$/;
const INTENT_ID = /^pi_[A-Za-z0-9]{6,64}$/;

type Row = HeldSub & Record<string, unknown>;
type Cursor = { h: number; p: string };

const parseCursor = (raw: unknown): Cursor => {
  try {
    const value = typeof raw === "string" ? (JSON.parse(raw) as Cursor) : null;
    return value && Number.isInteger(value.h) && value.h >= 0 && typeof value.p === "string" ? value : { h: 0, p: "" };
  } catch {
    return { h: 0, p: "" };
  }
};

/** Runs `each` over `items`, MEMBERS_AT_ONCE at a time, stopping once `until` has passed. */
async function inTurn<T>(items: T[], until: number, each: (item: T) => Promise<void>): Promise<boolean> {
  let at = 0;
  const work = async () => {
    while (at < items.length && Date.now() <= until) {
      const item = items[at];
      at += 1;
      await each(item);
    }
  };
  await Promise.all(Array.from({ length: MEMBERS_AT_ONCE }, work));
  return at >= items.length;
}

/**
 * Every subscription the store sold, page by page on its own account, from
 * the cursor kept under `field`; bounded by `until` and HOLD_PAGES_PER_RUN.
 * Answers whether it reached the end (and lets the cursor go then).
 */
async function eachSold(store: Store, folder: string, field: string, until: number, each: (rows: Row[]) => Promise<boolean>): Promise<boolean> {
  const account = store.stripeAccountId;
  if (!account) return true;
  const handles = [...saleHandles(store)];
  const [raw] = await redisPipeline([["HGET", workKey(folder), field]]);
  let cursor = parseCursor(raw);
  for (let pages = 0; pages < HOLD_PAGES_PER_RUN; pages += 1) {
    if (cursor.h >= handles.length) {
      await redisPipeline([["HDEL", workKey(folder), field]]);
      return true;
    }
    if (Date.now() > until) return false;
    const query = new URLSearchParams({ limit: "100", query: `metadata['store']:'${handles[cursor.h]}'` });
    query.append("expand[]", "data.customer");
    if (cursor.p) query.set("page", cursor.p);
    const found = await onAccount("GET", account, `/subscriptions/search?${query}`);
    if (!(await each(Array.isArray(found.data) ? (found.data as Row[]) : []))) return false;
    const next = typeof found.next_page === "string" ? found.next_page : "";
    cursor = found.has_more === true && next ? { h: cursor.h, p: next } : { h: cursor.h + 1, p: "" };
    await redisPipeline([["HSET", workKey(folder), field, JSON.stringify(cursor)]]);
  }
  if (cursor.h >= handles.length) {
    await redisPipeline([["HDEL", workKey(folder), field]]);
    return true;
  }
  return false;
}

/** Sets the closing's budget of calls to the creator's Stripe account, once an ending, before any is made. */
export async function startCallBudget(folder: string, calls: number): Promise<void> {
  await redisPipeline([["DEL", workKey(folder)], ["HSET", workKey(folder), "calls", Math.max(0, Math.floor(calls))]]);
}

/**
 * Takes `n` calls, all or none: from the budget ("calls"), or from the calls
 * set aside for refunds ("rcalls", REFUND_CALLS_PER_MEMBER for each member
 * held with a payment to give back), which nothing else may use.
 * Throws UnknownReplyError when HINCRBY's total is not a whole number
 * (CX-123 rule 24): no call is made on it, and nothing is given back, since
 * it is not known whether the take ran; the callers count the member as not
 * reached (holdRows marks it to try again, giveBackUnused stops).
 */
export async function takeCalls(folder: string, n: number, from: "calls" | "rcalls" = "calls"): Promise<boolean> {
  if (n <= 0) return true;
  const replies = repliesFor(await redisPipeline([["HINCRBY", workKey(folder), from, -n]]), 1);
  const left = replies ? signedOf(replies[0]) : null;
  if (left === null) throw new UnknownReplyError("a closing's budget of Stripe calls");
  if (left >= 0) return true;
  await redisPipeline([["HINCRBY", workKey(folder), from, n]]);
  return false;
}

/** A member's last paid invoice, as its membership line says, with the payment it was paid by. */
export function paidPeriodOf(invoice: Record<string, unknown>, email: string, intent = ""): PaidPeriod | null {
  // The payment it was paid by: on the invoice in older API versions, among its payments (expanded) in newer ones.
  if (!intent) {
    const payments = (invoice.payments as { data?: { status?: unknown; payment?: { payment_intent?: unknown } | null }[] } | undefined)?.data ?? [];
    const found = payments.find((p) => p.status === "paid")?.payment?.payment_intent;
    const id = typeof found === "string" ? found : (found as { id?: unknown } | null)?.id;
    if (typeof id === "string") intent = id;
  }
  if (invoice.status !== "paid" || typeof invoice.id !== "string" || !INVOICE_ID.test(invoice.id)) return null;
  const line = membershipLineOf(invoice as Parameters<typeof membershipLineOf>[0]);
  const tot = typeof invoice.amount_paid === "number" ? invoice.amount_paid : 0;
  const cur = typeof invoice.currency === "string" ? invoice.currency.toLowerCase() : "";
  if (!line || !(tot > 0) || !cur) return null;
  const direct = typeof invoice.payment_intent === "string" ? invoice.payment_intent : (invoice.payment_intent as { id?: unknown } | null)?.id;
  const pi = typeof direct === "string" && INTENT_ID.test(direct) ? direct : INTENT_ID.test(intent) ? intent : "";
  return { inv: invoice.id, ...(pi ? { pi } : {}), amt: line.amt, tot, cur, ps: line.ps, pe: line.pe, e: email };
}

const listOf = (reply: Record<string, unknown>) => (Array.isArray(reply.data) ? (reply.data as Record<string, unknown>[]) : []);

/**
 * Holds one member for an ending: its open invoices voided and its drafts
 * kept as drafts (marked, so a release can let them go again), so nothing
 * issued before is collected; its last paid invoice that holds its
 * membership written down (up to ten looked back, in one call); then its
 * collection paused. Every call is taken from the budget first, and its
 * refund's calls are set aside once it is held. Throws when Stripe could not
 * be asked; answers "over" when the budget did not cover it.
 */
async function holdOne(account: string, folder: string, sub: Row, endedAt: number): Promise<"held" | "over"> {
  const id = sub.id as string;
  // Its open and draft invoices listed, its paid ones read, its hold and its release; and its refund's, set aside.
  const plan = isPaymentPlan(sub);
  if (!(await takeCalls(folder, 5 + (plan ? 0 : REFUND_CALLS_PER_MEMBER)))) return "over";
  const open = listOf(await onAccount("GET", account, `/invoices?${new URLSearchParams({ subscription: id, status: "open", limit: "10" })}`));
  const drafts = listOf(await onAccount("GET", account, `/invoices?${new URLSearchParams({ subscription: id, status: "draft", limit: "10" })}`)).filter((d) => typeof d.id === "string" && INVOICE_ID.test(d.id) && d.auto_advance !== false);
  // A void each; a draft kept now and let go again on a release.
  if (!(await takeCalls(folder, open.length + 2 * drafts.length))) return "over";
  for (const invoice of open) {
    if (typeof invoice.id === "string" && INVOICE_ID.test(invoice.id)) await onAccount("POST", account, `/invoices/${encodeURIComponent(invoice.id)}/void`, undefined, undefined, `closing-void:${invoice.id}`);
  }
  for (const invoice of drafts) {
    await onAccount("POST", account, `/invoices/${encodeURIComponent(invoice.id as string)}`, new URLSearchParams({ auto_advance: "false", "metadata[closing_draft]": String(endedAt) }), undefined, `closing-draft:${invoice.id}:${endedAt}`);
  }
  if (drafts.length) await redisPipeline([["HSET", workKey(folder), `d:${id}`, drafts.map((d) => d.id).join(",")]]);
  const email = memberEmail(sub);
  if (!plan) {
    const query = new URLSearchParams({ subscription: id, status: "paid", limit: "10" });
    query.append("expand[]", "data.payments");
    const paid = listOf(await onAccount("GET", account, `/invoices?${query}`));
    const period = paid.map((invoice) => paidPeriodOf(invoice, email)).find((p): p is PaidPeriod => p !== null) ?? null;
    // The first reading is the one before any hold (HSETNX).
    if (period) await redisPipeline([["HSETNX", paidKey(folder), id, JSON.stringify(period)]]);
  }
  await onAccount("POST", account, `/subscriptions/${encodeURIComponent(id)}`, holdBody(sub, endedAt), undefined, `closing-hold:${id}:${endedAt}`);
  // Set aside only now that it is held: a hold that failed leaves its refund's calls spent, never a second reserve.
  if (!plan) await redisPipeline([["HINCRBY", workKey(folder), "rcalls", REFUND_CALLS_PER_MEMBER]]);
  return "held";
}

/** What a member with no address on Stripe is marked with: it cannot be told, and is counted. */
const NO_ADDRESS = "-";

/** The addresses of every member of this ending (held, past the budget or not held yet), payment plans included. */
export async function memberAddresses(folder: string): Promise<string[]> {
  return (await membersOf(folder)).emails;
}

/** Every member of this ending: the addresses, and the members with none (by subscription). */
export async function membersOf(folder: string): Promise<{ emails: string[]; missing: string[]; unpaused: string[] }> {
  if (!isRedisConfigured()) return { emails: [], missing: [], unpaused: [] };
  const [raw] = await redisPipeline([["HGETALL", workKey(folder)]]);
  const flat = Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
  const fields = new Map<string, string>();
  for (let i = 0; i + 1 < flat.length; i += 2) fields.set(flat[i], flat[i + 1]);
  const out = { emails: [] as string[], missing: [] as string[], unpaused: [] as string[] };
  for (const [field, value] of fields) {
    if (!field.startsWith("m:")) continue;
    const sub = field.slice(2);
    if (value === NO_ADDRESS) {
      out.missing.push(sub);
      continue;
    }
    if (!value) continue;
    out.emails.push(value);
    // Not paused: Stripe refused it (f:) or the closing's budget did not reach it (o:). It may still be charged.
    if (fields.has(`f:${sub}`) || fields.has(`o:${sub}`)) out.unpaused.push(value);
  }
  return out;
}

/** Whether a store's closing day has begun: then no plan may be started for it (app/api/billing/checkout). Throws when it cannot be read. */
export async function inClosingDay(ref: string): Promise<boolean> {
  // With no database there is no closing day to be in (the line lives there); one that does not answer throws, and the caller refuses.
  if (!isRedisConfigured()) return false;
  const [score] = await redisPipeline([["ZSCORE", FINAL_INDEX, ref]]);
  return score !== null && score !== undefined;
}

/** How the hold stands: the members it could not reach yet, and those past the budget. */
export async function holdCounts(folder: string): Promise<{ failed: number; over: number }> {
  if (!isRedisConfigured()) return { failed: 0, over: 0 };
  const [fields] = await redisPipeline([["HKEYS", workKey(folder)]]);
  const keys = Array.isArray(fields) ? (fields as unknown[]).map(String) : [];
  return { failed: keys.filter((k) => k.startsWith("f:")).length, over: keys.filter((k) => k.startsWith("o:")).length };
}

/** A member's address, from the customer Stripe expanded on its subscription. */
function memberEmail(sub: Row): string {
  const customer = sub.customer && typeof sub.customer === "object" ? (sub.customer as { email?: unknown }) : null;
  return typeof customer?.email === "string" ? normaliseEmail(customer.email) : "";
}

async function holdRows(account: string, folder: string, rows: Row[], endedAt: number, until: number): Promise<boolean> {
  const todo = rows.filter((sub) => typeof sub.id === "string" && SUB_ID.test(sub.id) && chargeable(sub) && !(sub.metadata?.store_hold === String(endedAt) && sub.pause_collection));
  // Every member's address is written down from the row itself, before any
  // budget or call, so one that is past the budget or that Stripe refused is
  // still told the store closes (lib/closing-buyers.ts); one with no address
  // is marked so, and counted as not told.
  const marks = todo.map((sub) => {
    const email = memberEmail(sub);
    return email ? ["HSET", workKey(folder), `m:${sub.id as string}`, email] : ["HSETNX", workKey(folder), `m:${sub.id as string}`, NO_ADDRESS];
  });
  if (marks.length) await redisPipeline(marks);
  return inTurn(todo, until, async (sub) => {
    const id = sub.id as string;
    try {
      const done = await holdOne(account, folder, sub, endedAt);
      await redisPipeline(done === "held" ? [["HDEL", workKey(folder), `f:${id}`, `o:${id}`]] : [["HSET", workKey(folder), `o:${id}`, "1"], ["HDEL", workKey(folder), `f:${id}`]]);
      if (done === "over") console.error("plan-closing: a member past the closing's call budget was not held; it ends on the closing day");
    } catch (error) {
      await redisPipeline([["HSET", workKey(folder), `f:${id}`, "1"]]);
      console.error("holding a member's charges after the plan ended failed; tried again tomorrow", error);
    }
  });
}

/**
 * One run of the hold for a plan that ended at `endedAt` (ms): the next pages
 * of the store's memberships. `done` once every page was read; members that
 * could not be held are tried again by retryHolds and counted, never a
 * reason to wait.
 */
export async function holdCharges(store: Store, endedAt: number, until: number): Promise<{ done: boolean; failed: number; over: number }> {
  const folder = await storeFolder(storeRef(store));
  const account = store.stripeAccountId;
  let done = true;
  if (account) done = await eachSold(store, folder, "hc", until, (rows) => holdRows(account, folder, rows, endedAt, until));
  await redisPipeline([["ZADD", HELD_INDEX, endedAt, storeRef(store)]]);
  return { done, ...(await holdCounts(folder)) };
}

/** The members not held yet, tried again: read one by one, then held. */
export async function retryHolds(store: Store, endedAt: number, until: number): Promise<{ failed: number; over: number }> {
  const folder = await storeFolder(storeRef(store));
  const account = store.stripeAccountId;
  if (!account) return holdCounts(folder);
  const [fields] = await redisPipeline([["HKEYS", workKey(folder)]]);
  const ids = (Array.isArray(fields) ? (fields as unknown[]).map(String) : []).filter((k) => k.startsWith("f:")).map((k) => k.slice(2)).filter((id) => SUB_ID.test(id));
  await inTurn(ids, until, async (id) => {
    try {
      if (!(await takeCalls(folder, 1))) {
        await redisPipeline([["HSET", workKey(folder), `o:${id}`, "1"], ["HDEL", workKey(folder), `f:${id}`]]);
        return;
      }
      const sub = (await onAccount("GET", account, `/subscriptions/${encodeURIComponent(id)}?expand[]=customer`)) as Row;
      if (!chargeable(sub) || (sub.metadata?.store_hold === String(endedAt) && sub.pause_collection)) {
        await redisPipeline([["HDEL", workKey(folder), `f:${id}`]]);
        return;
      }
      await holdRows(account, folder, [sub], endedAt, until);
    } catch (error) {
      console.error("holding a member's charges failed again; tried again tomorrow", error);
    }
  });
  return holdCounts(folder);
}

/** Lets every held member of the store go again, as they were. `done` when every one was reached. */
export async function releaseHolds(store: Store, until: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<{ done: boolean; released: number; failed: number }> {
  const out = { done: true, released: 0, failed: 0 };
  const account = store.stripeAccountId;
  if (!account) return out;
  const folder = await storeFolder(storeRef(store));
  // Each held member's release was taken from the budget with its hold (STRIPE_CALLS_PER_MEMBER): it is never refused for want of it.
  const reached = await eachSold(store, folder, "rc", until, async (rows) => {
    const todo = rows.filter((sub) => typeof sub.id === "string" && SUB_ID.test(sub.id) && Boolean(sub.metadata?.store_hold) && chargeable(sub));
    let failed = 0;
    const all = await inTurn(todo, until, async (sub) => {
      const id = sub.id as string;
      try {
        await onAccount("POST", account, `/subscriptions/${encodeURIComponent(id)}`, releaseBody(sub, nowSeconds), undefined, `closing-release:${id}:${sub.metadata?.store_hold}`);
        // The drafts its hold kept as drafts go on as they were (their calls were taken with the hold); voided invoices do not come back.
        const [kept] = await redisPipeline([["HGET", workKey(folder), `d:${id}`]]);
        for (const draft of typeof kept === "string" ? kept.split(",").filter((d) => INVOICE_ID.test(d)) : []) {
          await onAccount("POST", account, `/invoices/${encodeURIComponent(draft)}`, new URLSearchParams({ auto_advance: "true", "metadata[closing_draft]": "" }), undefined, `closing-draft-back:${draft}:${sub.metadata?.store_hold}`);
        }
        if (typeof kept === "string") await redisPipeline([["HDEL", workKey(folder), `d:${id}`]]);
        out.released += 1;
      } catch (error) {
        failed += 1;
        console.error("letting a held member's charges go again failed; tried again tomorrow", error);
      }
    });
    out.failed += failed;
    // A page with a member not let go is read again the next day: its cursor does not move past it.
    return all && failed === 0;
  });
  out.done = reached && out.failed === 0;
  return out;
}

/** The members' last payments a store has written down, by subscription. */
export async function paidPeriods(store: Store): Promise<Map<string, PaidPeriod>> {
  const out = new Map<string, PaidPeriod>();
  if (!isRedisConfigured()) return out;
  const [raw] = await redisPipeline([["HGETALL", paidKey(await storeFolder(storeRef(store)))]]);
  const flat = Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    try {
      const row = JSON.parse(flat[i + 1]) as PaidPeriod;
      if (SUB_ID.test(flat[i]) && typeof row.amt === "number" && typeof row.inv === "string") out.set(flat[i], row);
    } catch {
      // A row that cannot be read is left out, never guessed at.
    }
  }
  return out;
}

/** Writes back what became of one member's refund. */
export async function savePaidPeriod(store: Store, sub: string, row: PaidPeriod): Promise<void> {
  await redisPipeline([["HSET", paidKey(await storeFolder(storeRef(store))), sub, JSON.stringify(row)]]);
}

/** Once the store is closed or runs again: its written-down payments are deleted, and it leaves the line. */
export async function forgetHeld(store: Store, folder: string): Promise<void> {
  await redisPipeline([["DEL", paidKey(folder), workKey(folder)], ["ZREM", HELD_INDEX, storeRef(store)]]);
  await forgetCredit(folder);
}

export type Released = { key: string; state: "released" | "held" | "closing" | "gone" };

/**
 * The daily walk of the stores whose members are held: a store whose plan
 * runs again (or ended again, on another day) has every member let go, its
 * buyers told it stays (`staysOpen`, lib/closing-buyers.ts), and leaves the
 * line. Bounded by `deadline`; what is not reached is the next day's.
 */
export async function releaseRestarted(deadline: number, staysOpen: (store: Store, until: number) => Promise<boolean>, now = Date.now()): Promise<Released[]> {
  if (!isRedisConfigured()) return [];
  const out: Released[] = [];
  const flat: string[] = [];
  for (let from = 0; from < 100_000; from += 500) {
    const [raw] = await redisPipeline([["ZRANGEBYSCORE", HELD_INDEX, "-inf", "+inf", "WITHSCORES", "LIMIT", from, 500]]);
    const page = Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
    flat.push(...page);
    if (page.length < 1000) break;
  }
  for (let i = 0; i + 1 < flat.length; i += 2) {
    if (Date.now() > deadline) break;
    const key = flat[i];
    const endedAt = Number(flat[i + 1]);
    const store = await storeForEmail(key).catch(() => null);
    if (!store) {
      await redisPipeline([["ZREM", HELD_INDEX, key]]);
      out.push({ key, state: "gone" });
      continue;
    }
    const stillClosing = standingOf(store, now / 1000) === "ended" && Date.parse(store.planEndedAt) === endedAt;
    if (stillClosing) {
      out.push({ key, state: "closing" });
      continue;
    }
    try {
      const done = await releaseHolds(store, deadline, Math.floor(now / 1000));
      const told = done.done ? await staysOpen(store, deadline) : false;
      if (!done.done || !told) {
        out.push({ key, state: "held" });
        continue;
      }
      await forgetHeld(store, await storeFolder(storeRef(store)));
      out.push({ key, state: "released" });
    } catch (error) {
      console.error("letting a restarted store's members go again failed; tried again tomorrow", error);
      out.push({ key, state: "held" });
    }
  }
  return out;
}

/**
 * While the store is closing: the last payment kept for each of a person's
 * memberships, to give back the time they paid for, for the copy of their
 * data (619 [SZ3], lib/person-copy.ts). Only reads.
 */
export async function heldPaymentsOf(store: Store, email: string): Promise<(PaidPeriod & { subscription: string })[]> {
  if (!isRedisConfigured()) return [];
  const address = email.trim().toLowerCase();
  const folder = await storeFolder(storeRef(store));
  const [raw] = await redisPipeline([["HGETALL", paidKey(folder)]]);
  const flat = Array.isArray(raw) ? raw.map(String) : [];
  const out: (PaidPeriod & { subscription: string })[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    try {
      const row = JSON.parse(flat[i + 1]) as PaidPeriod;
      if (typeof row.e === "string" && row.e.trim().toLowerCase() === address) out.push({ ...row, subscription: flat[i] });
    } catch {
      // Not a payment row: skipped, as the closing itself skips it.
    }
  }
  return out;
}
