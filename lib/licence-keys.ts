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
 *   nl:keys:<store>:who:<address>      hash "<product>\t<key>" -> "1": the keys one person was given, written in
 *                                      the same step as the key (settle), so their copy reads only their own keys
 *                                      (issue #5125); <address> is a one-way digest of the normalised address
 *
 * <store> is the store's statsId, which follows it through a new address and
 * a new sign-in email.
 */
import { MAX_UPLOAD_KEYS, MAX_POOL_KEYS, MIN_KEY_LENGTH, MAX_KEY_LENGTH, KEY_ALPHABET, MAX_KEY_FILE_BYTES, sampleKey, type IssuedKey, type KeyCounts } from "@/lib/licence-key-rules";
export { MAX_UPLOAD_KEYS, MAX_POOL_KEYS, MIN_KEY_LENGTH, MAX_KEY_LENGTH, KEY_ALPHABET, MAX_KEY_FILE_BYTES, sampleKey, type IssuedKey, type KeyCounts } from "@/lib/licence-key-rules";
import { ERASING_KEY, STORE_ID_PATTERN, erasingField, saleHandles, storeIdCommand, storeRef } from "@/lib/store";
import { createHash } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
// One script carries at most this many commands, which the buyers' lists fill counts in its run's commands.
import { ORDER_WRITE_MAX, orderWriteCallsMost, orderWriteIfStoreLive } from "@/lib/order-data";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
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

/** A one-way digest of the address, normalised as the copy reads it (lib/auth.ts normaliseEmail): never the address in a key's name. */
export const keyHolderDigest = (email: string): string => createHash("sha256").update(`marktmorgen-licence-holder:${normaliseEmail(email)}`).digest("hex").slice(0, 32);
/** The keys one person was given in a store (issue #5125): a hash so it is written inside settle's ORDER_WRITE_IF_NEW, which takes hash writes only. */
export const holderKey = (store: Pick<Store, "statsId">, email: string) => `nl:keys:${store.statsId}:who:${keyHolderDigest(email)}`;
/** The field of one key in a holder's hash: the product and the key, which has no space in it (lib/licence-key-rules.ts). */
export const holderField = (product: Pick<Listing, "id">, key: string) => `${product.id}\t${key}`;
/**
 * A store's fill of its buyers' lists (#5136, Claude 4 3rC's MEDIUM): `at` is where it is ("<catalog digest>:<product
 * index>:<HSCAN cursor>" over the store's products in id order) and `done` is "1" once every product's records were
 * walked to the end in one unchanged catalog. Keys given before the lists existed (trial stores sold until 5 October
 * 2026) have no line until then. The digest is of the catalog's sorted ids (catalogDigest): when a product is added or
 * removed between two runs, the index would name another product (Claude 4 3Kc's MEDIUM on d2df5637dd: a removed product
 * before it skipped the next one, and the store was marked done with its keys left out), so the walk starts again from
 * the top. Walking again only reads what has its lines already; it never skips a product.
 */
const fillKey = (store: Pick<Store, "statsId">) => `nl:keys:${store.statsId}:whofill`;
/** The fill place's mark of the catalog it was walked in: the first 16 hex of a SHA-256 of the sorted product ids. */
const catalogDigest = (ids: string[]) => createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 16);
/** The company's mark that every store the sweep reached in one whole round had its fill done: the sweep stops asking. */
export const HOLDER_FILL_ALL_DONE = "nl:keysfill:done";
/** The round's mark: "clean" from the round's first store, "dirty" once a store's fill was left unfinished in it. */
export const HOLDER_FILL_ROUND = "nl:keysfill:round";
/** Records one HSCAN step asks for (Redis may give a whole small hash at once). */
/**
 * Records one step reads (HSCAN COUNT): a hint Redis may pass. 30, so a step at its dearest (an HMGET a buyer, every
 * line missing, each written behind the store-live fence with every call inside its script counted, and the place)
 * stays well inside one run of FILL_RUN_COMMANDS (about 313 calls at 30 records), now that a script is counted with
 * the calls inside it (Claude 4 3rC's LOW 1 and Codex N1 on #5136). A page Redis answers larger still marks the store
 * `whole` when even one cannot fit a run.
 */
const FILL_PAGE = 30;
/**
 * The most commands one store's fill sends in one run of the sweep, counted as the cost registry counts them (a script
 * is 1 plus its commands): a one-time company cost, never a store's. tests/licence-holder-fill.test.ts holds it.
 */
