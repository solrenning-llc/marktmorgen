/**
 * License keys: one unique key handed to each buyer of a product.
 *
 * For a creator who sells software, a plugin, a preset pack that unlocks
 * with a code, or seats in something they run elsewhere. They choose where
 * the keys come from:
 *
 *   - a pool they upload — a text or CSV file of keys their own system made,
 *     up to 10,000 at a time and 10,000 waiting at once — handed out one per
 *     sale in the order they were uploaded;
 *   - or keys made here, in a shape they set: a prefix and groups of letters
 *     and digits, like STUDIO-7K2Q-9XFD-M3PL. The alphabet leaves out the
 *     letters and digits people misread (0 and O, 1 and I), and the shortest
 *     key allowed has twelve random characters, which is 60 bits: nobody
 *     guesses one.
 *
 * The rule the whole file is built around is that a key is never given twice.
 * A pool is a Redis list and a key leaves it with one LPOP, which Redis does
 * atomically: two buyers paying in the same millisecond get two different
 * keys. A sale is given its key with HSETNX, so a sale that is looked at from
 * two places at once — the thanks page and the five-minute job that sends
 * the confirmation email — gets one key, and the loser of that race puts the
 * key it popped back at the front of the pool. A made key is only kept if
 * SADD says nobody has had it before. Every key ever uploaded or made is kept
 * in that set, so an upload that repeats an old key has the repeat skipped
 * rather than handed to a second buyer.
 *
 * The buyer sees their key on the thanks page, in the confirmation email and
 * on their list of purchases. The creator sees every key given, to whom and
 * for which sale, and can mark one revoked, which the public check
 * (/api/store/licence) then reports, so the creator's own software can refuse
 * it. A sale refunded in full in Stripe has its key revoked by itself: the
 * five-minute job reads the refunds on the creator's account and marks the
 * key, the same rule every other door uses (lib/refunds.ts). Nothing here can
 * reach into that software: revoking is a record the creator's app has to
 * ask about.
 *
 * When a pool runs low the creator is emailed once, and again after each
 * top-up; when it is empty the product shows as sold out and no checkout is
 * opened. A buyer who paid in the moment the last key went is not left with
 * nothing: their sale waits, the creator is told who is waiting, and the
 * next upload gives them a key and emails it to them.
 *
 *   nl:keys:<store>:<product>:pool     list of keys not yet given
 *   nl:keys:<store>:<product>:all      set of every key ever added or made
 *   nl:keys:<store>:<product>:sale     hash sale reference -> key
 *   nl:keys:<store>:<product>:info     hash key -> who, when, which sale, revoked
 *   nl:keys:<store>:<product>:waiting  hash sale reference -> buyer waiting for a key
 *   nl:keys:<store>:<product>:warned   set once the low-pool email has gone
 *
 * <store> is the store's statsId, which follows it through a new address and
 * a new sign-in email.
 */
import { MAX_UPLOAD_KEYS, MAX_POOL_KEYS, MIN_KEY_LENGTH, MAX_KEY_LENGTH, KEY_ALPHABET, MAX_KEY_FILE_BYTES, sampleKey, type IssuedKey, type KeyCounts } from "@/lib/licence-key-rules";
export { MAX_UPLOAD_KEYS, MAX_POOL_KEYS, MIN_KEY_LENGTH, MAX_KEY_LENGTH, KEY_ALPHABET, MAX_KEY_FILE_BYTES, sampleKey, type IssuedKey, type KeyCounts } from "@/lib/licence-key-rules";
import { saleHandles } from "@/lib/store";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { StripeListUnreadable, type StripeRow, hasOwnField, ownField, plainObject, readStripePage } from "@/lib/stripe-list";
import { orderWrite } from "@/lib/order-data";
import { giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { SITE_URL } from "@/lib/site-url";
import type { Listing, Store } from "@/lib/store";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { type LostRead, confirmLostRead, lostCursorKey, lostDisputesOrRetry, refundRowKnown, rowGivesBack } from "@/lib/refunds";
import { hasProduct, readListing, sellsAny } from "@/lib/catalog";
import { deliveredIds } from "@/lib/bundle-rules";
import { givingWords } from "@/lib/buyer-words/giving";
import { keepRefunds, readHeldRefunds, releaseHeld } from "@/lib/held-refunds";
import {
  MAX_PREFIX_LENGTH,
  MIN_GROUPS,
  MAX_GROUPS,
  MIN_GROUP_LENGTH,
  MAX_GROUP_LENGTH,
  DEFAULT_LOW_AT,
  MAX_LOW_AT,
  DEFAULT_KEYS,
  parseKeySetup,
  readKeySetup,
  canHaveKeys,
  activeKeys,
  type KeySetup,
} from "@/lib/key-setup";

// The setting itself lives in lib/key-setup.ts; it is still found here.
export {
  MAX_PREFIX_LENGTH,
  MIN_GROUPS,
  MAX_GROUPS,
  MIN_GROUP_LENGTH,
  MAX_GROUP_LENGTH,
  DEFAULT_LOW_AT,
  MAX_LOW_AT,
  DEFAULT_KEYS,
  parseKeySetup,
  readKeySetup,
  canHaveKeys,
  activeKeys,
};
export type { KeySource, KeySetup, SetupProblem } from "@/lib/key-setup";

/** The most keys one upload may hold, and the most a pool may hold waiting. */




/** Letters and digits nobody confuses with another, so a key can be typed from a screenshot. */

/** The biggest file of keys the studio reads. */


/**
 * One made key, from the shape the creator chose, drawn from the system's
 * secure random source. The alphabet has 32 letters, which divides 256, so
 * every letter is exactly as likely as every other.
 */
export function generateKey(setup: Pick<KeySetup, "prefix" | "groups" | "groupLength">): string {
  const bytes = new Uint8Array(setup.groups * setup.groupLength);
  crypto.getRandomValues(bytes);
  const groups: string[] = [];
  for (let g = 0; g < setup.groups; g += 1) {
    let group = "";
    for (let i = 0; i < setup.groupLength; i += 1) group += KEY_ALPHABET[bytes[g * setup.groupLength + i] % KEY_ALPHABET.length];
    groups.push(group);
  }
  return [setup.prefix, ...groups].filter(Boolean).join("-");
}

/** What a made key looks like, for the studio to show before anything is sold. */


export type KeyList = {
  keys: string[];
  /** Lines that were not a key: too short, too long, or with spaces inside. */
  refused: number;
  /** Keys that appeared more than once in the file itself. */
  repeated: number;
  /** Whether the file held more than one upload may. */
  tooMany: boolean;
};

/**
 * Reads a pasted list or an uploaded file of keys: one per line, or a CSV
 * whose first column is the key. A header line such as "key" or
 * "licence_key" is skipped, as are empty lines. A key keeps its case: a key
 * someone else's system made has to be handed over exactly as it was made.
 */
export function readKeyList(text: string): KeyList {
  const keys: string[] = [];
  const seen = new Set<string>();
  let refused = 0;
  let repeated = 0;
  let tooMany = false;
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  lines.forEach((line, index) => {
    let cell = line.trim();
    if (!cell) return;
    if (cell.includes(",") || cell.includes("\t") || cell.includes(";")) {
      cell = cell.split(/[,\t;]/)[0].trim();
    }
    cell = cell.replace(/^"(.*)"$/, "$1").trim();
    if (index === 0 && /^(licen[cs]e[ _-]?)?keys?$|^codes?$|^serials?$/i.test(cell)) return;
    if (cell.length < MIN_KEY_LENGTH || cell.length > MAX_KEY_LENGTH || /\s/.test(cell) || /[\u0000-\u001f\u007f]/.test(cell)) {
      refused += 1;
      return;
    }
    if (seen.has(cell)) {
      repeated += 1;
      return;
    }
    if (keys.length >= MAX_UPLOAD_KEYS) {
      tooMany = true;
      return;
    }
    seen.add(cell);
    keys.push(cell);
  });
  return { keys, refused, repeated, tooMany };
}

// ---------------------------------------------------------------- storage

const base = (store: Store, product: Pick<Listing, "id">) => `nl:keys:${store.statsId}:${product.id}`;
const poolKey = (store: Store, product: Pick<Listing, "id">) => `${base(store, product)}:pool`;
const allKey = (store: Store, product: Pick<Listing, "id">) => `${base(store, product)}:all`;
const saleKey = (store: Store, product: Pick<Listing, "id">) => `${base(store, product)}:sale`;
const infoKey = (store: Store, product: Pick<Listing, "id">) => `${base(store, product)}:info`;
const waitingKey = (store: Store, product: Pick<Listing, "id">) => `${base(store, product)}:waiting`;
const warnedKey = (store: Store, product: Pick<Listing, "id">) => `${base(store, product)}:warned`;

/**
 * What the refund job writes in a sale's place among the keys given (`:sale`) when the sale was refunded in full or
 * lost in a dispute before it had a key: never a key (a key has no space in it, lib/licence-key-rules.ts), and written
 * with HSETNX, so it and settle's HSETNX of a key cannot both win. A sale holding it is never given a key, and it is
 * kept for good with the product's keys (Claude 2's second money review of #2868, HIGH).
 */
export const REFUNDED_SALE = "refunded before a key";

/**
 * The same place's mark while the full refund is still `pending` (Claude 2's focal money review of #2868, LOW): a sale
 * holding it is given no key either, but its refund stays unread, so the next runs read it again. A refund Stripe then
 * answers `succeeded` (or a lost dispute) turns it into REFUNDED_SALE; only one Stripe answers exactly `failed` or
 * `canceled` clears it, so the paid sale can be given its key. Never a key (it has spaces), and never shorter than
 * REFUNDED_SALE, so turning it final never grows what the store's room was charged for it.
 */
export const PENDING_REFUND_SALE = "refund pending, no key yet";

/**
 * KEYS[1] a product's sales (`:sale`); ARGV the sale, the mark expected there, and what replaces it ("" deletes it).
 * Changes the place only while it still holds that mark, and answers 1, or 0 when it holds anything else: a key settled
 * in the meantime is never overwritten nor deleted. No writer else changes a field of `:sale` once written (settle and
 * the marks use HSETNX), so this is the only way a mark moves. It never grows the place (REFUNDED_SALE is shorter than
 * PENDING_REFUND_SALE); a deleted mark's bytes are not given back to the room, so the room only ever errs high.
 */
const SALE_SWAP = `-- marktmorgen:license-sale-swap:v1
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
if ARGV[3] == '' then redis.call('HDEL', KEYS[1], ARGV[1]) else redis.call('HSET', KEYS[1], ARGV[1], ARGV[3]) end
return 1`;

/** Swaps a sale's mark for `next` ("" clears it) only while the place holds `expected`; any reply but 0 or 1 is unknown. */
async function swapSale(store: Store, product: Pick<Listing, "id">, reference: string, expected: string, next: string): Promise<boolean> {
  const reply = countOf(repliesFor(await redisPipeline([["EVAL", SALE_SWAP, 1, saleKey(store, product), reference, expected, next]]), 1)?.[0]);
  if (reply !== 0 && reply !== 1) throw new UnknownReplyError("the swap of a refunded sale's mark");
  return reply === 1;
}

/** Keys go to Redis in batches this size, well under any request limit. */
const BATCH = 1_000;



type Info = { r: string; e: string; at: number; v?: number; w?: "refund" };

/**
 * A key's record read in its exact shape. Text that is not JSON, or JSON of another shape, is unknown and throws
 * UnknownReplyError, never "no such key" (review of #2868, CX-123 rule 24). The times are read only as the writers
 * write them: `settle` writes `at` as whole seconds, `setRevoked` adds `v` as whole seconds, and `w` only with it.
 * A revocation time of -1, 0, 0.5 or Infinity is unknown, never "already revoked" (review of #2868, Claude 4).
 */
const wholeSeconds = (value: unknown, least: number): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= least;

function readInfo(raw: string): Info {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new UnknownReplyError("a license key's record");
  }
  const info = value as Partial<Info> | null;
  if (
    !info ||
    typeof info !== "object" ||
    Array.isArray(info) ||
    typeof info.r !== "string" ||
    typeof info.e !== "string" ||
    !wholeSeconds(info.at, 0) ||
    (info.v !== undefined && !wholeSeconds(info.v, 1)) ||
    (info.w !== undefined && (info.w !== "refund" || info.v === undefined))
  ) {
    throw new UnknownReplyError("a license key's record");
  }
  return info as Info;
}

