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
 * The number takes its room in the store's data room (the largest record it
 * can become, so the count moving never grows it) in the same step that
 * writes it (LOW_STOCK_SAVE), and turning it off gives that room back in the
 * same step that deletes it (LOW_STOCK_OFF): the number and its room stand or
 * fall together, whatever runs at the same time. Two separate steps could
 * leave a live number uncounted (Codex G on #3650) or, kept counted to avoid
 * that, a room held with no number until the store closed: by a save whose
 * write never came, an off that found no number, or a product deleted
 * (Codex X6 on #3650). Nothing here sends an email or a phone alert, reads
 * Stripe or shows a field: those are unit 5.
 */
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { MAX_LOW_STOCK, crossedLow, readLowStock } from "@/lib/stock-alert-rules";
import { MAX_STOCK } from "@/lib/product-extras";
import { type DataStore, TAKE_DATA, dataKey, dataTakenOf, monthOf, takeDataCommands } from "@/lib/store-data";
import { contentRoomFor, dataBytes } from "@/lib/store-data-rules";

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
 * The data room's own steps (lib/store-data.ts, TAKE_DATA) for one product's slot, set to `bytes`, inside a script
 * whose KEYS[1] is the store's room: `mode` "0" takes it (refused past the room), "2" gives it back (it only shrinks,
 * and never re-creates a room the store's erasure took away). The same pattern as lib/receipt-number.ts.
 */
const LOW_STOCK_ROOM = `local function lowStockRoom(limit, mode, month, slot, bytes)
  local KEYS = {KEYS[1]}
  local ARGV = {limit, mode, month, 's', slot, bytes}
${TAKE_DATA}
end`;

/**
 * KEYS: the store's room, its low-stock numbers. ARGV: the room's limit, the month, the product's slot, the bytes it
 * is set to, the product, the record. The slot is taken, then the record written, in one step: a full room writes
 * nothing, and a record is never written without its room, nor its room taken without the record (Codex X6 on #3650).
 * Answers TAKE_DATA's {1, total} written, {0, total} full or {-1, total} for what it cannot read (nothing written).
 * lib/redis-memory.ts runs the same; scripts/test_low_stock_redis.py runs it on a real Redis.
 */
export const LOW_STOCK_SAVE = `-- marktmorgen:low-stock-save:v1
${LOW_STOCK_ROOM}
if #KEYS ~= 2 or #ARGV ~= 6 then return {-1, 0} end
local taken = lowStockRoom(ARGV[1], '0', ARGV[2], ARGV[3], ARGV[4])
if taken[1] ~= 1 then return taken end
redis.call('HSET', KEYS[2], ARGV[5], ARGV[6])
return taken`;

/**
 * KEYS: the store's room, its low-stock numbers. ARGV: the month, the product's slot, the product. The record is
 * deleted and its slot given back in one step, also when there was no record (a slot left by a save whose answer was
 * lost, or a product deleted; Codex X6 on #3650), so a save running at the same time comes either before both or
 * after both (Codex G on #3650). Answers {records deleted, the room's answer}: 1 given back, -1 a room it could not
 * read, then left as it was, fuller, never emptier. {-1, -1} for arguments it cannot read (nothing done).
 * lib/redis-memory.ts runs the same; scripts/test_low_stock_redis.py runs it on a real Redis.
 */
export const LOW_STOCK_OFF = `-- marktmorgen:low-stock-off:v1
${LOW_STOCK_ROOM}
if #KEYS ~= 2 or #ARGV ~= 3 then return {-1, -1} end
local removed = redis.call('HDEL', KEYS[2], ARGV[3])
local given = lowStockRoom('0', '2', ARGV[1], ARGV[2], '0')
return {removed, given[1]}`;

/**
 * What LOW_STOCK_SAVE bills at the most, as Upstash bills a script (its EVAL and every redis.call inside it): TAKE_DATA
 * for one slot at its worst (takeDataCommands(1), whose EVAL is this script's) and the HSET. The same as the takeData
 * and the HSET it replaced (Claude 5 ibuF on #5409); priced in tests/plan-cost-registry.ts (LOW_STOCK_RUN).
 */
export const LOW_STOCK_SAVE_COMMANDS = takeDataCommands(1) + 1;

/**
 * What LOW_STOCK_OFF bills at the most: its EVAL, the HDEL and TAKE_DATA's give-back for one slot at its worst
 * (takeDataCommands(1), whose EVAL is this script's), so takeDataCommands(1) more than the plain HDEL it replaced
 * (Claude 5 ibuF on #5409); priced in tests/plan-cost-registry.ts (LOW_STOCK_RUN).
 */
export const LOW_STOCK_OFF_COMMANDS = takeDataCommands(1) + 1;

/**
 * Sets a product's low-stock number (0 or empty turns it off), kept with the
 * units left now (`left`, as lib/stock.ts reads them) as the count seen.
 */
export async function setLowStock(store: DataStore, productId: string, raw: unknown, left: unknown, now = Date.now()): Promise<LowStockSave> {
  const low = readLowStock(raw);
  if (low === null) return "invalid";
  const room = dataKey(store);
  if (!store.statsId || !productId || !room || !isRedisConfigured()) return "unknown";
  const key = keyOf(store.statsId);
  try {
    if (low === 0) {
      // The number goes and its room comes back in one step (LOW_STOCK_OFF): never a live number uncounted, never a
      // room held for a number that is gone.
      const reply = repliesFor(await redisPipeline([["EVAL", LOW_STOCK_OFF, 2, room, key, monthOf(now), slotOf(productId), productId]]), 1)?.[0];
      const pair = repliesFor(reply, 2);
      if (!pair || (pair[0] !== 0 && pair[0] !== 1) || (pair[1] !== 1 && pair[1] !== -1)) return "unknown";
      if (pair[1] === -1) console.error("a low-stock number's room could not be read; it stays counted, fuller, never emptier");
      // The low-stock job's turn goes with the number.
      if (store.sid) {
        const gone = countOf(repliesFor(await redisPipeline([["ZREM", LOW_STOCK_DUE, lowStockMember(store.sid, productId)]]), 1)?.[0]);
        if (gone === null) return "unknown";
      }
      return "off";
    }
    if (!isLeft(left) || !store.sid) return "unknown";
    // Its room taken and the number kept, in one step (LOW_STOCK_SAVE).
    const reply = repliesFor(
      await redisPipeline([["EVAL", LOW_STOCK_SAVE, 2, room, key, contentRoomFor(store, now / 1000), monthOf(now), slotOf(productId), bytesOf(productId), productId, JSON.stringify({ low, seen: left })]]),
      1,
    )?.[0];
    const taken = dataTakenOf(store, reply, now / 1000);
    if (!taken.ok) return taken.reason === "full" ? "full" : "unknown";
    // Then due for the job at once (a product already waiting keeps its turn).
    const due = countOf(repliesFor(await redisPipeline([["ZADD", LOW_STOCK_DUE, "NX", now, lowStockMember(store.sid, productId)]]), 1)?.[0]);
    return due === 0 || due === 1 ? "saved" : "unknown";
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
 * The low-stock record's key and field, and what the CAS of noteUnitsLeft wrote for these units left: for
 * lib/low-stock-alert.ts's give-back, which puts the count seen back in the same step as the day's mark (Codex X6
 * on #3725). Null when there is nowhere to write.
 */
export function unitsSeenRestore(store: DataStore, productId: string, left: number, before: LowStock): { key: string; field: string; wroteSha: string; before: string } | null {
  if (!store.statsId || !productId) return null;
  return { key: keyOf(store.statsId), field: productId, wroteSha: sha1(JSON.stringify({ low: before.low, seen: left })), before: JSON.stringify(before) };
}

/**
 * Whether these units left would cross the creator's number, read only:
 * nothing is written, so a crossing that cannot be said yet (the store's
 * daily bound, an unreadable count) is still there at the next check.
 */
export async function wouldCrossLow(store: DataStore, productId: string, left: unknown): Promise<LowStockCheck> {
  if (!isLeft(left) || !store.statsId || !productId || !isRedisConfigured()) return "unknown";
  try {
    const raw = await readRaw(store.statsId, productId);
    if (raw === null) return "off";
    const kept = parse(raw);
    if (!kept) return "unknown";
    if (kept.seen === left) return "no";
    const crossed = crossedLow(kept.seen, left, kept.low);
    return crossed === "unknown" ? "unknown" : crossed === "yes" ? "crossed" : "no";
  } catch (error) {
    console.error("reading a low-stock number failed", error);
    return "unknown";
  }
}

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
