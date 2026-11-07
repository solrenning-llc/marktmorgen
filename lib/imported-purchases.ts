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
import { countOf, repliesFor, UnknownReplyError } from "@/lib/redis-reply";
import { type DataStore, needData } from "@/lib/store-data";
import { orderWrite } from "@/lib/order-data";
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
  const replies = repliesFor(await redisPipeline([["HGETALL", importedWhoKey(statsId)]]), 1);
  if (!replies) throw new UnknownReplyError("imported buyers");
  const read = pairs(replies[0]);
  const out = new Map<string, number>();
  let unknown = !read.complete;
  for (const [email, raw] of read.rows) {
    if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw)) {
      unknown = true;
      continue;
    }
    const at = Number(raw);
    if (!Number.isSafeInteger(at)) {
      unknown = true;
      continue;
    }
    out.set(email, at);
  }
  // This list drives the one-time closing notice. A legible row proves only
  // that buyer, never that the list is complete enough to advance the notice.
  if (unknown) throw new UnknownReplyError("imported buyers");
  return out;
}

/** The reference one imported purchase is known by on the list of purchases and in a download link. */
export function importedReference(statsId: string, email: string, productId: string): string {
  return `imp_${sha(`nimbus-imported-ref:${statsId}:${normaliseEmail(email)}:${productId}`).slice(0, 24)}`;
}

function parse(productId: string, raw: unknown): ImportedPurchase | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(productId) || typeof raw !== "string") return null;
  try {
    const decoded = JSON.parse(raw) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const value = decoded as Record<string, unknown>;
    if (typeof value.at !== "number" || !Number.isSafeInteger(value.at) || value.at < 0) return null;
    if (typeof value.job !== "string" || !value.job || value.job.length > 512) return null;
    if (value.items !== undefined && value.items !== null && !Array.isArray(value.items)) return null;
    const items = value.items ?? [];
    if (items.length > 20 || items.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id))) return null;
    if (value.option !== undefined && value.option !== null && (typeof value.option !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.option))) return null;
    return {
      productId,
      at: value.at,
      job: value.job,
      items: items.length ? items : null,
      option: typeof value.option === "string" ? value.option : null,
    };
  } catch {
    return null;
  }
}

/** Reads a hash as Redis returns it, a flat list or an object. */
function pairs(raw: unknown): { rows: [string, unknown][]; complete: boolean } {
  if (Array.isArray(raw)) {
    const out: [string, unknown][] = [];
    let complete = raw.length % 2 === 0;
    for (let i = 0; i + 1 < raw.length; i += 2) {
      if (typeof raw[i] !== "string") {
        complete = false;
        continue;
      }
      out.push([raw[i], raw[i + 1]]);
    }
    return { rows: out, complete };
  }
  if (raw && typeof raw === "object") return { rows: Object.entries(raw as Record<string, unknown>), complete: true };
  return { rows: [], complete: false };
}

/** The command that reads one address's imported purchases, for a caller's own pipeline. */
export function importedRead(store: Store, email: string): (string | number)[] | null {
  if (!store.pastBuyers || !store.statsId) return null;
  return ["HGETALL", importedKey(store.statsId, email)];
}

/** What such a read answered, as purchases. */
export function importedFrom(raw: unknown): ImportedPurchase[] {
  const read = pairs(raw);
  const found: ImportedPurchase[] = [];
  let unknown = !read.complete;
  for (const [id, value] of read.rows) {
    const purchase = parse(id, value);
    if (purchase) found.push(purchase);
    else unknown = true;
  }
  // A legible row is enough to establish access. Only a complete, legible
  // empty read may establish that there is none.
  if (found.length) return found;
  if (unknown) throw new UnknownReplyError("imported purchases");
  return [];
}

