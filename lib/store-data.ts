/**
 * A store's data room (lib/store-data-rules.ts says what it is and why):
 * the bytes it keeps in the database, counted where they are written.
 *
 *   nl:data:<store key>   hash: "#" -> bytes counted in all; "o" -> bytes its
 *                         orders left; <slot> -> bytes one record or one kind
 *                         of record is counted at
 *
 * A write names its slots and what each now weighs ("p:<product>" set to
 * 2,400) or how much it grew or shrank ("contacts" by +312). The script
 * below works out what that changes in all, and refuses a change that grows
 * the total past the room, before anything is written: the caller writes
 * only when it was taken. A change that shrinks or keeps the total is always
 * taken, so deleting never fails for want of room. An order's bytes are
 * added by the writes that leave them, at what each really adds
 * (lib/order-data.ts, slot "o"), never refused: their room is held up front
 * at the checkout (lib/order-admission.ts).
 *
 * What this errs toward. A record whose deletion is not given back stays
 * counted: the room looks fuller than it is, which costs the creator a
 * little room and never costs us storage nobody pays for. Unknown is
 * closed: when the room cannot be read or written, the write is refused
 * with a sentence saying to try again, the way a store figure is
 * (lib/store-allowance.ts).
 *
 * scripts/test_store_data_redis.py runs the script on a real Redis.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { StoreFullError } from "@/lib/store-full";
import { largerPlanFor } from "@/lib/larger-plan";
import { type DataFields, contentRoomFor, dataFullWords, dataRoomFor } from "@/lib/store-data-rules";

/** What a store is kept under, and what its room is measured by. */
export type DataStore = DataFields & { sid?: string; statsId?: string | null; handle?: string };

/**
 * One slot's change: its new weight (`set`), or what it grew or shrank by.
 * `until` (milliseconds) counts it in the slot of the month that time falls
 * in instead, for a record that expires by itself: the whole month's slot
 * comes off the room once the month is over, without anything deleting it.
 */
export type DataChange = { slot: string; bytes: number; set?: boolean } | { until: number; bytes: number };

export type DataTaken = { ok: true; used: number } | { ok: false; reason: "full" | "unknown"; used: number; room: number; message: string };

/**
 * KEYS[1] the store's room. ARGV[1] how far a change may grow it, ARGV[2]
 * "1" to take the change whatever it comes to, ARGV[3] this month
 * ("2026-10", UTC), then (mode, slot, bytes) three at a time: mode "s" sets
 * the slot to bytes, "a" adds bytes to it (never below zero). A slot named
 * "~2027-11" holds what expires by itself in that month, listed in "~"; every
 * call first takes the months that are over off the total. The room's own
 * field for each slot is counted in the total as well (64 bytes). Answers
 * {1, total} when taken, {0, total} when it would pass the room (nothing
 * written but the months taken off), {-1, total} for what it cannot read.
 */
export const TAKE_DATA = `-- marktmorgen:store-data:v1
local limit = tonumber(ARGV[1])
local always = ARGV[2] == '1'
local month = ARGV[3] or ''
if not limit or limit < 0 or not string.match(month, '^%d%d%d%d%-%d%d$') or (#ARGV - 3) % 3 ~= 0 then return {-1, 0} end
local total = tonumber(redis.call('HGET', KEYS[1], '#') or '0')
if not total then return {-1, 0} end
for i = 4, #ARGV, 3 do
  local mode = ARGV[i]
  local slot = ARGV[i + 1]
  local n = tonumber(ARGV[i + 2])
  if not n or n ~= n or n == math.huge or n == -math.huge or slot == '#' or slot == '~' or slot == '' or (mode ~= 's' and mode ~= 'a') then return {-1, total} end
  if string.sub(slot, 1, 1) == '~' then
    local m = string.sub(slot, 2)
    if mode ~= 'a' or not string.match(m, '^%d%d%d%d%-%d%d$') or m < month then return {-1, total} end
  end
end
local months = {}
local listed = redis.call('HGET', KEYS[1], '~') or ''
local relist = false
for m in string.gmatch(listed, '[^,]+') do
  if m < month then
    local held = tonumber(redis.call('HGET', KEYS[1], '~' .. m) or '0') or 0
    -- Its bytes and its own field.
    if held > 0 then total = total - held - 64 end
    redis.call('HDEL', KEYS[1], '~' .. m)
    relist = true
  else
    months[m] = true
  end
end
if total < 0 then total = 0 end
local function keep()
  if relist then
    local list = {}
    for m in pairs(months) do list[#list + 1] = m end
    table.sort(list)
    if #list > 0 then redis.call('HSET', KEYS[1], '~', table.concat(list, ',')) else redis.call('HDEL', KEYS[1], '~') end
  end
  redis.call('HSET', KEYS[1], '#', total)
end
local now = {}
local order = {}
local delta = 0
for i = 4, #ARGV, 3 do
  local mode = ARGV[i]
  local slot = ARGV[i + 1]
  local n = tonumber(ARGV[i + 2])
  if string.sub(slot, 1, 1) == '~' then
    local m = string.sub(slot, 2)
    if not months[m] then
      months[m] = true
      relist = true
    end
  end
  local old = now[slot]
  if old == nil then
    old = tonumber(redis.call('HGET', KEYS[1], slot) or '0') or 0
    order[#order + 1] = slot
  end
  local new = old + n
  if mode == 's' then new = n end
  if new < 0 then new = 0 end
  new = math.floor(new)
  now[slot] = new
  delta = delta + (new - old)
  -- The room's own field for a slot is counted too: 64 bytes while it is there.
  if old == 0 and new > 0 then delta = delta + 64 elseif old > 0 and new == 0 then delta = delta - 64 end
end
if delta > 0 and not always and total + delta > limit then
  keep()
  return {0, total}
end
for _, slot in ipairs(order) do
  if now[slot] > 0 then
    redis.call('HSET', KEYS[1], slot, now[slot])
  else
    redis.call('HDEL', KEYS[1], slot)
  end
end
total = total + delta
if total < 0 then total = 0 end
keep()
return {1, total}`;

