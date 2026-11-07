/**
 * A store's twelve months of money, read (426 [BX2] unit 2; docs/bx2-earnings-design.md).
 *
 * From the creator's own Stripe account: the store's paid checkouts and the
 * one-click extras after them, every paid invoice of its memberships and
 * payment plans but the first (`subscription_create`, which its checkout
 * already counted), and the refunds on the account; and the PayPal sales and
 * full refunds kept here as each was paid (lib/paypal-sales.ts). Stripe's
 * disputes are said not read, with the money given back (`reinstated`): the
 * design reads them only from their own balance transactions, whose shape is
 * not confirmed here, and never through DISPUTE_TAKES, which drops a dispute
 * once won and would rewrite a month already shown (docs/bx2-earnings-design.md,
 * "Units" 2). The same lists, paths and page caps as the sales reading
 * (lib/stats.ts, readSales), less the disputes, so one reading of the year is
 * within one SALES_READ_SHAPE (lib/read-ceilings.ts): 55 of its 58 Stripe
 * pages, 2,000 PayPal sales and PAYPAL_REFUNDS_READ refunds. It is one of the store's
 * HEAVY_READINGS_PER_DAY, taken before anything is read (keptReading), and the
 * months are kept as the fourth kind of reading, "earnings", so looking again
 * does not read again.
 *
 * Read here in their exact shape rather than through lib/stats.ts, whose
 * readers answer one `partial` for two lists together, read PayPal refunds
 * oldest first, and take an answer they cannot read as an empty list or a
 * zero: the months need, list by list, how far back each was read in full.
 * Every Stripe page goes through readStripePage (lib/stripe-list.ts), every
 * Redis reply through lib/redis-reply.ts. What each list says:
 *
 *   - read to its end: every month from the reading's start is known;
 *   - stopped at its cap, or at a record it cannot read: every record newer
 *     than where it stopped was read, so the months wholly after it are known
 *     (`reachedBack`) and the rest unknown, never a lower amount; the paid
 *     invoices, dated by payment and listed by when they were made, know no
 *     month when they stop (`reachedBack` null);
 *   - answered in another shape, out of order, with an id twice, or failed:
 *     unread, and every month of its source unknown.
 *
 * Renewals are dated by when they were paid (status_transitions.paid_at), not
 * when their invoice was made. Stripe lists invoices by when they were made,
 * so a renewal paid at the start of the year whose invoice was made before
 * it would not be read: until the longest time Stripe can take to collect an
 * invoice is proved from its dated documentation, the renewals are known only
 * from RENEWAL_PAID_WITHIN_DAYS after the reading's start, which gives up the
 * oldest month and no other; and a renewal read that was paid later than that
 * after its invoice shows the assumption does not hold, so the renewals are
 * unread. Every record carries its provider's id (`stripe:…`, `paypal:…`), and
 * the reading's time is taken once every list was read, so a record made while
 * it ran is money so far. Nothing here ranks or rates the creator by revenue
 * (561 [NE1]).
 */
import { type Earnings, type ListReading, type MoneyEvent, type MoneyKind, type ProviderReading, earningsByMonth, readingSince } from "@/lib/earnings-by-month";
import { PAYPAL_REFUNDS_READ, paidKey, refundedKey, salesKey } from "@/lib/paypal-sales";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { readsSales } from "@/lib/stats";
import { type Store, saleHandles } from "@/lib/store";
import { keyFor, onAccount } from "@/lib/stripe-account";
import { STRIPE_LIST_VERSION, ownField, plainObject, readStripePage } from "@/lib/stripe-list";
import { type Kept, NotRead, keptReading } from "@/lib/store-readings";

/** Pages of a hundred each Stripe list is read for: those of the sales reading (lib/stats.ts, readSales), less its 3 of disputes (said not read): 55 in all. */
export const EARNINGS_STRIPE_PAGES = { checkouts: 20, extras: 20, invoices: 10, refunds: 5 } as const;
/** PayPal sales read at most: those of the sales reading (readPaidSales(store, since, 20)). */
export const EARNINGS_PAYPAL_SALES = 20 * 100;
/** PayPal full refunds read at most. */
export const EARNINGS_PAYPAL_REFUNDS = PAYPAL_REFUNDS_READ;
/**
 * Days within which a renewal is taken to be paid after its invoice was made,
 * NOT proved from Stripe's dated documentation (docs/bx2-earnings-design.md,
 * "Renewal dates"). Under four weeks, so it gives up only the oldest month;
 * a renewal read that took longer makes the renewals unread.
 */
export const RENEWAL_PAID_WITHIN_DAYS = 27;
const RENEWAL_SHIFT_MS = RENEWAL_PAID_WITHIN_DAYS * 86_400_000;

