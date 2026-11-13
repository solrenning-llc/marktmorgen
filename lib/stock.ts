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
import { HOLD_SECONDS, StripeError, onAccount, watchCheckoutOpening } from "@/lib/stripe-account";
import { isSettled } from "@/lib/instant-pay";
import { limitedStock } from "@/lib/product-extras";
import { type Held, LockBusyError, releaseLock, takeLock } from "@/lib/redis-lock";
import { OrdersPausedError } from "@/lib/order-admission";
import { DigitalConsentMissing } from "@/lib/digital-consent";
import type { Listing, Store } from "@/lib/store";

const HOLD_MS = HOLD_SECONDS * 1000;
const MAX_CHECKS = 5;
/**
 * The longest one count waits for Stripe about a hold that ran out (2
 * November 2026): kept short, so a page or a checkout never waits long; an
 * answer that does not come in time counts the unit as used, the safe way to
 * be wrong. Since the review of 5 November 2026 Stripe is never asked while a
 * stock lock is held (withCartStockHolds).
 */
const CHECK_MS = 2_000;
/**
 * The most questions about lapsed holds one request has at Stripe at once,
 * whatever it counts (Claude 3's performance audit, 13 November 2026): a
 * store page of 24 limited products would otherwise ask up to 120 at once of
 * the creator's account and run into Stripe's own rate limit.
 */
export const STOCK_STRIPE_IN_FLIGHT = 8;
/**
 * The longest one request waits on Stripe about lapsed holds, all its counts
 * together. A question that cannot start in time is not asked: its hold
 * counts as used and the count as unknown, as a slow answer does.
 */
export const STOCK_STRIPE_WAIT_MS = 2 * CHECK_MS;
/** The least time worth asking Stripe in (lib/stripe-account.ts refuses a shorter ceiling). */
const LEAST_ASK_MS = 50;

/** What one request may still ask Stripe about lapsed holds: shared by every count it makes (stockBudget). */
export type StockBudget = { readonly until: number; inFlight: number; readonly waiting: (() => void)[] };

/** One request's questions to Stripe about lapsed holds, to share across every count it makes; timed by the real clock. */
export function stockBudget(): StockBudget {
  return { until: Date.now() + STOCK_STRIPE_WAIT_MS, inFlight: 0, waiting: [] };
}

/** Asks within the request's budget: at most STOCK_STRIPE_IN_FLIGHT at once, none started past its time; null when not asked. */
async function askWithin<T>(budget: StockBudget, ask: (ms: number) => Promise<T>): Promise<T | null> {
  if (budget.inFlight >= STOCK_STRIPE_IN_FLIGHT) await new Promise<void>((resolve) => budget.waiting.push(resolve));
  else budget.inFlight += 1;
  try {
    const left = budget.until - Date.now();
    if (left < LEAST_ASK_MS) return null;
    return await ask(Math.min(CHECK_MS, left));
  } finally {
    // The slot goes straight to the next one waiting, or is let go.
    const next = budget.waiting.shift();
    if (next) next();
    else budget.inFlight -= 1;
  }
}
/**
 * The longest a checkout waits for another's stock lock (5 November 2026):
 * a lock is held only for a few Redis round trips (Stripe is never asked
 * under it), so a short wait is enough, and it bounds the tries a contended
 * lock costs (tests/cart-stock.test.ts, CART_STOCK_COMMANDS_MOST).
 */
const LOCK_WAIT_MS = 500;
const LOCK_SECONDS = 15;
/**
 * The most limited products a checkout counts again at once after the holds
 * that ran out were settled (Claude 4's review of #1732, 6 November 2026):
 * the second count's locks, counts and hand-over stay, with the first, inside
 * CART_STOCK_COMMANDS_MOST (tests/cart-stock.test.ts); a larger cart is told
 * to press again instead, and its next try opens.
 */
const RECOUNT_MOST = 2;

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
export async function stockLeft(store: Store, product: Listing, now = Date.now(), budget: StockBudget = stockBudget()): Promise<number | null> {
  return (await countStock(store, product, now, budget))?.left ?? null;
}

/**
 * stockLeft, but null when any lapsed hold's checkout could not be read
 * (Stripe failed, or answered something that is neither settled nor expired):
 * the count is then a guess on the safe side, never proof of "Sold out"
 * (Claude 6's LOW on #1732). Used where a refusal is decided.
 */
