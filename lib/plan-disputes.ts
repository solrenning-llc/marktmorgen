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
import { isAddOn, isBillingConfigured, onPlatformAt } from "@/lib/billing";
import { type PlanDisputeStatus, coveredUntil, disputeStatusOf } from "@/lib/plan-dispute-rules";
import { recordPlanDispute, storeForHandle, storeForId, storeRef } from "@/lib/store";
import { type StripePage, readStripePage } from "@/lib/stripe-list";
import { CLAWBACKS_PER_RUN, clawBackInviteCredits } from "@/lib/creator-invite-clawback";

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
/**
 * Whether Stripe's reply is the object asked for, by its own id (rule 30): another's, or one with none, decides nothing.
 * A reply that is not an object (a JSON null, a string, a number) is not its own either, never a TypeError (Claude 6 on #3098).
 */
const isOwnReply = (reply: unknown, id: string): boolean =>
  reply !== null && typeof reply === "object" && Object.hasOwn(reply, "id") && (reply as { id?: unknown }).id === id;
const idOf = (value: unknown): string => (typeof value === "string" ? value : typeof objectOf(value)?.id === "string" ? String(objectOf(value)!.id) : "");

async function remember(id: string, what: string): Promise<void> {
  await redisPipeline([["HSET", SEEN_KEY, id, what], ["EXPIRE", SEEN_KEY, SEEN_SECONDS]]);
}

/**
 * A lost dispute on a plan invoice gives back the invite credit earned on it that is still unused (the owner's decision
 * of 19 November 2026 on #4514, part (b); lib/creator-invite-clawback.ts). Not done (a reply that does not read): the
 * dispute is still written on the store, but remembered as open, so the next run asks about it again by id.
 */
async function clawBack(status: PlanDisputeStatus, invoiceId: string, nowSeconds: number, room: { left: number }): Promise<boolean> {
  if (status !== "lost" || !invoiceId) return true;
  // Past this run's ceiling (CLAWBACKS_PER_RUN): kept open and handled the next day, never skipped.
  if (room.left <= 0) return false;
  room.left -= 1;
  try {
    await clawBackInviteCredits(invoiceId, nowSeconds);
    return true;
  } catch (error) {
    console.error(`taking back the invite credit of ${invoiceId} failed`, error);
    return false;
  }
}

/** Writes a dispute's status on a store already known. Answers whether it changed. */
async function writeStatus(sid: string, id: string, status: PlanDisputeStatus, at: number, coversUntil: number, nowSeconds: number, clawed = true): Promise<boolean> {
  const store = await storeForId(sid);
  if (!store) {
    await remember(id, `unmatched:${nowSeconds}`);
    return false;
  }
  const before = JSON.stringify(store.planDisputes ?? []);
  const after = await recordPlanDispute(storeRef(store), { id, status, at, coversUntil }, nowSeconds);
  if (!after) throw new Error("the dispute could not be written down");
  await remember(id, status === "open" || !clawed ? `open:${sid}` : "final");
  if (!clawed) throw new Error("the invite credit of a lost dispute is not taken back yet");
  return JSON.stringify(after.planDisputes ?? []) !== before;
}

/** Writes one listed dispute on its store. Answers what came of it. */
async function applyDispute(dispute: Record<string, unknown>, known: string | undefined, nowSeconds: number, room: { left: number }): Promise<"recorded" | "unchanged" | "unmatched"> {
  const id = typeof dispute.id === "string" ? dispute.id : "";
  const created = Number.isSafeInteger(dispute.created) ? (dispute.created as number) : 0;
  if (!DISPUTE_ID.test(id) || created <= 0) return "unmatched";
  if (known === "final") return "unchanged";
  // Not a plan payment: asked again for UNMATCHED_RETRY_DAYS, in case the store's record caught up.
  if (known?.startsWith("unmatched:") && nowSeconds - Number(known.slice(10)) > UNMATCHED_RETRY_DAYS * 24 * 60 * 60) return "unmatched";
  const invoice = objectOf(objectOf(dispute.charge)?.invoice);
  const status = disputeStatusOf(dispute.status);
  if (known?.startsWith("open:")) {
    const clawed = await clawBack(status, idOf(invoice), nowSeconds, room);
    return (await writeStatus(known.slice(5), id, status, created, coveredUntil(invoice), nowSeconds, clawed)) ? "recorded" : "unchanged";
  }
  const subscriptionId = idOf(invoice?.subscription);
  if (!invoice || !SUBSCRIPTION_ID.test(subscriptionId)) {
    await remember(id, known?.startsWith("unmatched:") ? known : `unmatched:${nowSeconds}`);
    return "unmatched";
  }
  const subscription = await onPlatformAt(DISPUTE_VERSION, "GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  // Another subscription's reply, or one with no id: neither written on a store nor remembered as unmatched. Counted as
  // failed, and the dispute is read again whole on the next run.
  if (!isOwnReply(subscription, subscriptionId)) throw new Error("Stripe answered for another subscription");
  const handle = objectOf(subscription.metadata)?.store;
  const store = isAddOn(subscription) || typeof handle !== "string" || !handle ? null : await storeForHandle(handle);
  // Only a subscription this store wrote down as its plan, or one of the same Stripe customer.
  if (!store || (store.subscriptionId !== subscriptionId && !sameCustomer(store.stripeCustomerId, subscription))) {
    await remember(id, known?.startsWith("unmatched:") ? known : `unmatched:${nowSeconds}`);
    return "unmatched";
  }
  const clawed = await clawBack(status, idOf(invoice), nowSeconds, room);
  return (await writeStatus(store.sid, id, status, created, coveredUntil(invoice), nowSeconds, clawed)) ? "recorded" : "unchanged";
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
  const room = { left: CLAWBACKS_PER_RUN };
  if (!isRedisConfigured() || !isBillingConfigured()) return counts;
  const [raw] = await redisPipeline([["HGETALL", SEEN_KEY]]);
  const seen = new Map<string, string>();
  if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) seen.set(String(raw[i]), String(raw[i + 1]));
  else if (raw && typeof raw === "object") for (const [key, value] of Object.entries(raw)) seen.set(key, String(value));
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
        const result = await applyDispute(dispute, seen.get(id), nowSeconds, room);
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
      // The same read, with its invoice, so a dispute lost late still gives back the invite credit earned on it.
      const dispute = await onPlatformAt(DISPUTE_VERSION, "GET", `/disputes/${encodeURIComponent(id)}?${new URLSearchParams({ "expand[]": "charge.invoice" })}`);
      if (dispute.id !== id) throw new Error("Stripe answered another dispute");
      counts.reread += 1;
      const created = Number.isSafeInteger(dispute.created) ? (dispute.created as number) : 0;
      const status = disputeStatusOf(dispute.status);
      const clawed = await clawBack(status, idOf(objectOf(objectOf(dispute.charge)?.invoice)), nowSeconds, room);
      if (await writeStatus(what.slice(5), id, status, created, 0, nowSeconds, clawed)) counts.recorded += 1;
    } catch (error) {
      counts.failed += 1;
      console.error(`re-reading plan dispute ${id} failed`, error);
    }
  }
  counts.complete = listDone && readable && stale.length < MAX_REREADS;
  return counts;
}
