/**
 * The kept record of each order made to order: 761 [STN8], unit 2. The rules
 * are lib/made-to-order-rules.ts; this keeps one record a paid sale, reads a
 * store's queue, and gives a person's records to their copy and erasure.
 * Built and off: nothing calls keepMadeOrder yet (a made-to-order product
 * needs 518 [PF6] first), and nothing is shown to anyone.
 *
 *   nl:mto:i:<statsId>         sorted set: a member a sale (its reference
 *                              hashed), scored by when its record ends
 *   nl:mto:o:<statsId>:<sale>  string: the record, JSON, ending by itself
 *                              KEEP_SECONDS after the payment
 *
 * What it keeps about a person: never the address or a name, only the
 * store's one-way key of the address (lib/person-key.ts), so the person's
 * copy and erasure can find their orders, the sale's reference, the days
 * promised and the stages with their times.
 *
 * How it is bounded, before anything is written:
 *   - at most MAX_KEPT_ORDERS records a store at once (expired ones are
 *     taken out of the list first), checked and listed in one script
 *     (LIST_IF_ROOM), so keeps run at the same time never pass it, and a
 *     read of the queue, the copy or the erasure reads a known number of
 *     keys; a list found longer than that throws, never read as complete;
 *   - each record at most RECORD_MAX_BYTES, refused above it, and
 *     ROOM_BYTES counted in the store's data room (lib/store-data.ts) until
 *     the month its record ends, refused when the room is full;
 *   - the store's list is written before the record, so every record can be
 *     found by the copy and the erasure; the record is a mark taken with SET
 *     NX and read back (lib/claim-mark.ts), so the same sale is never kept
 *     twice and an answer in another shape is unknown, never kept.
 * Unknown is never fine (rule 24): a reply in any other shape answers
 * "unknown" or throws UnknownReplyError; a record that does not read is
 * counted as unreadable, never as absent.
 */
import { createHash } from "node:crypto";
import { claimMark } from "@/lib/claim-mark";
import { type MadeOrder, MAX_PRODUCTION_DAYS, parseMadeOrder } from "@/lib/made-to-order-rules";
import { personKey } from "@/lib/person-key";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { type DataStore, takeData } from "@/lib/store-data";

const DAY_SECONDS = 86_400;
/** How long a record is kept after the payment: the longest production time and 60 days after it, for the refund offer. */
export const KEEP_SECONDS = (MAX_PRODUCTION_DAYS + 60) * DAY_SECONDS;
/** The most records one store keeps at once. */
export const MAX_KEPT_ORDERS = 500;
/** The most bytes one record's value may weigh. */
export const RECORD_MAX_BYTES = 640;
/** What one record takes of the store's room: its value at the most, its key, its member in the list, and what Redis keeps beside each. */
export const ROOM_BYTES = 1_024;
/** Keys read at once by MGET. */
const READ_BATCH = 100;

/** A sale's reference: a checkout (cs_…) or a one-click payment (pi_…). */
const SALE = /^(?:cs|pi)_[A-Za-z0-9_]{8,250}$/;
const STATS_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Lists a record in its store's list only while the store has room, in one
 * step: ended records out first, then the cap. ARGV: now (seconds), the cap,
 * the record's end (its score), its id, the list's lifetime. Answers 1
 * listed, 2 already listed, 0 full, -1 when the key holds something else.
 */
export const LIST_IF_ROOM = `-- marktmorgen:mto-list-if-room:v1
local t=redis.call('TYPE',KEYS[1]).ok
if t~='none' and t~='zset' then return -1 end
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1])
if redis.call('ZSCORE',KEYS[1],ARGV[4]) then return 2 end
if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[2]) then return 0 end
redis.call('ZADD',KEYS[1],ARGV[3],ARGV[4])
redis.call('EXPIRE',KEYS[1],ARGV[5])
return 1
`;

const saleId = (sale: string) => createHash("sha256").update(`mto-sale:${sale}`).digest("hex").slice(0, 32);
const listKey = (statsId: string) => `nl:mto:i:${statsId}`;
const recordKey = (statsId: string, id: string) => `nl:mto:o:${statsId}:${id}`;

/** One kept record: the order and who it belongs to, as their one-way key. */
export type MadeRecord = { sale: string; person: string; order: MadeOrder };

