/**
 * Buyers a creator brought over from another platform: people who paid for a
 * course or a download somewhere else, and keep it here without paying again.
 *
 * Every other purchase on Marktmorgen is read from the creator's own Stripe account
 * (lib/buyer-orders.ts): Stripe is the ledger. These never went through Stripe
 * — nothing was charged, and no receipt exists — so they are the one kind of
 * purchase written down here, and they are always shown for what they are:
 * "Brought over from another platform", never as a sale. They are not counted
 * in the store's numbers, sent to webhooks, credited to affiliates or
 * reviewed, because none of those can be true of them.
 *
 * What one gives is what a purchase of that product gives on the list of
 * purchases (/orders): its file or its link, its course, and for a bundle each
 * of its products — and, when the product (or one in the bundle) opens the
 * store's community, the community (lib/community-access.ts). License keys
 * are not handed out for them: a buyer who had a key on the old platform
 * still has it there.
 *
 *   nl:imp:buy:<statsId>:<address hash>  product id -> { at, job, items }
 *   nl:imp:who:<statsId>                  address -> when it was first brought over: the buyers an import
 *                                         brought, for the list's groups as history, never as a sale (lib/segments.ts)
 *
 * One entry per product and address, written only if there is none (HSETNX),
 * so importing the same file twice gives nobody anything twice.
 *
 * The same record carries two kinds of purchase that did not go through the
 * creator's Stripe either, told apart by `job`: "gift:<id>", a gift paid for
 * by someone else (lib/gifts.ts), and "paypal:<order>", a purchase paid into
 * the creator's own PayPal account (lib/paypal-sales.ts). Each is shown for
 * what it is on the list of purchases, never as brought over.
 */
import { rememberBuyers } from "@/lib/buyer-library";
import { createHash } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { fieldReleaseBytes, orderWrite, releaseOrderData } from "@/lib/order-data";
import { HASH_DEL_IF, HASH_TAKE_ALL, takenPairs } from "@/lib/redis-take";
import { dataBytes } from "@/lib/store-data-rules";
import type { Store } from "@/lib/store";

/** One product one address was given. */
export type ImportedPurchase = {
  productId: string;
  /** When it was brought over, in seconds. */
  at: number;
  /** The import that brought it (lib/imports.ts). */
  job: string;
  /** For a bundle: the products it held when it was brought over. */
  items: string[] | null;
  /**
   * For a product with price options, given as a gift or as a place in a
   * purchase for several: the option that was paid for, which decides what
   * is handed over. Null otherwise.
   */
  option: string | null;
};

/** How imported purchases are named on the list of purchases: never a Stripe id. */
export const IMPORTED_REFERENCE = /^imp_[0-9a-f]{24}$/;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** The same address, however it was typed, as a key. */
export function addressHash(email: string): string {
  return sha(`nimbus-imported:${normaliseEmail(email)}`).slice(0, 32);
}

export const importedKey = (statsId: string, email: string) => `nl:imp:buy:${statsId}:${addressHash(email)}`;
export const importedWhoKey = (statsId: string) => `nl:imp:who:${statsId}`;
/** An import's own job id (lib/imports.ts): only those are brought over; a gift, a place or a PayPal sale is not. */
const IMPORT_JOB = /^[0-9a-f]{24}$/;

/** The addresses an import brought over, with when each was first brought (seconds). */
export async function importedBuyers(statsId: string | null): Promise<Map<string, number>> {
  if (!statsId || !isRedisConfigured()) return new Map();
  const [raw] = await redisPipeline([["HGETALL", importedWhoKey(statsId)]]);
  const flat = Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
  const out = new Map<string, number>();
  for (let i = 0; i + 1 < flat.length; i += 2) out.set(flat[i], Number(flat[i + 1]) || 0);
  return out;
}

/** The reference one imported purchase is known by on the list of purchases and in a download link. */
export function importedReference(statsId: string, email: string, productId: string): string {
  return `imp_${sha(`nimbus-imported-ref:${statsId}:${normaliseEmail(email)}:${productId}`).slice(0, 24)}`;
}

function parse(productId: string, raw: unknown): ImportedPurchase | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const items = Array.isArray(value.items)
      ? value.items.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id)).slice(0, 20)
      : [];
    return {
      productId,
      at: typeof value.at === "number" ? value.at : 0,
      job: typeof value.job === "string" ? value.job : "",
      items: items.length ? items : null,
      option: typeof value.option === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.option) ? value.option : null,
    };
  } catch {
    return null;
  }
}

/** Reads a hash as Redis returns it, a flat list or an object. */
function pairs(raw: unknown): [string, unknown][] {
  if (Array.isArray(raw)) {
    const out: [string, unknown][] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) out.push([String(raw[i]), raw[i + 1]]);
    return out;
  }
  if (raw && typeof raw === "object") return Object.entries(raw as Record<string, unknown>);
  return [];
}

/** The command that reads one address's imported purchases, for a caller's own pipeline. */
export function importedRead(store: Store, email: string): (string | number)[] | null {
  if (!store.pastBuyers || !store.statsId) return null;
  return ["HGETALL", importedKey(store.statsId, email)];
}

/** What such a read answered, as purchases. */
export function importedFrom(raw: unknown): ImportedPurchase[] {
  return pairs(raw)
    .map(([id, value]) => parse(id, value))
    .filter((p): p is ImportedPurchase => p !== null);
}

/** Everything this address was given here by an import; [] for a store that never imported buyers. */
export async function importedFor(store: Store, email: string): Promise<ImportedPurchase[]> {
  const read = importedRead(store, email);
  if (!read || !isRedisConfigured()) return [];
  const [raw] = await redisPipeline([read]);
  const found = importedFrom(raw);
  // Brought over before the list of who was brought existed: noted the first time they are read.
  const brought = found.filter((p) => IMPORT_JOB.test(p.job));
  if (brought.length && store.statsId) {
    await orderWrite(store, [["HSETNX", importedWhoKey(store.statsId), normaliseEmail(email), String(Math.min(...brought.map((p) => p.at)))]]).catch(() => {});
  }
  return found;
}

