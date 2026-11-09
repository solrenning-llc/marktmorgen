/**
 * A plan paid for a store that is already closing (queue item 307 [EC1],
 * held to item 569 [NC1]: no wrong charge reaches a customer, and nothing
 * needs a person to put it right).
 *
 * A plan checkout opened before a store's closing day can still be finished
 * on it. From the start of that day the store is being removed and its
 * members' memberships have ended, so a plan paid then would be paid for and
 * never given. So, wherever a plan subscription comes to light while its
 * store is in its closing day (FINAL_INDEX) or after it was removed
 * (the way back from Stripe, the daily sync, the closing job itself):
 *
 *   - it is put in line here (UNDO_KEY) before anything else is done, so a
 *     step that fails is tried again on every later run, never dropped;
 *   - the subscription is ended at once (no final bill, no proration);
 *   - its open invoices are voided and its drafts deleted;
 *   - every payment made for it since the closing day began is refunded in
 *     full. The refund's idempotency key is the invoice and the number of
 *     refunds of that charge that have failed, so a retry of any caller
 *     never refunds twice, and a refund the bank turned down is made again;
 *   - the creator is told, once, that the store had already closed and the
 *     payment was returned;
 *   - only then is it marked settled, its address and name dropped; it is
 *     looked at again on each run for DONE_KEEP_DAYS (a refund the bank
 *     sends back is made again, the creator not told twice), then taken out.
 *
 * When the day starts, the open plan checkouts of the store are expired
 * (POST /v1/checkout/sessions/:id/expire, which only an `open` session
 * takes), so most of these never happen; and a store whose records are gone
 * is still known for SHUT_DAYS by a mark of its hashed address (SHUT_PREFIX).
 *
 *   nl:closing:undo           field a plan subscription, value its Undo: the
 *                             company's; once settled only its dates are
 *                             kept, and taken out DONE_KEEP_DAYS later
 *   nl:closing:shut:<hash>    the closing day's start for a store's address
 *                             (hashed), expiring by itself after SHUT_DAYS
 */
import { createHash } from "node:crypto";
import { BillingError, type StartedSubscription, isBillingConfigured, onPlatform, ownedBy, startedFromObservedSubscription } from "@/lib/billing";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { EMAIL_PATTERN, normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { CUSTOMER_PATTERN, SUBSCRIPTION_PATTERN, type Store, saleHandles, storeRef } from "@/lib/store";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { formatMoney } from "@/lib/money";
import { StripeListUnreadable, ownField, plainObject, readStripePage } from "@/lib/stripe-list";

export const UNDO_KEY = "nl:closing:undo";
const SHUT_PREFIX = "nl:closing:shut:";
/** How long a closed store's address is still known after its last closing run: past any checkout it had open (Stripe keeps one at most a day) and the daily sync after it. */
export const SHUT_DAYS = 30;
/**
 * How long a plan checkout opened for a store in its closing period lasts:
 * the shortest Stripe allows ("anywhere from 30 minutes to 24 hours after
 * Checkout Session creation", docs.stripe.com/api/checkout/sessions/create,
 * expires_at, read 30/10/2026), and a minute more so a clock a little
 * ahead of Stripe's is never refused.
 */
export const CLOSING_CHECKOUT_SECONDS = 31 * 60;

/**
 * The last moment a plan can be started to keep a store whose closing day
 * is `day` (ms): a checkout opened then has expired a minute before the day
 * begins, so none can be paid on it. Started again before then, the store
 * stays (the owner's decision of 30/10/2026, 18h16: starting again saves it).
 */
export function lastPlanMoment(day: number): number {
  return day - CLOSING_CHECKOUT_SECONDS * 1000 - 60_000;
}

/** The API version these reads are made at: a paid invoice names its `payment_intent` there. */
const AT = "2024-06-20";
const SESSION = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const OBJECT_ID = /^[a-z]{2,4}_[A-Za-z0-9]{6,128}$/;

/**
 * Every row of one Stripe list on our account, each page read in its exact
 * shape (CX-123 rule 24, lib/stripe-list.ts). A page in another shape, a row
 * that cannot be read, or more pages than `pages` throws StripeListUnreadable:
 * what the list holds is then not known, and the caller keeps its step for the
 * next run instead of taking it as none.
 */
async function allRows(path: string, query: URLSearchParams, legible: (row: Record<string, unknown>) => boolean, pages: number, idPattern?: RegExp): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let page = 0; page < pages; page += 1) {
    const read = readStripePage(await onPlatform("GET", `${path}?${query}`, undefined, { version: AT }), legible, idPattern);
    if (read.unreadable > 0) throw new StripeListUnreadable(`${read.unreadable} rows of ${path} could not be read`);
    rows.push(...read.rows);
    if (!read.hasMore) return rows;
    if (!read.lastId) throw new StripeListUnreadable(`${path} has more pages and no row to read them from`);
    query.set("starting_after", read.lastId);
  }
  throw new StripeListUnreadable(`${path} has more than ${pages} pages`);
}