function statsOf(store: DataStore): string | null {
  return typeof store.statsId === "string" && STATS_ID.test(store.statsId) ? store.statsId : null;
}

/** The record's value as written: the sale, the person's key, then the order. */
function valueOf(record: MadeRecord): string {
  return JSON.stringify({ sale: record.sale, person: record.person, paidAt: record.order.paidAt, days: record.order.days, steps: record.order.steps });
}

/** A kept value, whole or null. */
export function parseMadeRecord(raw: unknown): MadeRecord | null {
  if (typeof raw !== "string" || raw.length > RECORD_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { sale, person, ...rest } = value as Record<string, unknown>;
  if (typeof sale !== "string" || !SALE.test(sale) || typeof person !== "string" || !/^[0-9a-f]{32}$/.test(person)) return null;
  const order = parseMadeOrder(rest);
  return order ? { sale, person, order } : null;
}

export type KeepResult = "kept" | "already" | "full" | "invalid" | "unknown";

/**
 * Keeps a paid sale's order, once. "kept" when this call wrote it; "already"
 * when the sale's record was there (another run kept it); "full" when the
 * store keeps MAX_KEPT_ORDERS or its room is full; "invalid" for a sale, an
 * address or an order these rules refuse, or one whose record would already
 * have ended; "unknown" for any answer that does not read.
 */
export async function keepMadeOrder(store: DataStore, input: { sale: string; email: string; order: MadeOrder }, now = Date.now()): Promise<KeepResult> {
  const statsId = statsOf(store);
  const order = parseMadeOrder(input.order);
  if (!statsId || typeof input.sale !== "string" || !SALE.test(input.sale) || !order || order.steps.length !== 1) return "invalid";
  if (typeof input.email !== "string" || !input.email.includes("@")) return "invalid";
  const record: MadeRecord = { sale: input.sale, person: personKey(statsId, input.email), order };
  const value = valueOf(record);
  if (Buffer.byteLength(value, "utf8") > RECORD_MAX_BYTES) return "invalid";
  const nowSeconds = Math.floor(now / 1000);
  const endsAt = order.paidAt + KEEP_SECONDS;
  const seconds = endsAt - nowSeconds;
  if (seconds <= 0) return "invalid";
  if (!isRedisConfigured()) return "unknown";
  const id = saleId(input.sale);
  const list = listKey(statsId);
  let listed: boolean;
  try {
    const replies = repliesFor(await redisPipeline([["ZREMRANGEBYSCORE", list, "-inf", nowSeconds], ["ZCARD", list], ["ZSCORE", list, id]]), 3);
    const count = replies ? countOf(replies[1]) : null;
    if (!replies || countOf(replies[0]) === null || count === null || (replies[2] !== null && typeof replies[2] !== "string")) return "unknown";
    listed = replies[2] !== null;
    if (!listed && count >= MAX_KEPT_ORDERS) return "full";
  } catch {
    return "unknown";
  }
  if (!listed) {
    // The room first, until the month the record ends: nothing is written when it does not fit or cannot be read.
    const taken = await takeData(store, [{ until: endsAt * 1000, bytes: ROOM_BYTES }], now);
    if (!taken.ok) return taken.reason === "full" ? "full" : "unknown";
    // The store's list before the record, so every record written can be found by the copy and the erasure;
    // the cap checked again in the same step, so keeps at the same time never pass it. A place lost to
    // another keep leaves the room counted until that month ends: the safe direction, nothing is paid.
    try {
      const replies = repliesFor(await redisPipeline([["EVAL", LIST_IF_ROOM, 1, list, nowSeconds, MAX_KEPT_ORDERS, endsAt, id, KEEP_SECONDS]]), 1);
      const answer = replies ? replies[0] : null;
      if (answer === 0) return "full";
      if (answer !== 1 && answer !== 2) return "unknown";
    } catch {
      return "unknown";
    }
  }
  const claimed = await claimMark(recordKey(statsId, id), seconds, value);
  return claimed === "ours" ? "kept" : claimed === "taken" ? "already" : "unknown";
}

/**
 * The ids of a store's records not yet ended, at most MAX_KEPT_ORDERS; throws
 * on a reply that does not read and on a list longer than the cap, which is
 * never read as complete.
 */
async function listedIds(statsId: string, nowSeconds: number): Promise<string[]> {
  const replies = repliesFor(await redisPipeline([["ZRANGEBYSCORE", listKey(statsId), `(${nowSeconds}`, "+inf", "LIMIT", 0, MAX_KEPT_ORDERS + 1]]), 1);
  const ids = replies ? stringList(replies[0]) : null;
  if (!ids || ids.length > MAX_KEPT_ORDERS || !ids.every((id) => /^[0-9a-f]{32}$/.test(id))) throw new UnknownReplyError("listing a store's made-to-order records");
  return ids;
}

/** The records of these ids, in batches: a record gone by itself is absent; one that does not read is unreadable. */
async function recordsOf(statsId: string, ids: string[]): Promise<{ id: string; record: MadeRecord | null; absent: boolean }[]> {
  const out: { id: string; record: MadeRecord | null; absent: boolean }[] = [];
  for (let at = 0; at < ids.length; at += READ_BATCH) {
    const batch = ids.slice(at, at + READ_BATCH);
    const replies = repliesFor(await redisPipeline([["MGET", ...batch.map((id) => recordKey(statsId, id))]]), 1);
    const values = replies && Array.isArray(replies[0]) && replies[0].length === batch.length ? (replies[0] as unknown[]) : null;
    if (!values) throw new UnknownReplyError("reading a store's made-to-order records");
    batch.forEach((id, i) => out.push({ id, record: values[i] === null ? null : parseMadeRecord(values[i]), absent: values[i] === null }));
  }
  return out;
}

/**
 * A store's queue as kept: every record not yet ended, and how many listed
 * could not be read (never taken as absent). Null when the store has no id
 * or the database cannot be asked; throws on a reply that does not read.
 */
export async function readMadeOrders(store: DataStore, now = Date.now()): Promise<{ records: MadeRecord[]; unreadable: number } | null> {
  const statsId = statsOf(store);
  if (!statsId || !isRedisConfigured()) return null;
  const read = await recordsOf(statsId, await listedIds(statsId, Math.floor(now / 1000)));
  return { records: read.flatMap((r) => (r.record ? [r.record] : [])), unreadable: read.filter((r) => !r.record && !r.absent).length };
}

/**
 * A person's records, for the copy of their data (lib/person-copy.ts).
 * Throws when any record listed does not read: it could be theirs.
 */
export async function madeOrdersOf(store: DataStore, email: string, now = Date.now()): Promise<MadeRecord[]> {
  const statsId = statsOf(store);
  if (!statsId || !isRedisConfigured()) return [];
  const read = await recordsOf(statsId, await listedIds(statsId, Math.floor(now / 1000)));
  if (read.some((r) => !r.record && !r.absent)) throw new UnknownReplyError("reading a person's made-to-order records");
  const person = personKey(statsId, email);
  return read.flatMap((r) => (r.record && r.record.person === person ? [r.record] : []));
}

/**
 * Deletes a person's records and takes them out of the store's list
 * (lib/person-erasure.ts). Throws when a record listed does not read or a
 * delete does not answer as it should: the erasure is then not done, and a
 * retry finds everything. Answers how many records were deleted.
 */
export async function forgetMadeOrdersPerson(store: DataStore, email: string, now = Date.now()): Promise<number> {
  const statsId = statsOf(store);
  if (!statsId || !isRedisConfigured()) return 0;
  const read = await recordsOf(statsId, await listedIds(statsId, Math.floor(now / 1000)));
  if (read.some((r) => !r.record && !r.absent)) throw new UnknownReplyError("reading a person's made-to-order records");
  const person = personKey(statsId, email);
  const theirs = read.filter((r) => r.record?.person === person).map((r) => r.id);
  for (let at = 0; at < theirs.length; at += READ_BATCH) {
    const batch = theirs.slice(at, at + READ_BATCH);
    const replies = repliesFor(await redisPipeline([["DEL", ...batch.map((id) => recordKey(statsId, id))], ["ZREM", listKey(statsId), ...batch]]), 2);
    const deleted = replies ? countOf(replies[0]) : null;
    const removed = replies ? countOf(replies[1]) : null;
    if (deleted === null || removed === null || deleted > batch.length || removed > batch.length) throw new UnknownReplyError("deleting a person's made-to-order records");
  }
  return theirs.length;
}
