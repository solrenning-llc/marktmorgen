/**
 * Limited quantities: how many are left, and never selling one more.
 *
 * Every checkout for a limited product holds one unit for as long as that
 * checkout can be paid — about half an hour, the least Stripe allows — and the
 * unit is either paid for or handed back. A hold whose time is up is checked
 * against the creator's Stripe account before it is let go, so a buyer who
 * paid and closed the tab before coming back still counts as sold.
 *
 * The number a buyer sees is therefore the real number: units nobody has
 * paid for or is paying for right now.
 *
 * Since 4 November 2026 a unit sold leaves the hash of holds: it is counted
 * once in the product's sold count (nl:stock:sold:), and the checkout that
 * sold it is kept PAID_KEEP_SECONDS (nl:stock:paid:) so it is never counted
 * twice. The hash holds only holds that may still be paid, at most
 * STOCK_ENTRIES_MAX, so reading it costs a bounded number of bytes. Units
 * marked sold the old way (an entry {"until":0,"paid":true}) are counted as
 * they are and moved to the sold count under the product's lock.
 *
 *   nl:stock:<statsId>:<product>                 hash: checkout → {until, asked?}, provisional holds p_…
 *   nl:stock:sold:<statsId>:<product>            units sold
 *   nl:stock:paid:<statsId>:<product>:<session>  that checkout's unit is in the sold count (PAID_KEEP_SECONDS)
 *   nl:stock:lock:<statsId>:<product>            one count at a time
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { HOLD_SECONDS, StripeError, onAccount } from "@/lib/stripe-account";
import { BUMP_KEYS } from "@/lib/bundle-rules";
import { MAX_CART } from "@/lib/cart-rules";
import { deriveKey } from "@/lib/secret-box";
import { isSettled } from "@/lib/instant-pay";
import { limitedStock } from "@/lib/product-extras";
import { type Held, LockBusyError, releaseLock, takeLock } from "@/lib/redis-lock";
import type { Listing, Store } from "@/lib/store";

const HOLD_MS = HOLD_SECONDS * 1000;
/** How many times one count, or one cart's counts together, may ask Stripe about holds that ran out. */
export const MAX_CHECKS = 5;
/**
 * The longest one question to Stripe about a checkout waits (2 November
 * 2026): a count runs under the product's lock, so it is kept short; an
 * answer that does not come in time counts the unit as used, the safe way
 * to be wrong. The same ceiling bounds closing an old checkout and reading
 * one back (releaseCartStockHolds).
 */
export const CHECK_MS = 2_000;

/**
 * How many times a reading may still ask Stripe, shared by every product it
 * counts (3 November 2026). A reading that is only shown (the open cart, a
 * suggestion, a bundle, "Goes well with", a reminder) gets none, and since
 * 4 November 2026 it reads only how many holds there are and the sold count
 * (HLEN, GET) and writes nothing: every hold counts as used, and says it is
 * unchecked unless the units are all sold.
 */
export type StripeChecks = { left: number; shown?: boolean };
/** A reading that is only shown: no question to Stripe, no write, two small reads. */
export const shownOnly = (): StripeChecks => ({ left: 0, shown: true });

export type StockOptions = {
  /**
   * The checkouts this browser opened (its signed cart and product cookies,
   * heldCheckouts): their own live, unpaid holds are not counted against it,
   * and a question to Stripe goes to them first.
   */
  mine?: string[];
  /** The questions to Stripe this reading may ask; MAX_CHECKS of its own when left out. */
  checks?: StripeChecks;
  /**
   * Read under the product's lock (withCartStockHolds): only then are lapsed
   * provisional holds let go and units marked sold the old way moved to the
   * sold count.
   */
  underLock?: boolean;
};

/**
 * A count, how many of the units counted as used are so only because a hold
 * was not settled (Stripe not asked, or no answer), and how many holds the
 * hash keeps that may still be paid (`holds`, bounded by STOCK_ENTRIES_MAX).
 */
export type StockReading = { left: number; unchecked: number; holds: number };

/**
 * The most holds a product's hash may keep (4 November 2026): a new hold is
 * refused ("busy") at this many, so every reading of it is bounded. Holds
 * are written only for admitted orders (lib/order-admission.ts: the month's
 * orders and the checkouts held from the last day stay under the plan's
 * figure, 1,500 at the most) and provisional holds in flight, so a store
 * never reaches it in use; it is priced in every order's reads
 * (STOCK_ORDER_READ_BYTES).
 */