const textField = (row: Record<string, unknown>, name: string) => typeof ownField(row, name) === "string";
const wholeAtLeast = (value: unknown, least: number): value is number => Number.isSafeInteger(value) && (value as number) >= least;
/** Every status Stripe gives an invoice: another one is not known, never taken as "no payment". */
const INVOICE_STATUSES: ReadonlySet<unknown> = new Set(["draft", "open", "paid", "uncollectible", "void"]);
/** Every status Stripe gives a refund: another one is not known, never taken as "no refund". */
const REFUND_STATUSES: ReadonlySet<unknown> = new Set(["pending", "requires_action", "succeeded", "failed", "canceled"]);
/**
 * An invoice row read in its exact shape (CX-123 rule 24): its status, one of Stripe's own, and for a paid one every
 * field a refund is decided by. One that does not read is never taken as "no payment".
 */
const invoiceKnown = (row: Record<string, unknown>) => {
  const status = ownField(row, "status");
  if (!INVOICE_STATUSES.has(status)) return false;
  if (status !== "paid") return true;
  const transitions = ownField(row, "status_transitions");
  if (!plainObject(transitions)) return false;
  const paidAt = ownField(transitions, "paid_at");
  const intent = ownField(row, "payment_intent");
  return wholeAtLeast(ownField(row, "amount_paid"), 0) && wholeAtLeast(ownField(row, "created"), 1) && (paidAt === null || wholeAtLeast(paidAt, 1)) && (intent === null || typeof intent === "string");
};
const metadataKnown = (row: Record<string, unknown>) => {
  const meta = ownField(row, "metadata");
  return meta === null || plainObject(meta);
};

/** One plan subscription to undo. */
export type Undo = {
  /** The store's address it named. */
  h: string;
  /** Its customer, the creator. */
  c: string;
  /** The creator's address, when known; read from the customer otherwise. */
  to: string;
  /** The store's name, for the letter. */
  name: string;
  /** When the closing day began (ms): payments since then are refunded. */
  since: number;
  /** When the store's last plan ended (ms): a plan started after it is refunded whatever minute it was paid. */
  ended?: number;
  /** When it was put in line (ms). */
  at: number;
  /** Runs that could not settle it yet. */
  n: number;
  /** When it was all done (ms): kept DONE_KEEP_DAYS, so a retry of any caller finds it settled and tells nobody twice, and a refund the bank sends back later is made again. */
  done?: number;
  /** The creator was told: never told twice, even when a refund is made again later. */
  t?: 1;
  /** It was paid before the closing day began: it came too late to stop the closing, not after it began. */
  e?: 1;
};

/** Stripe: a refund can fail up to 30 days after it was asked for (docs.stripe.com/refunds, "Handle failed refunds", read 30/10/2026). A settled one is looked at again until then, and a little after. */
export const DONE_KEEP_DAYS = 40;

const shutKey = (handle: string) => `${SHUT_PREFIX}${createHash("sha256").update(handle.toLowerCase()).digest("hex").slice(0, 32)}`;

/** When a store's closing day began and when the plan before it ended (ms; 0 when not known). */
export type ClosingTimes = { since: number; ended: number };

