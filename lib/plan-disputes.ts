/**
 * The daily reading of disputes on our own Stripe account (232 [CA1] unit
 * 5): a creator who disputes a payment they made to us for their plan gets
 * what costs us to run paused, as for an unpaid renewal, and the dispute is
 * written on the store's record (lib/plan-dispute-rules.ts).
 *
 * Stripe keeps the subscription active and the invoice paid when a payment
 * is disputed, and we have no webhook on our own account, so this reads
 * Stripe's list of disputes opened in the last LOOKBACK_DAYS, newest first:
 * a new one is written, and one already written takes its new status, so a
 * decision the bank makes later is seen too.
 *
 * Bounded: a deadline, at most MAX_PAGES pages of a hundred and MAX_REREADS
 * re-reads by id. What each dispute turned out to be is remembered
 * (SEEN_KEY), so a dispute already settled costs no Stripe read when it is
 * listed again and every run reaches the newest first. One dispute that
 * cannot be read never stops the others. Only reads Stripe; the writes are
 * the store's own record and that memory.
 *
 * The Store assistant's own payments are not handled here: its sync already
 * ends a disputed add-on and never sells it again (lib/assistant-billing.ts).
 * A payment that is not a plan invoice (no invoice, or an invoice whose
 * subscription names no store) is counted as unmatched and logged.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { isAddOn, isBillingConfigured, onPlatformAt } from "@/lib/billing";
import { type PlanDisputeStatus, coveredUntil, disputeStatusOf } from "@/lib/plan-dispute-rules";
import { recordPlanDispute, storeForHandle, storeForId, storeRef } from "@/lib/store";
import { type StripePage, readStripePage } from "@/lib/stripe-list";

/** The version whose charge still names its invoice and whose invoice names its subscription. */
const DISPUTE_VERSION = "2024-06-20";
export const LOOKBACK_DAYS = 120;
export const MAX_PAGES = 5;
/** The most disputes still open re-read by id in one run. */
export const MAX_REREADS = 50;
/** How long a dispute that matched no plan is asked about again. */
export const UNMATCHED_RETRY_DAYS = 7;
/**
 * What each dispute already read turned out to be, by id: "final" (decided,
 * written), "unmatched:<seconds>" (not a plan payment, asked again for a
 * week), or "open:<store id>" (the store's id, never an address). A known
 * one costs no Stripe read when it is listed again, so the newest page is
 * always reached first and a run never spends its time on settled ones.
 */
export const SEEN_KEY = "nl:plan-disputes:seen";
const SEEN_SECONDS = 400 * 24 * 60 * 60;
const DISPUTE_ID = /^du_[A-Za-z0-9]+$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]+$/;

export type DisputeCounts = { seen: number; recorded: number; unmatched: number; reread: number; failed: number; complete: boolean };

const objectOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const idOf = (value: unknown): string => (typeof value === "string" ? value : typeof objectOf(value)?.id === "string" ? String(objectOf(value)!.id) : "");

async function remember(id: string, what: string): Promise<void> {
  await redisPipeline([["HSET", SEEN_KEY, id, what], ["EXPIRE", SEEN_KEY, SEEN_SECONDS]]);
}

/**
 * Whether the store with this id is confirmed gone: its id's key read exactly
 * (rule 24), EXISTS answering 0. 1 is "still there"; any other reply, or none,
 * throws UnknownReplyError.
 */
async function storeIdGone(sid: string): Promise<boolean> {
  // The same key lib/store.ts keeps a store's id under (`storeIdKey`, "nl:store:id:<id>"); written here because lib/store.ts
  // is reserved by another unit. tests/plan-disputes-open-mark.test.ts reads a real store through it: a different key
  // would answer 0 and give a live store's open mark up, which that test fails on.
  const n = countOf(repliesFor(await redisPipeline([["EXISTS", `nl:store:id:${sid}`]]), 1)?.[0]);
  if (n === null || n > 1) throw new UnknownReplyError("a store's id");
  return n === 0;
}

/** Writes a dispute's status on a store already known. Answers whether it changed. */
async function writeStatus(sid: string, id: string, status: PlanDisputeStatus, at: number, coversUntil: number, nowSeconds: number): Promise<boolean> {
  const store = await storeForId(sid);
  if (!store) {
    // storeForId answers null for a reply it could not read, too. Giving the open mark up means the dispute is never
    // re-read, so a later decision would never reach the store (a creator whose dispute was won kept paused): it is
    // given up only when the store's id is confirmed gone; otherwise this read fails and the next run reads it again.
    if (!(await storeIdGone(sid))) throw new UnknownReplyError("the disputed plan's store");
    await remember(id, `unmatched:${nowSeconds}`);
    return false;
  }
  const before = JSON.stringify(store.planDisputes ?? []);
  const after = await recordPlanDispute(storeRef(store), { id, status, at, coversUntil }, nowSeconds);
  if (!after) throw new Error("the dispute could not be written down");
  await remember(id, status === "open" ? `open:${sid}` : "final");
  return JSON.stringify(after.planDisputes ?? []) !== before;
}