/** Everything this address was given here by an import; [] for a store that never imported buyers. */
export async function importedFor(store: Store, email: string): Promise<ImportedPurchase[]> {
  const read = importedRead(store, email);
  if (!read || !isRedisConfigured()) return [];
  const replies = repliesFor(await redisPipeline([read]), 1);
  if (!replies) throw new UnknownReplyError("imported purchases");
  const found = importedFrom(replies[0]);
  // Brought over before the list of who was brought existed: noted the first time they are read.
  const brought = found.filter((p) => IMPORT_JOB.test(p.job));
  if (brought.length && store.statsId) {
    await orderWrite(store, [["HSETNX", importedWhoKey(store.statsId), normaliseEmail(email), String(Math.min(...brought.map((p) => p.at)))]]).catch(() => {});
  }
  return found;
}

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
  if (room) await needData(room, [{ slot: "imp", bytes: grants.reduce((sum, g) => sum + dataBytes([g.productId, JSON.stringify({ at: atSeconds, job, items: g.items, option: g.option ?? null }), g.email], 3), 0) }]);
  // Only what was bought on Marktmorgen puts a store in a buyer's library: a gift, a place, a pre-order,
  // a PayPal purchase (no room given); not an import or the API's gift, which take from the store's room.
  if (sid && !room) await rememberBuyers(sid, grants.map((g) => g.email));
  if (IMPORT_JOB.test(job)) {
    const commands = [...new Set(grants.map((g) => normaliseEmail(g.email)))].map((email) => ["HSETNX", importedWhoKey(statsId), email, String(atSeconds)]);
    const replies = repliesFor(await redisPipeline(commands), commands.length);
    if (!replies || replies.some((reply) => {
      const count = countOf(reply);
      return count !== 0 && count !== 1;
    })) throw new UnknownReplyError("the imported-buyer marks");
  }
  const writes: (string | number)[][] = grants.map((g) => [
    "HSETNX",
    importedKey(statsId, g.email),
    g.productId,
    JSON.stringify({ at: atSeconds, job, items: g.items, ...(g.option ? { option: g.option } : {}) }),
  ]);
  // An order's grant (no room given) is counted at what it really adds (lib/order-data.ts).
  const answers = room ? await redisPipeline(writes) : await orderWrite({ sid, statsId }, writes);
  const replies = repliesFor(answers, writes.length);
  if (!replies) throw new UnknownReplyError("the imported grants");
  return replies.map((reply) => {
    const count = countOf(reply);
    if (count !== 0 && count !== 1) throw new UnknownReplyError("an imported grant");
    return count === 1;
  });
}

/**
 * Takes back one product an address was given, only when it was given by
 * `prefix`'s kind of grant ("api:" for the creator's own tools): never an
 * import, a gift, a place or a PayPal purchase. Says whether it took it.
 */
export async function takeGiven(statsId: string, email: string, productId: string, prefix: string): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const key = importedKey(statsId, email);
  const read = repliesFor(await redisPipeline([["HGET", key, productId]]), 1);
  if (!read) throw new UnknownReplyError("the imported grant");
  const raw = read[0];
  if (raw === null) return false;
  const given = parse(productId, raw);
  if (!given) throw new UnknownReplyError("the imported grant");
  if (!given.job.startsWith(prefix)) return false;
  const removed = repliesFor(await redisPipeline([["HDEL", key, productId]]), 1);
  if (!removed) throw new UnknownReplyError("the imported grant deletion");
  const gone = countOf(removed[0]);
  if (gone !== 0 && gone !== 1) throw new UnknownReplyError("the imported grant deletion");
  return gone === 1;
}

/**
 * Deletes what an import from another platform gave one person here
 * (lib/person-erasure.ts): the purchases brought over for them, and the mark
 * that an import brought them. Nothing was paid here for these, so no order
 * of ours stands behind them; the person loses access to them.
 */
export async function forgetImportedPerson(statsId: string | null, email: string): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const replies = repliesFor(await redisPipeline([["DEL", importedKey(statsId, email)], ["HDEL", importedWhoKey(statsId), normaliseEmail(email)]]), 2);
  if (!replies) throw new UnknownReplyError("the imported-person erasure");
  return replies.reduce<number>((sum, reply) => {
    const count = countOf(reply);
    if (count !== 0 && count !== 1) throw new UnknownReplyError("the imported-person erasure");
    return sum + count;
  }, 0);
}