export const FILL_RUN_COMMANDS = 400;
/** The `done` value of a store whose fill could not fit one page in a run: its copy keeps main's whole read for good. */
export const HOLDER_FILL_WHOLE = "whole";
/**
 * How many times one store's fill may stop short before it is marked `whole` (Claude 6 i51q's MEDIUM on cdafb13ff9): a
 * run that met a reply in a shape no writer writes (rule 24, persistent, so the next run would meet it again) or a walk
 * that had to start again from the top because the catalog changed. Each other run advances at least one step, so a
 * store's fill ends after at most its steps plus these tries, and the sweep's asking ends with it.
 */
export const FILL_MAX_TRIES = 5;
/**
 * One fenced write of the fill's mark (the place, `done`, or `done` and `tries` together): the script and every call
 * inside it, as the cost registry counts a script (Claude 4 3rC's LOW 1 and Codex N1 on #5136), at the dearest of the
 * three, two fields.
 */
export const FILL_MARK_COMMANDS = orderWriteCallsMost([["HSET", "mark", "done", HOLDER_FILL_WHOLE, "tries", String(FILL_MAX_TRIES)]], { storeLive: true });
/**
 * What the fill's fenced writes of `n` missing lines cost: one script per ORDER_WRITE_MAX lines, each line a one-field
 * HSET of its own buyer's list at the dearest (every line on a list of its own), with every call inside the script.
 */
const writeCommands = (n: number) => {
  let calls = 0;
  for (let left = n; left > 0; left -= ORDER_WRITE_MAX) {
    const m = Math.min(left, ORDER_WRITE_MAX);
    calls += orderWriteCallsMost(Array.from({ length: m }, (_, i) => ["HSET", `list${i}`, "line", "1"]), { storeLive: true });
  }
  return calls;
};

/** One step of the fill at its dearest: an HMGET a buyer, every one of `lines` missing and written, and the place. */
export const fillStepCommandsMost = (buyers: number, lines: number) => buyers + writeCommands(lines) + FILL_MARK_COMMANDS;

/**
 * The store-live fence of every write the fill makes (Claude 1's LEVE and Codex N1 on #5136): the store's id key and
 * its erasing mark, read in the same step as the write (lib/order-data.ts ORDER_WRITE_IF_STORE_LIVE), so a fill that
 * reads a page while the store is being erased never writes a buyer's line, the place or a mark back after the
 * closing walk. A store kept from before ids has no id key the fence can read, so the fill never writes for it: its
 * copies keep main's whole read, complete (keysOf), as a store whose fill is not done.
 */
