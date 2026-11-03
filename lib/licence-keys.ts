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
 *   nl:keys:<store>:<product>:dev:<h>  hash device fingerprint -> first activated (seconds), for the key whose hash is h (610 [WP9])
 *
 * <store> is the store's statsId, which follows it through a new address and
 * a new sign-in email.
 */
import { MAX_UPLOAD_KEYS, MAX_POOL_KEYS, MIN_KEY_LENGTH, MAX_KEY_LENGTH, KEY_ALPHABET, MAX_KEY_FILE_BYTES, sampleKey, type IssuedKey, type KeyCounts } from "@/lib/licence-key-rules";
export { MAX_UPLOAD_KEYS, MAX_POOL_KEYS, MIN_KEY_LENGTH, MAX_KEY_LENGTH, KEY_ALPHABET, MAX_KEY_FILE_BYTES, sampleKey, type IssuedKey, type KeyCounts } from "@/lib/licence-key-rules";
import { saleHandles } from "@/lib/store";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { orderWrite } from "@/lib/order-data";
import { giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { createHash } from "node:crypto";
import { CREATE_FORM_OPPORTUNITY as SET_IF_ROOM } from "@/lib/form-opportunity";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { SITE_URL } from "@/lib/site-url";
import type { Listing, Store } from "@/lib/store";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { refundedInFull } from "@/lib/refunds";
import { readListing, sellsAny } from "@/lib/catalog";
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

/** Keys go to Redis in batches this size, well under any request limit. */
const BATCH = 1_000;



type Info = { r: string; e: string; at: number; v?: number; w?: "refund" };

function parseInfo(key: string, raw: unknown): IssuedKey | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Info;
    const revokedAt = Number(value.v) || 0;
    return {
      key,
      reference: String(value.r ?? ""),
      email: String(value.e ?? ""),
      at: Number(value.at) || 0,
      revokedAt,
      revokedBy: revokedAt ? (value.w === "refund" ? "refund" : "creator") : "",
    };
  } catch {
    return null;
  }
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
  if (!store.statsId || !isRedisConfigured() || !reference) return null;
  const [key, waiting] = await redisPipeline([
    ["HGET", saleKey(store, product), reference],
    ["HEXISTS", waitingKey(store, product), reference],
  ]);
  if (typeof key === "string" && key) {
    const [raw] = await redisPipeline([["HGET", infoKey(store, product), key]]);
    const info = parseInfo(key, raw);
    return { state: "issued", key, revoked: Boolean(info?.revokedAt) };
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
  const known = await keyOfSale(store, product, reference);
  if (known?.state === "issued") return known;
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
  if (result.state === "issued" && result.key === popped) await warnIfLow(store, product);
  return result;
}

/**
 * Ties a key to a sale, unless the sale got one a moment ago from somewhere
 * else — then that one stands, and this key goes back where it came from.
 */
async function settle(store: Store, product: Listing, reference: string, email: string, key: string, fromPool: boolean): Promise<SaleKey> {
  // A key given to a sale is kept for good: counted in the store's room at what it adds (lib/order-data.ts).
  const [won] = await orderWrite(store, [["HSETNX", saleKey(store, product), reference, key]]);
  if (Number(won) !== 1) {
    await redisPipeline(fromPool ? [["LPUSH", poolKey(store, product), key]] : [["SREM", allKey(store, product), key]]);
    const again = await keyOfSale(store, product, reference);
    return again ?? { state: "waiting" };
  }
  const info: Info = { r: reference, e: email, at: Math.floor(Date.now() / 1000) };
  await orderWrite(store, [
    ["HSET", infoKey(store, product), key, JSON.stringify(info)],
    ["HDEL", waitingKey(store, product), reference],
  ]);
  return { state: "issued", key, revoked: false };
}



