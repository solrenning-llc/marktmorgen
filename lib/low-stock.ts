/**
 * The creator's low-stock number, kept (623 [SZ7], unit 4, 11 November 2026;
 * the rules are in lib/stock-alert-rules.ts, readLowStock and crossedLow).
 *
 *   nl:ls:<store>   hash   product → {"low": n, "seen": units left last seen}
 *
 * <store> is the store's statsId. The creator picks a number of units for a
 * limited product and is told once each time the count falls to it, so they
 * can restock before selling out. The count last seen is kept beside the
 * number: a fall from above it to it or under it is a crossing, said once,
 * and said again only after a restock above it. Set below the count the
 * product is already at, it waits for the next fall from above.
 *
 * Rule 24: a number, a count, a record or a reply that cannot be read never
 * says "crossed" and never writes. The count seen moves only by a compare and
 * set on the record exactly as it was read, so two checks of the same fall at
 * once say it once; the one that lost says "unknown", never "crossed".
 *
 * The number takes its room in the store's data room before it is written
 * (the largest record it can become, so the count moving never grows it), and
 * gives it back when it is turned off. Nothing here sends an email or a phone
 * alert, reads Stripe or shows a field: those are unit 5.
 */
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { MAX_LOW_STOCK, crossedLow, readLowStock } from "@/lib/stock-alert-rules";
import { MAX_STOCK } from "@/lib/product-extras";
import { type DataStore, giveData, takeData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";

export type LowStock = { low: number; seen: number | null };

const keyOf = (statsId: string) => `nl:ls:${statsId}`;
/**
 * The products the low-stock job checks (lib/low-stock-alert.ts,
 * runLowStockChecks), scored by when each is due: "storeId|productId". One
 * enters when its number is set and leaves when it is turned off.
 */
export const LOW_STOCK_DUE = "nl:ls:due";
export const lowStockMember = (storeId: string, productId: string) => `${storeId}|${productId}`;
const slotOf = (productId: string) => `ls:${productId}`;
const sha1 = (value: string) => createHash("sha1").update(value).digest("hex");

/** The longest record one product can hold. */
const LONGEST = JSON.stringify({ low: MAX_LOW_STOCK, seen: MAX_STOCK });
/** The least room one product's number takes: the longest record, before its product id. */
export const LOW_STOCK_BYTES = dataBytes([LONGEST], 1);
const bytesOf = (productId: string) => dataBytes([productId, LONGEST], 1);

/** Units left as lib/stock.ts gives them: a whole count up to MAX_STOCK, or null for a product that is not limited. */
function isLeft(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_STOCK);
}

function parse(raw: string): LowStock | null {
  if (raw.length > LONGEST.length) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (keys.length !== 2 || !keys.includes("low") || !keys.includes("seen")) return null;
    const { low, seen } = value;
    if (typeof low !== "number" || readLowStock(low) !== low || low === 0 || !isLeft(seen)) return null;
    return { low, seen };
  } catch {
    return null;
  }
}

/** The record's text exactly as kept: a string, null for none; throws when the reply is anything else. */
async function readRaw(statsId: string, productId: string): Promise<string | null> {
  const replies = repliesFor(await redisPipeline([["HGET", keyOf(statsId), productId]]), 1);
  if (!replies || (replies[0] !== null && typeof replies[0] !== "string")) throw new UnknownReplyError("a low-stock number");
  return replies[0] as string | null;
}

/** A product's low-stock number and the count last seen; null when none is set. Throws when it cannot be read. */
export async function lowStockOf(store: DataStore, productId: string): Promise<LowStock | null> {
  if (!store.statsId || !isRedisConfigured()) throw new UnknownReplyError("a low-stock number");
  const raw = await readRaw(store.statsId, productId);
  if (raw === null) return null;
  const parsed = parse(raw);
  if (!parsed) throw new UnknownReplyError("a low-stock number");
  return parsed;
}

/**
 * A sale's hold changed these products' units left: each that has a number
 * (already on LOW_STOCK_DUE, ZADD XX) is due for the job at once; one
 * without a number is never added. One command a product, in one round
 * trip, inside the cart's stock commands (tests/cart-stock.test.ts). Its
 * failure is only a later check: the job still checks every product a day.
 */
export async function lowStockTouched(store: { sid?: string }, productIds: string[]): Promise<void> {
  if (!store.sid || !productIds.length || !isRedisConfigured()) return;
  const now = Date.now();
  await redisPipeline(productIds.map((id) => ["ZADD", LOW_STOCK_DUE, "XX", now, lowStockMember(store.sid!, id)])).catch(() => {});
}