export const STOCK_ENTRIES_MAX = 1_600;
/** The most bytes one hold takes in the hash: its checkout's id and {until, asked}. */
export const STOCK_ENTRY_BYTES = 130;
/** How long a checkout whose unit was counted sold is remembered, so it is never counted twice. */
export const PAID_KEEP_SECONDS = 400 * 86_400;
/** How many units marked sold the old way one count under the lock moves to the sold count. */
export const MIGRATE_MAX = 500;

/** How long a checkout waits for each product's lock at the most (takeLock). */
export const LOCK_WAIT_MS = 1_500;
/** How many lapsed provisional holds one count lets go of at the most; the rest are free all the same, and let go by a later count. */
export const MAX_LAPSED = 5;
/** How long after its end a hold Stripe says it has never heard of is taken for sold (stockReading). */
export const MISSING_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * What one order's stock work costs at the most (3 November 2026), named
 * in tests/plan-cost-registry.ts (ORDER_STOCK, not yet in ORDER_COST: the
 * owner's) and held by tests/cart-stock.test.ts against the commands a
 * cart's checkout really sends. Waited, held at 2 GB: each product's lock
 * (LOCK_WAIT_MS), and on Stripe the cart's counts together (MAX_CHECKS
 * questions), closing the old cart checkout and reading it back, closing
 * the old checkout of a product bought alone, and closing a new one whose
 * hold could not be written; each CHECK_MS at the most. Opening the
 * checkout itself is every order's (ORDER_COMPUTE). The open cart and every
 * reading that is only shown never ask Stripe (shownOnly).
 */
export const STOCK_ORDER_WAIT_MS = MAX_CART * LOCK_WAIT_MS + (MAX_CHECKS + 4) * CHECK_MS;
/**
 * Database commands for each limited product of a checkout: taking its lock
 * (nine tries at the most in LOCK_WAIT_MS), the count, renewing and letting
 * go of the lock (three each where the script is refused: EVAL, GET and
 * EXPIRE or DEL), the provisional hold and taking it back, the checkout's
 * own hold and taking back the provisional one, letting both go when it
 * cannot be written, the old checkouts' reads and their holds let go, and
 * the thanks page's mark.
 */
export const STOCK_COMMANDS_PER_PRODUCT = 27;
/**
 * Every limited product of a cart; for each question to Stripe its answer
 * and when it was asked; the lapsed provisional holds each count lets go
 * of; what the old cart checkout held outside the new cart; and the cart's
 * reminder, which reads each of its products only shown (three commands
 * each, SHOWN_READ_COMMANDS) once its checkout closed unpaid.
 */
export const STOCK_ORDER_COMMANDS = MAX_CART * STOCK_COMMANDS_PER_PRODUCT + 2 * MAX_CHECKS + MAX_CART * MAX_LAPSED + 2 * MAX_CART + MAX_CART * 3;
/**
 * The whole holds a checkout reads at the most (4 November 2026): the
 * cart's counts, the old cart checkout's reads (its products and what it
 * held outside the new cart) and the old checkout of a product bought
 * alone, each at most MAX_CART, each a hash of STOCK_ENTRIES_MAX holds.
 */
export const STOCK_ORDER_READ_BYTES = 4 * MAX_CART * STOCK_ENTRIES_MAX * STOCK_ENTRY_BYTES;
/** The commands of one reading only shown at the most: how many holds, the sold count, and this browser's own holds. */
export const SHOWN_READ_COMMANDS = 3;
/**
 * The open cart's reads of limited products, at most 2 * MAX_SUGGEST + MAX_CART readings only shown: this many more
 * of the store's requests, each priced as a later page (tests/plan-cost-registry.ts, public-requests; held by
 * tests/cart-stock.test.ts against what they cost).
 */
export const CART_READ_STOCK_UNITS = 1;
/**
 * A checkout's stock work with limited products, whatever it ends in (a checkout, sold out, busy, a paused store):
 * this many of the store's requests, taken before any of it, each priced as a later page; held by
 * tests/cart-stock.test.ts against ORDER_STOCK (4 November 2026).
 */
export const STOCK_ATTEMPT_UNITS = 11;
/** A Stripe Checkout session's id, as it may be named in a cookie. */
const CHECKOUT_ID = /^cs_(test|live)_[A-Za-z0-9]{8,200}$/;

/**
 * A hold, and when Stripe was last asked about it (`asked`, written only if
 * the hold is still exactly as read: STOCK_ASKED, so it can never undo a
 * sale). `paid` is a unit marked sold the old way, before 4 November 2026.
 * `raw` is the stored text, for that comparison.
 */