export async function keyCounts(store: Store, product: Listing): Promise<KeyCounts> {
  if (!store.statsId || !isRedisConfigured()) return { left: 0, issued: 0, revoked: 0, waiting: 0 };
  const [left, issued, waiting] = await redisPipeline([
    ["LLEN", poolKey(store, product)],
    ["HLEN", saleKey(store, product)],
    ["HLEN", waitingKey(store, product)],
  ]);
  const list = await issuedKeys(store, product, "", 0);
  return { left: Number(left) || 0, issued: Number(issued) || 0, revoked: list.revoked, waiting: Number(waiting) || 0 };
}

/** Whether a product that hands out keys from a pool has none left to give. */
export async function outOfKeys(store: Store, product: Listing): Promise<boolean> {
  if (activeKeys(product)?.source !== "pool" || !store.statsId || !isRedisConfigured()) return false;
  const [left] = await redisPipeline([["LLEN", poolKey(store, product)]]);
  return Number(left) === 0;
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
  const [length] = await redisPipeline([["LLEN", poolKey(store, product)]]);
  let room = Math.max(0, MAX_POOL_KEYS - (Number(length) || 0));
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
  const [raw] = await redisPipeline([["HGET", infoKey(store, product), key]]);
  if (typeof raw !== "string") return false;
  let info: Info;
  try {
    info = JSON.parse(raw) as Info;
  } catch {
    return false;
  }
  if (revoked && info.v) return true;
  const next: Info = {
    r: info.r,
    e: info.e,
    at: info.at,
    ...(revoked ? { v: Math.floor(Date.now() / 1000), ...(by === "refund" ? { w: "refund" as const } : {}) } : {}),
  };
  await orderWrite(store, [["HSET", infoKey(store, product), key, JSON.stringify(next)]]);
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
 * A partial refund changes nothing. Returns how many keys it revoked.
 */
const idOf = (value: unknown): string =>
  typeof value === "string"
    ? value
    : value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
      ? (value as { id: string }).id
      : "";

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
  let invoice = idOf(pi.invoice);
  if (!invoice) {
    const listed = await onAccount("GET", account, `/invoice_payments?${new URLSearchParams({ "payment[type]": "payment_intent", "payment[payment_intent]": intent, limit: "1" })}`);
    const row = (Array.isArray(listed.data) ? (listed.data as Record<string, unknown>[]) : [])[0];
    invoice = idOf(row?.invoice);
  }
  if (!/^in_[A-Za-z0-9]{8,255}$/.test(invoice)) return null;
  const read = await onAccount("GET", account, `/invoices/${encodeURIComponent(invoice)}`);
  const parent = read.parent as { subscription_details?: { subscription?: unknown } } | null | undefined;
  const subscription = idOf(read.subscription) || idOf(parent?.subscription_details?.subscription);
  if (!/^sub_[A-Za-z0-9]{8,255}$/.test(subscription)) return null;
  const sessions = await onAccount("GET", account, `/checkout/sessions?${new URLSearchParams({ subscription, limit: "1" })}`);
  const session = (Array.isArray(sessions.data) ? (sessions.data as Record<string, unknown>[]) : [])[0];
  if (!session || typeof session.id !== "string" || idOf(session.invoice) !== invoice) return null;
  const meta = (session.metadata ?? {}) as Record<string, string>;
  return meta.kind === "plan" ? { session: session.id, meta } : null;
}