/**
 * The store's plan subscriptions on our account, read from Stripe's list by
 * the store's customer: unlike its search, whose index can lag about a
 * minute, the list shows one made a moment ago. GET /v1/subscriptions takes
 * `customer`, `status` ("all": every status, canceled ones too) and `limit`
 * up to 100 (docs.stripe.com/api/subscriptions/list, read 30/10/2026). Only
 * those that name one of the store's addresses and are its own.
 */
export async function plansByCustomer(store: Store): Promise<Record<string, unknown>[]> {
  const customer = store.stripeCustomerId;
  if (!customer || !CUSTOMER_PATTERN.test(customer) || !isBillingConfigured()) return [];
  const observedStore = { ...store, previousHandles: [...store.previousHandles], releasedHandles: [...store.releasedHandles], stripeCustomerId: customer };
  const query = new URLSearchParams({ customer, status: "all", limit: "100" });
  query.append("expand[]", "data.customer");
  const page = await onPlatform("GET", `/subscriptions?${query}`);
  // The independent fallback may save a store and activate a funded plan.
  // It needs the same full-page proof as the two-read recovery path.
  const data = Object.getOwnPropertyDescriptor(page, "data");
  const more = Object.getOwnPropertyDescriptor(page, "has_more");
  const cursor = Object.getOwnPropertyDescriptor(page, "next_page");
  if (!data || !Object.hasOwn(data, "value") || !Array.isArray(data.value) || data.value.length > 100 ||
      !more || !Object.hasOwn(more, "value") || more.value !== false ||
      cursor && (!Object.hasOwn(cursor, "value") || cursor.value !== null && cursor.value !== undefined)) throw new Error("Subscription customer page is incomplete");
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < data.value.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(data.value, String(index));
    if (!entry || !Object.hasOwn(entry, "value")) throw new Error("Subscription customer page is incomplete");
    rows.push(entry.value);
  }
  const handles = saleHandles(observedStore);
  return rows
    .filter((row) => {
      const meta = row.metadata as Record<string, string> | null | undefined;
      return typeof row.id === "string" && SUBSCRIPTION_PATTERN.test(row.id) && typeof meta?.store === "string" && handles.has(meta.store) && ownedBy(observedStore, row);
    })
    .sort((a, b) => (Number(b.created) || 0) - (Number(a.created) || 0));
}

/** A plan of the store in good standing that Stripe's list shows: what keeps a closing store when its search has not caught up yet. */
export async function liveByCustomer(store: Store): Promise<StartedSubscription | null> {
  for (const row of await plansByCustomer(store)) {
    const started = await startedFromObservedSubscription(store, row);
    if (started) return started;
  }
  return null;
}

/**
 * Marks every address a closing store sells under, from its closing day's
 * start, with the end of its last plan; renewed on each closing run.
 */
export async function markShut(store: Pick<Store, "handle" | "previousHandles" | "releasedHandles"> & { planEndedAt?: string }, since: number, ended = Date.parse(store.planEndedAt ?? "")): Promise<void> {
  if (!isRedisConfigured()) return;
  const handles = [...saleHandles(store)].filter(Boolean);
  if (!handles.length) return;
  const value = `${Math.floor(since)}|${Number.isFinite(ended) && ended > 0 ? Math.floor(ended) : 0}`;
  await redisPipeline(handles.map((handle) => ["SET", shutKey(handle), value, "EX", SHUT_DAYS * 86_400]));
}