/** A record as a listed key; null when absent or of a shape no writer writes, never read as valid or revoked. */
function parseInfo(key: string, raw: unknown): IssuedKey | null {
  if (typeof raw !== "string") return null;
  let value: Info;
  try {
    value = readInfo(raw);
  } catch {
    return null;
  }
  const revokedAt = value.v ?? 0;
  return {
    key,
    reference: value.r,
    email: value.e,
    at: value.at,
    revokedAt,
    revokedBy: revokedAt ? (value.w === "refund" ? "refund" : "creator") : "",
  };
}

export type SaleKey =
  | { state: "issued"; key: string; revoked: boolean }
  /** Paid for while the pool was empty: the next upload gives it one. */
  | { state: "waiting" };

/** Whether this product hands out keys that can be read or given right now. */
function usable(store: Store, product: Listing): boolean {
  return Boolean(activeKeys(product) && store.statsId && isRedisConfigured());
}

/**
 * The key a sale already has, without giving it one. Read whether or not the
 * product still hands out keys: a key given stays the buyer's.
 */
export async function keyOfSale(store: Store, product: Listing, reference: string): Promise<SaleKey | null> {
  const known = await readSale(store, product, reference);
  return known?.state === "refunded" || known?.state === "pending" ? null : known;
}

/**
 * A sale's key as keyOfSale reads it, or that it was refunded before it had one (and whether a buyer's place still
 * waits), or that a full refund of it is still pending (PENDING_REFUND_SALE): no key either way.
 */
type SaleRead = SaleKey | { state: "refunded"; waiting: boolean } | { state: "pending" } | null;

async function readSale(store: Store, product: Listing, reference: string): Promise<SaleRead> {
  if (!store.statsId || !isRedisConfigured() || !reference) return null;
  const [key, waiting] = await redisPipeline([
    ["HGET", saleKey(store, product), reference],
    ["HEXISTS", waitingKey(store, product), reference],
  ]);
  if (key === REFUNDED_SALE) return { state: "refunded", waiting: Number(waiting) === 1 };
  if (key === PENDING_REFUND_SALE) return { state: "pending" };
  if (typeof key === "string" && key) {
    const [raw] = await redisPipeline([["HGET", infoKey(store, product), key]]);
    // No record yet (the moment between the sale's key and its record in settle) is not revoked; a reply of another
    // shape, or a record no writer writes, is unknown, never shown good or revoked (CX-123 rule 24).
    if (raw === null) return { state: "issued", key, revoked: false };
    if (typeof raw !== "string") throw new UnknownReplyError("HGET of a license key's record");
    return { state: "issued", key, revoked: Boolean(readInfo(raw).v) };
  }
  // Still waiting only while the product hands out keys: one switched off gives none.
  return Number(waiting) === 1 && activeKeys(product) ? { state: "waiting" } : null;
}

/**
 * The sale's key, giving it one if it has none yet. Safe to call from every
 * place that shows a key, as often as they like: a sale only ever gets one.
 *
 * `reference` must be a sale Stripe has already said is paid; the callers
 * only reach here after that check.
 */