type Entry = { until: number; paid?: boolean; asked?: number; raw: string };

const stockKey = (id: string, productId: string) => `nl:stock:${id}:${productId}`;
const soldKey = (id: string, productId: string) => `nl:stock:sold:${id}:${productId}`;
const paidKey = (id: string, productId: string, session: string) => `nl:stock:paid:${id}:${productId}:${session}`;
const lockKey = (id: string, productId: string) => `nl:stock:lock:${id}:${productId}`;

/**
 * Counts a checkout's unit sold, once: remembered for PAID_KEEP_SECONDS, its
 * hold taken out of the hash, and the sold count raised only the first time.
 * Answers 1 when counted now, 0 when it was already.
 */
const STOCK_SOLD = `-- marktmorgen:stock-sold:v1
local fresh = redis.call("SET", KEYS[3], "1", "NX", "EX", ARGV[2])
redis.call("HDEL", KEYS[1], ARGV[1])
if fresh then redis.call("INCR", KEYS[2]) return 1 end
return 0`;
const soldCommand = (statsId: string, productId: string, session: string): (string | number)[] =>
  ["EVAL", STOCK_SOLD, 3, stockKey(statsId, productId), soldKey(statsId, productId), paidKey(statsId, productId, session), session, PAID_KEEP_SECONDS];

/** Writes when Stripe was last asked about a hold, only if the hold is still exactly as it was read. */
const STOCK_ASKED = `-- marktmorgen:stock-asked:v1
if redis.call("HGET", KEYS[1], ARGV[1]) == ARGV[2] then redis.call("HSET", KEYS[1], ARGV[1], ARGV[3]) return 1 end
return 0`;

/**
 * Writes a cart's provisional holds only while every lock taken for it is
 * still this checkout's (KEYS: the locks, then the hashes; ARGV: the tokens,
 * then the field and its value), in one step. 1 when written, 0 when a lock
 * was lost.
 */
const STOCK_PENDING = `-- marktmorgen:stock-pending:v1
local n = #KEYS / 2
for i = 1, n do if redis.call("GET", KEYS[i]) ~= ARGV[i] then return 0 end end
for i = 1, n do redis.call("HSET", KEYS[n + i], ARGV[n + 1], ARGV[n + 2]) end
return 1`;

async function readEntries(store: Store, product: Pick<Listing, "id">): Promise<Map<string, Entry>> {
  const receipt = await redisPipeline([["HGETALL", stockKey(store.statsId!, product.id)]]);
  if (!Array.isArray(receipt) || receipt.length !== 1) throw new Error("Stock reading unavailable");
  return entriesOf(receipt[0]);
}

function entriesOf(raw: unknown): Map<string, Entry> {
  if (!Array.isArray(raw) || raw.length % 2 !== 0) throw new Error("Stock reading unavailable");
  const entries = new Map<string, Entry>();
  for (let i = 0; i < raw.length; i += 2) {
    const session = raw[i], encoded = raw[i + 1];
    if (typeof session !== "string" || !session || typeof encoded !== "string" || entries.has(session)) throw new Error("Stock reading unavailable");
    const entry = entryOf(encoded);
    if (!entry) throw new Error("Stock reading unavailable");
    entries.set(session, entry);
  }
  return entries;
}

function entryOf(encoded: string): Entry | null {
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Partial<Entry>;
  if (!Number.isSafeInteger(entry.until) || (entry.until as number) < 0 || (entry.paid !== undefined && typeof entry.paid !== "boolean")) return null;
  if (entry.asked !== undefined && (!Number.isSafeInteger(entry.asked) || (entry.asked as number) < 0)) return null;
  return { until: entry.until as number, ...(entry.paid !== undefined ? { paid: entry.paid } : {}), ...(entry.asked !== undefined ? { asked: entry.asked } : {}), raw: encoded };
}

/** A sold count as stored: nothing yet, or a whole number. */
function soldOf(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,12}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Stock reading unavailable");
  return n;
}

/**
 * Units left of a limited product, or null when it is not limited.
 *
 * Holds that ran out are settled on the way: paid ones become sales, the rest
 * are handed back. When Stripe cannot be asked, a hold stays counted — the
 * safe way to be wrong is to show one unit too few, never to sell one too many.
 *
 * `options.mine` is a checkout this browser opened (the open cart's signed
 * cookie): its own live, unpaid hold is not counted against it, so a buyer
 * back from Stripe is not told the unit they hold is sold out. Paying again
 * closes that checkout before holding a unit anew (releaseCartStockHolds),
 * so the unit is never sold twice. `options.checks` bounds the questions to
 * Stripe (StripeChecks).
 */