const ID = /^[A-Za-z0-9_]{3,255}$/;
const CURRENCY = /^[A-Za-z]{3}$/;

/** A whole count of seconds after 1970, or null. */
const seconds = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);

/** What a row is: money of the store's (an event), not the store's or not money ("skip"), or not readable (null). */
type Taken = MoneyEvent | "skip" | null;

/** An amount of a row in the smallest unit, its currency and when it was made; null when any of them cannot be read. */
function money(row: Record<string, unknown>, field: string, at: number): MoneyEvent | null {
  const cents = ownField(row, field);
  const currency = ownField(row, "currency");
  const id = ownField(row, "id");
  if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents < 0) return null;
  if (typeof currency !== "string" || !CURRENCY.test(currency) || typeof id !== "string") return null;
  return { id: `stripe:${id}`, at: at * 1000, cents, currency: currency.toLowerCase() };
}

/** The row's metadata, a plain object of its own, or null. */
const metadataOf = (row: Record<string, unknown>): Record<string, unknown> | null => {
  const meta = ownField(row, "metadata");
  return plainObject(meta) ? meta : null;
};

/** The subscription's metadata an invoice carries, where either API version keeps it; null when neither has one. */
function invoiceMetadata(row: Record<string, unknown>): Record<string, unknown> | null {
  const parent = ownField(row, "parent");
  const newer = plainObject(parent) ? ownField(parent, "subscription_details") : undefined;
  const older = ownField(row, "subscription_details");
  for (const details of [newer, older]) {
    const meta = plainObject(details) ? ownField(details, "metadata") : undefined;
    if (plainObject(meta)) return meta;
  }
  return null;
}

/** A renewal read that was paid later after its invoice than the reading takes for granted: the renewals are unread. */
class RenewalPaidLate extends Error {
  constructor() {
    super(`a renewal was paid more than ${RENEWAL_PAID_WITHIN_DAYS} days after its invoice`);
    this.name = "RenewalPaidLate";
  }
}

/** How each Stripe list's rows are read for the store. */
function takers(store: Store): Record<keyof typeof EARNINGS_STRIPE_PAGES, (row: Record<string, unknown>, created: number) => Taken> {
  const handles = saleHandles(store);
  const ours = (meta: Record<string, unknown>) => typeof ownField(meta, "store") === "string" && handles.has(ownField(meta, "store") as string);
  const text = (row: Record<string, unknown>, field: string): string | null => {
    const value = ownField(row, field);
    return typeof value === "string" ? value : null;
  };
  return {
    // A checkout this store opened that was paid: what the buyer paid, after any code, before fees or refunds.
    checkouts: (row, created) => {
      const meta = metadataOf(row);
      const status = text(row, "status");
      const paid = text(row, "payment_status");
      if (!meta || status === null || paid === null) return null;
      if (!ours(meta) || status !== "complete" || paid !== "paid") return "skip";
      return money(row, "amount_total", created);
    },
    // A product taken in one click after paying: a payment of its own.
    extras: (row, created) => {
      const meta = metadataOf(row);
      const status = text(row, "status");
      if (!meta || status === null) return null;
      if (ownField(meta, "kind") !== "upsell" || !ours(meta) || status !== "succeeded") return "skip";
      return money(row, "amount", created);
    },
    // Every paid invoice of the store's memberships and payment plans but the first, whose payment the checkout
    // already counted (renewals, a switch charged at once, any other reason), dated by when it was paid.
    invoices: (row, created) => {
      const status = text(row, "status");
      const reason = text(row, "billing_reason");
      if (status === null || reason === null) return null;
      if (status !== "paid" || reason === "subscription_create") return "skip";
      // An invoice of no subscription (one the creator sent by hand, or a quote's): not a membership's.
      const parent = ownField(row, "parent");
      if (parent === null || (plainObject(parent) && typeof ownField(parent, "type") === "string" && ownField(parent, "type") !== "subscription_details")) return "skip";
      const meta = invoiceMetadata(row);
      if (!meta) return null;
      if (!ours(meta)) return "skip";
      const transitions = ownField(row, "status_transitions");
      const paidAt = plainObject(transitions) ? seconds(ownField(transitions, "paid_at")) : null;
      if (paidAt === null || paidAt < created) return null;
      if ((paidAt - created) * 1000 > RENEWAL_SHIFT_MS) throw new RenewalPaidLate();
      const event = money(row, "amount_paid", paidAt);
      return event && event.cents === 0 ? "skip" : event;
    },
    // A refund on the account that went through or is on its way.
    refunds: (row, created) => {
      const status = text(row, "status");
      if (status === null) return null;
      return status === "succeeded" || status === "pending" ? money(row, "amount", created) : "skip";
    },
  };
}