export type LowStockSave = "saved" | "off" | "invalid" | "full" | "unknown";

/**
 * Sets a product's low-stock number (0 or empty turns it off), kept with the
 * units left now (`left`, as lib/stock.ts reads them) as the count seen.
 */
export async function setLowStock(store: DataStore, productId: string, raw: unknown, left: unknown, now = Date.now()): Promise<LowStockSave> {
  const low = readLowStock(raw);
  if (low === null) return "invalid";
  if (!store.statsId || !productId || !isRedisConfigured()) return "unknown";
  const key = keyOf(store.statsId);
  try {
    if (low === 0) {
      const removed = countOf(repliesFor(await redisPipeline([["HDEL", key, productId]]), 1)?.[0]);
      if (removed === null || removed > 1) return "unknown";
      if (removed === 1) await giveData(store, [{ slot: slotOf(productId), bytes: 0, set: true }], now);
      if (store.sid) {
        const left = countOf(repliesFor(await redisPipeline([["ZREM", LOW_STOCK_DUE, lowStockMember(store.sid, productId)]]), 1)?.[0]);
        if (left === null) return "unknown";
      }
      return "off";
    }
    if (!isLeft(left) || !store.sid) return "unknown";
    const taken = await takeData(store, [{ slot: slotOf(productId), bytes: bytesOf(productId), set: true }], now);
    if (!taken.ok) return taken.reason === "full" ? "full" : "unknown";
    // Kept, then due for the job at once (a product already waiting keeps its turn).
    const replies = repliesFor(await redisPipeline([["HSET", key, productId, JSON.stringify({ low, seen: left })], ["ZADD", LOW_STOCK_DUE, "NX", now, lowStockMember(store.sid, productId)]]), 2);
    const written = countOf(replies?.[0]);
    const due = countOf(replies?.[1]);
    return (written === 0 || written === 1) && (due === 0 || due === 1) ? "saved" : "unknown";
  } catch (error) {
    console.error("saving a low-stock number failed", error);
    return "unknown";
  }
}

/**
 * Sets the field only if it still holds what was read (by its SHA-1); one step
 * on the Redis side. The same script, line for line, as lib/contacts.ts
 * CAS_HSET, so the tests' Redis (lib/redis-memory.ts) runs the same check.
 */
const CAS_HSET = [
  "-- marktmorgen:contact-cas-hset:v1",
  "local out = {}",
  "for i = 1, #ARGV, 3 do",
  '  local cur = redis.call("HGET", KEYS[1], ARGV[i])',
  '  local seen = ""',
  "  if cur then seen = redis.sha1hex(cur) end",
  "  if seen == ARGV[i + 1] then",
  '    redis.call("HSET", KEYS[1], ARGV[i], ARGV[i + 2])',
  "    out[#out + 1] = 1",
  "  else",
  "    out[#out + 1] = 0",
  "  end",
  "end",
  "return out",
].join("\n");

export type LowStockCheck = "crossed" | "no" | "off" | "unknown";

/**
 * The units left of a product now (`left`, as lib/stock.ts reads them):
 * "crossed" once when they fell from above the creator's number to it or
 * under it, "no" otherwise, "off" when no number is set. The count seen moves
 * with every change; "unknown" when anything could not be read or another
 * check moved it first, and then nothing is said.
 */
export async function noteUnitsLeft(store: DataStore, productId: string, left: unknown): Promise<LowStockCheck> {
  if (!isLeft(left) || !store.statsId || !productId || !isRedisConfigured()) return "unknown";
  const key = keyOf(store.statsId);
  try {
    const raw = await readRaw(store.statsId, productId);
    if (raw === null) return "off";
    const kept = parse(raw);
    if (!kept) return "unknown";
    if (kept.seen === left) return "no";
    const crossed = crossedLow(kept.seen, left, kept.low);
    if (crossed === "unknown") return "unknown";
    const [result] = repliesFor(await redisPipeline([["EVAL", CAS_HSET, 1, key, productId, sha1(raw), JSON.stringify({ low: kept.low, seen: left })]]), 1) ?? [];
    const each = repliesFor(result, 1);
    if (!each || each[0] !== 1) return "unknown";
    return crossed === "yes" ? "crossed" : "no";
  } catch (error) {
    console.error("checking a low-stock number failed", error);
    return "unknown";
  }
}