type FillFence = { live: string; field: string };
async function fillFence(store: Store): Promise<FillFence | null> {
  if (!STORE_ID_PATTERN.test(store.sid)) return null;
  return { live: storeIdCommand(store.sid)[1], field: await erasingField(storeRef(store)) };
}
/** The store is gone (or erasing) under the fill: nothing more is written, and the sweep stops asking it. */
class FillStoreGone extends Error {}
async function fillWrite(store: Store, fence: FillFence, commands: [string, string, ...string[]][]): Promise<void> {
  for (let i = 0; i < commands.length; i += ORDER_WRITE_MAX) {
    const written = await orderWriteIfStoreLive(store, commands.slice(i, i + ORDER_WRITE_MAX), fence.live, ERASING_KEY, fence.field);
    if (written === null) throw new FillStoreGone("the store was erased during its fill");
  }
}

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
  // A key given to a sale is kept for good: counted in the store's room at what it adds (lib/order-data.ts). The
  // buyer's own list of keys is written in the same step, so a key is never given without it (issue #5125); a sale
  // with no address has nobody to list it under.
  const holder: [string, string, string, string][] = normaliseEmail(email) ? [["HSET", holderKey(store, email), holderField(product, key), "1"]] : [];
  const won = await orderWriteIfNew(store, [
    ["HSETNX", saleKey(store, product), reference, key],
    ["HSET", infoKey(store, product), key, JSON.stringify(info)],
    ["HDEL", waitingKey(store, product), reference],
    ...holder,
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
  // Read exactly (unknown is never zero): the studio shows the keys given and keyCounts counts them from this list, so
  // a reply in another shape throws and the keys route answers an error, never "0 keys given" (Codex X6's LOW 1 on
  // #2868, #5285). An empty hash is the list Redis answers for a product that has given none. The pipeline's envelope
  // holds exactly this one reply, the list holds whole field/value pairs, and every value is a record the writers made
  // (HSET of JSON(info) only): one more reply, an odd list or a record that does not read is unknown, never a shorter
  // count (Claude 1's LEVEs 1 and 2 on #5318).
  const raw = repliesFor(await redisPipeline([["HGETALL", infoKey(store, product)]]), 1)?.[0];
  if (!Array.isArray(raw) || raw.length % 2 !== 0) throw new UnknownReplyError("a product's license key records");
  const all: IssuedKey[] = [];
  const flat = raw as unknown[];
  for (let i = 0; i < flat.length; i += 2) {
    const entry = typeof flat[i] === "string" ? parseInfo(flat[i] as string, flat[i + 1]) : null;
    if (!entry) throw new UnknownReplyError("a product's license key record");
    all.push(entry);
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
const INTENT_PATTERN = /^pi_[A-Za-z0-9]{6,200}$/;

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
  // the place as it was, never a newer start that would then be written over the real, older place.
  const anchorRead = repliesFor(await redisPipeline([["GET", refundAnchorKey(store)]]), 1);
  const anchorRaw = anchorRead?.[0];
  if (!anchorRead || (anchorRaw !== null && !(typeof anchorRaw === "string" && /^\d{1,12}$/.test(anchorRaw)))) {
    throw new UnknownReplyError("the license keys' refund place");
  }
  const anchor = Number(anchorRaw) > 0 ? Number(anchorRaw) : now - REFUND_LOOKBACK_SECONDS;
  // A little overlap, so a refund created in the second the last run read is
  // not missed; the set of refunds already read keeps it from counting twice.
  const since = Math.max(0, anchor - 300);
  let newest = anchor;
  let lookups = REFUND_LOOKUPS;
  let revoked = 0;
  let after = "";
  let complete = false;
  // A refund whose sale could not be told for sure is left unread, and the
  // anchor stays, so the next run looks at it again.
  let unsure = false;
  let lostRead: LostRead | null = null;
  const handles = saleHandles(store);

  for (let page = 0; page < REFUND_PAGES && Date.now() < deadline; page += 1) {
    const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
    query.append("expand[]", "data.charge");
    if (after) query.set("starting_after", after);
    // A page in another shape is not "no refunds": the run stops here unsure, so the place stays (CX-123 rule 30).
    let listed: ReturnType<typeof readStripePage>;
    try {
      // Each row in the shape lib/refunds.ts reads a refund (its payment an id or null): any other row is unreadable.
      const raw = await onAccount("GET", account, `/refunds?${query}`);
      const latest = Math.floor(Date.now() / 1000) + 300;
      listed = readStripePage(raw, row => refundRowKnown(row) && (row.created as number) <= latest);
    } catch (error) {
      if (!(error instanceof StripeListUnreadable)) throw error;
      console.error("reading a store's refunds for license keys failed", store.handle, error);
      unsure = true;
      break;
    }
    // A row that cannot be read proves nothing, and keeps the place from moving past it.
    if (listed.unreadable > 0) unsure = true;
    const refunds: Record<string, unknown>[] = listed.rows;
    // Lost disputes, read once with the first page; more than it reads, or a failed read, keeps the anchor.
    const lost = page === 0 ? await lostDisputesOrRetry(account, since, deadline, lostCursorKey("keys", store.statsId ?? account)) : null;
    if (lost) lostRead = lost;
    if (lost && !lost.complete) unsure = true;
    const rows = [...(lost?.rows ?? []), ...refunds];
    for (const refund of rows) {
      if (Date.now() >= deadline) break;
      const id = typeof refund.id === "string" ? refund.id : "";
      const created = typeof refund.created === "number" ? refund.created : 0;
      if (!id) continue;
      // A full refund that needs an action (requires_action) is on its way, as a pending one (Claude 1 and Claude 6 on
      // #2868): skipped, a newer refund moved the anchor past it and, once it succeeded, its key stayed valid for good.
      // One whose charge does not read as refunded in full yet proves nothing, and keeps the place from moving past it.
      const actionNeeded = refund.object !== "dispute" && refund.status === "requires_action";
      if (actionNeeded && !refundedInFull(refund.charge)) {
        unsure = true;
        continue;
      }
      const givesBack = rowGivesBack(refund) || actionNeeded;
      // A refund Stripe answers exactly failed or canceled takes nothing back, but may undo the mark a pending one left
      // (PENDING_REFUND_SALE): its sale is looked up like any refund's, and only that mark is cleared. Any other row
      // that gives nothing back is skipped as before (Claude 2's focal money review of #2868, LOW).
      const undone = !givesBack && refund.object !== "dispute" && (refund.status === "failed" || refund.status === "canceled");
      if (!givesBack && !undone) continue;
      // A full refund not yet through: the keyless sale is marked pending, and the refund stays unread until it settles.
      // A succeeded part of a full refund whose rest is still pending counts as pending too (below).
      let pending = givesBack && refund.object !== "dispute" && REFUND_ON_ITS_WAY.has(refund.status as string);
      const [seen] = await redisPipeline([["SISMEMBER", refundSeenKey(store), id]]);
      if (Number(seen) === 1) {
        newest = Math.max(newest, created);
        continue;
      }
      const intent = typeof refund.payment_intent === "string" ? refund.payment_intent : "";
      if (!INTENT_PATTERN.test(intent)) {
        // No payment to look up (a charge made without one): no sale of this store can be told from it, so it is
        // read, and a lost dispute like it never holds the place back (review of #2158).
        await redisPipeline([
          ["SADD", refundSeenKey(store), id],
          ["EXPIRE", refundSeenKey(store), REFUND_LOOKBACK_SECONDS * 2 + 86_400],
        ]);
        newest = Math.max(newest, created);
        continue;
      }
      if (lookups <= 0) continue;
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
        unsure = true;
        continue;
      }
      if (session) {
        const meta = ownField(session, "metadata") as Record<string, string>;
        // The product, the one ticked, and every product of a bundle among them.
        if (handles.has(meta.store ?? "")) sales.push({ reference: session.id, products: deliveredIds(meta) });
      } else if (lookups > 0) {
        lookups -= 1;
        const pi: unknown = await onAccount("GET", account, `/payment_intents/${encodeURIComponent(intent)}`);
        // The payment in its exact shape, its metadata as Stripe gives it: anything else is not "no offer" nor "not a
        // plan", and the refund stays unread (Claude 4's second review of #2868, CX-123 rule 24).
        const piMeta = plainObject(pi) ? ownField(pi, "metadata") : undefined;
        if (!plainObject(pi) || ownField(pi, "object") !== "payment_intent" || ownField(pi, "id") !== intent || !stripeMetadata(piMeta)) {
          console.error("reading a refunded payment failed", store.handle, new StripeReplyUnreadable("a payment"));
          unsure = true;
          continue;
        }
        const meta = piMeta;
        if (meta.kind === "upsell" && handles.has(meta.store ?? "")) sales.push({ reference: intent, products: deliveredIds(meta) });
        else if (lookups > 0) {
          // A payment plan's first payment belongs to an invoice, not to the
          // checkout: found through the invoice, the plan is refunded like any sale.
          lookups -= 1;
          const plan = await planSaleOf(account, intent, pi).catch((error: unknown) => {
            // Stripe saying there is no such thing is an answer: not a plan.
            if (error instanceof StripeError && error.status >= 400 && error.status < 500 && error.status !== 429) return null;
            console.error("finding a refunded payment plan failed", error);
            return undefined;
          });
          if (plan === undefined) {
            unsure = true;
            continue;
          }
          if (plan && handles.has(plan.meta.store ?? "")) sales.push({ reference: plan.session, products: deliveredIds(plan.meta) });
        } else {
          unsure = true;
          continue;
        }
      } else {
        unsure = true;
        continue;
      }

      // A succeeded refund that is only part of a charge read as refunded in full (Stripe counts a refund still pending
      // in amount_refunded) takes nothing back while another refund of that charge is on its way: it may still fail,
      // and a key revoked then stays revoked on a sale mostly paid. All of the charge's refunds are read (one lookup);
      // while one is on its way the sale is held exactly like a pending refund, and anything unknown keeps the refund
      // unread (Claude 2's focal money review of #2868 at 9fa5c95602, HIGH). A single refund of the whole charge, and
      // a lost dispute, need no read.
      if (sales.length > 0 && givesBack && !pending && refund.object !== "dispute" && !wholeOnItsOwn(refund)) {
        if (lookups <= 0) continue;
        lookups -= 1;
        try {
          if ((await chargeRefundsSettled(account, refund)) === "held") pending = true;
        } catch (error) {
          if (!(error instanceof StripeListUnreadable)) throw error;
          console.error("reading the refunds of a refunded charge failed", store.handle, error);
          unsure = true;
          continue;
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
        unsure = true;
        continue;
      }
      if (held) {
        unsure = true;
        continue;
      }
      revoked += here;
      await redisPipeline([
        ["SADD", refundSeenKey(store), id],
        ["EXPIRE", refundSeenKey(store), REFUND_LOOKBACK_SECONDS * 2 + 86_400],
      ]);
      newest = Math.max(newest, created);
    }
    if (!listed.hasMore) {
      complete = true;
      break;
    }
    // More to read but no readable row to go on from: the rest is not known.
    if (!listed.lastId) {
      unsure = true;
      break;
    }
    after = listed.lastId;
  }
  // Only moved forward past what was read to the end: a run cut short by
  // its deadline, its pages or its lookups starts from the same place next
  // time, and the refunds it already handled are skipped as read.
  // The lost disputes' place moves only once every one read was handled (lib/refunds.ts, confirmLostRead); a sweep
  // that went on from a kept place moves the job no further than the newest closing it read, so a dispute closed
  // meanwhile is read from the top next run (review of #2158, inbox C4-24).
  if (lostRead) {
    if (!(await confirmLostRead(lostRead, refundSeenKey(store)))) unsure = true;
    else if (lostRead.complete) newest = lostRead.resumed ? lostRead.newest : Math.max(newest, lostRead.newest);
  }
  // The place moves only past what was read to the end, sure, with lookups left and inside its time. A store with no place yet keeps
  // the one it started from, so the next run reads the same window and the lost disputes' kept place still counts; its
  // refunds already read are kept as long (reviews of #2158). Otherwise nothing is written: a place that cannot move
  // lapses as it always did, and the read refunds, kept sixty-one days after the last one, always outlive it.
  const done = complete && !unsure && lookups > 0 && Date.now() < deadline;
  if (done) await redisPipeline([["SET", refundAnchorKey(store), String(Math.max(newest, anchor)), "EX", REFUND_LOOKBACK_SECONDS * 2]]);
  else if (!(Number(anchorRaw) > 0)) {
    await redisPipeline([
      ["SET", refundAnchorKey(store), String(anchor), "EX", REFUND_LOOKBACK_SECONDS * 2],
      ["EXPIRE", refundSeenKey(store), REFUND_LOOKBACK_SECONDS * 2 + 86_400],
    ]);
  }
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
  if (!store.statsId || !isRedisConfigured() || !normaliseEmail(email)) return [];
  // Until the store's fill is done, a key given before the lists may have no line: read every product's records, as
  // main did (complete, never worse). After it, only the person's own list (#5136).
  if (!(await holderFillDone(store))) return keysOfWhole(store, productIds, email);
  return keysOfList(store, productIds, email);
}

/** Whether the store's fill of its buyers' lists is done; a mark in any other shape is unknown and throws (rule 24). */
export async function holderFillDone(store: Pick<Store, "statsId">): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured()) return false;
  const reply = repliesFor(await redisPipeline([["HGET", fillKey(store), "done"]]), 1);
  const mark = reply?.[0];
  if (!reply || (mark !== null && mark !== "1" && mark !== HOLDER_FILL_WHOLE)) throw new UnknownReplyError("the license keys' fill mark");
  // `whole` is a store whose fill could not fit one page in a run: it keeps main's whole read, so it is never "done".
  return mark === "1";
}

