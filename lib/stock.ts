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
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { HOLD_SECONDS, StripeError, onAccount } from "@/lib/stripe-account";
import { BUMP_KEYS } from "@/lib/bundle-rules";
import { MAX_CART } from "@/lib/cart-rules";
import { deriveKey } from "@/lib/secret-box";
import { isSettled } from "@/lib/instant-pay";
import { limitedStock } from "@/lib/product-extras";
import { type Held, LockBusyError, holdLock, releaseLock, takeLock } from "@/lib/redis-lock";
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
 * counts (3 November 2026). A reading that is only shown (a suggestion, a
 * bundle, "Goes well with", a reminder) gets none: a hold that ran out is
 * then counted as used without asking, and said to be unchecked.
 */
export type StripeChecks = { left: number };
/** A budget of no questions to Stripe, for a reading that is only shown. */
export const shownOnly = (): StripeChecks => ({ left: 0 });

export type StockOptions = {
  /**
   * The checkouts this browser opened (its signed cart and product cookies,
   * heldCheckouts): their own live, unpaid holds are not counted against it,
   * and a question to Stripe goes to them first.
   */
  mine?: string[];
  /** The questions to Stripe this reading may ask; MAX_CHECKS of its own when left out. */
  checks?: StripeChecks;
};

/** A count, and how many of the holds counted as used are so only because Stripe was not asked or did not answer. */
export type StockReading = { left: number; unchecked: number };

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
 * of; and what the old cart checkout held outside the new cart.
 */
export const STOCK_ORDER_COMMANDS = MAX_CART * STOCK_COMMANDS_PER_PRODUCT + 2 * MAX_CHECKS + MAX_CART * MAX_LAPSED + 2 * MAX_CART;
/** A Stripe Checkout session's id, as it may be named in a cookie. */
const CHECKOUT_ID = /^cs_(test|live)_[A-Za-z0-9]{8,200}$/;

/**
 * A hold, and when Stripe was last asked about it (`asked`, kept in its own
 * field `a:<session>` so that writing it can never undo a sale marked at the
 * same moment).
 */
type Entry = { until: number; paid?: boolean; asked?: number };
const ASKED = "a:";

const stockKey = (id: string, productId: string) => `nl:stock:${id}:${productId}`;
const lockKey = (id: string, productId: string) => `nl:stock:lock:${id}:${productId}`;