/**
 * One Stripe list since `sinceSec`, newest first, at most `pages` pages of a
 * hundred, in the version its shapes are read in. `shift` (ms) moves where it
 * is known from (renewals: RENEWAL_SHIFT_MS). `byPayment`: its records are
 * dated otherwise than the order it is listed in (paid invoices, by payment),
 * so when it stops it knows no month (`reachedBack` null). Throws, so the list
 * is unread, for a page in another shape, an id twice or rows out of order.
 */
async function stripeList(account: string, path: string, kind: MoneyKind, sinceSec: number, pages: number, take: (row: Record<string, unknown>, created: number) => Taken, shift = 0, byPayment = false): Promise<ListReading> {
  const events: MoneyEvent[] = [];
  const seen = new Set<string>();
  const since = sinceSec * 1000 + shift;
  const stopped = (back: number | null): ListReading => ({ kind, events, since, complete: false, reachedBack: back === null || byPayment ? null : back * 1000 + shift });
  let after = "";
  let last: number | null = null;
  for (let page = 0; page < pages; page += 1) {
    const answer = await onAccount("GET", account, `${path}?limit=100&created[gte]=${sinceSec}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`, undefined, STRIPE_LIST_VERSION);
    // The page's own shape (a plain object, data a list, has_more true or false), or it throws.
    const { hasMore, lastId } = readStripePage(answer);
    const data = ownField(answer, "data") as unknown[];
    for (let i = 0; i < data.length; i += 1) {
      const slot = Object.getOwnPropertyDescriptor(data, String(i));
      const row: unknown = slot && Object.hasOwn(slot, "value") ? slot.value : undefined;
      const created = plainObject(row) ? seconds(ownField(row, "created")) : null;
      const id = plainObject(row) ? ownField(row, "id") : undefined;
      if (created !== null && last !== null && created > last) throw new Error(`Stripe listed ${path} out of order`);
      if (typeof id === "string" && seen.has(id)) throw new Error(`Stripe listed a row of ${path} twice`);
      const taken = plainObject(row) && created !== null && typeof id === "string" && ID.test(id) ? take(row, created) : null;
      // A row that cannot be read: every row newer than it was read, nothing older is known.
      if (taken === null) return stopped(created ?? last);
      seen.add(id as string);
      last = created;
      if (taken !== "skip") events.push(taken);
    }
    if (!hasMore) return { kind, events, since, complete: true, reachedBack: null };
    if (!data.length || lastId === null) return stopped(last);
    after = lastId;
  }
  return stopped(last);
}

/** The store's PayPal records kept under `key` since `sinceSec`, newest first, at most `cap`: two commands, a range and one read. */
async function payPalList(statsId: string, key: string, kind: "sale" | "refund", sinceSec: number, cap: number): Promise<ListReading> {
  const since = sinceSec * 1000;
  const ranged = repliesFor(await redisPipeline([["ZREVRANGEBYSCORE", key, "+inf", String(sinceSec), "WITHSCORES", "LIMIT", "0", String(cap + 1)]]), 1);
  const flat = ranged ? stringList(ranged[0]) : null;
  if (!flat || flat.length % 2 !== 0) throw new UnknownReplyError("a PayPal list");
  const listed: { order: string; at: number }[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const at = Number(flat[i + 1]);
    if (!flat[i] || !Number.isSafeInteger(at) || at < sinceSec || (listed.length && at > listed[listed.length - 1].at)) throw new UnknownReplyError("a PayPal list");
    listed.push({ order: flat[i], at });
  }
  const capped = listed.length > cap;
  const read = listed.slice(0, cap);
  const events: MoneyEvent[] = [];
  if (!read.length) return { kind, events, since, complete: true, reachedBack: null };
  const got = repliesFor(await redisPipeline([["MGET", ...read.map((entry) => paidKey(entry.order))]]), 1);
  const records = got ? repliesFor(got[0], read.length) : null;
  if (!records) throw new UnknownReplyError("PayPal's records");
  for (let i = 0; i < read.length; i += 1) {
    const { order, at } = read[i];
    let paid: unknown = null;
    try {
      paid = typeof records[i] === "string" ? JSON.parse(records[i] as string) : null;
    } catch {
      paid = null;
    }
    const cents = plainObject(paid) ? ownField(paid, "cents") : undefined;
    const currency = plainObject(paid) ? ownField(paid, "currency") : undefined;
    const readable =
      plainObject(paid) && ownField(paid, "store") === statsId && ownField(paid, "order") === order
      && (kind === "refund" || ownField(paid, "at") === at)
      && typeof cents === "number" && Number.isSafeInteger(cents) && cents >= 0 && typeof currency === "string" && CURRENCY.test(currency);
    // A record gone or not understood: every record newer than it was read, nothing older is known.
    if (!readable) return { kind, events, since, complete: false, reachedBack: at * 1000 };
    events.push({ id: `paypal:${kind}:${order}`, at: at * 1000, cents: cents as number, currency: (currency as string).toLowerCase() });
  }
  return { kind, events, since, complete: !capped, reachedBack: capped ? read[read.length - 1].at * 1000 : null };
}