/** When the closing day of the store that sold under this address began, and its last plan ended, while that is still known. */
export async function shutOf(handle: string): Promise<ClosingTimes | null> {
  if (!handle || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", shutKey(handle)]]);
  if (raw === null || raw === undefined) return null;
  const [since, ended] = String(raw).split("|").map(Number);
  return Number.isFinite(since) && since > 0 ? { since, ended: Number.isFinite(ended) && ended > 0 ? ended : 0 } : null;
}

/** When the closing day of the store that sold under this address began, while that is still known. */
export async function shutSince(handle: string): Promise<number | null> {
  return (await shutOf(handle))?.since ?? null;
}

/**
 * When this store's closing day began and its plan ended, or null when it is
 * not in one. Only a store whose plan ended can be. A failed read throws:
 * the caller does not adopt a plan it could not check.
 */
export async function closingSince(store: Store): Promise<ClosingTimes | null> {
  if (!store.planEndedAt || !isRedisConfigured()) return null;
  const [score] = await redisPipeline([["ZSCORE", FINAL_INDEX, storeRef(store)]]);
  if (score === null || score === undefined || !Number.isFinite(Number(score))) return null;
  // The line's score is the end of the plan (lib/plan-closing.ts, closingDay).
  const ended = Number(score);
  const marked = await shutOf(store.handle);
  return { since: marked?.since ?? ended, ended };
}

/** "returned-early": returned, and it had been paid just before the closing day began (too late to stop it). */
export type Refused = "no" | "returned" | "returned-early" | "returning";

/**
 * Whether this plan subscription belongs to a store in its closing day (or,
 * `store` null, to one already removed whose address is still marked). If
 * so it is put in line and undone now as far as Stripe allows: "returned"
 * when everything is done, "returning" when a step is left for a later run.
 * The caller must never write it down as the store's plan unless "no".
 */
export async function refusePlanIfClosing(input: { store: Store | null; handle: string; subscriptionId: string; customerId: string; onStopped?: () => void }): Promise<Refused> {
  if (!SUBSCRIPTION_PATTERN.test(input.subscriptionId)) return "no";
  const times = input.store ? await closingSince(input.store) : await shutOf(input.handle);
  if (times === null) return "no";
  const entry: Undo = {
    h: input.handle,
    c: CUSTOMER_PATTERN.test(input.customerId) ? input.customerId : "",
    to: input.store?.email ?? "",
    name: input.store?.name ?? "",
    since: times.since,
    ...(times.ended ? { ended: times.ended } : {}),
    at: Date.now(),
    n: 0,
  };
  // In line first: whatever fails after this is tried again by the closing job.
  await redisPipeline([["HSETNX", UNDO_KEY, input.subscriptionId, JSON.stringify(entry)]]);
  if (!(await settleOne(input.subscriptionId, false, input.onStopped))) return "returning";
  const [raw] = await redisPipeline([["HGET", UNDO_KEY, input.subscriptionId]]);
  const settled = readUndo(raw);
  if (!settled || typeof settled.done !== "number" || !Number.isFinite(settled.done) || settled.done <= 0) return "returning";
  return settled.e ? "returned-early" : "returned";
}

/**
 * The way back from a plan checkout for a store in its closing day: the
 * session is read (it must be a subscription checkout naming this store)
 * and its subscription undone. "no" when the session made nothing to undo.
 */
export async function refuseSession(store: Store, sessionId: string | undefined): Promise<Refused> {
  if (!sessionId || !SESSION.test(sessionId)) return "no";
  const session = await onPlatform("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`, undefined, { version: AT });
  const meta = session.metadata as Record<string, string> | null | undefined;
  if (session.mode !== "subscription" || typeof meta?.store !== "string" || !saleHandles(store).has(meta.store)) return "no";
  if (session.status === "open") {
    await expireSession(sessionId);
    return "no";
  }
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : "";
  const customerId = typeof session.customer === "string" ? session.customer : "";
  if (!SUBSCRIPTION_PATTERN.test(subscriptionId)) return "no";
  return refusePlanIfClosing({ store, handle: meta.store, subscriptionId, customerId });
}

async function expireSession(id: string): Promise<boolean> {
  try {
    const done = await onPlatform("POST", `/checkout/sessions/${encodeURIComponent(id)}/expire`, new URLSearchParams(), { version: AT, idempotencyKey: `closing-expire:${id}` });
    return done.status === "expired";
  } catch (error) {
    // Stripe failing or not answering is not "it was not open": thrown, so the closing day tries it again.
    if (!(error instanceof BillingError) || error.status >= 500 || error.status === 429) throw error;
    // Only an open session can be expired: one finished meanwhile is undone when it comes to light.
    return false;
  }
}

/**
 * At the start of the closing day: every plan checkout still open for this
 * store is expired, so it can no longer be paid. Found by the store's Stripe
 * customer, which a store whose plan ended has; a checkout this misses is
 * undone by refusePlanIfClosing if it is ever paid. Returns how many were expired.
 */
export async function expirePlanCheckouts(store: Store, customerIds: string[]): Promise<number> {
  if (!isBillingConfigured()) return 0;
  const handles = saleHandles(store);
  let expired = 0;
  // Not known in full (a list in another shape, a row that cannot be read, more pages than read, Stripe not
  // answering): what could be read is still expired, then the step is refused so the closing day tries it again.
  let unknown: unknown = null;
  for (const customer of [...new Set(customerIds)].filter((id) => CUSTOMER_PATTERN.test(id))) {
    let after = "";
    let complete = false;
    // Open checkouts last a day at most; a customer has a handful at once.
    for (let page = 0; page < 3; page += 1) {
      const query = new URLSearchParams({ status: "open", customer, limit: "100" });
      if (after) query.set("starting_after", after);
      let listed: ReturnType<typeof readStripePage>;
      try {
        listed = readStripePage(await onPlatform("GET", `/checkout/sessions?${query}`, undefined, { version: AT }), (row) => textField(row, "mode") && metadataKnown(row));
      } catch (error) {
        console.error("listing a closing store's open plan checkouts failed", error);
        unknown = error;
        break;
      }
      for (const row of listed.rows) {
        const meta = row.metadata as Record<string, string> | null | undefined;
        const id = row.id;
        if (row.mode !== "subscription" || !SESSION.test(id) || typeof meta?.store !== "string" || !handles.has(meta.store)) continue;
        try {
          if (await expireSession(id)) expired += 1;
        } catch (error) {
          console.error("expiring a closing store's plan checkout failed", error);
          unknown = error;
        }
      }
      if (listed.unreadable > 0) {
        unknown = new StripeListUnreadable(`${listed.unreadable} open checkouts could not be read`);
        break;
      }
      if (!listed.hasMore) {
        complete = true;
        break;
      }
      if (!listed.lastId) break;
      after = listed.lastId;
    }
    if (!complete && !unknown) unknown = new StripeListUnreadable("the open checkouts were not read to their end");
  }
  if (unknown) throw unknown;
  return expired;
}

function readUndo(raw: unknown): Undo | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<Undo>;
    if (typeof value.since !== "number" || !Number.isFinite(value.since)) return null;
    return {
      h: typeof value.h === "string" ? value.h : "",
      c: typeof value.c === "string" ? value.c : "",
      to: typeof value.to === "string" ? value.to : "",
      name: typeof value.name === "string" ? value.name.slice(0, 200) : "",
      since: value.since,
      ...(typeof value.ended === "number" && value.ended > 0 ? { ended: value.ended } : {}),
      at: typeof value.at === "number" ? value.at : 0,
      n: typeof value.n === "number" ? value.n : 0,
      ...(typeof value.done === "number" ? { done: value.done } : {}),
      ...(value.t === 1 ? { t: 1 as const } : {}),
      ...(value.e === 1 ? { e: 1 as const } : {}),
    };
  } catch {
    return null;
  }
}