/** "2026-10": the UTC month a time falls in, what TAKE_DATA's month slots are named by. */
export function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/**
 * The key a store's room is kept under: its id (or, for a store not yet
 * given one, its statistics id or address). Nothing here needs node:crypto,
 * so the files the studio's editors share with the server can count.
 */
export function dataKey(store: Pick<DataStore, "sid" | "statsId" | "handle">): string | null {
  const raw = (store.sid || store.statsId || store.handle || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return raw ? `nl:data:${raw}` : null;
}

function argsOf(changes: DataChange[], nowMs: number): (string | number)[] | null {
  const out: (string | number)[] = [];
  for (const change of changes) {
    if (!Number.isFinite(change.bytes)) return null;
    if ("until" in change) {
      // Never a month already over: what expires sooner is counted in this one.
      if (!Number.isFinite(change.until)) return null;
      out.push("a", `~${monthOf(Math.max(change.until, nowMs))}`, Math.ceil(change.bytes));
      continue;
    }
    if (typeof change.slot !== "string" || !change.slot || change.slot === "#" || change.slot.startsWith("~") || change.slot.length > 200) return null;
    out.push(change.set ? "s" : "a", change.slot, Math.ceil(change.bytes));
  }
  return out;
}

/**
 * What a script that ran TAKE_DATA answered ({state, total}), read as run
 * reads it: for a write that takes its room in the same script as itself
 * (lib/creator-card.ts, lib/path.ts).
 */
export function dataTakenOf(store: DataStore, reply: unknown, nowSeconds = Date.now() / 1000): DataTaken {
  const room = dataRoomFor(store, nowSeconds);
  // Read exactly (Codex G2, #1961): {state, total}, the state the number 0 (full) or 1 (taken) and the total a safe
  // whole number of bytes, 0 or more. Anything else (missing, null, text, negative, an extra item) is not a receipt.
  const exact = Array.isArray(reply) && reply.length === 2 && (reply[0] === 0 || reply[0] === 1) && typeof reply[1] === "number" && Number.isSafeInteger(reply[1]) && reply[1] >= 0;
  if (!exact) return { ok: false, reason: "unknown", used: 0, room, message: "This can't be saved right now. Try again in a minute." };
  const used = reply[1] as number;
  if (reply[0] === 1) return { ok: true, used };
  return { ok: false, reason: "full", used, room, message: dataFullWords(used, room, largerPlanFor(store, nowSeconds)) };
}

async function run(store: DataStore, changes: DataChange[], always: boolean, nowSeconds: number): Promise<DataTaken> {
  const room = dataRoomFor(store, nowSeconds);
  const unknown = (used = 0): DataTaken => ({ ok: false, reason: "unknown", used, room, message: "This can't be saved right now. Try again in a minute." });
  if (changes.length === 0) return { ok: true, used: 0 };
  const key = dataKey(store);
  const args = argsOf(changes, nowSeconds * 1000);
  if (!key || !args || !isRedisConfigured()) return unknown();
  try {
    const [reply] = await redisPipeline([["EVAL", TAKE_DATA, 1, key, contentRoomFor(store, nowSeconds), always ? "1" : "0", monthOf(nowSeconds * 1000), ...args]]);
    return dataTakenOf(store, reply, nowSeconds);
  } catch (error) {
    console.error("could not count a store's data", error);
    return unknown();
  }
}

/**
 * Thrown by needData when a write does not fit. A StoreFullError, so every
 * studio route that already answers a full store answers this too
 * ("store_full"); the buyers' routes turn it into their own sentence.
 */
export class DataRoomError extends StoreFullError {
  constructor(readonly taken: Extract<DataTaken, { ok: false }>) {
    super(taken.message);
    this.name = "DataRoomError";
  }
}

/**
 * Takes room for a write before it is made, all or nothing. A change that
 * does not grow what the store keeps is always taken.
 */
export function takeData(store: DataStore, changes: DataChange[], now = Date.now()): Promise<DataTaken> {
  return run(store, changes, false, now / 1000);
}

/** The same, throwing DataRoomError when it is not taken, for a write that has nothing to say but no. */
export async function needData(store: DataStore, changes: DataChange[], now = Date.now()): Promise<void> {
  const taken = await takeData(store, changes, now);
  if (taken.ok) return;
  // Full is said as full; a room that could not be read is an ordinary failure, to try again.
  if (taken.reason === "full") throw new DataRoomError(taken);
  throw new Error("the store's data room could not be counted");
}

/** One slot grown (or shrunk) by `bytes`, before it is written; throws DataRoomError when it is not taken. */
export function needDataBytes(store: DataStore, slot: string, bytes: number, now = Date.now()): Promise<void> {
  return needData(store, [{ slot, bytes }], now);
}

/** One slot grown by `bytes`, before it is written. */
export function takeDataBytes(store: DataStore, slot: string, bytes: number, now = Date.now()): Promise<DataTaken> {
  return takeData(store, [{ slot, bytes }], now);
}

/**
 * Room for a record that expires by itself `seconds` from now, taken before
 * it is written: true when it fits. For what is worth keeping only while
 * there is room (a cache, a mark that saves work): the caller writes nothing
 * when this answers false, and goes on without it.
 */
export async function keepFor(store: DataStore, bytes: number, seconds: number, now = Date.now()): Promise<boolean> {
  if (!Number.isFinite(seconds) || seconds < 0) return false;
  return (await takeData(store, [{ until: now + seconds * 1000, bytes }], now)).ok;
}

/**
 * Gives back what a deletion freed, or puts right what a write that was
 * taken and then failed took. Never refuses and never throws.
 */
export async function giveData(store: DataStore, changes: DataChange[], now = Date.now()): Promise<void> {
  // What expires by itself is never given back early: it comes off with its month.
  const shrinking = changes.flatMap((change) => ("until" in change ? [] : [change.set ? change : { ...change, bytes: -Math.abs(change.bytes) }]));
  await run(store, shrinking, true, now / 1000).catch(() => undefined);
}

/**
 * Counts what is already written, as it is, whatever it comes to: a record
 * moved, or kept before the room was counted. Never refuses and never throws.
 */
export async function noteData(store: DataStore, changes: DataChange[], now = Date.now()): Promise<void> {
  await run(store, changes, true, now / 1000).catch(() => undefined);
}

/**
 * Counts a record as noteData does, never refusing for room, but throws when
 * the count could not be made: for a write that goes ahead whatever the room
 * holds and must never be left uncounted (lib/pipeline-access.ts, a
 * teammate's restrictions moved with their sign-in).
 */
export async function forceData(store: DataStore, changes: DataChange[], now = Date.now()): Promise<void> {
  const counted = await run(store, changes, true, now / 1000);
  if (!counted.ok) throw new Error("the store's data room could not be counted");
}

/** One slot shrunk by `bytes`. Never refuses and never throws. */
export function giveDataBytes(store: DataStore, slot: string, bytes: number, now = Date.now()): Promise<void> {
  return giveData(store, [{ slot, bytes }], now);
}

/**
 * The room's field that holds what all the store's students' lesson notes
 * take of it, each note's slot with its own 64-byte field
 * (lib/lesson-notes.ts keeps it in the same step as each note's slot).
 */
export const NOTES_TOTAL_FIELD = "ln#";

/**
 * What a store keeps, in bytes, and the room it has, for the studio; null
 * when it cannot be read. With `notes`, the same read also gives what the
 * students' lesson notes take (NOTES_TOTAL_FIELD): null when that one count
 * cannot be read, never zero.
 */
export async function dataUsed(store: DataStore, now = Date.now(), ask: { notes?: boolean } = {}): Promise<{ used: number; orders: number; room: number; notes?: number | null } | null> {
  const key = dataKey(store);
  if (!key || !isRedisConfigured()) return null;
  const fields = ask.notes ? ["#", "o", NOTES_TOTAL_FIELD] : ["#", "o"];
  try {
    const replies = await redisPipeline([["HMGET", key, ...fields]]);
    if (replies.length !== 1) return null;
    const reply = replies[0];
    if (!Array.isArray(reply) || reply.length !== fields.length) return null;
    // HMGET returns a decimal string for a kept hash field and null for one
    // that is absent. Coercing another value would turn an unknown count into
    // zero (or a fraction) before callers set aside the work it pays for.
    const count = (value: unknown): number | null => {
      if (value === null) return 0;
      if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : null;
    };
    const used = count(reply[0]);
    const orders = count(reply[1]);
    if (used === null || orders === null) return null;
    const room = dataRoomFor(store, now / 1000);
    return ask.notes ? { used, orders, room, notes: count(reply[2]) } : { used, orders, room };
  } catch {
    return null;
  }
}
