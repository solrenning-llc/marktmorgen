/**
 * A receipt's number (601 [KB22], unit U2): each sale a store downloads a
 * receipt for is given the store's next number, "R-000001" upward, the first
 * time, and the same number every time after.
 *
 *   nl:rcpt:n:<sid>    hash: checkout reference (cs_…) -> its number
 *   nl:rcpt:seq:<sid>  the store's last number given
 *
 * Both are named by the store's own id, so each store counts on its own and
 * the closing walk erases both with the store (lib/data-families.ts,
 * CLOSING). What they keep is the only thing a receipt keeps: a Stripe
 * checkout reference and a whole number. The reference names a sale on the
 * creator's own Stripe account; it holds no name, address or email, and the
 * buyer's details stay on that account (the receipt reads them there each
 * time, lib/receipt-pdf.ts).
 *
 * One script (RECEIPT_NUMBER) reads the sale's number and, only for a sale
 * not yet numbered, takes its room from the store's data room
 * (lib/store-data.ts, TAKE_DATA, slot RECEIPT_SLOT), counts the next number
 * and writes it, all in one step: two downloads at once get the same number,
 * a re-download takes no room, and a full room writes nothing. A number is
 * never given twice and never reused. The count is in order but not promised
 * without gaps: a script Redis stops between its count and its write would
 * leave one number unused, and that number is then never given.
 *
 * Any reply that is not exactly one the script gives is unknown: no number
 * is guessed, and the route makes no PDF (503).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { DATA_EXPIRED_COMMANDS, type DataStore, TAKE_DATA, dataKey, dataTakenOf, monthOf } from "@/lib/store-data";
import { contentRoomFor, dataBytes } from "@/lib/store-data-rules";
import { RECEIPT_REFERENCE } from "@/lib/receipt-pdf";

/** The slot of the store's data room the numbers are counted in. */
export const RECEIPT_SLOT = "rcpt";
/** The largest number read back as one: far past any store's sales, so anything larger is not a number this wrote. */
export const RECEIPT_NUMBER_MAX = 999_999_999_999;
const LONGEST_NUMBER = String(RECEIPT_NUMBER_MAX);
/** The longest checkout reference (RECEIPT_REFERENCE): "cs_live_" and 200 characters. */
const LONGEST_REFERENCE = `cs_live_${"x".repeat(200)}`;
/**
 * What one sale's number takes from the room, at the most: its field (the
 * longest reference) and its number, as lib/store-data-rules.ts dataBytes
 * counts a field. The first number of a store takes RECEIPT_KEYS_BYTES more.
 */
export const RECEIPT_NUMBER_BYTES = dataBytes([LONGEST_REFERENCE, LONGEST_NUMBER], 1);
/** What the two keys themselves take, once, with the store's first number: their names and the count. */
export const RECEIPT_KEYS_BYTES = dataBytes([`nl:rcpt:n:${"x".repeat(32)}`, `nl:rcpt:seq:${"x".repeat(32)}`, LONGEST_NUMBER], 2);
/**
 * The database commands one numbering is billed, at the most (Upstash bills
 * a script's inner commands beside the EVAL): the EVAL, the read of the
 * sale's field, the count's GET, the room's steps (its total, its list of
 * expiring months, DATA_EXPIRED_COMMANDS for the months over it takes off
 * however long the store sat idle, the list written back, the slot read and
 * written, the total written), the INCR and the HSET, with one to spare: 10
 * with no month over and 13 with any number of them, measured with INFO
 * commandstats on a real Redis (review of #3001). Held inside
 * RECEIPT_PDF_UNITS studio requests by tests/kb22-receipt-number.test.ts.
 */
export const RECEIPT_NUMBER_COMMANDS = 12 + DATA_EXPIRED_COMMANDS;

const STORE_ID = /^[A-Za-z0-9_-]{6,80}$/;

export const receiptNumbersKey = (sid: string) => `nl:rcpt:n:${sid}`;
export const receiptCounterKey = (sid: string) => `nl:rcpt:seq:${sid}`;

/** How a number is written: "R-" and at least six digits. */
export function receiptNumberText(n: number): string {
  return `R-${String(n).padStart(6, "0")}`;
}