async function readEntries(store: Store, product: Pick<Listing, "id">): Promise<Map<string, Entry>> {
  const receipt = await redisPipeline([["HGETALL", stockKey(store.statsId!, product.id)]]);
  if (!Array.isArray(receipt) || receipt.length !== 1) throw new Error("Stock reading unavailable");
  const raw: unknown = receipt[0];
  if (!Array.isArray(raw) || raw.length % 2 !== 0) throw new Error("Stock reading unavailable");
  const entries = new Map<string, Entry>();
  const asked = new Map<string, number>();
  for (let i = 0; i < raw.length; i += 2) {
    const session = raw[i], encoded = raw[i + 1];
    if (typeof session !== "string" || !session || typeof encoded !== "string" || entries.has(session)) throw new Error("Stock reading unavailable");
    if (session.startsWith(ASKED)) {
      // When Stripe was last asked about a hold: a time, or nothing is known (asked at once).
      if (/^\d{1,16}$/.test(encoded) && Number.isSafeInteger(Number(encoded))) asked.set(session.slice(ASKED.length), Number(encoded));
      continue;
    }
    let value: unknown;
    try { value = JSON.parse(encoded); } catch { throw new Error("Stock reading unavailable"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stock reading unavailable");
    const entry = value as Partial<Entry>;
    if (!Number.isSafeInteger(entry.until) || (entry.until as number) < 0 || (entry.paid !== undefined && typeof entry.paid !== "boolean")) throw new Error("Stock reading unavailable");
    entries.set(session, { until: entry.until as number, ...(entry.paid !== undefined ? { paid: entry.paid } : {}) });
  }
  for (const [session, at] of asked) {
    const entry = entries.get(session);
    if (entry) entry.asked = at;
  }
  return entries;
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
  const entries = await readEntries(store, product);
  const checks = options.checks ?? { left: MAX_CHECKS };
  const mine = new Set(options.mine ?? []);
  const key = stockKey(store.statsId, product.id);
  let used = 0;
  let unchecked = 0;
  let lapsed = 0;
  const writes: (string | number)[][] = [];
  const toAsk: [string, Entry][] = [];
  for (const [session, entry] of entries) {
    // This browser's own live hold is its own (options.mine).
    if (mine.has(session) && !entry.paid && entry.until > now) continue;
    if (entry.paid || entry.until > now) {
      used += 1;
      continue;
    }
    // A cart's provisional hold that lapsed: every checkout opened under it has closed, and none bears its name
    // (withCartStockHolds). Free; let go of MAX_LAPSED at a time, so one count's writes stay bounded.
    if (session.startsWith(PENDING)) {
      if (lapsed < MAX_LAPSED) writes.push(["HDEL", key, session]);
      lapsed += 1;
      continue;
    }
    toAsk.push([session, entry]);
  }
  // The browser's own first, then the one asked longest ago, so holds Stripe never settles cannot keep the others from
  // being asked about (3 November 2026).
  toAsk.sort(([a, x], [b, y]) => Number(mine.has(b)) - Number(mine.has(a)) || (x.asked ?? 0) - (y.asked ?? 0) || x.until - y.until);
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
        writes.push(["HSET", key, session, JSON.stringify({ until: 0, paid: true })], ["HDEL", key, `${ASKED}${session}`]);
        used += 1;
      } else if (found.status === "expired") {
        writes.push(["HDEL", key, session], ["HDEL", key, `${ASKED}${session}`]);
      } else {
        // An unknown or completed-but-unsettled response is not proof that
        // this unit can be sold again.
        writes.push(["HSET", key, `${ASKED}${session}`, String(now)]);
        used += 1;
      }
    } catch (error) {
      used += 1;
      if (error instanceof StripeError && error.status === 404 && error.code === "resource_missing" && entry.until + MISSING_AFTER_MS < now) {
        // Stripe has never heard of it, a day after its end (the creator connected another account, or it was removed):
        // it can never be paid or let go, so it is taken for sold. It stops costing questions, and never becomes a
        // free unit, the safe way to be wrong. No email to the creator is sent for it yet (docs/codex-queue.md, 513 [PF1]).
        writes.push(["HSET", key, session, JSON.stringify({ until: 0, paid: true })], ["HDEL", key, `${ASKED}${session}`]);
      } else {
        writes.push(["HSET", key, `${ASKED}${session}`, String(now)]);
        unchecked += 1;
      }
    }
  }
  if (writes.length) await redisPipeline(writes).catch(() => {});
  return { left: Math.max(0, limit - used), unchecked };
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
  await redisPipeline([
    ["HSET", stockKey(store.statsId, product.id), session, JSON.stringify({ until: 0, paid: true })],
  ]);
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
  await redisPipeline([["HDEL", stockKey(store.statsId, product.id), session], ["HDEL", stockKey(store.statsId, product.id), `${ASKED}${session}`]]);
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
 * under them; each lock is then renewed, and if any ran out meanwhile (a
 * count may ask Stripe several times), nothing is held, since another
 * checkout may have counted the same unit. Only then a provisional hold is
 * written for each and the locks let go, so no lock is held while Stripe
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
    for (const product of limited) {
      // A count that cannot be read throws, as it always has for one product: nothing opens, every lock is let go below.
      const left = await stockLeft(store, product, now, { checks });
      if (left !== null && left <= 0) out.push(product.id);
    }
    if (out.length > 0) return { ok: false, reason: "soldout", ids: out };
    for (const held of taken) if (!(await holdLock(held))) return { ok: false, reason: "busy" };
    const receipt = await redisPipeline(limited.map((product) => ["HSET", stockKey(statsId, product.id), pending, JSON.stringify({ until: Date.now() + PENDING_MS })]));
    if (!acknowledged(receipt, limited.length)) {
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
  const written = acknowledged(receipt, limited.length * 2);
  if (!written) {
    // Nobody is sent to a checkout whose units are not written as its own: it is closed at Stripe, and the provisional holds lapse.
    if (store.stripeAccountId) await onAccount("POST", store.stripeAccountId, `/checkout/sessions/${encodeURIComponent(value.id)}/expire`, new URLSearchParams(), undefined, undefined, CHECK_MS).catch(() => {});
    return { ok: false, reason: "busy" };
  }
  return { ok: true, value };
}

/** Marks every limited product of a paid cart as sold, once the buyer is back, as confirmStock does for one. */
export async function confirmCartStock(store: Store, products: Listing[], session: string): Promise<void> {
  const limited = products.filter((product) => limitedStock(product) !== null);
  if (limited.length === 0 || !store.statsId || !isRedisConfigured()) return;
  const statsId = store.statsId;
  await redisPipeline(limited.map((product) => ["HSET", stockKey(statsId, product.id), session, JSON.stringify({ until: 0, paid: true })]));
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
    const entries = await readEntries(store, product);
    if (entries.get(session)?.paid) return "paid";
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
      if (sold.length) await redisPipeline(sold.map((id) => ["HSET", stockKey(statsId, id), session, JSON.stringify({ until: 0, paid: true })]));
      return "paid";
    }
    if (found.status !== "expired") return "kept";
    closed = found;
  }
  const held = await holdingOf(store, closed, known, session);
  if (held.length) await redisPipeline(held.flatMap((id) => [["HDEL", stockKey(statsId, id), session], ["HDEL", stockKey(statsId, id), `${ASKED}${session}`]]));
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