/** Main's read, kept for a store whose fill is not done: every product's whole records, filtered by the address. */
async function keysOfWhole(store: Store, productIds: string[], email: string): Promise<(IssuedKey & { product: string })[]> {
  if (!productIds.length) return [];
  const address = normaliseEmail(email);
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
      if (entry && normaliseEmail(entry.email) === address) out.push({ ...entry, product });
    }
    return out;
  });
}

/** The person's own keys, from their list: one HGETALL and one HMGET a product they hold a key of. */
async function keysOfList(store: Store, productIds: string[], email: string): Promise<(IssuedKey & { product: string })[]> {
  const address = normaliseEmail(email);
  // Only this person's keys, from their own list written with each key (settle; issue #5125), never every key the
  // store gave. An unknown answer is not "no keys": the copy says it could not read them rather than leave them out
  // (CX-123 rule 24).
  const listed = repliesFor(await redisPipeline([["HGETALL", holderKey(store, email)]]), 1)?.[0];
  const flat = listed === undefined ? null : stringList(listed);
  if (!flat || flat.length % 2 !== 0) throw new UnknownReplyError("the person's list of license keys");
  const byProduct = new Map<string, string[]>();
  for (let i = 0; i < flat.length; i += 2) {
    const cut = flat[i].indexOf("\t");
    const product = cut > 0 ? flat[i].slice(0, cut) : "";
    const key = cut > 0 ? flat[i].slice(cut + 1) : "";
    if (!product || !key || flat[i + 1] !== "1") throw new UnknownReplyError("an entry of the person's list of license keys");
    byProduct.set(product, [...(byProduct.get(product) ?? []), key]);
  }
  // The products the store still lists first, as the copy has always shown them; then any other product they hold a key of.
  const order = [...productIds.filter((id) => byProduct.has(id)), ...[...byProduct.keys()].filter((id) => !productIds.includes(id))];
  if (!order.length) return [];
  const replies = repliesFor(await redisPipeline(order.map((id) => ["HMGET", infoKey(store, { id }), ...byProduct.get(id)!])), order.length);
  if (!replies) throw new UnknownReplyError("the license keys' records");
  return order.flatMap((product, i) => {
    const keys = byProduct.get(product)!;
    const values = replies[i];
    if (!Array.isArray(values) || values.length !== keys.length) throw new UnknownReplyError("HMGET of a person's license keys");
    const out: (IssuedKey & { product: string })[] = [];
    values.forEach((raw, k) => {
      // A key whose product's records are gone (the product deleted with its keys) is kept nowhere: nothing to copy.
      if (raw === null) return;
      if (typeof raw !== "string") throw new UnknownReplyError("a license key's record");
      // An unreadable record is unknown, never a key left out of the copy.
      readInfo(raw);
      const entry = parseInfo(keys[k], raw);
      if (entry && normaliseEmail(entry.email) === address) out.push({ ...entry, product });
    });
    return out;
  });
}