export async function revokeRefunded(store: Store, deadline: number): Promise<number> {
  if (!storeHasKeys(store) || !isRedisConfigured()) return 0;
  const account = store.stripeAccountId as string;
  const now = Math.floor(Date.now() / 1000);
  const [anchorRaw] = await redisPipeline([["GET", refundAnchorKey(store)]]);
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
  const handles = saleHandles(store);

  for (let page = 0; page < REFUND_PAGES && Date.now() < deadline; page += 1) {
    const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
    query.append("expand[]", "data.charge");
    if (after) query.set("starting_after", after);
    const listed = await onAccount("GET", account, `/refunds?${query}`);
    const rows = Array.isArray(listed.data) ? (listed.data as Record<string, unknown>[]) : [];
    for (const refund of rows) {
      if (Date.now() >= deadline) break;
      const id = typeof refund.id === "string" ? refund.id : "";
      const created = typeof refund.created === "number" ? refund.created : 0;
      if (!id) continue;
      if (refund.status !== "succeeded" && refund.status !== "pending") continue;
      if (!refundedInFull(refund.charge)) continue;
      const [seen] = await redisPipeline([["SISMEMBER", refundSeenKey(store), id]]);
      if (Number(seen) === 1) {
        newest = Math.max(newest, created);
        continue;
      }
      const intent = typeof refund.payment_intent === "string" ? refund.payment_intent : "";
      if (!INTENT_PATTERN.test(intent) || lookups <= 0) continue;
      lookups -= 1;

      // Which sale that payment was: a checkout of this store, or an offer.
      const sales: { reference: string; products: string[] }[] = [];
      const sessions = await onAccount("GET", account, `/checkout/sessions?${new URLSearchParams({ payment_intent: intent, limit: "1" })}`);
      const session = (Array.isArray(sessions.data) ? (sessions.data as Record<string, unknown>[]) : [])[0];
      if (session && typeof session.id === "string") {
        const meta = (session.metadata ?? {}) as Record<string, string>;
        // The product, the one ticked, and every product of a bundle among them.
        if (handles.has(meta.store ?? "")) sales.push({ reference: session.id, products: deliveredIds(meta) });
      } else if (lookups > 0) {
        lookups -= 1;
        const pi = await onAccount("GET", account, `/payment_intents/${encodeURIComponent(intent)}`);
        const meta = (pi.metadata ?? {}) as Record<string, string>;
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

      for (const sale of sales) {
        for (const productId of sale.products) {
          const product = await readListing(store, productId);
          if (!product) continue;
          const [key] = await redisPipeline([["HGET", saleKey(store, product), sale.reference]]);
          if (typeof key === "string" && key && (await setRevoked(store, product, key, true, "refund"))) revoked += 1;
          // A buyer still waiting for a key from an empty pool is not given one.
          await redisPipeline([["HDEL", waitingKey(store, product), sale.reference]]);
        }
      }
      await redisPipeline([
        ["SADD", refundSeenKey(store), id],
        ["EXPIRE", refundSeenKey(store), REFUND_LOOKBACK_SECONDS + 86_400],
      ]);
      newest = Math.max(newest, created);
    }
    const last = rows[rows.length - 1];
    if (listed.has_more !== true || !last || typeof last.id !== "string") {
      complete = true;
      break;
    }
    after = last.id;
  }
  // Only moved forward past what was read to the end: a run cut short by
  // its deadline, its pages or its lookups starts from the same place next
  // time, and the refunds it already handled are skipped as read.
  if (complete && !unsure && lookups > 0 && Date.now() < deadline) {
    await redisPipeline([["SET", refundAnchorKey(store), String(Math.max(newest, anchor)), "EX", REFUND_LOOKBACK_SECONDS * 2]]);
  }
  return revoked;
}

export type KeyCheck = "valid" | "revoked" | "unknown";

// ---------------------------------------------------------------- devices (610 [WP9])

/** The longest device id the creator's software may send; anything longer is refused, never cut. */
export const MAX_DEVICE_ID = 200;
/** A device id: printable, no spaces, as an app's machine id or a random id it keeps. */
export const DEVICE_ID = /^[\x21-\x7e]{1,200}$/;

const keyHash = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 24);
const devKey = (store: Store, product: Pick<Listing, "id">, key: string) => `${base(store, product)}:dev:${keyHash(key)}`;
const devSlot = (product: Pick<Listing, "id">, key: string) => `lk:dev:${product.id}:${keyHash(key)}`;

/**
 * A one-way fingerprint of a device for one product: the id the creator's
 * software sent is never kept, and the same machine gives a different
 * fingerprint in another product or store.
 */
