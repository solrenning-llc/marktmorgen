/**
 * Keeping every store's "paid up" snapshot true to Stripe, once a day.
 *
 * The snapshot is what lets a buyer's page open without waiting on Stripe,
 * and until now it was refreshed only when its creator opened the studio. A
 * creator who cancelled, or whose card stopped paying, and then simply never
 * came back, kept a till that took money for ever. This closes that, from
 * Stripe's side, without anybody having to open anything:
 *
 *   1. Every subscription on our own account is read, newest first, and the
 *      store named in its metadata is brought in line with it. A subscription
 *      in good standing that its store never wrote down — the creator paid
 *      and the way back did not arrive — is written down, if it is plainly
 *      that store's (lib/billing.ts, ownedBy).
 *   2. Every store that still counts as paid up, and whose subscription the
 *      first step did not see, is asked about on its own. That covers the one
 *      Stripe does not have at all: an id from another key, or another mode.
 *
 * Bounded by a deadline, safe to run as often as it is called, and it only
 * writes where the snapshot is actually wrong. The walk through the stores
 * picks up the next day where it stopped.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { applyListedAssistant } from "@/lib/assistant-billing";
import {
  type SubscriptionState,
  isAddOn,
  hasContractFunding,
  isBillingConfigured,
  listSubscriptions,
  ownedBy,
  readSubscription,
  startedFrom,
  startedFromObservedSubscription,
  stateOf,
} from "@/lib/billing";
import { ENDED_INDEX } from "@/lib/plan-standing";
import { allowanceWindow, samePeriod } from "@/lib/allowance-window";
import { type Store, setSubscription, storeForHandle, storeRef, storesAfter } from "@/lib/store";
import { refusePlanIfClosing } from "@/lib/closing-plan-guard";

const MAX_PAGES = 50;
const MAX_SCAN_STEPS = 500;
/** Where the walk through the stores stopped, when the deadline stopped it. */
const CURSOR_KEY = "nl:billing:sync:cursor";
const CURSOR_SECONDS = 7 * 24 * 60 * 60;
/** Where the reading of Stripe's list stopped, when the deadline stopped it. */
const LIST_CURSOR_KEY = "nl:billing:sync:after";
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]+$/;

export type SyncCounts = {
  /** Subscriptions read from Stripe. */
  seen: number;
  /** Stores whose snapshot was wrong and was corrected. */
  updated: number;
  /** Paying subscriptions a store had never written down, now written down. */
  adopted: number;
  /** Stores asked about one by one. */
  checked: number;
  failed: number;
  /** Whether both steps reached the end before the deadline. */
  complete: boolean;
};

/**
 * Writes what Stripe says about the store's own subscription into its
 * snapshot, the same way the studio does when it is opened. "unknown" means
 * Stripe could not be asked, and changes nothing. Returns whether it wrote.
 */
export async function recordState(store: Store, state: SubscriptionState): Promise<boolean> {
  if (state.state === "unknown") return false;
  const active = state.state === "active";
  const plan = active ? { tier: state.tier, cycle: state.cycle, trialEnds: state.trialing ? state.until : 0, shared: state.shared, period: state.period, renewalUnpaid: state.renewalUnpaid === true } : null;
  if (
    active === store.subscriptionActive &&
    (!plan || (plan.tier === store.tier && plan.cycle === store.cycle && plan.trialEnds === store.trialEnds && plan.shared === store.shared && samePeriod(plan.period, store.period ?? null) &&
      plan.renewalUnpaid === (store.renewalUnpaidSince ?? 0) > 0))
  ) {
    return false;
  }
  return (await setSubscription(storeRef(store), { active, ...(plan ?? {}) })) !== null;
}

/**
 * Reads a paying store's billing month from Stripe when its record has none
 * the window can be made from (lib/allowance-window.ts): a record from before
 * the period was kept, or one whose renewal the daily job has not seen yet.
 * Called by the studio before it counts a request, so the studio is never
 * shut out by the very thing it would put right. Answers the store as it is
 * now; unchanged when Stripe cannot be asked.
 */