/**
 * The person's keys as their data copy reads them (lib/person-copy.ts): read once per copy, so the keys part and the
 * devices part (lib/licence-activations.ts) share one read (issue #5125). `scope` is the copy's own scope object.
 */
const copyReads = new WeakMap<object, ReturnType<typeof keysOf>>();
export function keysForCopy(scope: { store: Store; productIds: string[]; email: string }): ReturnType<typeof keysOf> {
  let read = copyReads.get(scope);
  if (!read) {
    read = keysOf(scope.store, scope.productIds, scope.email);
    copyReads.set(scope, read);
  }
  return read;
}

/**
 * The opening check of issue #5125 (coordinator f416), read only and never called by a route: every key a product
 * gave whose line is missing from its buyer's own list (holderKey), so the person's copy would leave it out. Keys are
 * given only by settle, which writes the line in the same step; keys given before this list existed (stores sold on a
 * trial until 5 October 2026) get theirs from the sweep's fill (fillHolderLines). Before sales open, it proves it on
 * the real data for every store whose fill is done (holderFillDone); a store not done (marked `whole`, or never asked
 * because it sells no keys now, Claude 6 i51q's LOW on cdafb13ff9) may still list keys here, and its copy reads every
 * product's records as main did, complete. Reads each product's whole record hash and, per buyer, one
 * HMGET of their list: an audit's cost, not a request's. An unknown reply throws (rule 24), never "none missing".
 */