export async function stockLeft(store: Store, product: Listing, now = Date.now(), options: StockOptions = {}): Promise<number | null> {
  return (await stockReading(store, product, now, options))?.left ?? null;
}

/** stockLeft, saying also how many units are counted as used only because a hold that ran out was not settled. */
export async function stockReading(store: Store, product: Listing, now = Date.now(), options: StockOptions = {}): Promise<StockReading | null> {
  const limit = limitedStock(product);
  if (limit === null) return null;
  if (!store.statsId || !isRedisConfigured()) throw new Error("Stock reading unavailable");
  const checks = options.checks ?? { left: MAX_CHECKS };
  const mine = [...new Set(options.mine ?? [])];
  const key = stockKey(store.statsId, product.id);
  if (checks.shown) return shownReading(key, soldKey(store.statsId, product.id), limit, mine, now);
  const receipt = await redisPipeline([["HGETALL", key], ["GET", soldKey(store.statsId, product.id)]]);
  if (!Array.isArray(receipt) || receipt.length !== 2) throw new Error("Stock reading unavailable");
  const entries = entriesOf(receipt[0]);
  let used = soldOf(receipt[1]);
  let unchecked = 0;
  let holds = 0;
  let lapsed = 0;
  let migrated = 0;
  const statsId = store.statsId;
  const writes: (string | number)[][] = [];
  const toAsk: [string, Entry][] = [];
  for (const [session, entry] of entries) {
    if (entry.paid) {
      // Marked sold the old way: counted as it is, and moved to the sold count under the lock, once (STOCK_SOLD).
      used += 1;
      if (options.underLock && migrated < MIGRATE_MAX) {
        writes.push(soldCommand(statsId, product.id, session));
        migrated += 1;
      }
      continue;
    }
    holds += 1;
    // This browser's own live hold is its own (options.mine).
    if (mine.includes(session) && entry.until > now) continue;
    if (entry.until > now) {
      used += 1;
      continue;
    }
    // A cart's provisional hold that lapsed: every checkout opened under it has closed, and none bears its name
    // (withCartStockHolds). Free; let go of under the lock, MAX_LAPSED at a time, so one count's writes stay bounded.
    if (session.startsWith(PENDING)) {
      if (options.underLock && lapsed < MAX_LAPSED) writes.push(["HDEL", key, session]);
      lapsed += 1;
      continue;
    }
    toAsk.push([session, entry]);
  }
  // The browser's own first, then the one asked longest ago, so holds Stripe never settles cannot keep the others from
  // being asked about (3 November 2026).
  toAsk.sort(([a, x], [b, y]) => Number(mine.includes(b)) - Number(mine.includes(a)) || (x.asked ?? 0) - (y.asked ?? 0) || x.until - y.until);
  const asked = (session: string, entry: Entry) =>
    ["EVAL", STOCK_ASKED, 1, key, session, entry.raw, JSON.stringify({ until: entry.until, asked: now })];
  for (const [session, entry] of toAsk) {
    if (checks.left <= 0 || !store.stripeAccountId) {
      used += 1;
      unchecked += 1;
      continue;
    }
    checks.left -= 1;
    try {
      const found = await onAccount("GET", store.stripeAccountId, `/checkout/sessions/${encodeURIComponent(session)}`, undefined, undefined, undefined, CHECK_MS);
      if (isSettled(found)) {
        writes.push(soldCommand(statsId, product.id, session));
        used += 1;
      } else if (found.status === "expired") {
        writes.push(["HDEL", key, session]);
      } else {
        // An unknown or completed-but-unsettled response is not proof that
        // this unit can be sold again.
        writes.push(asked(session, entry));
        used += 1;
      }
    } catch (error) {
      used += 1;
      if (error instanceof StripeError && error.status === 404 && error.code === "resource_missing" && entry.until + MISSING_AFTER_MS < now) {
        // Stripe has never heard of it, a day after its end (the creator connected another account, or it was removed):
        // it can never be paid or let go, so it is taken for sold. It stops costing questions, and never becomes a
        // free unit, the safe way to be wrong. No email to the creator is sent for it yet (docs/codex-queue.md, 513 [PF1]).
        writes.push(soldCommand(statsId, product.id, session));
      } else {
        writes.push(asked(session, entry));
        unchecked += 1;
      }
    }
  }
  if (writes.length) await redisPipeline(writes).catch(() => {});
  return { left: Math.max(0, limit - used), unchecked, holds };
}