export async function keyForSale(store: Store, product: Listing, reference: string, email: string): Promise<SaleKey | null> {
  if (!usable(store, product) || !reference) return null;
  const known = await readSale(store, product, reference);
  if (known?.state === "issued") return known;
  // Refunded before it had a key: none is given, and a place it kept on an empty pool is let go.
  if (known?.state === "refunded") return refundedSale(store, product, reference, known.waiting);
  // A full refund still pending: no key while it is, and a place kept on an empty pool stays, served if the refund fails.
  if (known?.state === "pending") return null;
  const setup = activeKeys(product) as KeySetup;

  if (setup.source === "generated") {
    for (let tries = 0; tries < 5; tries += 1) {
      const key = generateKey(setup);
      const [fresh] = await redisPipeline([["SADD", allKey(store, product), key]]);
      if (Number(fresh) !== 1) continue;
      return settle(store, product, reference, email, key, false);
    }
    throw new Error("could not make a unique license key");
  }

  const [popped] = await redisPipeline([["LPOP", poolKey(store, product)]]);
  if (typeof popped !== "string" || !popped) {
    const [added] = await redisPipeline([
      ["HSETNX", waitingKey(store, product), reference, JSON.stringify({ e: email, at: Math.floor(Date.now() / 1000) })],
    ]);
    if (Number(added) === 1) await tellCreatorEmpty(store, product, reference, email);
    return { state: "waiting" };
  }
  const result = await settle(store, product, reference, email, popped, true);
  if (result?.state === "issued" && result.key === popped) await warnIfLow(store, product);
  return result;
}

/**
 * Ties a key to a sale, unless the sale got one a moment ago from somewhere
 * else — then that one stands, and this key goes back where it came from.
 */
async function settle(store: Store, product: Listing, reference: string, email: string, key: string, fromPool: boolean): Promise<SaleKey | null> {
  // A key given to a sale is kept for good: counted in the store's room at what it adds (lib/order-data.ts).
  const [won] = await orderWrite(store, [["HSETNX", saleKey(store, product), reference, key]]);
  if (Number(won) !== 1) {
    await redisPipeline(fromPool ? [["LPUSH", poolKey(store, product), key]] : [["SREM", allKey(store, product), key]]);
    // Lost to a key given a moment ago from somewhere else, or to the refund job's mark: then no key at all.
    const again = await readSale(store, product, reference);
    if (again?.state === "refunded") return refundedSale(store, product, reference, again.waiting);
    if (again?.state === "pending") return null;
    return again ?? { state: "waiting" };
  }
  const info: Info = { r: reference, e: email, at: Math.floor(Date.now() / 1000) };
  await orderWrite(store, [
    ["HSET", infoKey(store, product), key, JSON.stringify(info)],
    ["HDEL", waitingKey(store, product), reference],
  ]);
  return { state: "issued", key, revoked: false };
}

/** A sale refunded before it had a key: no key, and its place on an empty pool, if one was kept in the same moment, let go. */
async function refundedSale(store: Store, product: Listing, reference: string, waiting: boolean): Promise<null> {
  if (waiting) await redisPipeline([["HDEL", waitingKey(store, product), reference]]);
  return null;
}



export async function keyCounts(store: Store, product: Listing): Promise<KeyCounts> {
  if (!store.statsId || !isRedisConfigured()) return { left: 0, issued: 0, revoked: 0, waiting: 0 };
  const [left, waiting] = await redisPipeline([
    ["LLEN", poolKey(store, product)],
    ["HLEN", waitingKey(store, product)],
  ]);
  // Keys given are counted from their records: the sales' hash also holds the sales refunded before a key (REFUNDED_SALE).
  const list = await issuedKeys(store, product, "", 0);
  return { left: Number(left) || 0, issued: list.total, revoked: list.revoked, waiting: Number(waiting) || 0 };
}

/**
 * Whether a product that hands out keys from a pool has none left to give.
 * The count is read only in its exact shape, one whole number; any other
 * answer, or no Redis to ask, throws, so a caller that sells on it never
 * takes "unknown" for "some left" (CX-123, rule 24; SG2, findings 11 and 12).
 */
export async function outOfKeys(store: Store, product: Listing): Promise<boolean> {
  if (activeKeys(product)?.source !== "pool") return false;
  if (!store.statsId || !isRedisConfigured()) throw new Error("Key count unavailable");
  const receipt: unknown = await redisPipeline([["LLEN", poolKey(store, product)]]);
  // Read through the envelope's own data properties only, so an accessor is
  // never run and never taken for a reply, and a value counts only when it is
  // the descriptor's own, never one inherited from a polluted prototype
  // (reviews of #2665).
  const length = Array.isArray(receipt) ? Object.getOwnPropertyDescriptor(receipt, "length") : undefined;
  const slot = Array.isArray(receipt) ? Object.getOwnPropertyDescriptor(receipt, "0") : undefined;
  if (!length || !Object.hasOwn(length, "value") || length.value !== 1 || !slot || !Object.hasOwn(slot, "value")) throw new Error("Key count unavailable");
  const left: unknown = slot.value;
  if (typeof left !== "number" || !Number.isSafeInteger(left) || left < 0) throw new Error("Key count unavailable");
  return left === 0;
}

export type UploadResult = {
  added: number;
  /** Already in this product's pool or given to someone before. */
  known: number;
  /** Left out because the pool would pass MAX_POOL_KEYS. */
  overflow: number;
  left: number;
  /** Waiting buyers given a key by this upload. */
  served: number;
};

/**
 * Adds keys to the end of the pool, skipping any this product has ever had.
 * Then gives a key to every buyer who paid while the pool was empty, and
 * emails it to them.
 */
export async function addKeys(store: Store, product: Listing, keys: string[], origin: string = SITE_URL): Promise<UploadResult> {
  if (!store.statsId || !isRedisConfigured()) throw new Error("keys cannot be stored");
  // An unknown count is not an empty pool: the upload is refused rather than let past MAX_POOL_KEYS (CX-123 rule 24).
  const length = countOf(repliesFor(await redisPipeline([["LLEN", poolKey(store, product)]]), 1)?.[0]);
  if (length === null) throw new UnknownReplyError("LLEN of a license key pool");
  let room = Math.max(0, MAX_POOL_KEYS - length);
  let added = 0;
  let known = 0;
  let overflow = 0;
  // The keys take room in the store's data room first, in the pool and in the
  // record of every key ever added (DataRoomError when they do not fit); the
  // ones not kept give theirs back below.
  const weigh = (list: string[]) => list.reduce((sum, key) => sum + dataBytes([key], 2), 0);
  const slot = `lk:${product.id}`;
  await needData(store, [{ slot, bytes: weigh(keys) }]);
  const notKept: string[] = [];
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    // One key at a time into the set, so the answer says which ones are new.
    const fresh = await redisPipeline(batch.map((key) => ["SADD", allKey(store, product), key]));
    const take: string[] = [];
    const giveBack: string[] = [];
    batch.forEach((key, j) => {
      if (Number(fresh[j]) !== 1) {
        known += 1;
        notKept.push(key);
        return;
      }
      if (room > 0) {
        take.push(key);
        room -= 1;
      } else {
        overflow += 1;
        giveBack.push(key);
        notKept.push(key);
      }
    });
    const writes: (string | number)[][] = [];
    if (take.length) writes.push(["RPUSH", poolKey(store, product), ...take]);
    if (giveBack.length) writes.push(["SREM", allKey(store, product), ...giveBack]);
    if (writes.length) await redisPipeline(writes);
    added += take.length;
  }
  if (notKept.length) await giveData(store, [{ slot, bytes: weigh(notKept) }]);
  // A top-up means the next low pool is worth another warning.
  if (added > 0) await redisPipeline([["DEL", warnedKey(store, product)]]);
  const served = added > 0 ? await serveWaiting(store, product, origin) : 0;
  const [after] = await redisPipeline([["LLEN", poolKey(store, product)]]);
  return { added, known, overflow, left: Number(after) || 0, served };
}

/** Takes every key still in the pool out, so none of them is ever given. */
export async function clearPool(store: Store, product: Listing): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const [length] = await redisPipeline([["LLEN", poolKey(store, product)]]);
  await redisPipeline([["DEL", poolKey(store, product)]]);
  return Number(length) || 0;
}