/** Ends the subscription at once. True once Stripe says it is ended. */
async function endIt(id: string): Promise<{ ended: boolean; created: number }> {
  const over = (sub: Record<string, unknown>) => ({ ended: sub.status === "canceled" || sub.status === "incomplete_expired", created: Number(sub.created) || 0 });
  try {
    // A DELETE is idempotent at Stripe by itself; no key is sent with it.
    const ended = over(await onPlatform("DELETE", `/subscriptions/${encodeURIComponent(id)}`, undefined, { version: AT }));
    if (ended.ended) return ended;
  } catch (error) {
    if (!(error instanceof BillingError)) throw error;
  }
  // Already ended (a second DELETE is refused), or not: Stripe is asked which.
  return over(await onPlatform("GET", `/subscriptions/${encodeURIComponent(id)}`, undefined, { version: AT }));
}

type ChargeOutcome = { settled: boolean; returned: number; disputed: number; currency: string };

/** Returns one paid invoice's charge in full. Settled when refunded in full, or when a dispute returns it. */
async function giveBack(id: string, invoice: Record<string, unknown>): Promise<ChargeOutcome> {
  const invoiceId = String(invoice.id);
  const intent = typeof invoice.payment_intent === "string" ? invoice.payment_intent : "";
  if (!OBJECT_ID.test(intent)) return { settled: false, returned: 0, disputed: 0, currency: "" };
  const pi = await onPlatform("GET", `/payment_intents/${encodeURIComponent(intent)}?expand[]=latest_charge`, undefined, { version: AT });
  const charge = pi.latest_charge as Record<string, unknown> | null | undefined;
  if (!charge || typeof charge.id !== "string" || !OBJECT_ID.test(charge.id)) return { settled: false, returned: 0, disputed: 0, currency: "" };
  // Each field the refund is decided by, in its exact shape (CX-123 rule 24): one that does not read throws, and
  // settleOne keeps the plan in line, never settled as refunded with nothing given back.
  const amount = ownField(charge, "amount");
  const onCharge = ownField(charge, "amount_refunded");
  const isDisputed = ownField(charge, "disputed");
  const currency = ownField(charge, "currency");
  if (!wholeAtLeast(amount, 1) || !wholeAtLeast(onCharge, 0) || typeof isDisputed !== "boolean" || typeof currency !== "string" || !/^[a-z]{3}$/.test(currency)) {
    throw new Error(`Stripe answered the charge of ${invoiceId} in another shape`);
  }
  // A disputed charge cannot be refunded: the bank's dispute takes it back to the creator.
  if (isDisputed) return { settled: true, returned: 0, disputed: amount, currency };
  // Read in full or not at all: a refund missed on an unknown list would be asked for twice (settleOne keeps it on the throw).
  // Each row in Stripe's own domain: a refund's amount is above zero and its status one of Stripe's. A negative one
  // would ask for more than was paid, an unknown one for a second refund: either throws before anything is asked for.
  const refunds = await allRows("/refunds", new URLSearchParams({ charge: charge.id, limit: "100" }), (row) => REFUND_STATUSES.has(ownField(row, "status")) && wholeAtLeast(ownField(row, "amount"), 1), 5);
  const sum = (status: string) => refunds.filter((row) => row.status === status).reduce((total, row) => total + (Number(row.amount) || 0), 0);
  const succeeded = sum("succeeded");
  const pending = sum("pending") + sum("requires_action");
  const failed = refunds.filter((row) => row.status === "failed" || row.status === "canceled").length;
  if (succeeded >= amount) return { settled: true, returned: succeeded, disputed: 0, currency };
  // On its way: looked at again on the next run.
  if (pending > 0) return { settled: false, returned: succeeded, disputed: 0, currency };
  // The charge itself says it was refunded although the list does not show it yet: never a second one. (Only
  // while no refund of it has failed: a failed refund's amount goes back, and the list is then what counts.)
  if (failed === 0 && onCharge >= amount) return { settled: false, returned: succeeded, disputed: 0, currency };
  const made = await onPlatform(
    "POST",
    "/refunds",
    new URLSearchParams({ payment_intent: intent, amount: String(amount - succeeded), reason: "requested_by_customer", "metadata[closing_plan]": id }),
    { version: AT, idempotencyKey: `closing-plan-refund:${invoiceId}:${failed}` },
  );
  const now = made.status === "succeeded" ? succeeded + (Number(made.amount) || 0) : succeeded;
  return { settled: made.status === "succeeded" && now >= amount, returned: now, disputed: 0, currency };
}