/**
 * A reading only shown: how many entries the hash keeps and the sold count,
 * and this browser's own holds; nothing written, Stripe never asked. Every
 * entry counts as used except this browser's own live holds; units are said
 * sold out (unchecked 0) only when the sold count alone reaches the limit.
 */
async function shownReading(key: string, sold: string, limit: number, mine: string[], now: number): Promise<StockReading> {
  const receipt = await redisPipeline([["HLEN", key], ["GET", sold], ...(mine.length ? [["HMGET", key, ...mine]] : [])]);
  if (!Array.isArray(receipt) || receipt.length !== (mine.length ? 3 : 2)) throw new Error("Stock reading unavailable");
  const count = receipt[0];
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("Stock reading unavailable");
  let own = 0;
  if (mine.length) {
    const values = receipt[2];
    if (!Array.isArray(values) || values.length !== mine.length) throw new Error("Stock reading unavailable");
    for (const value of values) {
      const entry = typeof value === "string" ? entryOf(value) : null;
      if (entry && !entry.paid && entry.until > now) own += 1;
    }
  }
  const soldCount = soldOf(receipt[1]);
  const used = soldCount + count - own;
  return { left: Math.max(0, limit - used), unchecked: Math.max(0, count - own), holds: count };
}

/**
 * The two cookies that name a checkout this browser opened on a store: one
 * for its cart, one for a product bought alone (3 November 2026). Each name
 * carries the store's id, so a checkout opened on another store never
 * replaces it, and both are sent to every route under HOLD_COOKIE_PATH, so
 * the cart and a product bought alone each know the other's hold.
 */
