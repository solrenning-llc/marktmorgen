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
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { HOLD_SECONDS, onAccount } from "@/lib/stripe-account";
import { isSettled } from "@/lib/instant-pay";
import { limitedStock } from "@/lib/product-extras";
import { type Held, LockBusyError, holdLock, releaseLock, takeLock } from "@/lib/redis-lock";
import type { Listing, Store } from "@/lib/store";

const HOLD_MS = HOLD_SECONDS * 1000;
const MAX_CHECKS = 5;

type Entry = { until: number; paid?: boolean };

const stockKey = (id: string, productId: string) => `nl:stock:${id}:${productId}`;
const lockKey = (id: string, productId: string) => `nl:stock:lock:${id}:${productId}`;

async function readEntries(store: Store, product: Listing): Promise<Map<string, Entry>> {
  const receipt = await redisPipeline([["HGETALL", stockKey(store.statsId!, product.id)]]);
  if (!Array.isArray(receipt) || receipt.length !== 1) throw new Error("Stock reading unavailable");
  const raw: unknown = receipt[0];
  if (!Array.isArray(raw) || raw.length % 2 !== 0) throw new Error("Stock reading unavailable");
  const entries = new Map<string, Entry>();
  for (let i = 0; i < raw.length; i += 2) {
    const session = raw[i], encoded = raw[i + 1];
    if (typeof session !== "string" || !session || typeof encoded !== "string" || entries.has(session)) throw new Error("Stock reading unavailable");
    let value: unknown;
    try { value = JSON.parse(encoded); } catch { throw new Error("Stock reading unavailable"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stock reading unavailable");
    const entry = value as Partial<Entry>;
    if (!Number.isSafeInteger(entry.until) || (entry.until as number) < 0 || (entry.paid !== undefined && typeof entry.paid !== "boolean")) throw new Error("Stock reading unavailable");
    entries.set(session, { until: entry.until as number, ...(entry.paid !== undefined ? { paid: entry.paid } : {}) });
  }
  return entries;
}

/**
 * Units left of a limited product, or null when it is not limited.
 *
 * Holds that ran out are settled on the way: paid ones become sales, the rest
 * are handed back. When Stripe cannot be asked, a hold stays counted — the
 * safe way to be wrong is to show one unit too few, never to sell one too many.
 */
export async function stockLeft(store: Store, product: Listing, now = Date.now()): Promise<number | null> {
  const limit = limitedStock(product);
  if (limit === null) return null;
  if (!store.statsId || !isRedisConfigured()) throw new Error("Stock reading unavailable");
  const entries = await readEntries(store, product);
  let used = 0;
  let checks = 0;
  const writes: (string | number)[][] = [];
  for (const [session, entry] of entries) {
    if (entry.paid || entry.until > now) {
      used += 1;
      continue;
    }
    // A cart's provisional hold that lapsed: every checkout opened under it has closed, and none bears its name (withCartStockHolds).
    if (session.startsWith(PENDING)) {
      writes.push(["HDEL", stockKey(store.statsId, product.id), session]);
      continue;
    }
    if (checks >= MAX_CHECKS || !store.stripeAccountId) {
      used += 1;
      continue;
    }
    checks += 1;
    try {
      const found = await onAccount("GET", store.stripeAccountId, `/checkout/sessions/${encodeURIComponent(session)}`);
      if (isSettled(found)) {
        writes.push(["HSET", stockKey(store.statsId, product.id), session, JSON.stringify({ until: 0, paid: true })]);
        used += 1;
      } else if (found.status === "expired") {
        writes.push(["HDEL", stockKey(store.statsId, product.id), session]);
      } else {
        // An unknown or completed-but-unsettled response is not proof that
        // this unit can be sold again.
        used += 1;
      }
    } catch {
      used += 1;
    }
  }
  if (writes.length) await redisPipeline(writes).catch(() => {});
  return Math.max(0, limit - used);
}

export type StockHold<T> = { ok: true; value: T } | { ok: false; reason: "soldout" | "busy" };

/**
 * Opens a checkout for a limited product only if a unit is free, and holds
 * that unit for it. Two buyers pressing buy for the last unit at the same
 * instant cannot both get a checkout: the count and the hold happen under one
 * short lock. `open` is told whether a unit is held, so the checkout it makes
 * closes before the hold runs out.
 */
export async function withStockHold<T extends { id: string }>(
  store: Store,
  product: Listing,
  open: (held: boolean) => Promise<T>,
): Promise<StockHold<T>> {
  if (limitedStock(product) === null) {
    return { ok: true, value: await open(false) };
  }
  if (!store.statsId || !isRedisConfigured()) return { ok: false, reason: "busy" };
  const lock = lockKey(store.statsId, product.id);
  let locked = false;
  for (let attempt = 0; attempt < 6 && !locked; attempt += 1) {
    const receipt = await redisPipeline([["SET", lock, "1", "NX", "EX", 15]]);
    // Unknown acquisition evidence cannot open a checkout or release the lock.
    if (!Array.isArray(receipt) || receipt.length !== 1) return { ok: false, reason: "busy" };
    const got: unknown = receipt[0];
    if (got !== null && got !== "OK") return { ok: false, reason: "busy" };
    locked = got === "OK";
    if (!locked) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!locked) return { ok: false, reason: "busy" };
  try {
    const left = await stockLeft(store, product, Date.now());
    if (left !== null && left <= 0) return { ok: false, reason: "soldout" };
    const value = await open(true);
    // Counted from after the checkout exists, so the hold outlasts it.
    const receipt = await redisPipeline([
      ["HSET", stockKey(store.statsId, product.id), value.id, JSON.stringify({ until: Date.now() + HOLD_MS })],
    ]);
    if (!Array.isArray(receipt) || receipt.length !== 1) return { ok: false, reason: "busy" };
    const recorded: unknown = receipt[0];
    if (recorded !== 0 && recorded !== 1) return { ok: false, reason: "busy" };
    return { ok: true, value };
  } finally {
    await redisPipeline([["DEL", lock]]).catch(() => {});
  }
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
  if (!/^cs_(test|live)_[A-Za-z0-9]{8,200}$/.test(session)) return;
  const entries = await readEntries(store, product);
  const entry = entries.get(session);
  if (!entry || entry.paid) return;
  try {
    const closed = await onAccount(
      "POST",
      store.stripeAccountId,
      `/checkout/sessions/${encodeURIComponent(session)}/expire`,
      new URLSearchParams(),
    );
    if (closed.status !== "expired") return;
  } catch {
    return;
  }
  await redisPipeline([["HDEL", stockKey(store.statsId, product.id), session]]);
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
 * Any lock not taken, or any count that cannot be read, opens nothing
 * (unknown never becomes a unit). Each hold is then settled as a single
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
    for (const product of limited) taken.push(await takeLock(lockKey(statsId, product.id), 15, 1500));
    const now = Date.now();
    const out: string[] = [];
    for (const product of limited) {
      const left = await stockLeft(store, product, now).catch(() => undefined);
      if (left === undefined) return { ok: false, reason: "busy" };
      if (left !== null && left <= 0) out.push(product.id);
    }
    if (out.length > 0) return { ok: false, reason: "soldout", ids: out };
    for (const held of taken) if (!(await holdLock(held))) return { ok: false, reason: "busy" };
    const receipt = await redisPipeline(limited.map((product) => ["HSET", stockKey(statsId, product.id), pending, JSON.stringify({ until: Date.now() + PENDING_MS })]));
    if (!Array.isArray(receipt) || receipt.length !== limited.length || receipt.some((recorded: unknown) => recorded !== 0 && recorded !== 1)) {
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
  const written = Array.isArray(receipt) && receipt.length === limited.length * 2 && receipt.every((recorded: unknown) => recorded === 0 || recorded === 1);
  if (!written) {
    // Nobody is sent to a checkout whose units are not written as its own: it is closed at Stripe, and the provisional holds lapse.
    if (store.stripeAccountId) await onAccount("POST", store.stripeAccountId, `/checkout/sessions/${encodeURIComponent(value.id)}/expire`, new URLSearchParams()).catch(() => {});
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
 * never be paid as well; then its hold is let go on every limited product of
 * the new cart that it held. A hold on a product no longer in the cart is
 * let go by stockLeft once Stripe says the checkout expired.
 */
export async function releaseCartStockHolds(store: Store, products: Listing[], session: string): Promise<void> {
  const limited = products.filter((product) => limitedStock(product) !== null);
  if (limited.length === 0 || !store.statsId || !store.stripeAccountId || !isRedisConfigured()) return;
  if (!/^cs_(test|live)_[A-Za-z0-9]{8,200}$/.test(session)) return;
  const holding: Listing[] = [];
  for (const product of limited) {
    const entry = (await readEntries(store, product)).get(session);
    if (entry?.paid) return;
    if (entry) holding.push(product);
  }
  if (holding.length === 0) return;
  try {
    const closed = await onAccount("POST", store.stripeAccountId, `/checkout/sessions/${encodeURIComponent(session)}/expire`, new URLSearchParams());
    if (closed.status !== "expired") return;
  } catch {
    return;
  }
  const statsId = store.statsId;
  await redisPipeline(holding.map((product) => ["HDEL", stockKey(statsId, product.id), session]));
}