export async function keysWithoutHolderLine(store: Store, productIds: string[]): Promise<{ product: string; key: string }[]> {
  if (!store.statsId || !productIds.length || !isRedisConfigured()) return [];
  const replies = repliesFor(await redisPipeline(productIds.map((id) => ["HGETALL", infoKey(store, { id })])), productIds.length);
  if (!replies) throw new UnknownReplyError("the license keys' records");
  const byHolder = new Map<string, { email: string; fields: { product: string; key: string }[] }>();
  productIds.forEach((product, i) => {
    const flat = stringList(replies[i]);
    if (!flat || flat.length % 2 !== 0) throw new UnknownReplyError("HGETALL of a product's license keys");
    for (let k = 0; k + 1 < flat.length; k += 2) {
      const info = readInfo(flat[k + 1]);
      // A sale with no address has nobody to list it under (settle writes no line for it).
      if (!normaliseEmail(info.e)) continue;
      const holder = holderKey(store, info.e);
      const entry = byHolder.get(holder) ?? { email: info.e, fields: [] };
      entry.fields.push({ product, key: flat[k] });
      byHolder.set(holder, entry);
    }
  });
  const holders = [...byHolder.entries()];
  if (!holders.length) return [];
  const lines = repliesFor(await redisPipeline(holders.map(([holder, e]) => ["HMGET", holder, ...e.fields.map((f) => holderField({ id: f.product }, f.key))])), holders.length);
  if (!lines) throw new UnknownReplyError("the buyers' lists of license keys");
  return holders.flatMap(([, e], i) => {
    const values = lines[i];
    if (!Array.isArray(values) || values.length !== e.fields.length) throw new UnknownReplyError("HMGET of a buyer's list of license keys");
    return e.fields.filter((_, k) => {
      if (values[k] === "1") return false;
      if (values[k] === null) return true;
      throw new UnknownReplyError("an entry of a buyer's list of license keys");
    });
  });
}