/**
 * Every key given for this product, newest first, with what matches `query`
 * — part of a key, a sale reference or an email — when one is given.
 */
export async function issuedKeys(
  store: Store,
  product: Listing,
  query: string,
  limit = 50,
): Promise<{ keys: IssuedKey[]; total: number; revoked: number }> {
  if (!store.statsId || !isRedisConfigured()) return { keys: [], total: 0, revoked: 0 };
  const [raw] = await redisPipeline([["HGETALL", infoKey(store, product)]]);
  const all: IssuedKey[] = [];
  const flat = Array.isArray(raw) ? (raw as unknown[]) : [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const entry = parseInfo(String(flat[i]), flat[i + 1]);
    if (entry) all.push(entry);
  }
  const needle = query.trim().toLowerCase();
  const matching = needle
    ? all.filter((k) => k.key.toLowerCase().includes(needle) || k.reference.toLowerCase().includes(needle) || k.email.toLowerCase().includes(needle))
    : all;
  matching.sort((a, b) => b.at - a.at);
  return { keys: limit > 0 ? matching.slice(0, limit) : [], total: matching.length, revoked: all.filter((k) => k.revokedAt).length };
}

/**
 * Marks a given key revoked, or good again. False when this product never
 * gave it. `by` says whether the creator did it or a refund did; a key
 * already revoked stays as it was, so a refund read twice changes nothing.
 */
export async function setRevoked(
  store: Store,
  product: Pick<Listing, "id">,
  key: string,
  revoked: boolean,
  by: "creator" | "refund" = "creator",
): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured()) return false;
  // Only "no such key" is false; a reply in another shape is unknown and throws, so a refund waiting on this
  // revocation stays unread and is tried again (CX-123 rule 24).
  const raw = repliesFor(await redisPipeline([["HGET", infoKey(store, product), key]]), 1)?.[0];
  if (raw === null) return false;
  if (typeof raw !== "string") throw new UnknownReplyError("HGET of a license key's record");
  // A record read back unreadable is unknown too: it is not "never given", and the healthy record is not overwritten.
  const info = readInfo(raw);
  if (revoked && info.v) return true;
  const next: Info = {
    r: info.r,
    e: info.e,
    at: info.at,
    ...(revoked ? { v: Math.floor(Date.now() / 1000), ...(by === "refund" ? { w: "refund" as const } : {}) } : {}),
  };
  const [written] = await orderWrite(store, [["HSET", infoKey(store, product), key, JSON.stringify(next)]]);
  if (countOf(written) === null) throw new UnknownReplyError("HSET of a license key's record");
  return true;
}

// ------------------------------------------------------- refunds revoke keys

const refundAnchorKey = (store: Store) => `nl:keys:${store.statsId}:refunds:since`;
const refundSeenKey = (store: Store) => `nl:keys:${store.statsId}:refunds:seen`;
/** Refunds Stripe has not finished, kept for a later look (lib/held-refunds.ts). */
const refundHeldKey = (store: Store) => `nl:keys:${store.statsId}:refunds:held`;
/** How far back the first look goes, and how long a refund is remembered as read. */
const REFUND_LOOKBACK_SECONDS = 30 * 86_400;
/** Pages of a hundred refunds, and payments looked up, per store per run. */
const REFUND_PAGES = 3;
const REFUND_LOOKUPS = 20;
const INTENT_PATTERN = /^pi_[A-Za-z0-9]{6,200}$/;
/**
 * Where a pass over a store's refunds stands, kept between runs (Claude 5's audit of the Stripe reads, A3): a pass reads
 * the window from its anchor to its end, newest first, and may take several runs. Without it every run read the same
 * newest pages again, and a refund past them was never read.
 */
const refundPassKey = (store: Store) => `nl:keys:${store.statsId}:refunds:pass`;
/** How long a pass is kept without moving: well past the runs it takes; one left behind starts again from the anchor. */
const REFUND_PASS_SECONDS = 7 * 86_400;
/** The lookups a run that resumes a pass keeps for the pass while it reads the newest page first, so the pass always moves. */
const PASS_LOOKUPS = REFUND_LOOKUPS / 2;
/** A refund's id as the pass keeps it, to read on from (Stripe's `starting_after`). */
const REFUND_CURSOR = /^[A-Za-z0-9_]{3,255}$/;
/**
 * The Redis commands one run sends for its place in a store's refunds, outside the rows it reads (CX-123 rule 24): one
 * GET of the anchor and one of the pass, then at most three writes, either the pass kept (SET, with the anchor and the
 * read set's expiry written as before when the store had no anchor yet) or, at the end of a pass, the anchor written,
 * the read set's expiry renewed and the pass deleted. The pass is one key a store, under 400 bytes, kept
 * REFUND_PASS_SECONDS. A run still reads at most REFUND_PAGES pages of refunds and makes at most REFUND_LOOKUPS lookups.
 */
export const KEY_REFUND_PLACE_COMMANDS = 5;

/**
 * A pass over the refunds: `from` the anchor it began at (the window starts 300 seconds before), `start` when it began
 * (the anchor never moves past it), `after` the last refund it read to the end, `newest` the latest refund it handled,
 * and `floor` the earliest one it left unknown or pending (null when none), below which the anchor stays.
 */
type RefundPass = { from: number; start: number; after: string; newest: number; floor: number | null };

const passSeconds = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A kept pass read exactly; anything else is no pass, and a new one starts from the anchor, which never moved past it. */
function readRefundPass(raw: unknown): RefundPass | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!plainObject(value)) return null;
  const from = ownField(value, "from");
  const start = ownField(value, "start");
  const after = ownField(value, "after");
  const newest = ownField(value, "newest");
  const floor = ownField(value, "floor");
  if (!passSeconds(from) || !passSeconds(start) || !passSeconds(newest) || (floor !== null && !passSeconds(floor))) return null;
  if (typeof after !== "string" || !REFUND_CURSOR.test(after) || start < from || newest < from) return null;
  return { from, start, after, newest, floor };
}

/** A sale's key whose record settle has not written yet: unknown for the refund job, which leaves the refund unread. */
class RecordNotWrittenYet extends UnknownReplyError {
  constructor() {
    super("a refunded sale's license key record");
    this.message = "a refunded sale's license key has no record yet (settle is between its two writes)";
  }
}

/** Whether any product of this store hands out keys, so its refunds are worth reading. */
export function storeHasKeys(store: Store): boolean {
  return Boolean(store.statsId && store.stripeAccountId) && sellsAny(store, "keys");
}