/** A list that failed, said as unread. */
const unread = (kind: MoneyKind) => (error: unknown): ListReading => {
  console.error(`reading a store's ${kind} list for its earnings failed`, error);
  return { kind, unread: true };
};

/**
 * Every list of the store's money from `since` (ms): Stripe's four, when it
 * has an account, with its disputes and money given back said not read; and
 * PayPal's two, when it sells or sold through PayPal (or PayPal could not be
 * read, so it may have), with its disputes said not read. Each list read side
 * by side.
 */
export async function readEarningsLists(store: Store, since: number): Promise<ProviderReading[]> {
  const sinceSec = Math.floor(since / 1000);
  const providers: ProviderReading[] = [];
  const stripe = (async (): Promise<ProviderReading | null> => {
    const account = store.stripeAccountId;
    if (!account) return null;
    const take = takers(store);
    const p = EARNINGS_STRIPE_PAGES;
    const lists = await Promise.all([
      stripeList(account, "/checkout/sessions", "sale", sinceSec, p.checkouts, take.checkouts).catch(unread("sale")),
      stripeList(account, "/payment_intents", "sale", sinceSec, p.extras, take.extras).catch(unread("sale")),
      stripeList(account, "/invoices", "renewal", sinceSec, p.invoices, take.invoices, RENEWAL_SHIFT_MS, true).catch(unread("renewal")),
      stripeList(account, "/refunds", "refund", sinceSec, p.refunds, take.refunds).catch(unread("refund")),
    ]);
    // Disputes are read only from their own balance transactions, not confirmed here; money given back goes with them.
    return { source: "stripe", lists, notRead: ["dispute", "reinstated"] };
  })();
  const paypal = (async (): Promise<ProviderReading | null> => {
    if (!store.statsId || !isRedisConfigured()) return null;
    const statsId = store.statsId;
    const lists = await Promise.all([
      payPalList(statsId, salesKey(statsId), "sale", sinceSec, EARNINGS_PAYPAL_SALES).catch(unread("sale")),
      payPalList(statsId, refundedKey(statsId), "refund", sinceSec, EARNINGS_PAYPAL_REFUNDS).catch(unread("refund")),
    ]);
    const anything = lists.some((list) => "unread" in list || list.events.length > 0 || !list.complete);
    // PayPal disputes are not read anywhere in the product: said on every PayPal month.
    return store.paypalSeller || anything ? { source: "paypal", lists, notRead: ["dispute"] } : null;
  })();
  for (const provider of await Promise.all([stripe, paypal])) if (provider) providers.push(provider);
  return providers;
}

/**
 * The store's twelve months in `timeZone`, kept: the kept copy while it is
 * fresh (unless `fresh`), otherwise read again when the day has a heavy
 * reading left, counted before Stripe or PayPal is read; otherwise the last
 * copy, stale, or ReadingsUsed with none (lib/store-readings.ts). A store with
 * neither Stripe nor PayPal reads nothing and spends nothing. null for an
 * unknown time zone or a store with no counts. Entries typed by the creator
 * are not built (unit 3): none are given.
 */
export async function readEarningsYear(store: Store, timeZone: string, now = Date.now(), fresh = false): Promise<Kept<Earnings | null> | null> {
  const since = readingSince(now, timeZone);
  if (!Number.isFinite(since)) return null;
  if (!readsSales(store)) return { value: earningsByMonth({ at: now, timeZone, providers: [], manual: [] }), at: now, stale: false };
  return keptReading(store, "earnings", async () => {
    // Selling not configured on our side: nothing is called, so the reading's unit is given back (inbox C4-53).
    if (store.stripeAccountId && !keyFor(store.stripeAccountId)) throw new NotRead("selling is not configured");
    const started = Date.now();
    const providers = await readEarningsLists(store, since);
    // Nothing could be read at all: a failed reading (the last copy is shown), not twelve unknown months kept a day.
    if (providers.length && providers.every((p) => p.lists.every((list) => "unread" in list))) throw new Error("no list of the store's money could be read");
    // The reading's time, taken once every list was read: a record made while it ran is money so far, not after it.
    return earningsByMonth({ at: now + Math.max(0, Date.now() - started), timeZone, providers, manual: [] });
  }, now, fresh);
}