/**
 * One run's share of a store's fill (#5136): walks the store's products in id order, each one's records with HSCAN from
 * the kept place, writes every missing line of the buyers' lists (orderWrite, counted in the store's room), keeps its
 * place after each step, and marks the store done only once the last product's walk is back at cursor 0. Answers whether
 * the store needs no more runs. An unknown reply throws (rule 24): the place stays as it was, never "done".
 *
 * The commands a run sends never pass `budget` (coordinator 14f3), counted as the cost registry counts them: a
 * pipelined command is 1 and an orderWrite script is 1 plus its commands. A step (one HSCAN page, its HMGETs, its
 * missing lines and the place) runs only when its worst case, known once the page is read, still leaves room for the
 * `done` mark; otherwise the run stops before writing anything of that page and the next run reads it again. A page that
 * cannot fit in a whole run even alone (Redis may answer an HSCAN with more than COUNT records) marks the store
 * `whole`: its copy keeps main's read of every product's records for good, complete, and the sweep stops asking it.
 */
export async function fillHolderLines(store: Store, deadline: number, budget = FILL_RUN_COMMANDS): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured()) return false;
  // No fence to write behind (a store from before ids): nothing is written, its copies keep main's whole read.
  const fence = await fillFence(store);
  if (!fence) return true;
  try {
    return await fillRun(store, fence, deadline, budget);
  } catch (error) {
    // Erased while it was being filled: nothing more is written for it, and nothing is left to ask.
    if (error instanceof FillStoreGone) return true;
    throw error;
  }
}