/** Where what an import or the API's gift gives is counted in the store's data room (lib/store-data.ts). */
const IMPORTED_SLOT = "imp";

/** What one grant taken from the store's room was counted at (grantImported), and is given back at when it is deleted. */
const grantBytes = (productId: string, v: { at?: unknown; job?: unknown; items?: unknown; option?: unknown }, email: string) =>
  dataBytes([productId, JSON.stringify({ at: v.at, job: v.job, items: v.items, option: v.option ?? null }), email], 3);

/** Whether a grant was taken from the store's room (an import, the API's gift) rather than written as an order's (lib/order-data.ts). */
const fromRoom = (job: string) => IMPORT_JOB.test(job) || job.startsWith("api:");

/**
 * Gives many addresses their products in one round trip. Returns, for each
 * grant, whether it was new (false: that address already had that product).
 */
export async function grantImported(
  statsId: string,
  job: string,
  grants: { email: string; productId: string; items: string[] | null; option?: string | null }[],
  atSeconds = Math.floor(Date.now() / 1000),
  /** The store's own id, so each address finds the store in its library (lib/buyer-library.ts), for what was bought on Marktmorgen. */
  sid = "",
  /**
   * The store whose data room an import or the API's gift takes from
   * (DataRoomError when it does not fit), or null for what an order gives (a
   * gift, a place, a pre-order, a PayPal purchase), counted at what it
   * really adds (lib/order-data.ts).
   */
  room: DataStore | null = null,
): Promise<boolean[]> {
  if (!grants.length || !isRedisConfigured()) return grants.map(() => false);
  // Each grant at the most it weighs: its field, the address's key and place among those brought over, its library.
  if (room) await needData(room, [{ slot: IMPORTED_SLOT, bytes: grants.reduce((sum, g) => sum + grantBytes(g.productId, { at: atSeconds, job, items: g.items, option: g.option }, g.email), 0) }]);
  // Only what was bought on Marktmorgen puts a store in a buyer's library: a gift, a place, a pre-order,
  // a PayPal purchase (no room given); not an import or the API's gift, which take from the store's room.
  if (sid && !room) await rememberBuyers(sid, grants.map((g) => g.email));
  if (IMPORT_JOB.test(job)) {
    await redisPipeline([...new Set(grants.map((g) => normaliseEmail(g.email)))].map((email) => ["HSETNX", importedWhoKey(statsId), email, String(atSeconds)]));
  }
  const writes: (string | number)[][] = grants.map((g) => [
    "HSETNX",
    importedKey(statsId, g.email),
    g.productId,
    JSON.stringify({ at: atSeconds, job, items: g.items, ...(g.option ? { option: g.option } : {}) }),
  ]);
  // An order's grant (no room given) is counted at what it really adds (lib/order-data.ts).
  const answers = room ? await redisPipeline(writes) : await orderWrite({ sid, statsId }, writes);
  return answers.map((a) => Number(a) === 1);
}

/**
 * Takes back one product an address was given, only when it was given by
 * `prefix`'s kind of grant ("api:" for the creator's own tools): never an
 * import, a gift, a place or a PayPal purchase. Says whether it took it.
 */
export async function takeGiven(statsId: string, email: string, productId: string, prefix: string, room?: DataStore): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const key = importedKey(statsId, email);
  const [raw] = await redisPipeline([["HGET", key, productId]]);
  const given = parse(productId, raw);
  if (!given || !given.job.startsWith(prefix) || typeof raw !== "string") return false;
  // Deleted only as it was read, so two takes at once (or a take beside a
  // deletion of the person) give its room back once.
  const [gone] = await redisPipeline([["EVAL", HASH_DEL_IF, 1, key, productId, raw]]);
  if (Number(gone) !== 1) return false;
  if (room) {
    const value = json(raw);
    if (value && typeof value.job === "string" && fromRoom(value.job)) await giveData(room, [{ slot: IMPORTED_SLOT, bytes: grantBytes(productId, value, normaliseEmail(email)) }]);
    else await releaseOrderData(room, fieldReleaseBytes(productId, raw));
  }
  return true;
}

/**
 * Deletes what an import from another platform gave one person here
 * (lib/person-erasure.ts): the purchases brought over for them, and the mark
 * that an import brought them. Nothing was paid here for these, so no order
 * of ours stands behind them; the person loses access to them.
 */
export async function forgetImportedPerson(statsId: string | null, email: string, room?: DataStore): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const address = normaliseEmail(email);
  // Read and deleted in one step: two deletions at once give back once.
  const [taken, who] = await redisPipeline([["EVAL", HASH_TAKE_ALL, 1, importedKey(statsId, email)], ["HDEL", importedWhoKey(statsId), address]]);
  const given = takenPairs(taken);
  if (room && given.length) {
    // What an import or the API's gift took from the room comes back as it was
    // counted; what an order wrote comes back to the orders' part, at the field's own share.
    let imported = 0;
    let ordered = 0;
    for (const [productId, raw] of given) {
      const value = json(raw);
      if (value && typeof value.job === "string" && fromRoom(value.job)) imported += grantBytes(productId, value, address);
      else ordered += fieldReleaseBytes(productId, raw);
    }
    if (imported > 0) await giveData(room, [{ slot: IMPORTED_SLOT, bytes: imported }]);
    await releaseOrderData(room, ordered);
  }
  return (given.length ? 1 : 0) + (Number(who) || 0);
}

function json(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