/**
 * Settles one subscription in line, as far as it can today: ended, its open
 * invoices voided and drafts deleted, its payments since the closing day
 * began returned, its creator told. True once it is all done. `recheck`
 * looks again at one settled already: a refund the bank sent back since is
 * made again, and it goes back in line if that cannot be done now.
 */
export async function settleOne(id: string, recheck = false, onStopped?: () => void): Promise<boolean> {
  const [raw] = await redisPipeline([["HGET", UNDO_KEY, id]]);
  const entry = readUndo(raw);
  if (!entry) {
    if (raw !== null && raw !== undefined) console.error(`closing-plan-guard: an unreadable entry for ${id} is kept for a person to see`);
    return raw === null || raw === undefined;
  }
  if (entry.done && !recheck) return true;
  const keep = async (why: string, error?: unknown) => {
    console.error(`closing-plan-guard: ${id} is not settled yet (${why}); tried again on the next run`, error ?? "");
    const { done: _settled, ...open } = entry;
    void _settled;
    await redisPipeline([["HSET", UNDO_KEY, id, JSON.stringify({ ...open, n: entry.n + 1 })]]).catch(() => null);
    return false;
  };
  if (!isBillingConfigured()) return keep("Stripe is not configured");
  try {
    const plan = await endIt(id);
    if (!plan.ended) return keep("Stripe did not end it");
    // The independent queue was read above and holds every field the retry
    // needs. Its confirmed cancellation can release file retention even if
    // refunding or telling the creator still needs a later worker pass.
    onStopped?.();
    // A plan started after the store's last one ended is a plan for a closing store: every payment of it is given
    // back, whatever minute it was paid (one paid just before the day began and found only after it, too). The
    // store's own plan from before that end gives back only what it was paid since the closing day began.
    const before = plan.created > 0 && (entry.ended ? plan.created * 1000 < entry.ended : plan.created * 1000 < entry.since);
    const cutoff = before ? entry.since : (entry.ended ?? entry.since);
    // Every page read before anything is voided, deleted or refunded; a list not known in full throws, and the
    // plan is kept in line (catch below), never settled as having had no payment.
    const invoices = await allRows("/invoices", new URLSearchParams({ subscription: id, limit: "100" }), invoiceKnown, 10, OBJECT_ID);
    let settled = true;
    let returned = 0;
    let disputed = 0;
    let currency = "usd";
    for (const invoice of invoices) {
      const invoiceId = typeof invoice.id === "string" ? invoice.id : "";
      if (!OBJECT_ID.test(invoiceId)) continue;
      if (invoice.status === "open") {
        await onPlatform("POST", `/invoices/${encodeURIComponent(invoiceId)}/void`, new URLSearchParams(), { version: AT, idempotencyKey: `closing-plan-void:${invoiceId}` });
        continue;
      }
      if (invoice.status === "draft") {
        await onPlatform("DELETE", `/invoices/${encodeURIComponent(invoiceId)}`, undefined, { version: AT });
        continue;
      }
      // Read by invoiceKnown: a paid one's amount and dates are whole numbers, its payment time null or one.
      if (invoice.status !== "paid" || !((invoice.amount_paid as number) > 0)) continue;
      const paidAt = ((invoice.status_transitions as { paid_at: number | null }).paid_at) ?? 0;
      const created = invoice.created as number;
      // Paid before the closing day began: a payment for a plan the store had, not this one.
      if (Math.max(paidAt, created) * 1000 < cutoff) continue;
      const outcome = await giveBack(id, invoice);
      if (paidAt > 0 && paidAt * 1000 < entry.since && (outcome.returned > 0 || outcome.disputed > 0)) entry.e = 1;
      returned += outcome.returned;
      disputed += outcome.disputed;
      if (outcome.currency) currency = outcome.currency;
      if (!outcome.settled) settled = false;
    }
    if (!settled) return keep("a refund is not made in full yet");
    if (entry.done) return true;
    // The store's own plan, started before its last plan ended and never paid since the closing day began: ended
    // so it can charge no more, and no letter (there is no payment to speak of, and it was not started anew).
    const own = before && returned === 0 && disputed === 0;
    if (!entry.t && !own) {
      if (!(await tell(id, entry, returned, disputed, currency))) return keep("the creator could not be told yet");
      // Written at once, so whatever happens next the creator is never written to twice.
      entry.t = 1;
      await redisPipeline([["HSET", UNDO_KEY, id, JSON.stringify(entry)]]);
    }
    // Settled: only its dates are kept, for a retry or a recheck to find (no address, no customer, no name).
    await redisPipeline([["HSET", UNDO_KEY, id, JSON.stringify({ h: "", c: "", to: "", name: "", since: entry.since, ...(entry.ended ? { ended: entry.ended } : {}), at: entry.at, n: entry.n, done: Date.now(), t: 1, ...(entry.e ? { e: 1 } : {}) })]]);
    return true;
  } catch (error) {
    return keep("Stripe did not answer", error);
  }
}