export function deviceFingerprint(store: Pick<Store, "statsId">, product: Pick<Listing, "id">, device: string): string {
  return createHash("sha256").update(`${store.statsId}|${product.id}|${device}`).digest("hex").slice(0, 32);
}

/** What `devices` activated devices of a key weigh in the store's data room: the record's name, then each fingerprint and its date. */
export function devicesBytes(count: number): number {
  // The record's name at its longest: "nl:keys:", the store's 32-character id, a product id of up to 40, ":dev:" and the key's 24-character hash.
  return count > 0 ? dataBytes(["x".repeat(8 + 32 + 1 + 40 + 5 + 24)]) + count * dataBytes(["0".repeat(32), "1700000000"]) : 0;
}

/** How many devices this key is activated on now. */
export async function devicesOf(store: Store, product: Listing, key: string): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const [length] = await redisPipeline([["HLEN", devKey(store, product, key)]]);
  return Number(length) || 0;
}

export type Activation =
  /** This device already had the key, or has it now; `used` of `limit` devices. */
  | { state: "active"; used: number; limit: number }
  /** Every place is taken by other devices. */
  | { state: "full"; used: number; limit: number };

/**
 * Activates a good key on one device, within the product's limit: the same
 * device asking again takes no new place. Checked and written in one Redis
 * operation, so two new devices at once cannot both take the last place;
 * the store's data room is taken for the new place first (DataRoomError when
 * it does not fit) and given back when no place was taken. The caller has
 * already found the key good (checkKey).
 */
export async function activateDevice(store: Store, product: Listing, key: string, device: string, limit: number, now = Date.now()): Promise<Activation> {
  const record = devKey(store, product, key);
  const fingerprint = deviceFingerprint(store, product, device);
  const [had, length] = await redisPipeline([["HEXISTS", record, fingerprint], ["HLEN", record]]);
  const used = Number(length) || 0;
  if (Number(had) === 1) return { state: "active", used, limit };
  if (used >= limit) return { state: "full", used, limit };
  const slot = devSlot(product, key);
  await needData(store, [{ slot, bytes: devicesBytes(used + 1), set: true }], now);
  const [reply] = await redisPipeline([["EVAL", SET_IF_ROOM, 1, record, fingerprint, String(Math.floor(now / 1000)), limit]]);
  const state = Array.isArray(reply) ? Number(reply[0]) : NaN;
  const after = await devicesOf(store, product, key);
  if (state !== 1) await giveData(store, [{ slot, bytes: devicesBytes(after), set: true }], now);
  if (state === 1 || state === 0) return { state: "active", used: after, limit };
  if (state === -1) return { state: "full", used: after, limit };
  throw new Error("a device could not be activated");
}

/** Frees every device a key is activated on (the creator, from the studio): its places open again. */
export async function freeDevices(store: Store, product: Listing, key: string, now = Date.now()): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const record = devKey(store, product, key);
  const [length] = await redisPipeline([["HLEN", record], ["DEL", record]]);
  await giveData(store, [{ slot: devSlot(product, key), bytes: 0, set: true }], now);
  return Number(length) || 0;
}

/** The devices of each of these keys, in one round trip, for the studio's list. */
export async function devicesOfKeys(store: Store, product: Listing, keys: string[]): Promise<number[]> {
  if (!store.statsId || !isRedisConfigured() || keys.length === 0) return keys.map(() => 0);
  const replies = await redisPipeline(keys.map((key) => ["HLEN", devKey(store, product, key)]));
  return keys.map((_, i) => Number(replies[i]) || 0);
}

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
  const [left] = await redisPipeline([["LLEN", poolKey(store, product)]]);
  const count = Number(left) || 0;
  if (count > setup.lowAt) return;
  const [claimed] = await redisPipeline([["SET", warnedKey(store, product), "1", "NX", "EX", 90 * 86_400]]);
  if (claimed === null) return;
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
    if (given?.state !== "issued") break;
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