/**
 * Reads the refunds made on the creator's Stripe account since the last run
 * and revokes the key of every sale refunded in full. Run by the five-minute
 * job for each store that hands out keys (lib/checkout-sweep.ts).
 *
 * A refund names a payment; the sale a key was given to is the checkout that
 * made that payment (a cs_… reference), or the payment itself for an offer
 * taken in one click (a pi_… reference). Both the product bought and the one
 * ticked at checkout lose their keys, since both were paid by that payment.
 * A partial refund changes nothing. A full refund still pending revokes a
 * key already given, but a sale with none yet only gets PENDING_REFUND_SALE,
 * and that refund stays unread until Stripe says it went through (the mark
 * turns final) or answers it failed or canceled (the mark is cleared, so the
 * paid sale can be given its key); every failed or canceled refund read is
 * looked up once for that, inside the same lookups. A dispute Stripe closed as lost takes
 * the key back as a full refund does (queue 388 [TB14]): the disputes closed
 * since the last run are read with the first page of refunds, from Stripe's
 * closing events, so a lost dispute revokes within the same five minutes;
 * one still open or won changes nothing, and one lost for less than the
 * price is read as lost (lib/refunds.ts says why). That is up to
 * LOST_DISPUTE_PAGES more GET /events every five minutes per store that
 * hands out keys, inside the run's deadline, and no other call. Stripe keeps events thirty days,
 * so a job down longer than that misses lost disputes; refunds are not
 * affected. A failed read of the disputes leaves the refunds handled and the
 * anchor where it was. Returns how many keys it revoked.
 *
 * A run reads at most REFUND_PAGES pages and makes at most REFUND_LOOKUPS
 * lookups. A pass from the anchor to the end of the window may take several
 * runs: where it stands is kept (refundPassKey), so the next run goes on from
 * the last refund read instead of the newest one again (Claude 5's audit of
 * the Stripe reads, A3: 300 newer partial refunds kept a full refund unread
 * and its key valid). A run that resumes a pass first reads the newest page,
 * so a refund made meanwhile does not wait for the pass. A refund left
 * unknown or pending never holds the pass back, only the anchor: the anchor
 * moves at the end of a pass, never past such a refund, so the next pass reads
 * it again; one the run had no time or lookups for is where the pass goes on.
 *
 * Two kinds of unfinished refund are told apart. A full refund still pending
 * (its charge already refunded in full) marks the sale PENDING_REFUND_SALE and
 * holds the anchor, as above. One that gives nothing back yet (requires_action,
 * or pending on a charge not refunded in full: unfinishedRefund) is kept by its
 * id (lib/held-refunds.ts), so the anchor may move past it; each run reads back
 * at most HELD_REFUND_READS kept ones that are due, and one that now gives
 * everything back is read as a row of the window, with at most half the run's
 * lookups, and let go once handled (rule 30).
 */
/**
 * A Stripe reply of a shape these reads cannot tell a sale from (CX-123 rule 24): never "no sale" nor "not a plan".
 * The refund that needed it stays unread, and the next run reads it again (Claude 4's second review of #2868).
 */
class StripeReplyUnreadable extends Error {
  constructor(what: string) {
    super(`Stripe answered ${what} in an unknown shape`);
    this.name = "StripeReplyUnreadable";
  }
}

/** Metadata as Stripe gives it: a plain object whose every value is text. */
const stripeMetadata = (value: unknown): value is Record<string, string> =>
  plainObject(value) && Object.keys(value).every((name) => typeof ownField(value, name) === "string");

/** A checkout row is read only with its metadata as Stripe gives it; anything else proves nothing. */
const checkoutLegible = (row: Record<string, unknown>): boolean => stripeMetadata(ownField(row, "metadata"));

const INVOICE_PATTERN = /^in_[A-Za-z0-9]{8,255}$/;
const SUBSCRIPTION_PATTERN = /^sub_[A-Za-z0-9]{8,255}$/;

/** An id Stripe gives as text or as the expanded object holding it, of the expected pattern; "" for anything else. */
const refOf = (value: unknown, pattern: RegExp): string => {
  const id = typeof value === "string" ? value : plainObject(value) ? ownField(value, "id") : undefined;
  return typeof id === "string" && pattern.test(id) ? id : "";
};

/**
 * The subscription an invoice belongs to, read in its exact shape: the invoice itself (its object and id), then its
 * subscription whichever way the API version names it (`subscription` before 2025-03-31, `parent` since). null only
 * when it says for sure there is none (a null subscription, a null parent, or a quote's parent); any other shape
 * throws StripeReplyUnreadable, never "not a plan" (Claude 4's second review of #2868).
 */
function subscriptionOfInvoice(read: unknown, invoice: string): string | null {
  if (!plainObject(read) || ownField(read, "object") !== "invoice" || ownField(read, "id") !== invoice) {
    throw new StripeReplyUnreadable("an invoice");
  }
  const named = hasOwnField(read, "subscription");
  const parented = hasOwnField(read, "parent");
  if (!named && !parented) throw new StripeReplyUnreadable("an invoice without its subscription");
  let found: string | null = null;
  if (named) {
    const value = ownField(read, "subscription");
    if (value !== null) {
      found = refOf(value, SUBSCRIPTION_PATTERN);
      if (!found) throw new StripeReplyUnreadable("an invoice's subscription");
    }
  }
  if (parented) {
    const parent = ownField(read, "parent");
    if (parent !== null) {
      if (!plainObject(parent)) throw new StripeReplyUnreadable("an invoice's parent");
      const type = ownField(parent, "type");
      if (type === "subscription_details") {
        const details = ownField(parent, "subscription_details");
        const id = plainObject(details) ? refOf(ownField(details, "subscription"), SUBSCRIPTION_PATTERN) : "";
        if (!id || (found && found !== id)) throw new StripeReplyUnreadable("an invoice's subscription details");
        found = id;
      } else if (type !== "quote_details") {
        throw new StripeReplyUnreadable("an invoice's parent of an unknown type");
      }
    }
  }
  return found;
}

/**
 * The one row of a lookup read with limit 1, in its exact shape (lib/stripe-list.ts): the row, or null only when
 * the list says for sure there is none (read to its end, every row readable). Anything else is not "none": it throws
 * StripeListUnreadable, and the refund that needed it stays unread (CX-123 rules 24 and 30).
 */
function onlyRow(answer: unknown, legible?: (row: Record<string, unknown>) => boolean): StripeRow | null {
  const listed = readStripePage(answer, legible);
  if (listed.rows.length) return listed.rows[0];
  if (listed.unreadable > 0 || listed.hasMore) throw new StripeListUnreadable("a row that could not be read");
  return null;
}

/**
 * The payment plan checkout whose first payment this was, or null: the
 * invoice the payment paid, whichever way the API version names it, then the
 * checkout that started its subscription, when that invoice was its first.
 */
async function planSaleOf(
  account: string,
  intent: string,
  pi: Record<string, unknown>,
): Promise<{ session: string; meta: Record<string, string> } | null> {
  // The payment names its invoice (older API versions: an id, or null) or not at all (newer ones): anything else
  // named there is unknown. Without one, the invoice payments list says for sure which invoice, or that there is none.
  const named = ownField(pi, "invoice");
  let invoice = refOf(named, INVOICE_PATTERN);
  if (!invoice && named !== undefined && named !== null) throw new StripeReplyUnreadable("a payment's invoice");
  if (!invoice) {
    const listed = await onAccount("GET", account, `/invoice_payments?${new URLSearchParams({ "payment[type]": "payment_intent", "payment[payment_intent]": intent, limit: "1" })}`);
    const row = onlyRow(listed);
    if (!row) return null;
    invoice = refOf(ownField(row, "invoice"), INVOICE_PATTERN);
    if (!invoice) throw new StripeReplyUnreadable("an invoice payment's invoice");
  }
  const subscription = subscriptionOfInvoice(await onAccount("GET", account, `/invoices/${encodeURIComponent(invoice)}`), invoice);
  if (!subscription) return null;
  const sessions = await onAccount("GET", account, `/checkout/sessions?${new URLSearchParams({ subscription, limit: "1" })}`);
  const session = onlyRow(sessions, checkoutLegible);
  if (!session) return null;
  // The checkout's first invoice, an id or null (not paid by invoice yet): a field missing or of another type is unknown.
  const first = ownField(session, "invoice");
  const firstInvoice = refOf(first, INVOICE_PATTERN);
  if (!firstInvoice && first !== null) throw new StripeReplyUnreadable("a plan checkout's invoice");
  if (firstInvoice !== invoice) return null;
  const meta = ownField(session, "metadata") as Record<string, string>;
  return meta.kind === "plan" ? { session: session.id, meta } : null;
}