export type ReceiptNumbered =
  | { ok: true; number: string }
  | { ok: false; reason: "full"; message: string }
  | { ok: false; reason: "unknown" };

const UNKNOWN: ReceiptNumbered = { ok: false, reason: "unknown" };

/**
 * KEYS[1] the store's room, KEYS[2] its numbers, KEYS[3] its count. ARGV[1]
 * how far the room may grow, ARGV[2] this month, ARGV[3] the sale's
 * reference, ARGV[4] what a number takes, ARGV[5] what the keys take with
 * the first. Answers {2, n} for a number already given, {3, n} for one given
 * now, and the room's own {0, total} (full: nothing written) or {-1, total}
 * (unreadable). A count that is not a whole number below RECEIPT_NUMBER_MAX
 * (or of another type, which Redis refuses) is unreadable before any room is
 * taken, so no try spends room without a number (review of #3001, L1).
 * Modelled by lib/redis-memory.ts.
 */
export const RECEIPT_NUMBER = `-- marktmorgen:receipt-number:v1
local function receiptRoom(limit, month, size)
  local KEYS = {KEYS[1]}
  local ARGV = {limit, '0', month, 'a', '${RECEIPT_SLOT}', size}
${TAKE_DATA}
end
local held = redis.call('HGET', KEYS[2], ARGV[3])
if held then
  local n = tonumber(held)
  if not n or n < 1 or n ~= math.floor(n) then return {-1, 0} end
  return {2, n}
end
local size = tonumber(ARGV[4])
local keys = tonumber(ARGV[5])
if not size or not keys then return {-1, 0} end
-- The count is read before any room is taken: one INCR cannot add to, or that would pass RECEIPT_NUMBER_MAX, takes nothing.
local count = redis.call('GET', KEYS[3])
if not count then
  size = size + keys
elseif count ~= '0' and not (string.match(count, '^[1-9]%d*$') and #count <= 12 and tonumber(count) < 999999999999) then
  return {-1, 0}
end
local taken = receiptRoom(ARGV[1], ARGV[2], tostring(size))
if taken[1] ~= 1 then return taken end
local n = redis.call('INCR', KEYS[3])
redis.call('HSET', KEYS[2], ARGV[3], n)
return {3, n}`;

/** The script's reply, read exactly: anything else is unknown, never a number. */
export function receiptNumberFrom(store: DataStore, reply: unknown, nowSeconds = Date.now() / 1000): ReceiptNumbered {
  if (!Array.isArray(reply) || reply.length !== 2) return UNKNOWN;
  const [state, value] = reply;
  if (state === 2 || state === 3) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > RECEIPT_NUMBER_MAX) return UNKNOWN;
    return { ok: true, number: receiptNumberText(value) };
  }
  if (state === 0) {
    const taken = dataTakenOf(store, reply, nowSeconds);
    if (!taken.ok && taken.reason === "full") return { ok: false, reason: "full", message: taken.message };
  }
  return UNKNOWN;
}

/** The sale's number: read when it has one, given when not. Never throws. */
export async function assignReceiptNumber(store: DataStore & { sid: string }, reference: string, now = Date.now()): Promise<ReceiptNumbered> {
  if (!STORE_ID.test(store.sid) || !RECEIPT_REFERENCE.test(reference) || !isRedisConfigured()) return UNKNOWN;
  const room = dataKey(store);
  if (!room) return UNKNOWN;
  try {
    const replies: unknown = await redisPipeline([[
      "EVAL", RECEIPT_NUMBER, 3, room, receiptNumbersKey(store.sid), receiptCounterKey(store.sid),
      contentRoomFor(store, now / 1000), monthOf(now), reference, dataBytes([reference, LONGEST_NUMBER], 1), RECEIPT_KEYS_BYTES,
    ]]);
    if (!Array.isArray(replies) || replies.length !== 1) return UNKNOWN;
    return receiptNumberFrom(store, replies[0], now / 1000);
  } catch (error) {
    console.error("numbering a receipt failed", error);
    return UNKNOWN;
  }
}