async function fillRun(store: Store, fence: FillFence, deadline: number, budget: number): Promise<boolean> {
  const state = repliesFor(await redisPipeline([["HMGET", fillKey(store), "done", "at", "tries"]]), 1)?.[0];
  if (!Array.isArray(state) || state.length !== 3) throw new UnknownReplyError("the license keys' fill state");
  const [mark, at, triedRaw] = state;
  if ((mark !== null && mark !== "1" && mark !== HOLDER_FILL_WHOLE) || (at !== null && typeof at !== "string")) throw new UnknownReplyError("the license keys' fill state");
  if (triedRaw !== null && (typeof triedRaw !== "string" || !/^\d{1,3}$/.test(triedRaw))) throw new UnknownReplyError("the license keys' fill tries");
  if (mark !== null) return true;
  const tried = triedRaw === null ? 0 : Number(triedRaw);
  // One more try, kept; the last one leaves the store on main's whole read for good, complete, and asked no more.
  const tryAgain = async (): Promise<boolean> => {
    const n = tried + 1;
    await fillWrite(store, fence, [n >= FILL_MAX_TRIES ? ["HSET", fillKey(store), "done", HOLDER_FILL_WHOLE, "tries", String(n)] : ["HSET", fillKey(store), "tries", String(n)]]);
    return n >= FILL_MAX_TRIES;
  };
  const place = typeof at === "string" ? /^([0-9a-f]{16}):(\d{1,6}):(\d{1,20})$/.exec(at) : null;
  if (at !== null && !place) throw new UnknownReplyError("the license keys' fill place");
  const ids = [...new Set(store.catalog.items.map((item) => item.id))].sort();
  const digest = catalogDigest(ids);
  // A place kept in another catalog would name another product (a product added or removed since): walk from the top.
  const same = place !== null && place[1] === digest;
  if (place !== null && !same && (await tryAgain())) return true;
  let index = same ? Number(place[2]) : 0;
  let cursor = same ? place[3] : "0";
  let used = place !== null && !same ? 1 + FILL_MARK_COMMANDS : 1;
  let steps = 0;
  try {
    while (index < ids.length && Date.now() < deadline && used + 1 + FILL_MARK_COMMANDS <= budget) {
      const product = { id: ids[index] };
      const page = repliesFor(await redisPipeline([["HSCAN", infoKey(store, product), cursor, "COUNT", FILL_PAGE]]), 1)?.[0];
      used += 1;
      if (!Array.isArray(page) || page.length !== 2 || typeof page[0] !== "string" || !/^\d{1,20}$/.test(page[0])) throw new UnknownReplyError("HSCAN of a product's license keys");
      const flat = stringList(page[1]);
      if (!flat || flat.length % 2 !== 0) throw new UnknownReplyError("HSCAN of a product's license keys");
      const byHolder = new Map<string, string[]>();
      for (let k = 0; k + 1 < flat.length; k += 2) {
        const info = readInfo(flat[k + 1]);
        // A sale with no address has nobody to list it under (settle writes no line for it either).
        if (!normaliseEmail(info.e)) continue;
        const holder = holderKey(store, info.e);
        byHolder.set(holder, [...(byHolder.get(holder) ?? []), holderField(product, flat[k])]);
      }
      const holders = [...byHolder.entries()];
      const fields = holders.reduce((n, [, f]) => n + f.length, 0);
      // The step's worst case: one HMGET a buyer, every line missing, and the place.
      const worst = fillStepCommandsMost(holders.length, fields);
      if (used + worst + FILL_MARK_COMMANDS > budget) {
        if (steps > 0) return false;
        // Not even one page fits in a whole run: this store keeps main's read for good (complete), and is not asked again.
        if (2 + worst + FILL_MARK_COMMANDS > budget) {
          await fillWrite(store, fence, [["HSET", fillKey(store), "done", HOLDER_FILL_WHOLE]]);
          return true;
        }
        return false;
      }
      if (holders.length) {
        const lines = repliesFor(await redisPipeline(holders.map(([holder, f]) => ["HMGET", holder, ...f])), holders.length);
        used += holders.length;
        if (!lines) throw new UnknownReplyError("the buyers' lists of license keys");
        const missing: [string, string, string, string][] = [];
        holders.forEach(([holder, f], i) => {
          const values = lines[i];
          if (!Array.isArray(values) || values.length !== f.length) throw new UnknownReplyError("HMGET of a buyer's list of license keys");
          f.forEach((field, k) => {
            if (values[k] === null) missing.push(["HSET", holder, field, "1"]);
            else if (values[k] !== "1") throw new UnknownReplyError("an entry of a buyer's list of license keys");
          });
        });
        if (missing.length) {
          await fillWrite(store, fence, missing);
          used += writeCommands(missing.length);
        }
      }
      cursor = page[0];
      if (cursor === "0") index += 1;
      await fillWrite(store, fence, [["HSET", fillKey(store), "at", `${digest}:${index}:${cursor}`]]);
      used += FILL_MARK_COMMANDS;
      steps += 1;
    }
  } catch (error) {
    // A reply in a shape no writer writes is persistent: counted, so it cannot hold the fill open for good. Anything
    // else (Redis not answering) is not counted and is tried again on the next run.
    if (!(error instanceof UnknownReplyError)) throw error;
    if (await tryAgain()) return true;
    throw error;
  }
  if (index < ids.length) return false;
  await fillWrite(store, fence, [["HSET", fillKey(store), "done", "1"]]);
  return true;
}

/**
 * The sweep's side of the fill (lib/checkout-sweep.ts): whether it still has to ask each store with keys (no company
 * mark yet); a round's start, the round left unfinished by a store, and the round's end, which sets the company mark only
 * when the round began clean here and no store was left unfinished. An unknown mark is "still on": asking costs a read,
 * stopping early could leave a store unfilled.
 */
export async function holderFillOn(): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const reply = repliesFor(await redisPipeline([["GET", HOLDER_FILL_ALL_DONE]]), 1);
  return !(reply && reply[0] === "1");
}
export async function startHolderFillRound(): Promise<void> {
  await redisPipeline([["SET", HOLDER_FILL_ROUND, "clean"]]);
}
export async function holderFillLeft(): Promise<void> {
  await redisPipeline([["SET", HOLDER_FILL_ROUND, "dirty"]]);
}
export async function endHolderFillRound(): Promise<void> {
  const reply = repliesFor(await redisPipeline([["GET", HOLDER_FILL_ROUND]]), 1);
  if (reply && reply[0] === "clean") await redisPipeline([["SET", HOLDER_FILL_ALL_DONE, "1"], ["DEL", HOLDER_FILL_ROUND]]);
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