export function holdCookieNames(store: Store): { cart: string; product: string } {
  const id = (store.statsId ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
  return { cart: `nl_cart_hold_${id}`, product: `nl_stock_hold_${id}` };
}
export const HOLD_COOKIE_PATH = "/api/store";

/** The checkouts a browser's signed hold cookies name on this store: its cart's, its product's, and both as `mine`. */
export function heldCheckouts(store: Store, read: (name: string) => string | undefined): { cart: string | null; product: string | null; mine: string[] } {
  const names = holdCookieNames(store);
  const cart = heldCheckout(store, read(names.cart));
  const product = heldCheckout(store, read(names.product));
  return { cart, product, mine: [cart, product].filter((session): session is string => session !== null) };
}

/**
 * The cookie that names a checkout this browser opened, signed for this
 * store (3 November 2026), or null when no key is set: someone who learns
 * another person's checkout id cannot make a cookie that closes it.
 */
export function holdCookieValue(store: Store, session: string): string | null {
  const mac = holdMac(store, session);
  return mac ? `${session}.${mac}` : null;
}

/** The checkout a hold cookie names, only when it is this store's and signed by us; otherwise null. */
export function heldCheckout(store: Store, value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const session = value.slice(0, dot);
  const given = value.slice(dot + 1);
  if (!CHECKOUT_ID.test(session) || !/^[0-9a-f]{32}$/.test(given)) return null;
  const made = holdMac(store, session);
  return made && timingSafeEqual(Buffer.from(made), Buffer.from(given)) ? session : null;
}

function holdMac(store: Store, session: string): string | null {
  const key = deriveKey("stock-hold-cookie");
  if (!key || !store.statsId || !CHECKOUT_ID.test(session)) return null;
  return createHmac("sha256", key).update(`${store.statsId}|${session}`).digest("hex").slice(0, 32);
}

export type StockHold<T> = { ok: true; value: T } | { ok: false; reason: "soldout" | "busy" };

/**
 * Opens a checkout for a limited product only if a unit is free, and holds
 * that unit for it. Two buyers pressing buy for the last unit at the same
 * instant cannot both get a checkout. `open` is told whether a unit is held,
 * so the checkout it makes closes before the hold runs out.
 *
 * Since 2 November 2026 (513 [PF1], found by the review of unit 3) this is a
 * cart of one (withCartStockHolds): its lock is a token only its holder lets
 * go of, it is renewed before anything is written, and it is let go once a
 * provisional hold is written, before Stripe is asked to open the checkout.
 * Until then the lock, a plain value deleted without checking, was held
 * while Stripe opened the checkout, which can take longer than the lock
 * lasted, so a second checkout could count the same last unit. The cart
 * takes the same lock key, so a product bought alone and the same product
 * in a cart wait on each other and never both get the last unit.
 */
export async function withStockHold<T extends { id: string }>(
  store: Store,
  product: Listing,
  open: (held: boolean) => Promise<T>,
): Promise<StockHold<T>> {
  const held = await withCartStockHolds(store, [product], open);
  return held.ok ? held : { ok: false, reason: held.reason };
}

/** Marks a limited product's checkout as sold, once the buyer is back. */
export async function confirmStock(store: Store, product: Listing, session: string): Promise<void> {
  if (limitedStock(product) === null || !store.statsId || !isRedisConfigured()) return;
  // Counted once, however often the buyer comes back (STOCK_SOLD).
  await redisPipeline([soldCommand(store.statsId, product.id, session)]);
}

/**
 * Hands back the unit a buyer was holding when they go back from Stripe's
 * page and press buy again: the old checkout is closed at Stripe first, so it
 * can never be paid as well. A paid checkout cannot be closed, and stays sold.
 */
export async function releaseStockHold(store: Store, product: Listing, session: string): Promise<void> {
  if (limitedStock(product) === null || !store.statsId || !store.stripeAccountId || !isRedisConfigured()) return;
  if (!CHECKOUT_ID.test(session)) return;
  const entries = await readEntries(store, product);
  const entry = entries.get(session);
  if (!entry || entry.paid) return;
  try {
    const closed = await onAccount(
      "POST",
      store.stripeAccountId,
      `/checkout/sessions/${encodeURIComponent(session)}/expire`,
      new URLSearchParams(),
      undefined,
      undefined,
      CHECK_MS,
    );
    if (closed.status !== "expired") return;
  } catch {
    return;
  }
  await redisPipeline([["HDEL", stockKey(store.statsId, product.id), session]]);
}

/** Exactly `count` replies, each an explicit 0 or 1, read by index so a hole in a sparse reply is never taken for one. */
function acknowledged(receipt: unknown, count: number): boolean {
  if (!Array.isArray(receipt) || receipt.length !== count) return false;
  for (let i = 0; i < count; i += 1) if (receipt[i] !== 0 && receipt[i] !== 1) return false;
  return true;
}

/** Why a cart's units could not be held: one of its limited products has none left (`ids`), or the count could not be read safely. */
export type CartStockHold<T> = { ok: true; value: T } | { ok: false; reason: "soldout"; ids: string[] } | { ok: false; reason: "busy" };

/**
 * A provisional hold, written under the locks before a cart's checkout is
 * opened and replaced by the checkout's own hold once it exists. Its time
 * covers the checkout's whole life (HOLD_MS, from before it is opened) and
 * the longest the opening can take at Stripe, so a checkout opened under it
 * has always closed before it lapses; a lapsed one is let go without asking
 * Stripe (stockLeft), since no checkout bears its name.
 */
const PENDING = "p_";
const PENDING_MS = HOLD_MS + 5 * 60 * 1000;

/**
 * A cart's checkout (lib/cart-checkout.ts; 513 [PF1], unit 3, added 2
 * November 2026): one unit of each limited product in it held for the one
 * checkout, as withStockHold holds one for a product bought on its own.
 *
 * Every limited product's lock is taken first (lib/redis-lock.ts: a token
 * only its holder can let go of), always in the order of their ids, so two
 * carts sharing products never wait on each other. Every count is read
 * under them; the provisional holds are then written in one step only while
 * every lock is still this checkout's (STOCK_PENDING, since 4 November
 * 2026; before, each lock was renewed first): if any ran out meanwhile (a
 * count may ask Stripe several times), nothing is held, since another
 * checkout may have counted the same unit. Then the locks are let go, so no lock is held while Stripe
 * opens the checkout. Once it exists, its own hold replaces the provisional
 * one; if it cannot be opened, the provisional ones are taken back; if its
 * hold cannot be written, it is closed at Stripe and nothing is sold on it.
 * Any lock not taken opens nothing ("busy"); a count that cannot be read
 * throws, so nothing opens either (unknown never becomes a unit). Each hold is then settled as a single
 * product's is: paid becomes sold, expired is handed back (stockLeft).
 */
export async function withCartStockHolds<T extends { id: string }>(
  store: Store,
  products: Listing[],
  open: (held: boolean) => Promise<T>,
): Promise<CartStockHold<T>> {
  const limited = [...new Map(products.filter((product) => limitedStock(product) !== null).map((product) => [product.id, product])).values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (limited.length === 0) return { ok: true, value: await open(false) };
  if (!store.statsId || !isRedisConfigured()) return { ok: false, reason: "busy" };
  const statsId = store.statsId;
  const pending = `${PENDING}${crypto.randomUUID().replace(/-/g, "")}`;
  const taken: Held[] = [];
  try {
    // Long enough for the counts to ask Stripe their most times together, each at its ceiling.
    const lockSeconds = 15 + Math.ceil((MAX_CHECKS * CHECK_MS) / 1000);
    for (const product of limited) taken.push(await takeLock(lockKey(statsId, product.id), lockSeconds, LOCK_WAIT_MS));
    const now = Date.now();
    const out: string[] = [];
    // The cart's counts share MAX_CHECKS questions to Stripe, so the time under the locks is bounded whatever the cart holds.
    const checks: StripeChecks = { left: MAX_CHECKS };
    let full = false;
    for (const product of limited) {
      // A count that cannot be read throws, as it always has for one product: nothing opens, every lock is let go below.
      const reading = await stockReading(store, product, now, { checks, underLock: true });
      if (reading && reading.left <= 0) out.push(product.id);
      // A hash at its most holds takes no more, so every reading of it stays bounded (STOCK_ENTRIES_MAX).
      if (reading && reading.holds >= STOCK_ENTRIES_MAX) full = true;
    }
    if (out.length > 0) return { ok: false, reason: "soldout", ids: out };
    if (full) return { ok: false, reason: "busy" };
    // Written only while every lock is still this checkout's, in one step (STOCK_PENDING); a lock lost, or a script
    // refused or unanswered, holds nothing: whatever may have landed is taken back.
    const written = await redisPipeline([[
      "EVAL", STOCK_PENDING, 2 * limited.length,
      ...taken.map((held) => held.key), ...limited.map((product) => stockKey(statsId, product.id)),
      ...taken.map((held) => held.token), pending, JSON.stringify({ until: Date.now() + PENDING_MS }),
    ]]).catch(() => null);
    if (!Array.isArray(written) || written.length !== 1 || written[0] !== 1) {
      await redisPipeline(limited.map((product) => ["HDEL", stockKey(statsId, product.id), pending])).catch(() => {});
      return { ok: false, reason: "busy" };
    }
  } catch (error) {
    if (error instanceof LockBusyError) return { ok: false, reason: "busy" };
    throw error;
  } finally {
    for (const held of taken) await releaseLock(held);
  }
  let value: T;
  try {
    value = await open(true);
  } catch (error) {
    await redisPipeline(limited.map((product) => ["HDEL", stockKey(statsId, product.id), pending])).catch(() => {});
    throw error;
  }
  // Counted from after the checkout exists, so its hold outlasts it; the provisional one goes.
  const hold = JSON.stringify({ until: Date.now() + HOLD_MS });
  const receipt = await redisPipeline(limited.flatMap((product) => [["HSET", stockKey(statsId, product.id), value.id, hold], ["HDEL", stockKey(statsId, product.id), pending]])).catch(() => null);
  // Each HDEL must say it took the provisional hold away (1): that hold was there until the checkout's own was written just
  // before it, so no other checkout could count the unit in between. A 0 means it was already gone (it lapsed, which the
  // open's own time limits rule out, or Redis lost it); then the unit may have been counted free meanwhile, so the checkout
  // is treated as unwritten and closed.
  const written = acknowledged(receipt, limited.length * 2) && limited.every((_, i) => (receipt as unknown[])[2 * i + 1] === 1);
  if (!written) {
    // Nobody is sent to a checkout whose units are not written as its own: it is closed at Stripe. Once Stripe says it is
    // closed, its holds are let go; otherwise the provisional ones lapse on their own (fewer sold, never more).
    const closed = store.stripeAccountId
      ? await onAccount("POST", store.stripeAccountId, `/checkout/sessions/${encodeURIComponent(value.id)}/expire`, new URLSearchParams(), undefined, undefined, CHECK_MS).catch(() => null)
      : null;
    if (closed?.status === "expired") {
      await redisPipeline(limited.flatMap((product) => [["HDEL", stockKey(statsId, product.id), pending], ["HDEL", stockKey(statsId, product.id), value.id]])).catch(() => {});
    }
    return { ok: false, reason: "busy" };
  }
  return { ok: true, value };
}

/** Marks every limited product of a paid cart as sold, once the buyer is back, as confirmStock does for one. */
export async function confirmCartStock(store: Store, products: Listing[], session: string): Promise<void> {
  const limited = products.filter((product) => limitedStock(product) !== null);
  if (limited.length === 0 || !store.statsId || !isRedisConfigured()) return;
  const statsId = store.statsId;
  // Counted once each, however often the buyer comes back (STOCK_SOLD).
  await redisPipeline(limited.map((product) => soldCommand(statsId, product.id, session)));
}

/**
 * Hands back what a buyer was holding with a cart's checkout when they go
 * back from Stripe's page and pay for a cart again, as releaseStockHold does
 * for one product: the old checkout is closed at Stripe first, so it can
 * never be paid as well; then its hold is let go on every product it held,
 * in the new cart or not (read from the checkout Stripe closed).
 *
 * When Stripe will not close it, it is read back (3 November 2026): one
 * paid with nobody back on the thanks page is marked sold on every product
 * it held, so the cart says so at once instead of offering the unit again;
 * one that had closed already is let go as above. `session` must come from
 * the signed cookie (heldCheckout). Each question to Stripe waits CHECK_MS
 * at the most.
 */
export async function releaseCartStockHolds(
  store: Store,
  products: Listing[],
  session: string,
  options: { ifHolding?: boolean } = {},
): Promise<ReleaseOutcome> {
  if (!store.statsId || !store.stripeAccountId || !isRedisConfigured()) return "kept";
  if (!CHECKOUT_ID.test(session)) return "kept";
  const statsId = store.statsId;
  const account = store.stripeAccountId;
  const limited = products.filter((product) => limitedStock(product) !== null);
  // Read once each, and kept for what the old checkout held below.
  const known = new Map<string, Map<string, Entry>>();
  for (const product of limited) {
    // Its holds, and whether this checkout's unit of it is already in the sold count (STOCK_SOLD): then it was paid.
    const receipt = await redisPipeline([["HGETALL", stockKey(statsId, product.id)], ["EXISTS", paidKey(statsId, product.id, session)]]);
    if (!Array.isArray(receipt) || receipt.length !== 2) throw new Error("Stock reading unavailable");
    const entries = entriesOf(receipt[0]);
    if (entries.get(session)?.paid || receipt[1] === 1) return "paid";
    known.set(product.id, entries);
  }
  // A product bought alone closes a cart's checkout only when it holds that product's unit.
  if (options.ifHolding && ![...known.values()].some((entries) => entries.has(session))) return "kept";
  const path = `/checkout/sessions/${encodeURIComponent(session)}`;
  let closed: Record<string, unknown> | null = await onAccount("POST", account, `${path}/expire`, new URLSearchParams(), undefined, undefined, CHECK_MS).catch(() => null);
  if (closed?.status !== "expired") {
    const found = await onAccount("GET", account, path, undefined, undefined, undefined, CHECK_MS).catch(() => null);
    if (!found) return "kept";
    if (isSettled(found)) {
      const sold = await holdingOf(store, found, known, session);
      if (sold.length) await redisPipeline(sold.map((id) => soldCommand(statsId, id, session)));
      return "paid";
    }
    if (found.status !== "expired") return "kept";
    closed = found;
  }
  const held = await holdingOf(store, closed, known, session);
  if (held.length) await redisPipeline(held.map((id) => ["HDEL", stockKey(statsId, id), session]));
  return "closed";
}

/** What became of an old checkout handed back: closed at Stripe and let go, found paid and marked sold, or neither (kept as it was). */
export type ReleaseOutcome = "closed" | "paid" | "kept";

/**
 * The products a checkout holds a unit of: those of the new cart, and those
 * Stripe's record of it names (its product and what was added, BUMP_KEYS),
 * each only where a hold of it is kept. What the new cart's counts read is
 * not read again: at most MAX_CART reads more.
 */
async function holdingOf(store: Store, session: Record<string, unknown>, known: Map<string, Map<string, Entry>>, id: string): Promise<string[]> {
  const meta = (session.metadata ?? {}) as Record<string, unknown>;
  const named = [meta.product, ...BUMP_KEYS.map((key) => meta[key])].filter((value): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value));
  const out: string[] = [];
  for (const productId of new Set([...known.keys(), ...named])) {
    const entries = known.get(productId) ?? (await readEntries(store, { id: productId }).catch(() => new Map<string, Entry>()));
    if (entries.has(id)) out.push(productId);
  }
  return out;
}