export async function revokeRefunded(store: Store, deadline: number): Promise<number> {
  if (!storeHasKeys(store) || !isRedisConfigured()) return 0;
  const account = store.stripeAccountId as string;
  const now = Math.floor(Date.now() / 1000);
  const [anchorRaw, passRaw] = await redisPipeline([["GET", refundAnchorKey(store)], ["GET", refundPassKey(store)]]);
  const anchor = Number(anchorRaw) > 0 ? Number(anchorRaw) : now - REFUND_LOOKBACK_SECONDS;
  // A pass an earlier run began goes on from where it stopped (Claude 5's audit of the Stripe reads, A3); none, or one
  // in an unknown shape, begins at the anchor, which never moved past anything a pass left unread.
  const kept = readRefundPass(passRaw);
  const pass: RefundPass = kept ? { ...kept } : { from: anchor, start: now, after: "", newest: anchor, floor: null };
  // A little overlap, so a refund created in the second the last pass read is
  // not missed; the set of refunds already read keeps it from counting twice.
  const since = Math.max(0, pass.from - 300);
  let lookups = REFUND_LOOKUPS;
  let revoked = 0;
  const handles = saleHandles(store);
  /** The anchor stays at or below a refund of this pass left unknown or pending: the next pass reads it again. */
  const hold = (created: number) => {
    pass.floor = pass.floor === null ? created : Math.min(pass.floor, created);
  };

  // Refunds Stripe had not finished when an earlier run read them, kept by id with an end (lib/held-refunds.ts; rule 30):
  // those that now give everything back are read this run, before the pages, as a refund of the window is. A kept set
  // that does not read throws, so the run writes nothing and the anchor stays where it was.
  const heldKey = refundHeldKey(store);
  const heldRead = await readHeldRefunds(account, heldKey, now, deadline);
  // Every row handled this run, so one listed twice (kept and in the window, or in the newest page and the pass) is
  // handled once.
  const handledIds = new Set<string>();
  /** The read mark of a row handled now, sent with the kept set's release of it (once: a second visit sends none). */
  const markRead = async (id: string) => {
    await redisPipeline([
      ["SADD", refundSeenKey(store), id],
      ["EXPIRE", refundSeenKey(store), REFUND_LOOKBACK_SECONDS * 2 + 86_400],
      ...releaseHeld(heldKey, heldRead, id),
    ]);
    heldRead.members.delete(id);
    handledIds.add(id);
  };
  /**
   * One row read: "nothing" when it takes nothing back, "handled" once read (marked read, its keys revoked for sure),
   * "held" when its sale could not be told or its keys not revoked for sure, or it is a full refund still pending that
   * holds a sale's mark (the row stays unread, for the next pass), and "later" when the run had no time or lookups left
   * for it, above the `reserve` it keeps (the pass reads it again from there next run).
   */
  const visit = async (refund: Record<string, unknown>, reserve: number): Promise<"nothing" | "handled" | "held" | "later"> => {
    if (Date.now() >= deadline) return "later";
    const id = typeof refund.id === "string" ? refund.id : "";
    if (!id) return "nothing";
    if (handledIds.has(id)) return "handled";
    const givesBack = rowGivesBack(refund);
    // A refund Stripe answers exactly failed or canceled takes nothing back, but may undo the mark a pending one left
    // (PENDING_REFUND_SALE): its sale is looked up like any refund's, and only that mark is cleared. Any other row
    // that gives nothing back is skipped as before (Claude 2's focal money review of #2868, LOW).
    const undone = !givesBack && refund.object !== "dispute" && (refund.status === "failed" || refund.status === "canceled");
    if (!givesBack && !undone) return "nothing";
    // A full refund not yet through: the keyless sale is marked pending, and the refund stays unread until it settles.
    const pending = givesBack && refund.object !== "dispute" && refund.status === "pending";
    const [seen] = await redisPipeline([["SISMEMBER", refundSeenKey(store), id]]);
    if (Number(seen) === 1) {
      // Read by an earlier run: a kept refund read back is let go now.
      const release = releaseHeld(heldKey, heldRead, id);
      if (release.length) await redisPipeline(release);
      heldRead.members.delete(id);
      handledIds.add(id);
      return "handled";
    }
    const intent = typeof refund.payment_intent === "string" ? refund.payment_intent : "";
    if (!INTENT_PATTERN.test(intent)) {
      // No payment to look up (a charge made without one): no sale of this store can be told from it, so it is
      // read, and a lost dispute like it never holds the place back (review of #2158).
      await markRead(id);
      return "handled";
    }
    if (lookups <= reserve) return "later";
    lookups -= 1;

    // Which sale that payment was: a checkout of this store, or an offer.
    const sales: { reference: string; products: string[] }[] = [];
    // A list in another shape is not "no checkout": the refund stays unread and is read again (sweep A3 finding 2).
    let session: StripeRow | null;
    try {
      session = onlyRow(await onAccount("GET", account, `/checkout/sessions?${new URLSearchParams({ payment_intent: intent, limit: "1" })}`), checkoutLegible);
    } catch (error) {
      if (!(error instanceof StripeListUnreadable)) throw error;
      console.error("reading the checkout of a refunded payment failed", store.handle, error);
      return "held";
    }
    if (session) {
      const meta = ownField(session, "metadata") as Record<string, string>;
      // The product, the one ticked, and every product of a bundle among them.
      if (handles.has(meta.store ?? "")) sales.push({ reference: session.id, products: deliveredIds(meta) });
    } else if (lookups > reserve) {
      lookups -= 1;
      const pi: unknown = await onAccount("GET", account, `/payment_intents/${encodeURIComponent(intent)}`);
      // The payment in its exact shape, its metadata as Stripe gives it: anything else is not "no offer" nor "not a
      // plan", and the refund stays unread (Claude 4's second review of #2868, CX-123 rule 24).
      const piMeta = plainObject(pi) ? ownField(pi, "metadata") : undefined;
      if (!plainObject(pi) || ownField(pi, "object") !== "payment_intent" || ownField(pi, "id") !== intent || !stripeMetadata(piMeta)) {
        console.error("reading a refunded payment failed", store.handle, new StripeReplyUnreadable("a payment"));
        return "held";
      }
      const meta = piMeta;
      if (meta.kind === "upsell" && handles.has(meta.store ?? "")) sales.push({ reference: intent, products: deliveredIds(meta) });
      else if (lookups > reserve) {
        // A payment plan's first payment belongs to an invoice, not to the
        // checkout: found through the invoice, the plan is refunded like any sale.
        lookups -= 1;
        const plan = await planSaleOf(account, intent, pi).catch((error: unknown) => {
          // Stripe saying there is no such thing is an answer: not a plan.
          if (error instanceof StripeError && error.status >= 400 && error.status < 500 && error.status !== 429) return null;
          console.error("finding a refunded payment plan failed", error);
          return undefined;
        });
        if (plan === undefined) return "held";
        if (plan && handles.has(plan.meta.store ?? "")) sales.push({ reference: plan.session, products: deliveredIds(plan.meta) });
      } else return "later";
    } else return "later";

    // The refund is marked read only once every key it takes back is revoked for sure: a reply in an unknown shape
    // throws UnknownReplyError, and the refund stays unread for the next run (sweep A3 finding 2, CX-123 rule 24).
    let here = 0;
    // A sale marked pending by this refund (now or before): the refund stays unread, read again next run.
    let held = false;
    try {
      for (const sale of sales) {
        for (const productId of sale.products) {
          const product = await readListing(store, productId);
          // Only a product the store no longer lists is gone, with no key to revoke. One it still lists whose listing
          // came back empty (outside the catalog head, its GET answered in an unknown shape) is unknown: the refund
          // stays unread for the next run (review of #2868, CX-123 rule 24).
          if (!product && hasProduct(store, productId)) throw new UnknownReplyError("a refunded product's listing");
          if (!product) continue;
          if (undone) {
            // Only the pending mark is cleared, and only while it is still there: a key, the final mark or nothing
            // stays as it is (SALE_SWAP). Asked whether or not the product still hands out keys.
            await swapSale(store, product, sale.reference, PENDING_REFUND_SALE, "");
            continue;
          }
          let heldHere = false;
          // A sale of a product set to hand out keys takes the refunded mark in the key's place when it has none yet,
          // with HSETNX, so it is never given one: settle's HSETNX of a key and this one cannot both win (Claude 2's
          // second money review of #2868, HIGH). A product never set up for keys gets no mark and keeps no data for it.
          let taken = true;
          if (product.keys) {
            // A pending refund writes its own mark, which denies the key the same way but can still be undone.
            const mark = pending ? PENDING_REFUND_SALE : REFUNDED_SALE;
            const marked = countOf(repliesFor(await orderWrite(store, [["HSETNX", saleKey(store, product), sale.reference, mark]]), 1)?.[0]);
            if (marked !== 0 && marked !== 1) throw new UnknownReplyError("HSETNX of a refunded sale's mark");
            taken = marked === 0;
            if (!taken && pending) heldHere = true;
          }
          if (taken) {
            const key = repliesFor(await redisPipeline([["HGET", saleKey(store, product), sale.reference]]), 1)?.[0];
            // The sale's place holds its key, or the mark of a refund read before. No writer stores an empty key, and a
            // place just seen taken is not empty, so "" (or none, after the mark lost) is unknown, never "no key" (Claude
            // 4's second review of #2868, CX-123 rule 24). A product never set up for keys answers none: no key.
            if (key === null && !product.keys) continue;
            if (typeof key !== "string" || !key) throw new UnknownReplyError("HGET of a sale's license key");
            if (key === PENDING_REFUND_SALE) {
              // Still pending: held. Through (succeeded, or a dispute lost): the mark turns final, only while it is
              // still the pending one; a key settled after another run cleared it is revoked next run (0 is unknown).
              if (pending) heldHere = true;
              else if (!(await swapSale(store, product, sale.reference, PENDING_REFUND_SALE, REFUNDED_SALE))) {
                throw new UnknownReplyError("the swap of a pending refund's mark");
              }
            } else if (key !== REFUNDED_SALE) {
              // A key whose record settle has not written yet is not "nothing to revoke": the refund stays unread and
              // the next run revokes the record written meanwhile (Claude 2's second money review of #2868, MEDIUM).
              if (!(await setRevoked(store, product, key, true, "refund"))) throw new RecordNotWrittenYet();
              here += 1;
            }
          }
          // A buyer still waiting for a key from an empty pool keeps the place while the refund is pending, and is
          // served if it fails; once it is through, they are not given one.
          if (heldHere) {
            held = true;
            continue;
          }
          const dropped = countOf(repliesFor(await redisPipeline([["HDEL", waitingKey(store, product), sale.reference]]), 1)?.[0]);
          if (dropped === null) throw new UnknownReplyError("HDEL of a buyer waiting for a license key");
        }
      }
    } catch (error) {
      if (!(error instanceof UnknownReplyError)) throw error;
      console.error("revoking a refunded sale's license key could not be confirmed", store.handle, error);
      return "held";
    }
    if (held) return "held";
    revoked += here;
    await markRead(id);
    return "handled";
  };

  /** One page of refunds from `after` (the newest when empty), every row as refundRowKnown reads it; null when the page itself does not read. */
  const readPage = async (after: string) => {
    const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
    query.append("expand[]", "data.charge");
    if (after) query.set("starting_after", after);
    let listed: ReturnType<typeof readStripePage>;
    try {
      // Each row in the shape lib/refunds.ts reads a refund (its payment an id or null): any other row is unreadable.
      listed = readStripePage(await onAccount("GET", account, `/refunds?${query}`), refundRowKnown);
    } catch (error) {
      if (!(error instanceof StripeListUnreadable)) throw error;
      console.error("reading a store's refunds for license keys failed", store.handle, error);
      return null;
    }
    // A refund Stripe has not finished (it gives nothing back yet) is kept for a later look before the anchor can move
    // past it (lib/held-refunds.ts; rule 30, review of #3188): once it goes through it is read back by its id and its
    // key is revoked, however many refunds came after. One that cannot be kept (too many kept, or a count that does
    // not read): the anchor stays where this pass began, so the next pass reads it again.
    if (!(await keepRefunds(heldKey, listed.rows, now))) hold(since);
    return listed;
  };

  // The kept refunds that now give everything back, read before the pages with at most half the run's lookups, so the
  // pass still moves. One handled is let go (markRead); one held or left for later stays kept and due for the next run.
  for (const refund of heldRead.rows) {
    if ((await visit(refund, PASS_LOOKUPS)) === "later") break;
  }

  // Lost disputes, read once a run with the first page of refunds that reads, from their own kept place in the same
  // window (lib/refunds.ts), and handled before that page's refunds.
  let lost: LostRead | null = null;
  const readLost = async () => {
    if (lost) return;
    const read = await lostDisputesOrRetry(account, since, deadline, lostCursorKey("keys", store.statsId ?? account));
    lost = read;
    for (const row of read.rows) {
      if ((await visit(row, 0)) === "handled") pass.newest = Math.max(pass.newest, row.created as number);
    }
  };

  let pages = REFUND_PAGES;
  if (pass.after) {
    // Resuming a pass: the newest refunds first, so one made meanwhile does not wait for the pass to end, with at most
    // half the run's lookups. What is read here never moves the pass: a refund of the pass's window it left unknown is
    // read again by the pass, or was already held below by it, and a newer one is in the next pass's window.
    pages -= 1;
    const top = await readPage("");
    if (top) await readLost();
    for (const refund of top?.rows ?? []) {
      if ((await visit(refund, PASS_LOOKUPS)) === "later") break;
    }
  }
  let ended = false;
  // A cursor Stripe answers it does not know: the pass starts again from the anchor, which never moved past it.
  let restart = false;
  for (let page = 0; page < pages && Date.now() < deadline; page += 1) {
    let listed: Awaited<ReturnType<typeof readPage>>;
    try {
      listed = await readPage(pass.after);
    } catch (error) {
      if (!pass.after || !(error instanceof StripeError) || (error.status !== 400 && error.status !== 404)) throw error;
      console.error("a store's kept place in its refunds for license keys is not known to Stripe; read again from the anchor", store.handle, error);
      restart = true;
      break;
    }
    // A page in another shape is not "no refunds": the pass stays where it is and reads it again (CX-123 rule 30).
    if (!listed) break;
    await readLost();
    // A row that cannot be read proves nothing: the pass reads on past it, but the anchor stays where this pass began,
    // so the next pass reads it again (CX-123 rule 24).
    if (listed.unreadable > 0) hold(since);
    // The pass moves past a refund only once it was read: handled, nothing to take back, or held below for the next
    // pass. One the run had no time or lookups for is where the next run goes on from, never skipped.
    let whole = true;
    for (const refund of listed.rows) {
      const read = await visit(refund, 0);
      if (read === "later") {
        whole = false;
        break;
      }
      if (read === "held") hold(refund.created as number);
      if (read === "handled") pass.newest = Math.max(pass.newest, refund.created as number);
      pass.after = refund.id as string;
    }
    if (!whole) break;
    if (!listed.hasMore) {
      ended = true;
      break;
    }
    // More to read but no readable row on this page to go on from: the rest is not known yet; the next run tries again.
    if (!listed.rows.length) break;
  }

  // The lost disputes' place moves only once every one read was handled (lib/refunds.ts, confirmLostRead), every run.
  // Set inside readLost, which the type checker does not follow.
  const lostRead = lost as LostRead | null;
  const lostKept = lostRead ? await confirmLostRead(lostRead, refundSeenKey(store)) : false;
  if (ended) {
    // The end of a pass: the anchor moves to the newest refund it handled (a sweep of the lost disputes that went on
    // from a kept place no further than the newest closing it read, so a dispute closed meanwhile is read from the top
    // next run; review of #2158, inbox C4-24), never past when the pass began, nor past a refund it left unknown or
    // pending, nor at all while the lost disputes were not all read and handled. The read refunds outlive it.
    let top = pass.newest;
    if (!lostRead || !lostKept || !lostRead.complete) hold(since);
    else top = lostRead.resumed ? lostRead.newest : Math.max(top, lostRead.newest);
    const moved = Math.max(pass.from, Math.min(top, pass.start, pass.floor ?? Number.POSITIVE_INFINITY));
    await redisPipeline([
      ["SET", refundAnchorKey(store), String(moved), "EX", REFUND_LOOKBACK_SECONDS * 2],
      ["EXPIRE", refundSeenKey(store), REFUND_LOOKBACK_SECONDS * 2 + 86_400],
      ["DEL", refundPassKey(store)],
    ]);
    return revoked;
  }
  // A pass not at its end is kept only when it moved, so one that cannot move lapses and starts again from the anchor.
  // A store with no anchor yet keeps the one its pass began at, so the next run reads the same window and the lost
  // disputes' kept place still counts; its refunds already read are kept as long (reviews of #2158).
  const next = JSON.stringify(pass);
  const writes: (string | number)[][] = [];
  if (restart) writes.push(["DEL", refundPassKey(store)]);
  else if (pass.after && next !== passRaw) writes.push(["SET", refundPassKey(store), next, "EX", REFUND_PASS_SECONDS]);
  if (!(Number(anchorRaw) > 0)) {
    writes.push(
      ["SET", refundAnchorKey(store), String(pass.from), "EX", REFUND_LOOKBACK_SECONDS * 2],
      ["EXPIRE", refundSeenKey(store), REFUND_LOOKBACK_SECONDS * 2 + 86_400],
    );
  }
  if (writes.length) await redisPipeline(writes);
  return revoked;
}

