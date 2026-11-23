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
import { UnknownReplyError, countOf, replyList, repliesFor, stringList } from "@/lib/redis-reply";
import { StripeListUnreadable, type StripeRow, hasOwnField, ownField, plainObject, readStripePage } from "@/lib/stripe-list";
import { orderWrite } from "@/lib/order-data";
import { giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
// A sale's key line and its record, written together or not at all (settle).
import { orderWriteIfNew } from "@/lib/order-data";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { SITE_URL } from "@/lib/site-url";
import type { Listing, Store } from "@/lib/store";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { type LostRead, confirmLostRead, lostCursorKey, lostDisputesOrRetry, refundRowKnown, refundedInFull, rowGivesBack } from "@/lib/refunds";
import { hasProduct, readListing, sellsAny } from "@/lib/catalog";
import { deliveredIds } from "@/lib/bundle-rules";
import { givingWords } from "@/lib/buyer-words/giving";
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

/**
 * Pushes new keys onto a product's pool while it is under its bound, in one step (Claude 7's race hunt): the room is
 * read and taken with the push, so two uploads at once never both take the same room and pass MAX_POOL_KEYS. KEYS[1]
 * the pool; ARGV[1] the bound; ARGV[2..] the keys, in order. Answers how many it pushed: always the first ones.
 */
export const POOL_PUSH = `-- marktmorgen:license-pool-push:v1
local n = #ARGV - 1
local room = tonumber(ARGV[1]) - redis.call('LLEN', KEYS[1])
if room < n then n = room end
if n <= 0 then return 0 end
for i = 2, n + 1 do redis.call('RPUSH', KEYS[1], ARGV[i]) end
return n`;



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
  // Each reply read in its exact shape (CX-123 rule 24): the sale's key as text or none, whether it waits as 0 or 1.
  // Any other is not known, never "no key yet": it throws, and each caller says the key could not be read.
  const line = repliesFor(
    await redisPipeline([
      ["HGET", saleKey(store, product), reference],
      ["HEXISTS", waitingKey(store, product), reference],
    ]),
    2,
  );
  const [key, waiting] = line ?? [];
  if (!line || (key !== null && typeof key !== "string") || (waiting !== 0 && waiting !== 1)) throw new UnknownReplyError("a sale's license key");
  if (key === REFUNDED_SALE) return { state: "refunded", waiting: waiting === 1 };
  if (key === PENDING_REFUND_SALE) return { state: "pending" };
  if (typeof key === "string" && key) {
    const reply = repliesFor(await redisPipeline([["HGET", infoKey(store, product), key]]), 1);
    const raw = reply?.[0];
    // A record that does not read is not known, never a good key (this PR); no record yet (the moment between the
    // sale's key and its record in settle) is not revoked, and a record no writer writes is unknown (main, readInfo).
    if (!reply || (raw !== null && typeof raw !== "string")) throw new UnknownReplyError("a license key's record");
    if (raw === null) return { state: "issued", key, revoked: false };
    return { state: "issued", key, revoked: Boolean(readInfo(raw).v) };
  }
  // Still waiting only while the product hands out keys: one switched off gives none.
  return waiting === 1 && activeKeys(product) ? { state: "waiting" } : null;
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
 *
 * The sale's key line and the key's record are written in one script, so a
 * process that stops part way never leaves a sale with a key no check can
 * find: both are there, or neither is and the sale is given a key the next
 * time it is looked at (11 November 2026).
 */
async function settle(store: Store, product: Listing, reference: string, email: string, key: string, fromPool: boolean): Promise<SaleKey | null> {
  const info: Info = { r: reference, e: email, at: Math.floor(Date.now() / 1000) };
  // A key given to a sale is kept for good: counted in the store's room at what it adds (lib/order-data.ts).
  const won = await orderWriteIfNew(store, [
    ["HSETNX", saleKey(store, product), reference, key],
    ["HSET", infoKey(store, product), key, JSON.stringify(info)],
    ["HDEL", waitingKey(store, product), reference],
  ]);
  if (!won) {
    await redisPipeline(fromPool ? [["LPUSH", poolKey(store, product), key]] : [["SREM", allKey(store, product), key]]);
    // Lost to a key given a moment ago from somewhere else, or to the refund job's mark: then no key at all.
    const again = await readSale(store, product, reference);
    if (again?.state === "refunded") return refundedSale(store, product, reference, again.waiting);
    if (again?.state === "pending") return null;
    return again ?? { state: "waiting" };
  }
  return { state: "issued", key, revoked: false };
}

/** A sale refunded before it had a key: no key, and its place on an empty pool, if one was kept in the same moment, let go. */
async function refundedSale(store: Store, product: Listing, reference: string, waiting: boolean): Promise<null> {
  if (waiting) await redisPipeline([["HDEL", waitingKey(store, product), reference]]);
  return null;
}



export async function keyCounts(store: Store, product: Listing): Promise<KeyCounts> {
  if (!store.statsId || !isRedisConfigured()) return { left: 0, issued: 0, revoked: 0, waiting: 0 };
  // Read exactly (unknown is never zero): the studio shows these as real, so a count in another shape throws and
  // the keys route answers an error, never "0 keys left".
  const replies = repliesFor(await redisPipeline([
    ["LLEN", poolKey(store, product)],
    ["HLEN", waitingKey(store, product)],
  ]), 2);
  const [left, waiting] = (replies ?? [null, null]).map(countOf);
  if (left === null || waiting === null) throw new UnknownReplyError("a product's license key counts");
  // Keys given are counted from their records: the sales' hash also holds the sales refunded before a key (REFUNDED_SALE).
  const list = await issuedKeys(store, product, "", 0);
  return { left, issued: list.total, revoked: list.revoked, waiting };
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
    const offered: string[] = [];
    batch.forEach((key, j) => {
      if (Number(fresh[j]) !== 1) {
        known += 1;
        notKept.push(key);
        return;
      }
      offered.push(key);
    });
    if (!offered.length) continue;
    // The room is taken with the push (POOL_PUSH): what did not fit is left out. Read exactly (CX-123 rule 24): an
    // answer that is not a count of the keys offered throws, never "all of them fitted" or "none did".
    const [pushedReply] = await redisPipeline([["EVAL", POOL_PUSH, 1, poolKey(store, product), MAX_POOL_KEYS, ...offered]]);
    const pushed = typeof pushedReply === "number" && Number.isSafeInteger(pushedReply) && pushedReply >= 0 && pushedReply <= offered.length ? pushedReply : null;
    if (pushed === null) throw new UnknownReplyError("the key pool's room");
    const giveBack = offered.slice(pushed);
    if (giveBack.length) {
      overflow += giveBack.length;
      notKept.push(...giveBack);
      await redisPipeline([["SREM", allKey(store, product), ...giveBack]]);
    }
    added += pushed;
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
 * `byEmail: false` leaves the buyer's address out of the search, for a role
 * that may not read it (lib/buyer-addresses.ts): a search must not confirm it.
 */
export async function issuedKeys(
  store: Store,
  product: Listing,
  query: string,
  limit = 50,
  options: { byEmail?: boolean } = {},
): Promise<{ keys: IssuedKey[]; total: number; revoked: number }> {
  const byEmail = options.byEmail !== false;
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
    ? all.filter((k) => k.key.toLowerCase().includes(needle) || k.reference.toLowerCase().includes(needle) || (byEmail && k.email.toLowerCase().includes(needle)))
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
/** How far back the first look goes, and how long a refund is remembered as read. */
const REFUND_LOOKBACK_SECONDS = 30 * 86_400;
/** Pages of a hundred refunds, and payments looked up, per store per run. */
const REFUND_PAGES = 3;
const REFUND_LOOKUPS = 20;
/**
 * The lookups of a run, out of REFUND_LOOKUPS, kept for the refunds on the list to try again, for the lost disputes and
 * for the newest page a run that resumes a pass reads first (#5285 row #2868): the pass keeps the rest, at least the four
 * a row may take, so the first row of each part a run reads is always read whole and every part goes on.
 */
const REFUND_REREAD_LOOKUPS = 4;
const REFUND_LOST_LOOKUPS = 4;
const REFUND_TOP_LOOKUPS = 4;
const INTENT_PATTERN = /^pi_[A-Za-z0-9]{6,200}$/;
const REFUND_ID = /^(re|pyr)_[A-Za-z0-9]{3,250}$/;
/** Where a pass over the refunds stands between runs (revokeRefunded), in the store's nl:keys: keys (erased with it). */
const refundPassKey = (store: Store) => `nl:keys:${store.statsId}:refunds:pass`;
/** How long a pass is kept: well past the runs it takes, and short enough that one left behind is started again. */
const REFUND_PASS_SECONDS = 7 * 86_400;
/**
 * Refunds Stripe finished (succeeded) whose key could not be revoked for sure, refund id to payment, in the store's
 * nl:keys: keys (erased with it), as lib/gifts.ts keeps them: read again from Stripe and tried again first on every run,
 * and let go only once handled or once Stripe says there is nothing to take back, so one row that can never be handled
 * does not hold the place forever (#5285 row #2868, Codex X6's LOW 2). At most REFUND_RETRY_CAP; with the list full, the
 * row holds the place at its time instead. Kept as long as the refunds read, renewed with every row put on it and by
 * every run that reads it, so a row that keeps failing never lapses with it while the job still runs (Claude 2 lpgvy's
 * LEVE on #5321): its key record has no expiry, and a row past the place is read from nowhere else.
 */
const refundRetryKey = (store: Store) => `nl:keys:${store.statsId}:refunds:retry`;
/** The last refund on the list a run read again: the next run reads on from the one after it, in the order of their ids. */
const refundRetryFromKey = (store: Store) => `nl:keys:${store.statsId}:refunds:retry:from`;
const REFUND_RETRY_CAP = 100;
const REFUND_RETRY_KEEP_SECONDS = 2 * 30 * 86_400 + 86_400;
/** The time a run gives the list to try again before its pages (at least one row is read whenever the deadline allows). */
const REFUND_REREAD_MS = 2_000;
/**
 * Refunds on the list to try again read again from Stripe (GET /refunds/{id}, its charge expanded) per store per run,
 * before any key is revoked for them. Priced in tests/plan-cost-registry.ts (NOT_A_COST).
 */
export const KEYS_REFUND_REREADS_PER_STORE = 10;

type KeysRefundPass = { since: number; after: string; newest: number; account: string; waiting?: number; unread?: true };
/** A kept pass in its exact shape, as lib/gifts.ts reads its own; null when there is none or it is in any other shape. */
function readKeysRefundPass(raw: unknown, now: number): KeysRefundPass | null {
  if (typeof raw !== "string") return null;
  let pass: unknown;
  try {
    pass = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!pass || typeof pass !== "object" || Array.isArray(pass)) return null;
  const { since, after, newest, account, waiting, unread } = pass as Record<string, unknown>;
  if (!Number.isSafeInteger(since) || (since as number) < 0 || !Number.isSafeInteger(newest) || (newest as number) < 0) return null;
  if (typeof after !== "string" || !/^[A-Za-z0-9_]{3,255}$/.test(after)) return null;
  if (typeof account !== "string" || !/^acct_[A-Za-z0-9]{1,255}$/.test(account)) return null;
  if (waiting !== undefined && (!Number.isSafeInteger(waiting) || (waiting as number) < 0)) return null;
  if (unread !== undefined && unread !== true) return null;
  // Figures a pass never keeps, each of which would move the place wrongly: its newest refund and the time it waits at
  // lie within its window, from its start to now (with the place's 300 s margin).
  const latest = now + 300;
  if ((newest as number) < (since as number) || (newest as number) > latest) return null;
  if (waiting !== undefined && ((waiting as number) < (since as number) || (waiting as number) > latest)) return null;
  return { since: since as number, after, newest: newest as number, account, ...(waiting === undefined ? {} : { waiting: waiting as number }), ...(unread ? { unread: true as const } : {}) };
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
 * A partial refund changes nothing. A full refund still pending takes
 * nothing back yet, since it may still fail: a key already given stays valid,
 * a sale with none yet only gets PENDING_REFUND_SALE (no key while it is
 * pending), and that refund stays unread until Stripe says it went through
 * (the key is revoked, the mark turns final) or answers it failed or canceled
 * (the mark is cleared, so the paid sale can be given its key; a key given
 * stays as it is); every failed or canceled refund read is looked up once for
 * that, inside the same lookups (Claude 5's pre-review of
 * claude5/licence-refunds-combined, HIGH 2). A succeeded refund that is only
 * part of the charge counts as pending while another refund of that charge is
 * on its way (one GET /refunds?charge= inside the same lookups, asked only when
 * the charge reads refunded in full and this refund alone does not cover it;
 * Claude 2's focal money review of #2868, HIGH). A dispute Stripe closed as lost takes
 * the key back as a full refund does (queue 388 [TB14]): the disputes closed
 * since the last run are read with the first page of refunds, from Stripe's
 * closing events, so a lost dispute revokes within the same five minutes;
 * one still open or won changes nothing, and one lost for less than the
 * price is read as lost (lib/refunds.ts says why). That is up to
 * LOST_DISPUTE_PAGES more GET /events every five minutes per store that
 * hands out keys, inside the run's deadline, and no other call. Stripe keeps events thirty days,
 * so a job down longer than that misses lost disputes; refunds are not
 * affected. A failed read of the disputes leaves the refunds handled and the
 * anchor where it was. The limit of the pages and lookups read per run,
 * which also keeps the anchor, was there before. Returns how many keys it revoked.
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

/** The most refunds of one charge read in one GET /refunds?charge= (one page; more than that is unknown). */
const CHARGE_REFUNDS_PAGE = 100;
const CHARGE_PATTERN = /^(ch|py)_[A-Za-z0-9]{6,255}$/;
/** Statuses a refund still on its way has: it may yet fail, and Stripe already counts it in amount_refunded. */
const REFUND_ON_ITS_WAY = new Set(["pending", "requires_action"]);
const REFUND_STATUS_KNOWN = new Set(["pending", "requires_action", "succeeded", "failed", "canceled"]);
const centsKnown = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Whether a succeeded refund whose charge reads refunded in full gave the whole charge back by itself: its own amount
 * covers the charge's. Only then is no other refund of the charge needed to say the money went back for good.
 */
function wholeOnItsOwn(refund: Record<string, unknown>): boolean {
  const charge = refund.charge;
  if (!plainObject(charge)) return false;
  const amount = ownField(charge, "amount");
  return centsKnown(refund.amount) && centsKnown(amount) && amount > 0 && refund.amount >= amount;
}

/**
 * A full refund made of several refunds of one charge, read from all of that charge's refunds (one GET /refunds?charge=,
 * Stripe's own list): "held" while any is still on its way (pending or needing action: it may still fail, and Stripe
 * counts it in the charge's amount_refunded already), "through" when the ones that succeeded add up to the whole charge.
 * Anything else (no charge id, a row or a list in another shape, more than one page, or succeeded refunds that do not
 * add up although the charge reads refunded in full) throws StripeListUnreadable: never "nothing pending" (Claude 2's
 * focal money review of #2868 at 9fa5c95602, HIGH; CX-123 rule 24).
 */
async function chargeRefundsSettled(account: string, refund: Record<string, unknown>): Promise<"held" | "through"> {
  const charge = refund.charge;
  const id = plainObject(charge) ? ownField(charge, "id") : undefined;
  const amount = plainObject(charge) ? ownField(charge, "amount") : undefined;
  if (typeof id !== "string" || !CHARGE_PATTERN.test(id) || !centsKnown(amount) || amount <= 0) {
    throw new StripeListUnreadable("a refund's charge without its id or amount");
  }
  const legible = (row: Record<string, unknown>) => {
    const status = ownField(row, "status");
    const named = ownField(row, "charge");
    const chargeId = typeof named === "string" ? named : plainObject(named) ? ownField(named, "id") : undefined;
    return typeof status === "string" && REFUND_STATUS_KNOWN.has(status) && centsKnown(ownField(row, "amount")) && chargeId === id;
  };
  const listed = readStripePage(
    await onAccount("GET", account, `/refunds?${new URLSearchParams({ charge: id, limit: String(CHARGE_REFUNDS_PAGE) })}`),
    legible,
  );
  if (listed.unreadable > 0 || listed.hasMore) throw new StripeListUnreadable("a charge's refunds");
  // The refund being read is one of them, as it now stands: if Stripe's list does not have it, the list proves nothing.
  if (!listed.rows.some((row) => row.id === refund.id)) throw new StripeListUnreadable("a charge's refunds without the one read");
  if (listed.rows.some((row) => REFUND_ON_ITS_WAY.has(ownField(row, "status") as string))) return "held";
  const through = listed.rows.reduce((sum, row) => sum + (ownField(row, "status") === "succeeded" ? (ownField(row, "amount") as number) : 0), 0);
  if (through >= amount) return "through";
  throw new StripeListUnreadable("a charge read refunded in full whose succeeded refunds do not add up");
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
  // The walk's place, read exactly (rule 24): only GET's exact null is "no place yet"; another shape stops the run with
  // the place as it was, never a newer start that would then be written over the real, older place. Read after it:
  // where an unfinished pass stands, and the list of refunds to try again with its place (#5285 row #2868, Codex X6's
  // LOW 2).
  const anchorRead = repliesFor(await redisPipeline([["GET", refundAnchorKey(store)]]), 1);
  const anchorRaw = anchorRead?.[0];
  if (!anchorRead || (anchorRaw !== null && !(typeof anchorRaw === "string" && /^\d{1,12}$/.test(anchorRaw)))) {
    throw new UnknownReplyError("the license keys' refund place");
  }
  // Read after the place, in one request: a reply cut short reads as no pass (started over from the place, read again,
  // never skipped) and as a list in another shape (left as it is, read again next run).
  const kept = repliesFor(await redisPipeline([["GET", refundPassKey(store)], ["HGETALL", refundRetryKey(store)], ["GET", refundRetryFromKey(store)]]), 3);
  const begun = [anchorRaw, kept?.[0] ?? null, kept ? kept[1] : undefined, kept?.[2] ?? null];
  const anchor = Number(anchorRaw) > 0 ? Number(anchorRaw) : now - REFUND_LOOKBACK_SECONDS;
  // A little overlap, so a refund created in the second the last run read is
  // not missed; the set of refunds already read keeps it from counting twice.
  const fresh = Math.max(0, anchor - 300);
  // A pass over the refunds longer than one run goes on where the last run stopped, as lib/gifts.ts does (#5285 row
  // #2868, Codex X6's LOW 2): before, a run read the newest REFUND_PAGES pages every time and the place moved only once
  // they were all read and sure, so one refund left unresolved early held it, and with more than REFUND_PAGES x 100
  // refunds after it the older ones were never read; the place then lapsed and the read started again a month back,
  // and a full refund never read left its key valid. A pass kept in another shape, of another account or of another
  // place's window, is started over from the place, which never moved past it: read again, never skipped.
  const keptPass = readKeysRefundPass(begun[1], now);
  const pass = keptPass && keptPass.account === account && (anchorRaw === null || keptPass.since === fresh) ? keptPass : null;
  const since = pass ? pass.since : fresh;
  let newest = pass ? pass.newest : anchor;
  // The last refund the pass went through (handled, held or kept on the list): the next run goes on from the row after
  // it, read from Stripe after that row, so rows that keep failing never take every lookup of every run.
  let after = pass ? pass.after : "";
  // The oldest refund the pass read that could not be handled and is not on the list to try again (Infinity: none): the
  // place waits at it when the pass ends, so the next pass reads it again (a refund still on its way, as before).
  let waiting = pass?.waiting ?? Infinity;
  // Whether the pass read a row that is not readable: the place then stays where it was when the pass ends.
  let unread = pass?.unread === true;
  const passNow = (): KeysRefundPass => ({ since, after, newest, account, ...(Number.isFinite(waiting) ? { waiting } : {}), ...(unread ? { unread } : {}) });
  let revoked = 0;
  let ended = false;
  // The lost disputes' read not done to its end, or one not handled: the place stays (as before).
  let unsure = false;
  const handles = saleHandles(store);

  /**
   * One refund (or lost dispute) row read whole and handled, with the lookups it may take from `budget`: "done" when it
   * was handled or needs nothing (and then it is marked read or never needed to be), "failed" when its sale could not be
   * told for sure or its key revoked for sure (left unread: kept on the list to try again when Stripe finished it, else
   * the place waits at it), "short" when the budget ran out before it could be (read again on a later run).
   */
  const handleRow = async (refund: Record<string, unknown>, budget: { left: number }): Promise<"done" | "failed" | "short"> => {
    const id = typeof refund.id === "string" ? refund.id : "";
    if (!id) return "done";
    // A full refund that needs an action (requires_action) is on its way, as a pending one (Claude 1 and Claude 6 on
    // #2868): skipped, a newer refund moved the anchor past it and, once it succeeded, its key stayed valid for good.
    // One whose charge does not read as refunded in full yet proves nothing, and keeps the place from moving past it.
    const actionNeeded = refund.object !== "dispute" && refund.status === "requires_action";
    if (actionNeeded && !refundedInFull(refund.charge)) {
      return "failed";
    }
    const givesBack = rowGivesBack(refund) || actionNeeded;
    // A refund Stripe answers exactly failed or canceled takes nothing back, but may undo the mark a pending one left
    // (PENDING_REFUND_SALE): its sale is looked up like any refund's, and only that mark is cleared. Any other row
    // that gives nothing back is skipped as before (Claude 2's focal money review of #2868, LOW).
    const undone = !givesBack && refund.object !== "dispute" && (refund.status === "failed" || refund.status === "canceled");
    if (!givesBack && !undone) return "done";
    // A full refund not yet through: the keyless sale is marked pending, and the refund stays unread until it settles.
    // A succeeded part of a full refund whose rest is still pending counts as pending too (below).
    let pending = givesBack && refund.object !== "dispute" && REFUND_ON_ITS_WAY.has(refund.status as string);
    const [seen] = await redisPipeline([["SISMEMBER", refundSeenKey(store), id]]);
    if (Number(seen) === 1) {
      return "done";
    }
    const intent = typeof refund.payment_intent === "string" ? refund.payment_intent : "";
    if (!INTENT_PATTERN.test(intent)) {
      // No payment to look up (a charge made without one): no sale of this store can be told from it, so it is
      // read, and a lost dispute like it never holds the place back (review of #2158).
      await redisPipeline([
        ["SADD", refundSeenKey(store), id],
        ["EXPIRE", refundSeenKey(store), REFUND_LOOKBACK_SECONDS * 2 + 86_400],
      ]);
      return "done";
    }
    if (budget.left <= 0) return "short";
    budget.left -= 1;

    // Which sale that payment was: a checkout of this store, or an offer.
    const sales: { reference: string; products: string[] }[] = [];
    // A list in another shape is not "no checkout": the refund stays unread and is read again (sweep A3 finding 2).
    let session: StripeRow | null;
    try {
      session = onlyRow(await onAccount("GET", account, `/checkout/sessions?${new URLSearchParams({ payment_intent: intent, limit: "1" })}`), checkoutLegible);
    } catch (error) {
      if (!(error instanceof StripeListUnreadable)) throw error;
      console.error("reading the checkout of a refunded payment failed", store.handle, error);
      return "failed";
    }
    if (session) {
      const meta = ownField(session, "metadata") as Record<string, string>;
      // The product, the one ticked, and every product of a bundle among them.
      if (handles.has(meta.store ?? "")) sales.push({ reference: session.id, products: deliveredIds(meta) });
    } else if (budget.left > 0) {
      budget.left -= 1;
      const pi: unknown = await onAccount("GET", account, `/payment_intents/${encodeURIComponent(intent)}`);
      // The payment in its exact shape, its metadata as Stripe gives it: anything else is not "no offer" nor "not a
      // plan", and the refund stays unread (Claude 4's second review of #2868, CX-123 rule 24).
      const piMeta = plainObject(pi) ? ownField(pi, "metadata") : undefined;
      if (!plainObject(pi) || ownField(pi, "object") !== "payment_intent" || ownField(pi, "id") !== intent || !stripeMetadata(piMeta)) {
        console.error("reading a refunded payment failed", store.handle, new StripeReplyUnreadable("a payment"));
        return "failed";
      }
      const meta = piMeta;
      if (meta.kind === "upsell" && handles.has(meta.store ?? "")) sales.push({ reference: intent, products: deliveredIds(meta) });
      else if (budget.left > 0) {
        // A payment plan's first payment belongs to an invoice, not to the
        // checkout: found through the invoice, the plan is refunded like any sale.
        budget.left -= 1;
        const plan = await planSaleOf(account, intent, pi).catch((error: unknown) => {
          // Stripe saying there is no such thing is an answer: not a plan.
          if (error instanceof StripeError && error.status >= 400 && error.status < 500 && error.status !== 429) return null;
          console.error("finding a refunded payment plan failed", error);
          return undefined;
        });
        if (plan === undefined) {
          return "failed";
        }
        if (plan && handles.has(plan.meta.store ?? "")) sales.push({ reference: plan.session, products: deliveredIds(plan.meta) });
      } else {
        return "short";
      }
    } else {
      return "short";
    }

    // A succeeded refund that is only part of a charge read as refunded in full (Stripe counts a refund still pending
    // in amount_refunded) takes nothing back while another refund of that charge is on its way: it may still fail,
    // and a key revoked then stays revoked on a sale mostly paid. All of the charge's refunds are read (one lookup);
    // while one is on its way the sale is held exactly like a pending refund, and anything unknown keeps the refund
    // unread (Claude 2's focal money review of #2868 at 9fa5c95602, HIGH). A single refund of the whole charge, and
    // a lost dispute, need no read.
    if (sales.length > 0 && givesBack && !pending && refund.object !== "dispute" && !wholeOnItsOwn(refund)) {
      if (budget.left <= 0) return "short";
      budget.left -= 1;
      try {
        if ((await chargeRefundsSettled(account, refund)) === "held") pending = true;
      } catch (error) {
        if (!(error instanceof StripeListUnreadable)) throw error;
        console.error("reading the refunds of a refunded charge failed", store.handle, error);
        return "failed";
      }
    }

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
              if (pending) {
                // A key already given stays valid while the refund is pending: it may still fail, and a key revoked
                // then would stay revoked on a sale that was paid. The refund stays unread and is read again until it
                // goes through (the key is revoked then) or fails (the key stays as it is; Claude 5's pre-review of
                // claude5/licence-refunds-combined, HIGH 2).
                heldHere = true;
              } else {
                // A key whose record settle has not written yet is not "nothing to revoke": the refund stays unread
                // and the next run revokes the record written meanwhile (Claude 2's second money review of #2868,
                // MEDIUM).
                if (!(await setRevoked(store, product, key, true, "refund"))) throw new RecordNotWrittenYet();
                here += 1;
              }
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
      return "failed";
    }
    if (held) {
      return "failed";
    }
    revoked += here;
    await redisPipeline([
      ["SADD", refundSeenKey(store), id],
      ["EXPIRE", refundSeenKey(store), REFUND_LOOKBACK_SECONDS * 2 + 86_400],
    ]);
    return "done";
  };

  /** One page of refunds since the pass's start in its exact shape (lib/stripe-list.ts); null when it could not be read. */
  const readPage = async (from: string): Promise<ReturnType<typeof readStripePage> | null> => {
    const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
    query.append("expand[]", "data.charge");
    if (from) query.set("starting_after", from);
    // A page in another shape is not "no refunds": the pass stays on it, so the place stays (CX-123 rule 30).
    try {
      // Each row in the shape lib/refunds.ts reads a refund (its payment an id or null): any other row is unreadable.
      const raw = await onAccount("GET", account, `/refunds?${query}`);
      const latest = Math.floor(Date.now() / 1000) + 300;
      return readStripePage(raw, row => refundRowKnown(row) && (row.created as number) <= latest);
    } catch (error) {
      if (!(error instanceof StripeListUnreadable)) throw error;
      console.error("reading a store's refunds for license keys failed", store.handle, error);
      return null;
    }
  };

  /**
   * Puts refunds Stripe finished whose work could not be done on the list to try again, as lib/gifts.ts does; true only
   * when every one is kept for sure. Only a refund that succeeded (the owner's decision 18 of 9 November 2026; reviews
   * of #3302): the list tries a row again as finished, so a refund not final yet is never put on it and holds the place.
   */
  const keepForLater = async (rows: Record<string, unknown>[]): Promise<boolean> => {
    const fields: string[] = [];
    for (const row of rows) {
      const { id, payment_intent: pi } = row;
      if (row.object !== "refund" || row.status !== "succeeded" || typeof id !== "string" || typeof pi !== "string" || !REFUND_ID.test(id) || !INTENT_PATTERN.test(pi)) return false;
      fields.push(id, pi);
    }
    // Only rows not on the list yet count against its cap, each slot read from the reply's own data (replyList).
    const ids = fields.filter((_, i) => i % 2 === 0);
    const read = repliesFor(await redisPipeline([["HLEN", refundRetryKey(store)], ["HMGET", refundRetryKey(store), ...ids]]), 2);
    const counted = countOf(read?.[0]);
    const slots = replyList(read?.[1]);
    let added: number | null = slots && slots.length === ids.length ? 0 : null;
    for (const value of slots ?? []) {
      if (added === null) break;
      if (value === null) added += 1;
      else if (typeof value !== "string") added = null;
    }
    if (counted === null || added === null || counted + added > REFUND_RETRY_CAP) {
      console.error("reading refunds for license keys: the list to try again is full or unknown; the place waits at the rows", store.handle);
      return false;
    }
    const kept = repliesFor(await redisPipeline([["HSET", refundRetryKey(store), ...fields], ["EXPIRE", refundRetryKey(store), REFUND_RETRY_KEEP_SECONDS]]), 2);
    const wrote = countOf(kept?.[0]);
    return wrote !== null && wrote <= rows.length && kept?.[1] === 1;
  };

  /**
   * A refund on the list read again from Stripe before anything is taken back: the row itself when it succeeded on a
   * charge refunded in full; "drop" when Stripe failed or canceled it, or its charge is not refunded in full (nothing to
   * take back); "keep" when it is not final, in another shape, or Stripe could not be asked (read again later).
   */
  const reread = async (id: string, pi: string): Promise<Record<string, unknown> | "drop" | "keep"> => {
    let row: unknown;
    try {
      row = await onAccount("GET", account, `/refunds/${encodeURIComponent(id)}?${new URLSearchParams([["expand[]", "charge"]])}`);
    } catch (error) {
      console.error("reading refunds for license keys: a row to try again could not be read again; kept", store.handle, error);
      return "keep";
    }
    if (!plainObject(row) || row.object !== "refund" || row.id !== id || row.payment_intent !== pi || !refundRowKnown(row)) return "keep";
    if (row.status === "failed" || row.status === "canceled") return "drop";
    if (row.status !== "succeeded" || !plainObject(row.charge)) return "keep";
    return (row.charge as Record<string, unknown>).refunded === true ? row : "drop";
  };

  // The refunds on the list to try again, first, at most KEYS_REFUND_REREADS_PER_STORE a run and at most
  // REFUND_REREAD_MS of the run, in the order of their ids from the one after the last this store's runs read, with
  // their own REFUND_REREAD_LOOKUPS: each read again from Stripe and handled as the row Stripe sends; let go once handled,
  // or once Stripe failed or canceled it or its charge is not refunded in full. A list read in another shape, or a row on
  // it that is not a refund and a payment, is left as it is and read again next run: never taken as empty or dropped.
  const flat = stringList(begun[2]);
  if (!flat || flat.length % 2 !== 0) console.error("reading refunds for license keys: the list to try again was read in another shape; read again next run", store.handle);
  else if (flat.length > 0) {
    const listed: [string, string][] = [];
    for (let i = 0; i < flat.length; i += 2) {
      if (REFUND_ID.test(flat[i]) && INTENT_PATTERN.test(flat[i + 1])) listed.push([flat[i], flat[i + 1]]);
      else console.error("reading refunds for license keys: a row to try again in another shape; kept", store.handle);
    }
    listed.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const from = begun[3];
    const place = typeof from === "string" && REFUND_ID.test(from) ? from : null;
    const past = place === null ? 0 : listed.findIndex(([id]) => id > place);
    const start = past < 0 ? 0 : past;
    const until = Math.min(deadline, Date.now() + REFUND_REREAD_MS);
    const budget = { left: REFUND_REREAD_LOOKUPS };
    let last = "";
    for (let k = 0; k < Math.min(listed.length, KEYS_REFUND_REREADS_PER_STORE); k += 1) {
      if (Date.now() >= deadline || (k > 0 && Date.now() >= until)) break;
      const [id, pi] = listed[(start + k) % listed.length];
      const verdict = await reread(id, pi);
      if (verdict !== "keep" && verdict !== "drop") {
        const outcome = await handleRow(verdict, budget);
        // Out of lookups: this row and the ones after it are read again from here next run.
        if (outcome === "short") break;
        last = id;
        if (outcome === "failed") continue;
      } else {
        last = id;
        if (verdict === "keep") continue;
      }
      const gone = repliesFor(await redisPipeline([["HDEL", refundRetryKey(store), id]]), 1);
      if (countOf(gone?.[0]) === null) console.error("reading refunds for license keys: letting go of a row was left unknown; read again next run", store.handle);
    }
    // The list is kept as long again by every run that reads it (Claude 2 lpgvy's LEVE on #5321): kept only from the
    // last row put on it, a row that kept failing lapsed with it, past the place, and the key of a sale refunded in full
    // stayed valid for good (its record has no expiry). So it lapses only once the store's job stops reading it. The
    // place moves past every row read this run; a write left unknown reads the same rows again next run.
    const writes: (string | number)[][] = [["EXPIRE", refundRetryKey(store), REFUND_RETRY_KEEP_SECONDS]];
    if (last) writes.push(["SET", refundRetryFromKey(store), last, "EX", REFUND_RETRY_KEEP_SECONDS]);
    const kept = repliesFor(await redisPipeline(writes), writes.length);
    // 0 is a list whose last row this run let go (nothing left to keep); anything but 0 or 1 is unknown.
    if (kept?.[0] !== 0 && kept?.[0] !== 1) console.error("reading refunds for license keys: keeping the list to try again was left unknown; renewed next run", store.handle);
    if (last && kept?.[1] !== "OK") console.error("reading refunds for license keys: the place on the list to try again was left unknown", store.handle);
  }

  // Lost disputes, read once a run from the pass's start, as before: with the first page of refunds the run reads and
  // inside its deadline; more than it reads, a failed read or a row not handled keeps the place. They take their own
  // REFUND_LOST_LOOKUPS, never the pass's.
  let lostRead: LostRead | null = null;
  const lostBudget = { left: REFUND_LOST_LOOKUPS };
  const takeLost = async (): Promise<void> => {
    if (lostRead || Date.now() >= deadline) return;
    const read = await lostDisputesOrRetry(account, since, deadline, lostCursorKey("keys", store.statsId ?? account));
    lostRead = read;
    if (!read.complete) unsure = true;
    for (const row of read.rows) {
      if (Date.now() >= deadline) {
        unsure = true;
        return;
      }
      if ((await handleRow(row, lostBudget)) !== "done") unsure = true;
    }
  };

  // The pass's own lookups, REFUND_LOOKUPS less what the newest page may take: a row takes at most four (its checkout,
  // its payment, a plan's invoice, its charge's refunds), so the first row a run reads is always read whole.
  const budget = { left: REFUND_LOOKUPS - REFUND_TOP_LOOKUPS };
  let pages = REFUND_PAGES;
  // A run that resumes a pass first reads the newest page, so a refund made meanwhile does not wait for the pass: what
  // it reads there never moves the pass or the place, and the next pass reads it again (each handled one stays handled).
  if (after) {
    pages -= 1;
    const top = await readPage("");
    await takeLost();
    const topBudget = { left: REFUND_TOP_LOOKUPS };
    for (const refund of top?.rows ?? []) {
      if (Date.now() >= deadline) return revoked;
      if ((await handleRow(refund, topBudget)) === "short") break;
    }
  }
  const keepPass = async () => {
    // Either reply leaves a place that skips nothing: the one written, or the one kept before it (read again).
    await redisPipeline([["SET", refundPassKey(store), JSON.stringify(passNow()), "EX", REFUND_PASS_SECONDS]]);
  };
  for (let page = 0; page < pages; page += 1) {
    if (Date.now() >= deadline) break;
    const read = await readPage(after);
    if (!read) break;
    await takeLost();
    const failed: Record<string, unknown>[] = [];
    let stopped = false;
    let through = "";
    for (const refund of read.rows) {
      if (Date.now() >= deadline) {
        stopped = true;
        break;
      }
      const outcome = await handleRow(refund, budget);
      if (outcome === "short") {
        stopped = true;
        break;
      }
      if (outcome === "failed") failed.push(refund);
      newest = Math.max(newest, typeof refund.created === "number" ? refund.created : 0);
      if (typeof refund.id === "string" && refund.id) through = refund.id;
    }
    // A refund Stripe finished goes on the list to try again, so the place need not wait for it. Any other row not
    // handled (a refund not final yet, or one the list could not keep for sure: full, or a reply left unknown) holds the
    // place at its time; a row not readable, whose time is not known, keeps the place where it was.
    const finished = failed.filter((refund) => refund.object === "refund" && refund.status === "succeeded");
    const listed = finished.length > 0 && (await keepForLater(finished));
    for (const refund of failed) {
      if (listed && refund.object === "refund" && refund.status === "succeeded") continue;
      waiting = Math.min(waiting, typeof refund.created === "number" ? refund.created : since);
    }
    if (read.unreadable > 0) unread = true;
    if (stopped) {
      // Out of time or of lookups: the pass goes on next run from the last row this one went through.
      if (through) {
        after = through;
        await keepPass();
      }
      return revoked;
    }
    if (!read.hasMore) {
      ended = true;
      break;
    }
    // The next page is read from the last row, or, when that row is not readable, from the last readable one, which
    // reads the rows after it again (never skipped). A page with no readable row at all has nothing to go on from: the
    // pass stays on it and the place where it was, so nothing behind it is passed over.
    const next = read.lastId ?? (through || null);
    if (!next) {
      console.error("reading refunds for license keys: a page with no readable row; the pass stays on it", store.handle);
      break;
    }
    after = next;
    await keepPass();
  }
  // The lost disputes' place moves only once every one read was handled (lib/refunds.ts, confirmLostRead), and the
  // place with it. A run that read every refund from the place to now (no pass resumed) moves as before: to the newest
  // closing of the whole sweep when it went on from a kept place, else past the newest it read. A run that resumed a
  // pass read the refunds only up to when the pass began, so it moves no further than the pass's newest refund (as
  // lib/gifts.ts): a refund made since is read by the next pass.
  const lost = lostRead as LostRead | null;
  if (!lost) unsure = true;
  else if (!(await confirmLostRead(lost, refundSeenKey(store)))) unsure = true;
  else if (lost.complete) newest = pass ? (lost.resumed ? Math.min(newest, Math.max(lost.newest, since)) : newest) : lost.resumed ? lost.newest : Math.max(newest, lost.newest);
  if (ended && !unsure) {
    // Never past a refund the pass read that could not be handled and is not on the list: the next pass reads it again
    // from there. A pass that read a row not readable lets the pass go and keeps the place where it was.
    const to = Math.min(Math.max(newest, anchor), Math.max(waiting, since));
    const closed = repliesFor(await redisPipeline([...(unread ? [] : [["SET", refundAnchorKey(store), String(to), "EX", REFUND_LOOKBACK_SECONDS * 2]]), ["DEL", refundPassKey(store)]]), unread ? 1 : 2);
    if (!closed) console.error("ending a pass over refunds for license keys was left unknown", store.handle);
    return revoked;
  }
  if (!(Number(anchorRaw) > 0)) {
    // A store with no place yet keeps the one it started from, so the next run reads the same window and the lost
    // disputes' kept place still counts; its refunds already read are kept as long (reviews of #2158).
    await redisPipeline([
      ["SET", refundAnchorKey(store), String(anchor), "EX", REFUND_LOOKBACK_SECONDS * 2],
      ["EXPIRE", refundSeenKey(store), REFUND_LOOKBACK_SECONDS * 2 + 86_400],
    ]);
  }
  // A pass not ended, or ended while a lost dispute was left: kept, so the next run goes on from it.
  if (after) await keepPass();
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
    await sendEmail({ meter: { by: "order", store },
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