/** Writes one listed dispute on its store. Answers what came of it. */
async function applyDispute(dispute: Record<string, unknown>, known: string | undefined, nowSeconds: number): Promise<"recorded" | "unchanged" | "unmatched"> {
  const id = typeof dispute.id === "string" ? dispute.id : "";
  const created = Number.isSafeInteger(dispute.created) ? (dispute.created as number) : 0;
  if (!DISPUTE_ID.test(id) || created <= 0) return "unmatched";
  if (known === "final") return "unchanged";
  // Not a plan payment: asked again for UNMATCHED_RETRY_DAYS, in case the store's record caught up.
  if (known?.startsWith("unmatched:") && nowSeconds - Number(known.slice(10)) > UNMATCHED_RETRY_DAYS * 24 * 60 * 60) return "unmatched";
  const invoice = objectOf(objectOf(dispute.charge)?.invoice);
  const status = disputeStatusOf(dispute.status);
  if (known?.startsWith("open:")) {
    return (await writeStatus(known.slice(5), id, status, created, coveredUntil(invoice), nowSeconds)) ? "recorded" : "unchanged";
  }
  const subscriptionId = idOf(invoice?.subscription);
  if (!invoice || !SUBSCRIPTION_ID.test(subscriptionId)) {
    await remember(id, known?.startsWith("unmatched:") ? known : `unmatched:${nowSeconds}`);
    return "unmatched";
  }
  const subscription = await onPlatformAt(DISPUTE_VERSION, "GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  const handle = objectOf(subscription.metadata)?.store;
  const store = isAddOn(subscription) || typeof handle !== "string" || !handle ? null : await storeForHandle(handle);
  // Only a subscription this store wrote down as its plan, or one of the same Stripe customer.
  if (!store || (store.subscriptionId !== subscriptionId && !sameCustomer(store.stripeCustomerId, subscription))) {
    await remember(id, known?.startsWith("unmatched:") ? known : `unmatched:${nowSeconds}`);
    return "unmatched";
  }
  return (await writeStatus(store.sid, id, status, created, coveredUntil(invoice), nowSeconds)) ? "recorded" : "unchanged";
}

function sameCustomer(customerId: string | null | undefined, subscription: Record<string, unknown>): boolean {
  return Boolean(customerId) && idOf(subscription.customer) === customerId;
}

/**
 * Reads the disputes until `deadline` (milliseconds since the epoch): the
 * newest first, every run, so a new one is never left behind older ones;
 * then, by id, the ones still open that the list no longer reaches (older
 * than LOOKBACK_DAYS), so a late decision is still seen.
 */
export async function syncPlanDisputes(deadline: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<DisputeCounts> {
  const counts: DisputeCounts = { seen: 0, recorded: 0, unmatched: 0, reread: 0, failed: 0, complete: false };
  if (!isRedisConfigured() || !isBillingConfigured()) return counts;
  // The disputes already seen, only as a whole list of field/value pairs (rule 24): unknown, the run throws (the daily job
  // logs it and the next run reads again) rather than handle every dispute as new and skip the open ones' re-read.
  const flat = stringList(repliesFor(await redisPipeline([["HGETALL", SEEN_KEY]]), 1)?.[0]);
  if (!flat || flat.length % 2) throw new UnknownReplyError("the plan disputes seen");
  const seen = new Map<string, string>();
  for (let i = 0; i + 1 < flat.length; i += 2) seen.set(flat[i], flat[i + 1]);
  const listed = new Set<string>();
  const since = nowSeconds - LOOKBACK_DAYS * 24 * 60 * 60;
  let after = "";
  let listDone = false;
  let readable = true;
  for (let page = 0; page < MAX_PAGES && !listDone; page += 1) {
    if (Date.now() > deadline) return counts;
    const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
    query.append("expand[]", "data.charge.invoice");
    if (after) query.set("starting_after", after);
    // Read in its exact shape (lib/stripe-list.ts): a page in another shape stops the reading here, and a row not readable
    // is a failure counted; either way the run is not complete, so nothing is taken as read that was not.
    let read: StripePage;
    try {
      read = readStripePage(await onPlatformAt(DISPUTE_VERSION, "GET", `/disputes?${query}`), () => true, DISPUTE_ID);
    } catch (error) {
      counts.failed += 1;
      readable = false;
      console.error("reading plan disputes failed", error);
      break;
    }
    if (read.unreadable) {
      counts.failed += read.unreadable;
      readable = false;
    }
    const rows: Record<string, unknown>[] = read.rows;
    for (const dispute of rows) {
      if (Date.now() > deadline) return counts;
      counts.seen += 1;
      const id = typeof dispute.id === "string" ? dispute.id : "";
      if (id) listed.add(id);
      try {
        const result = await applyDispute(dispute, seen.get(id), nowSeconds);
        if (result === "recorded") counts.recorded += 1;
        if (result === "unmatched") counts.unmatched += 1;
      } catch (error) {
        counts.failed += 1;
        console.error(`reading plan dispute ${id || "?"} failed`, error);
      }
      if (DISPUTE_ID.test(id)) after = id;
    }
    if (!read.hasMore) listDone = true;
    else if (!read.lastId) {
      // More pages, and no readable last row to read them from: not complete.
      readable = false;
      break;
    }
  }
  if (!listDone) console.error("plan disputes: more than one run's pages; the oldest wait for the next run");
  // Still open, and no longer in the list: asked by id.
  const stale = [...seen].filter(([id, what]) => what.startsWith("open:") && !listed.has(id)).slice(0, MAX_REREADS);
  for (const [id, what] of stale) {
    if (Date.now() > deadline) return counts;
    try {
      const dispute = await onPlatformAt(DISPUTE_VERSION, "GET", `/disputes/${encodeURIComponent(id)}`);
      if (dispute.id !== id) throw new Error("Stripe answered another dispute");
      counts.reread += 1;
      const created = Number.isSafeInteger(dispute.created) ? (dispute.created as number) : 0;
      if (await writeStatus(what.slice(5), id, disputeStatusOf(dispute.status), created, 0, nowSeconds)) counts.recorded += 1;
    } catch (error) {
      counts.failed += 1;
      console.error(`re-reading plan dispute ${id} failed`, error);
    }
  }
  // Complete only when nothing failed: a dispute or a re-read that could not be handled is read again next run.
  counts.complete = listDone && readable && counts.failed === 0 && stale.length < MAX_REREADS;
  return counts;
}