export type KeyCheck = "valid" | "revoked" | "unknown";

/**
 * What the public check answers about a key: given and good, given and
 * revoked, or never given. Keys given before keys were switched off stay valid.
 */
export async function checkKey(store: Store, product: Listing, key: string): Promise<KeyCheck> {
  if (!store.statsId || !isRedisConfigured()) return "unknown";
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) return "unknown";
  const [raw] = await redisPipeline([["HGET", infoKey(store, product), key]]);
  const info = parseInfo(key, raw);
  if (!info) return "unknown";
  return info.revokedAt ? "revoked" : "valid";
}

/**
 * The license keys these products gave a person, with the sale each came
 * from, for the copy of their data (619 [SZ3], lib/person-copy.ts). Kept on
 * purpose (lib/person-data.ts): the key is what was bought. Only reads.
 */
export async function keysOf(store: Store, productIds: string[], email: string): Promise<(IssuedKey & { product: string })[]> {
  if (!store.statsId || !productIds.length || !isRedisConfigured()) return [];
  const address = email.trim().toLowerCase();
  // An unknown answer is not "no keys": the copy says it could not read them rather than leave them out (CX-123 rule 24).
  const replies = repliesFor(await redisPipeline(productIds.map((id) => ["HGETALL", infoKey(store, { id })])), productIds.length);
  if (!replies) throw new UnknownReplyError("the license keys' records");
  return productIds.flatMap((product, i) => {
    const flat = stringList(replies[i]);
    if (!flat || flat.length % 2 !== 0) throw new UnknownReplyError("HGETALL of a product's license keys");
    const out: (IssuedKey & { product: string })[] = [];
    for (let k = 0; k + 1 < flat.length; k += 2) {
      // An unreadable record is unknown, never a key left out of the copy.
      readInfo(flat[k + 1]);
      const entry = parseInfo(String(flat[k]), flat[k + 1]);
      if (entry && entry.email.trim().toLowerCase() === address) out.push({ ...entry, product });
    }
    return out;
  });
}