export async function refreshPeriod(store: Store): Promise<Store> {
  if (!store.subscriptionId || !isBillingConfigured() || allowanceWindow(store)) return store;
  try {
    const state = await readSubscription(store.subscriptionId,store);
    if (!(await recordState(store, state))) return store;
    return (await storeForHandle(store.handle)) ?? store;
  } catch (error) {
    console.error("reading a store's billing month failed", error);
    return store;
  }
}

/**
 * Writes down, the day the email about it goes, that a store's renewal is
 * unpaid (lib/billing-reminders.ts, 232 [CA1] unit 4), so what the email
 * says has stopped has stopped. Only for the subscription the store itself
 * wrote down, and never for one with contract funding (its own observation,
 * lib/contract-funding.ts). Answers whether the store now records it unpaid,
 * or null when no store keeps this subscription; throws when it could not be
 * written, so the email waits for the next run.
 */
export async function recordUnpaidRenewal(subscription: Record<string, unknown>): Promise<boolean | null> {
  const id = typeof subscription.id === "string" ? subscription.id : "";
  const handle = (subscription.metadata as Record<string, unknown> | null | undefined)?.store;
  if (!id || typeof handle !== "string" || !handle || isAddOn(subscription)) return null;
  const store = await storeForHandle(handle);
  if (!store || store.subscriptionId !== id) return null;
  const state = stateOf(subscription);
  if (state.state !== "active" || !state.renewalUnpaid || hasContractFunding(subscription)) return (store.renewalUnpaidSince ?? 0) > 0;
  await recordState(store, state);
  const after = await storeForHandle(handle);
  if (!after || !((after.renewalUnpaidSince ?? 0) > 0)) throw new Error("the unpaid renewal could not be written down");
  return true;
}

/** Brings the store named by one listed subscription in line with it. */
async function applyListed(subscription: Record<string, unknown>, counts: SyncCounts): Promise<void> {
  // The Store assistant's own subscription: brought in line with its store by its own rules (lib/assistant-billing.ts).
  if (isAddOn(subscription)) {
    if (await applyListedAssistant(subscription)) counts.updated += 1;
    return;
  }
  const id = typeof subscription.id === "string" ? subscription.id : "";
  const meta = subscription.metadata as Record<string, string> | null | undefined;
  const handle = meta?.store;
  if (!id || typeof handle !== "string" || !handle) return;
  const store = await storeForHandle(handle);
  // A plan for a store already closing, or already removed, is never written
  // down: it is ended and its payment returned (queue item 307 [EC1],
  // lib/closing-plan-guard.ts). Only one that can still charge is looked at.
  if (subscription.status !== "canceled" && subscription.status !== "incomplete_expired" && (!store || (store.planEndedAt && ownedBy(store, subscription)))) {
    const customer = subscription.customer;
    const customerId = typeof customer === "string" ? customer : typeof (customer as { id?: unknown } | null)?.id === "string" ? String((customer as { id: string }).id) : "";
    if ((await refusePlanIfClosing({ store, handle, subscriptionId: id, customerId })) !== "no") return;
  }
  if (!store) return;

  // The one this store wrote down: Stripe's word stands.
  if (store.subscriptionId === id) {
    const state=stateOf(subscription);
    if(state.state==='active'&&hasContractFunding(subscription)){
      const observed=await startedFromObservedSubscription(store,subscription);if(!observed)return;
      state.period=observed.period;
    }
    if (await recordState(store, state)) counts.updated += 1;
    return;
  }

  // Another subscription under this store's address. Written down only when
  // it is paying, the store has nothing paying written down, and it is
  // plainly this store's. A second paying one beside a first is left for a
  // person to sort out — a refund is not something to decide in a loop.
  const started = startedFrom(subscription);
  if (!started || !ownedBy(store, subscription)) return;
  if (store.subscriptionActive && store.subscriptionId) {
    console.error(`store ${store.handle} has a second subscription in good standing: ${id}`);
    return;
  }
  const verified=await startedFromObservedSubscription(store,subscription);
  if(verified && await setSubscription(storeRef(store),verified)) counts.adopted += 1;
}