async function stockLeftKnown(store: Store, product: Listing, budget: StockBudget, now = Date.now()): Promise<number | null> {
  const count = await countStock(store, product, now, budget);
  return count && count.unknown === 0 ? count.left : null;
}

/**
 * The count itself. Without a budget to `ask` with (under a stock lock) Stripe is never asked:
 * a hold that ran out and is not settled yet counts as used, the safe way to
 * be wrong, and is counted in `unresolved` so the caller can have it settled
 * once the lock is let go.
 */
async function countStock(store: Store, product: Listing, now: number, ask: StockBudget | null): Promise<{ left: number; unresolved: number; unknown: number } | null> {
  const limit = limitedStock(product);
  if (limit === null) return null;
  if (!store.statsId || !isRedisConfigured()) throw new Error("Stock reading unavailable");
  const entries = await readEntries(store, product);
  let used = 0;
  let checks = 0;
  let unresolved = 0;
  // Lapsed holds whose checkout could not be read: counted as used (the safe way to be wrong for selling), and
  // counted here so a refusal is never decided on them (stockLeftKnown).
  let unknown = 0;
  const writes: (string | number)[][] = [];
  const asking: string[] = [];
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
    if (!ask) {
      used += 1;
      unresolved += 1;
      continue;
    }
    if (checks >= MAX_CHECKS || !store.stripeAccountId) {
      used += 1;
      continue;
    }
    checks += 1;
    asking.push(session);
  }
  // Asked side by side, inside the request's budget (Claude 3's performance
  // audit, 13 November 2026): at most STOCK_STRIPE_IN_FLIGHT at once for the
  // whole request and none started after STOCK_STRIPE_WAIT_MS, so a page or a
  // click never waits MAX_CHECKS × CHECK_MS in a row, and a page of limited
  // products never floods the creator's account. A question not asked in time
  // counts as an answer that did not come: the unit used, the count unknown.
  const { stripeAccountId } = store;
  const answers = stripeAccountId && ask
    ? await Promise.all(
        asking.map((session) =>
          askWithin(ask, (ms) => onAccount("GET", stripeAccountId, `/checkout/sessions/${encodeURIComponent(session)}`, undefined, undefined, undefined, ms)).then(
            (found) => ({ session, found }),
            () => ({ session, found: null }),
          ),
        ),
      )
    : [];
  for (const { session, found } of answers) {
    if (found === null) {
      used += 1;
      unknown += 1;
    } else if (isSettled(found)) {
      writes.push(["HSET", stockKey(store.statsId, product.id), session, JSON.stringify({ until: 0, paid: true })]);
      used += 1;
    } else if (found.status === "expired") {
      writes.push(["HDEL", stockKey(store.statsId, product.id), session]);
    } else {
      // An unknown or completed-but-unsettled response is not proof that
      // this unit can be sold again. A checkout still open or completed is a
      // known holder of the unit; any other answer is unknown.
      used += 1;
      if (found.status !== "open" && found.status !== "complete") unknown += 1;
    }
  }
  if (writes.length) await redisPipeline(writes).catch(() => {});
  return { left: Math.max(0, limit - used), unresolved, unknown };
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
 * go of, checked with the provisional hold in one step (STOCK_ADMIT, since
 * Codex G2's review of 5 November 2026), and let go before Stripe is asked
 * to open the checkout; an opening whose answer is unknown keeps the unit,
 * and the checkout's own hold replaces the provisional one only once it is
 * written (STOCK_BIND). Until then the lock, a plain value deleted without
 * checking, was held while Stripe opened the checkout, which can take longer
 * than the lock lasted, so a second checkout could count the same last unit.
 * Paused orders and a missing consent are refused before Stripe is asked
 * (refusedBeforeStripe), so they hand the unit back at once; since Claude 4's
 * review of #1732 (6 November 2026) so does any error raised before Stripe is
 * asked to open the checkout (watchCheckoutOpening), such as a false option.
 */
export async function withStockHold<T extends { id: string }>(
  store: Store,
  product: Listing,
  open: (held: boolean) => Promise<T>,
  refused: (error: unknown) => boolean = refusedBeforeStripe,
): Promise<StockHold<T>> {
  const held = await withCartStockHolds(store, [product], open, refused);
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

/** Exactly `count` replies, each an explicit 0 or 1, read by index so a hole in a sparse reply is never taken for one. */
function acknowledged(receipt: unknown, count: number): boolean {
  if (!Array.isArray(receipt) || receipt.length !== count) return false;
  for (let i = 0; i < count; i += 1) if (receipt[i] !== 0 && receipt[i] !== 1) return false;
  return true;
}

/** A script's one reply, read only in its exact shape: 1 or 0, anything else (a hole, an error, another number) unknown. */
function scriptAnswer(receipt: unknown): 1 | 0 | null {
  if (!Array.isArray(receipt) || receipt.length !== 1 || !Object.hasOwn(receipt, 0)) return null;
  return receipt[0] === 1 ? 1 : receipt[0] === 0 ? 0 : null;
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
 * The admission of a cart's provisional holds (CX-123, rule 25; Codex G2's
 * review of #1730, 5 November 2026), one step on the Redis side: every
 * lock still holds this request's token AND every provisional hold it wrote
 * is there, so 1, and the locks are let go in the same step; otherwise each
 * of its provisional holds is taken back in the same step, so 0. A key of
 * another type makes the script fail, read as unknown (nothing opens). A lock key that still holds our token has held it
 * since we took it (only we write that token, and a lock that ran out comes
 * back with another), so no other checkout counted that product between our
 * count and our write: whoever counts after the write sees our hold.
 * KEYS: the n locks, then the n products' holds; ARGV: n, the n tokens, the
 * provisional hold's name.
 */
export const STOCK_ADMIT = `-- marktmorgen:stock-admit:v1
local n = tonumber(ARGV[1])
if not n or n ~= math.floor(n) or n < 1 or n > 8 or #KEYS ~= 2 * n or #ARGV ~= n + 2 then return -1 end
local pending = ARGV[n + 2]
local ours = 1
for i = 1, n do
  if redis.call("GET", KEYS[i]) ~= ARGV[1 + i] then ours = 0 end
  if redis.call("HEXISTS", KEYS[n + i], pending) ~= 1 then ours = 0 end
end
if ours == 1 then
  for i = 1, n do redis.call("DEL", KEYS[i]) end
  return 1
end
for i = 1, n do redis.call("HDEL", KEYS[n + i], pending) end
return 0`;

/**
 * The hand-over from the provisional holds to the checkout's own, after the
 * checkout's hold is written and acknowledged: in one step, only when every
 * product has both the checkout's hold and the provisional one, the
 * provisional ones are let go, so 1; otherwise nothing changes, so 0. Both
 * there proves the unit was held without a gap from the count to the
 * checkout (the provisional one, once let go, never comes back): a
 * provisional hold that lapsed and was let go while the checkout was being
 * opened could have let the unit be sold to someone else.
 * KEYS: the n products' holds; ARGV: n, the provisional hold's name, the checkout's id.
 */
export const STOCK_BIND = `-- marktmorgen:stock-bind:v1
local n = tonumber(ARGV[1])
if not n or n ~= math.floor(n) or n < 1 or n > 8 or #KEYS ~= n or #ARGV ~= 3 then return -1 end
for i = 1, n do
  if redis.call("HEXISTS", KEYS[i], ARGV[2]) ~= 1 or redis.call("HEXISTS", KEYS[i], ARGV[3]) ~= 1 then return 0 end
end
for i = 1, n do redis.call("HDEL", KEYS[i], ARGV[2]) end
return 1`;

/**
 * Stripe's answer that it did not make the checkout: a 4xx it answers
 * before doing anything (bad request, key, card, permission, not found, too
 * many requests). Everything else — no answer, a 5xx, a 409 or 424, a reply
 * without the checkout's address — may have made one, and is unknown.
 */
const NOT_MADE = new Set([400, 401, 402, 403, 404, 429]);
export const stripeRefusedOpening = (error: unknown): boolean => error instanceof StripeError && NOT_MADE.has(error.status);

/** The refusals every checkout raises before it asks Stripe for anything: orders paused (lib/order-admission.ts), the consent box not checked (lib/digital-consent.ts). */
export const refusedBeforeStripe = (error: unknown): boolean => error instanceof OrdersPausedError || error instanceof DigitalConsentMissing;

/**
 * A cart's checkout (lib/cart-checkout.ts; 513 [PF1], unit 3, added 2
 * November 2026): one unit of each limited product in it held for the one
 * checkout, as withStockHold holds one for a product bought on its own.
 *
 * Every limited product's lock is taken first (lib/redis-lock.ts: a token
 * only its holder can let go of), always in the order of their ids, so two
 * carts sharing products never wait on each other. Every count is read
 * under them, a provisional hold is written for each, and STOCK_ADMIT then
 * checks, in one step, that every lock is still ours and every provisional
 * hold there, or takes them back: a lock that ran out meanwhile (a request
 * may be paused) opens nothing, since another checkout may have counted the
 * same unit (Codex G2, 5 November 2026). The admission lets the locks go in
 * the same step, so no lock is held while Stripe opens the checkout. Stripe
 * is never asked while a lock is held (review of 5 November 2026): a hold
 * that ran out and is not settled counts as used, and a cart refused for it
 * has it asked about once the locks are let go, every product at once.
 *
 * The provisional holds are let go only when it is proven they are no
 * longer needed: when Stripe was never asked to make the checkout (any error
 * before that request, watchCheckoutOpening), when it refused to (`refused`,
 * and Stripe's own 4xx), or once the checkout's own hold is written and
 * STOCK_BIND hands over. An opening whose outcome is unknown (no answer: the
 * checkout may exist at Stripe) keeps them until they lapse, after any
 * checkout made under them has closed. A checkout whose own hold cannot be
 * confirmed is closed at Stripe, and only Stripe's "expired" lets its units
 * go; without it they stay held and lapse. Any lock not taken opens nothing
 * ("busy"); a count that cannot be read throws, so nothing opens either
 * (unknown never becomes a unit). Each hold is then settled as a single
 * product's is: paid becomes sold, expired is handed back (stockLeft).
 */
export async function withCartStockHolds<T extends { id: string }>(
  store: Store,
  products: Listing[],
  open: (held: boolean) => Promise<T>,
  /** Errors the caller raises before asking Stripe for anything (nothing was made), besides Stripe's own refusals. */
  refused: (error: unknown) => boolean = () => false,
): Promise<CartStockHold<T>> {
  const limited = [...new Map(products.filter((product) => limitedStock(product) !== null).map((product) => [product.id, product])).values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (limited.length === 0) return { ok: true, value: await open(false) };
  if (!store.statsId || !isRedisConfigured()) return { ok: false, reason: "busy" };
  const statsId = store.statsId;
  const keys = limited.map((product) => stockKey(statsId, product.id));
  const pending = `${PENDING}${crypto.randomUUID().replace(/-/g, "")}`;
  // Our own provisional holds, and nothing else, taken back while no checkout was opened under them; one that stays lapses.
  const withdraw = () => redisPipeline(keys.map((key) => ["HDEL", key, pending])).catch(() => {});
  // A count refused only for holds that ran out, which Stripe says gave their units back, is never "Sold out" (Claude 4's review
  // of #1732, 6 November 2026): they are settled once the locks are let go, and a checkout of at most RECOUNT_MOST limited
  // products is counted again at once, so its first click opens; a larger cart is told to press again ("busy"), which opens.
  for (let round = 0; ; round += 1) {
    const taken: Held[] = [];
    // Locks the admission let go in its own step (STOCK_ADMIT), not to be let go again.
    let admittedLocks = false;
    // Products refused only for holds that ran out and are not settled yet: asked about once the locks are let go.
    const unsettled: Listing[] = [];
    let refusal: CartStockHold<T> | null = null;
    try {
      for (const product of limited) taken.push(await takeLock(lockKey(statsId, product.id), LOCK_SECONDS, LOCK_WAIT_MS));
      const now = Date.now();
      const out: string[] = [];
      for (const product of limited) {
        // Never Stripe under a lock (review of 5 November 2026). A count that cannot be read throws: nothing opens, every lock is let go below.
        const counted = await countStock(store, product, now, null);
        if (counted !== null && counted.left <= 0) {
          out.push(product.id);
          if (counted.unresolved > 0) unsettled.push(product);
        }
      }
      if (out.length > 0) {
        refusal = { ok: false, reason: "soldout", ids: out };
      } else {
        const receipt = await redisPipeline(keys.map((key) => ["HSET", key, pending, JSON.stringify({ until: Date.now() + PENDING_MS })])).catch(() => null);
        if (!acknowledged(receipt, keys.length)) {
          await withdraw();
          return { ok: false, reason: "busy" };
        }
        const admitted = scriptAnswer(
          await redisPipeline([["EVAL", STOCK_ADMIT, keys.length * 2, ...taken.map((held) => held.key), ...keys, keys.length, ...taken.map((held) => held.token), pending]]).catch(() => null),
        );
        if (admitted !== 1) {
          // 0: taken back in the same step. Unknown: never opened on; taken back again, or lapsing.
          if (admitted === null) await withdraw();
          return { ok: false, reason: "busy" };
        }
        admittedLocks = true;
      }
    } catch (error) {
      if (error instanceof LockBusyError) return { ok: false, reason: "busy" };
      throw error;
    } finally {
      if (!admittedLocks) for (const held of taken) await releaseLock(held);
    }
    if (!refusal) break;
    if (refusal.reason !== "soldout") return refusal;
    // Stripe is asked about the lapsed holds once a click (Claude 5's review of #1732): a second round that still finds
    // them (their settling write was refused while reads answer) is told to press again, so a click never waits more
    // than one wave of MAX_CHECKS × CHECK_MS (CART_STOCK_STRIPE_WAIT_MS). Never "Sold out" on that guess.
    if (round > 0) return { ok: false, reason: "busy" };
    // The holds that ran out are asked about now, with no lock held, every product at once, so the next count is right.
    const budget = stockBudget();
    const settled = await Promise.all(unsettled.map((product) => stockLeftKnown(store, product, budget).catch(() => null)));
    // A count that could not be read (Stripe or the database did not answer) is unknown: press again, never "Sold out".
    if (settled.some((left) => left === null)) return { ok: false, reason: "busy" };
    // Freed: every product refused had nothing but such holds, and each has a unit back now; otherwise it is sold out.
    const freed = unsettled.length === refusal.ids.length && settled.every((left) => left !== null && left > 0);
    if (!freed) return refusal;
    if (limited.length > RECOUNT_MOST) return { ok: false, reason: "busy" };
  }
  let value: T;
  const opening = watchCheckoutOpening(() => open(true));
  try {
    value = await opening.done;
  } catch (error) {
    // Only a proven refusal hands the units back: a lost answer may hide a checkout Stripe made (Codex G2, 5 November 2026).
    // Proven: Stripe was never asked to open one (any error before that request; Claude 4's review of #1732, 6 November
    // 2026: a false option id held the last unit for the provisional hold's whole term), or refused to.
    if (!opening.asked() || refused(error) || stripeRefusedOpening(error)) await withdraw();
    throw error;
  }
  // Counted from after the checkout exists, so its hold outlasts it; the provisional one goes only once this one is written (STOCK_BIND).
  const hold = JSON.stringify({ until: Date.now() + HOLD_MS });
  const receipt = await redisPipeline(keys.map((key) => ["HSET", key, value.id, hold])).catch(() => null);
  const bound = acknowledged(receipt, keys.length)
    ? scriptAnswer(await redisPipeline([["EVAL", STOCK_BIND, keys.length, ...keys, keys.length, pending, value.id]]).catch(() => null))
    : null;
  if (bound === 1) return { ok: true, value };
  // Nobody is sent to a checkout whose units are not proven its own: it is closed at Stripe, and only Stripe's "expired" lets its holds go.
  if (store.stripeAccountId) {
    const closed = await onAccount("POST", store.stripeAccountId, `/checkout/sessions/${encodeURIComponent(value.id)}/expire`, new URLSearchParams()).catch(() => null);
    // One command a product, both fields at once, so the failure path stays inside CART_STOCK_COMMANDS_MOST (tests/cart-stock.test.ts).
    if (closed?.status === "expired") await redisPipeline(keys.map((key) => ["HDEL", key, value.id, pending])).catch(() => {});
  }
  return { ok: false, reason: "busy" };
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