// ---------------------------------------------------------------- email

function displayName(name: string): string {
  return name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || "A store";
}

function senderAddress(): string {
  const match = NIMBUS_FROM.match(/<([^>]+)>/);
  return (match ? match[1] : NIMBUS_FROM).trim();
}

/** Once per top-up: the pool is at or under the number the creator chose. */
async function warnIfLow(store: Store, product: Listing): Promise<void> {
  const setup = activeKeys(product);
  if (!setup || setup.source !== "pool") return;
  // An unknown count is not an empty pool: no warning is claimed or sent on it, and the next sale reads it again
  // (sweep A3, MEDIUM). Never thrown: the buyer's key is already given.
  const count = countOf(repliesFor(await redisPipeline([["LLEN", poolKey(store, product)]]), 1)?.[0]);
  if (count === null) {
    console.error("the license key pool could not be counted; no low-pool warning", store.handle, product.id);
    return;
  }
  if (count > setup.lowAt) return;
  // Sent only on a sure claim: "OK". Null (already warned) or an unknown answer sends nothing.
  const claimed = repliesFor(await redisPipeline([["SET", warnedKey(store, product), "1", "NX", "EX", 90 * 86_400]]), 1)?.[0];
  if (claimed !== "OK") return;
  await sendEmail({ meter: { by: "store", store: store, kind: "email" },
    from: `"Marktmorgen" <${senderAddress()}>`,
    to: store.email,
    subject: count === 0 ? `No license keys left for ${product.title}` : `${count} license ${count === 1 ? "key" : "keys"} left for ${product.title}`,
    text: [
      count === 0
        ? `The last license key for ${product.title} has just been given to a buyer. Until you add more, the product shows as sold out on your store and no checkout opens for it.`
        : `${product.title} has ${count} license ${count === 1 ? "key" : "keys"} left to give. You asked to be told at ${setup.lowAt}.`,
      "",
      `Add more in your studio, under the product: ${SITE_URL}/studio${store.sid ? `?store=${store.sid}` : ""}#products`,
      "",
      "This email comes once each time the pool runs low; adding keys resets it.",
    ].join("\n"),
  }).catch((error) => console.error("warning about license keys failed", error));
}

/** A buyer paid in the moment the last key went: the creator hears at once. */
async function tellCreatorEmpty(store: Store, product: Listing, reference: string, email: string): Promise<void> {
  await sendEmail({ meter: { by: "store", store: store, kind: "email" },
    from: `"Marktmorgen" <${senderAddress()}>`,
    to: store.email,
    subject: `A buyer of ${product.title} is waiting for a license key`,
    text: [
      `${email || "A buyer"} paid for ${product.title} just as its license keys ran out, so they have not been given one yet.`,
      `Their order reference is ${reference}.`,
      "",
      `Add keys in your studio, under the product: ${SITE_URL}/studio${store.sid ? `?store=${store.sid}` : ""}#products`,
      "The moment you do, they are given the first one and it is emailed to them. Nothing else is needed from you.",
    ].join("\n"),
  }).catch((error) => console.error("telling a creator about a waiting buyer failed", error));
}

/** Gives every waiting buyer a key from a fresh upload, and emails it. */
async function serveWaiting(store: Store, product: Listing, origin: string): Promise<number> {
  const [raw] = await redisPipeline([["HGETALL", waitingKey(store, product)]]);
  const flat = Array.isArray(raw) ? (raw as unknown[]) : [];
  let served = 0;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const reference = String(flat[i]);
    let email = "";
    try {
      email = String((JSON.parse(String(flat[i + 1])) as { e?: unknown }).e ?? "");
    } catch {}
    const given = await keyForSale(store, product, reference, email);
    // A sale refunded while it waited is given nothing, and lets its place go: the next buyer is still served.
    if (!given) continue;
    if (given.state !== "issued") break;
    served += 1;
    if (!email) continue;
    const g = givingWords(store.language);
    await sendEmail({ meter: { by: "order" },
      from: `"${displayName(store.name)}" <${senderAddress()}>`,
      to: email,
      replyTo: store.email,
      subject: g.keyLabelFor(product.title).slice(0, 200),
      text: [
        g.keyReady(product.title),
        "",
        given.key,
        "",
        g.keyThanks(`${origin}/@${store.handle}/orders`),
        g.orderRef(reference),
        "",
        g.keyQuestions(store.name),
      ].join("\n"),
      idempotencyKey: `nimbus-key:${store.statsId}:${product.id}:${reference}`,
    }).catch((error) => console.error("emailing a waiting buyer their key failed", error));
  }
  return served;
}