/** Step 1: every subscription on our account, newest first. */
async function syncListed(deadline: number, seen: Set<string>, counts: SyncCounts): Promise<boolean> {
  // A list longer than one run carries on the next day where it stopped,
  // so the oldest subscriptions are reached too.
  const [saved] = await redisPipeline([["GET", LIST_CURSOR_KEY]]);
  let after: string | undefined = typeof saved === "string" && SUBSCRIPTION_ID.test(saved) ? saved : undefined;
  const stop = async () => {
    if (after) await redisPipeline([["SET", LIST_CURSOR_KEY, after, "EX", CURSOR_SECONDS]]);
    return false;
  };
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (Date.now() > deadline) return stop();
    const { data, hasMore } = await listSubscriptions("all", after);
    for (const subscription of data) {
      if (typeof subscription.id === "string") seen.add(subscription.id);
      counts.seen += 1;
      try {
        await applyListed(subscription, counts);
      } catch (error) {
        counts.failed += 1;
        console.error("settling a store's subscription failed", error);
      }
    }
    const last = data[data.length - 1];
    if (!hasMore || typeof last?.id !== "string") {
      await redisPipeline([["DEL", LIST_CURSOR_KEY]]);
      return true;
    }
    after = last.id;
  }
  return stop();
}

/** Step 2: stores still paid up whose subscription step 1 did not see. */
async function syncStores(deadline: number, seen: Set<string>, counts: SyncCounts): Promise<boolean> {
  const [saved] = await redisPipeline([["GET", CURSOR_KEY]]);
  let cursor = typeof saved === "string" && /^\d+$/.test(saved) ? saved : "0";
  for (let step = 0; step < MAX_SCAN_STEPS; step += 1) {
    if (Date.now() > deadline) break;
    const { stores, next } = await storesAfter(cursor);
    // Every store whose plan has ended is in the line the daily job for
    // such stores walks (lib/plan-closing.ts). It is put there the moment
    // its plan ends (lib/store.ts); this puts back one that write missed.
    const ended = stores.filter((store) => !store.subscriptionActive && Number.isFinite(Date.parse(store.planEndedAt)));
    if (ended.length) {
      await redisPipeline(ended.map((store) => ["ZADD", ENDED_INDEX, "NX", Date.parse(store.planEndedAt), storeRef(store)])).catch((error) =>
        console.error("could not keep the line of ended plans", error),
      );
    }
    for (const store of stores) {
      if (!store.subscriptionActive || !store.subscriptionId || seen.has(store.subscriptionId)) continue;
      counts.checked += 1;
      try {
        if (await recordState(store, await readSubscription(store.subscriptionId,store))) counts.updated += 1;
      } catch (error) {
        counts.failed += 1;
        console.error("checking a store's subscription failed", error);
      }
    }
    cursor = next;
    if (cursor === "0") {
      await redisPipeline([["DEL", CURSOR_KEY]]);
      return true;
    }
  }
  await redisPipeline([["SET", CURSOR_KEY, cursor, "EX", CURSOR_SECONDS]]);
  return false;
}

/** Runs both steps until `deadline` (milliseconds since the epoch). */
export async function syncSubscriptions(deadline: number): Promise<SyncCounts> {
  const counts: SyncCounts = { seen: 0, updated: 0, adopted: 0, checked: 0, failed: 0, complete: false };
  if (!isRedisConfigured() || !isBillingConfigured()) return counts;
  const seen = new Set<string>();
  // Stripe's list gets at most two thirds of the time, so the stores that
  // count as paid up are always asked about too.
  const listed = await syncListed(Date.now() + ((deadline - Date.now()) * 2) / 3, seen, counts);
  const walked = await syncStores(deadline, seen, counts);
  counts.complete = listed && walked;
  return counts;
}