/** The letter to the creator: what happened, honestly, and that nothing more is charged. */
export function planReturnedLetter(name: string, returned: number, disputed: number, currency: string, early = false): { subject: string; text: string } {
  const store = name || "your store";
  const money = (cents: number) => formatMoney(cents, currency.toUpperCase());
  const lines = [
    early
      ? `Your plan for ${store} went through just before its closing day began on Marktmorgen, too late to stop the closing, which had already started. So the plan could not keep the store.`
      : `Your store ${store} had already begun closing on Marktmorgen when this plan went through, so the plan could not be given.`,
    "",
    "We ended that plan at once.",
  ];
  if (returned > 0) lines.push(`We returned your payment of ${money(returned)} in full, to the card or account you paid with. Your bank may take a few days to show it.`);
  if (disputed > 0) lines.push(`A payment of ${money(disputed)} is in a dispute with your bank, and the dispute returns it to you. We have not charged anything more.`);
  if (returned === 0 && disputed === 0) lines.push("No payment was taken for it.");
  lines.push("", "Nothing else will be charged for this plan.", "", "If you have a question, reply to this email.", "", "Marktmorgen");
  return { subject: returned > 0 ? `${store}: your plan payment was returned` : `${store}: the plan you started was ended`, text: lines.join("\n") };
}

async function tell(id: string, entry: Undo, returned: number, disputed: number, currency: string): Promise<boolean> {
  let to = entry.to;
  if (!to && CUSTOMER_PATTERN.test(entry.c)) {
    const customer = await onPlatform("GET", `/customers/${encodeURIComponent(entry.c)}`, undefined, { version: AT });
    to = typeof customer.email === "string" ? customer.email : "";
  }
  const address = normaliseEmail(to);
  if (!EMAIL_PATTERN.test(address)) {
    // The money is back; there is no address to say so to.
    console.error(`closing-plan-guard: ${id} was undone and there is no address to tell`);
    return true;
  }
  if (!isSenderConfigured()) return false;
  const { subject, text } = planReturnedLetter(entry.name, returned, disputed, currency, entry.e === 1);
  return sendEmail({ meter: { by: "company" }, from: NIMBUS_FROM, to: address, replyTo: SUPPORT_EMAIL, subject, text, idempotencyKey: `closing-plan-told:${id}` }).catch((error) => {
    console.error("telling a creator their plan payment was returned failed", error);
    return false;
  });
}

/** The closing job: every subscription still in line, tried again until `deadline` (ms). */
export async function retryPlanUndos(deadline: number): Promise<{ settled: number; left: number }> {
  if (!isRedisConfigured()) return { settled: 0, left: 0 };
  const [fields] = await redisPipeline([["HKEYS", UNDO_KEY]]);
  const ids = Array.isArray(fields) ? (fields as unknown[]).map(String) : [];
  let settled = 0;
  let left = 0;
  for (const id of ids) {
    if (Date.now() > deadline) {
      left += 1;
      continue;
    }
    const [raw] = await redisPipeline([["HGET", UNDO_KEY, id]]);
    const entry = readUndo(raw);
    // Settled long enough ago that no refund can still come back and no retry still come: taken out.
    if (entry?.done && Date.now() - entry.done > DONE_KEEP_DAYS * 86_400_000) {
      await redisPipeline([["HDEL", UNDO_KEY, id]]);
      continue;
    }
    if (await settleOne(id, Boolean(entry?.done))) {
      if (!entry?.done) settled += 1;
    } else left += 1;
  }
  return { settled, left };
}

