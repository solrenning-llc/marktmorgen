/**
 * What an order really keeps in the database, counted as it is written
 * (added 18 October 2026, after lib/store-data.ts).
 *
 * Until this day every order counted took a fixed ORDER_DATA_BYTES and
 * ITEM_DATA_BYTES for each product it handed over from its store's data
 * room, for good: the most every record an order could ever leave weighs,
 * whether it left them or not. A Store's room then held about 2,000
 * one-product orders, after which new checkouts paused. But most orders
 * write a small part of that: a buyer's contact and their library entry,
 * a course's place in their record, and, for a buyer who has bought before,
 * almost nothing new at all.
 *
 * So the records an order leaves are written here, and each write is
 * charged what it really adds, measured by Redis itself in the same script
 * that makes it: a new key its name and ORDER_KEY_BYTES, a new field, member
 * or list item its name, its value and ORDER_ENTRY_BYTES (a board's member
 * ORDER_BOARD_ENTRY_BYTES and its score), a value made longer what it grew
 * by, and a quarter more of all that for what Redis's allocator rounds each
 * piece up to, rounded up to DATA_STEP_BYTES. Nothing is refused here (a
 * buyer who paid gets everything); the room for it was held at the checkout,
 * at the most an order can take (lib/order-admission.ts, orderDataBytes),
 * and what the order did not use is let go when the checkout settles.
 *
 * What this errs toward. A value written shorter, a field deleted, a key
 * that expires: none is given back here, so the room looks fuller than it
 * is, never emptier. scripts/test_order_data_redis.py runs the script on a
 * real Redis and holds the charges at or above what Redis itself says it
 * keeps for them (MEMORY USAGE, every sample), at every step, through every
 * change of encoding a hash, a set or a board goes through as it grows. The
 * script is written out whole, its sizes as numbers, so that test can run it
 * as it is; tests/order-data.test.ts holds them to the constants below.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, listSlots, repliesFor } from "@/lib/redis-reply";
import { type DataStore, dataKey, giveData } from "@/lib/store-data";
import { DATA_STEP_BYTES } from "@/lib/store-data-rules";

/** Who an order's records are counted for: the store's ids, as its room is named (lib/store-data.ts, dataKey). */
export type DataOwner = Pick<DataStore, "sid" | "statsId" | "handle">;

type Command = (string | number)[];

/** What a new key is charged beside its name: Redis's record of the key, its entry in the keyspace and in the expiries. */
export const ORDER_KEY_BYTES = 96;
/** What a new field, member or list item is charged beside its bytes: its entry and its share of the table it is in. */
export const ORDER_ENTRY_BYTES = 64;
/** What a new member of a board (a sorted set) is charged beside its bytes and its 8-byte score: its entry in the table and in the list kept in order. */
export const ORDER_BOARD_ENTRY_BYTES = 128;

/** The commands an order's records are written with; anything else is refused before it is sent. */
export const ORDER_COMMANDS = ["SET", "HSET", "HSETNX", "HINCRBY", "SADD", "ZADD", "ZINCRBY", "RPUSH", "LPUSH", "INCR", "INCRBY", "DECR", "DECRBY", "EXPIRE", "PEXPIRE", "EXPIREAT", "PEXPIREAT", "DEL", "HDEL", "SREM", "ZREM"] as const;
const ALLOWED = new Set<string>(ORDER_COMMANDS);

/** The most commands one script carries; a longer write is sent as several. */
export const ORDER_WRITE_MAX = 48;

/** What an error inside the script is answered as, so one command's failure is not taken for a reply. */
export const ORDER_WRITE_ERROR = "\u0000order-write-error:";

/**
 * KEYS[1] the store's room (lib/store-data.ts), then every key the commands
 * write. ARGV[1] how many commands, then each as its name, the index of its
 * key in KEYS, how many arguments follow the key, and those arguments.
 * Measures what each command adds, runs it, adds what it all came to to the
 * room's slot "o" (and to "#", with the slot's own 64 bytes the first time),
 * and answers {charged, reply...}. A malformed call answers {-1} and writes
 * nothing; a command Redis refuses is answered by ORDER_WRITE_ERROR and the
 * rest still run, the way a pipeline does.
 */
export const ORDER_WRITE = `-- marktmorgen:order-write:v1
local KEY = 96
local ENTRY = 64
local ZENTRY = 128
local STEP = 16
local allowed = {SET=1, HSET=1, HSETNX=1, HINCRBY=1, SADD=1, ZADD=1, ZINCRBY=1, RPUSH=1, LPUSH=1, INCR=1, INCRBY=1, DECR=1, DECRBY=1, EXPIRE=1, PEXPIRE=1, EXPIREAT=1, PEXPIREAT=1, DEL=1, HDEL=1, SREM=1, ZREM=1}
local n = tonumber(ARGV[1])
if not n or n < 1 or n > 48 then return {-1} end
local plan = {}
local i = 2
for c = 1, n do
  local name = ARGV[i]
  local k = tonumber(ARGV[i + 1])
  local argc = tonumber(ARGV[i + 2])
  if not name or not allowed[name] or not k or k < 2 or not KEYS[k] or not argc or argc < 0 or i + 2 + argc > #ARGV then return {-1} end
  local args = {}
  for j = 1, argc do args[j] = ARGV[i + 2 + j] end
  plan[c] = {name, KEYS[k], args}
  i = i + 3 + argc
end
if i ~= #ARGV + 1 then return {-1} end
local existed = {}
local function kind(key) return redis.call('TYPE', key)['ok'] end
local function slen(key) if kind(key) == 'string' then return redis.call('STRLEN', key) end return 0 end
local grown = 0
local replies = {}
for c = 1, n do
  local name, key, args = plan[c][1], plan[c][2], plan[c][3]
  if existed[key] == nil then existed[key] = redis.call('EXISTS', key) == 1 end
  local t = kind(key)
  local before = {}
  if name == 'SET' or name == 'INCR' or name == 'INCRBY' or name == 'DECR' or name == 'DECRBY' then
    before[1] = slen(key)
  elseif (name == 'HSET' or name == 'HSETNX') and (t == 'hash' or t == 'none') then
    for j = 1, #args - 1, 2 do
      local f = args[j]
      if before[f] == nil then
        if t == 'hash' and redis.call('HEXISTS', key, f) == 1 then before[f] = redis.call('HSTRLEN', key, f) else before[f] = false end
      end
    end
  elseif name == 'HINCRBY' and (t == 'hash' or t == 'none') then
    local f = args[1]
    if t == 'hash' and f and redis.call('HEXISTS', key, f) == 1 then before[f] = redis.call('HSTRLEN', key, f) elseif f then before[f] = false end
  elseif name == 'SADD' and (t == 'set' or t == 'none') then
    for j = 1, #args do
      local m = args[j]
      if before[m] == nil then before[m] = t == 'set' and redis.call('SISMEMBER', key, m) == 1 end
    end
  elseif (name == 'ZADD' or name == 'ZINCRBY') and (t == 'zset' or t == 'none') then
    local members = {}
    if name == 'ZINCRBY' then members[1] = args[2] else
      local j = 1
      while args[j] and string.match(string.upper(args[j]), '^[A-Z]+$') do j = j + 1 end
      while args[j + 1] do members[#members + 1] = args[j + 1]; j = j + 2 end
    end
    for _, m in ipairs(members) do
      if m and before[m] == nil then before[m] = t == 'zset' and redis.call('ZSCORE', key, m) ~= false end
    end
  end
  local ok, reply = pcall(redis.call, name, key, unpack(args))
  if ok then
    if reply == nil then reply = false end
    replies[c] = reply
    if name == 'SET' or name == 'INCR' or name == 'INCRBY' or name == 'DECR' or name == 'DECRBY' then
      local after = slen(key)
      if after > before[1] then grown = grown + (after - before[1]) end
    elseif name == 'HSET' or name == 'HSETNX' or name == 'HINCRBY' then
      for f, old in pairs(before) do
        if redis.call('HEXISTS', key, f) == 1 then
          local now = redis.call('HSTRLEN', key, f)
          if old == false then grown = grown + #f + now + ENTRY elseif now > old then grown = grown + (now - old) end
        end
      end
    elseif name == 'SADD' or name == 'ZADD' or name == 'ZINCRBY' then
      for m, was in pairs(before) do
        if not was then
          local there = false
          if name == 'SADD' then there = redis.call('SISMEMBER', key, m) == 1 else there = redis.call('ZSCORE', key, m) ~= false end
          if there then
            if name == 'SADD' then grown = grown + #m + ENTRY else grown = grown + #m + 8 + ZENTRY end
          end
        end
      end
    elseif name == 'RPUSH' or name == 'LPUSH' then
      for j = 1, #args do grown = grown + #args[j] + ENTRY end
    end
  else
    replies[c] = string.char(0) .. 'order-write-error:' .. tostring(reply['err'] or reply)
  end
end
for key, was in pairs(existed) do
  if not was and redis.call('EXISTS', key) == 1 then grown = grown + #key + KEY end
end
-- A quarter more for what Redis's allocator rounds each piece up to.
local charged = math.ceil(grown * 5 / 4 / STEP) * STEP
if charged > 0 then
  local room = KEYS[1]
  local old = tonumber(redis.call('HGET', room, 'o') or '0') or 0
  local total = tonumber(redis.call('HGET', room, '#') or '0') or 0
  local add = charged
  if old <= 0 then add = add + 64 end
  redis.call('HSET', room, 'o', math.max(old, 0) + charged, '#', math.max(total, 0) + add)
end
local out = {charged}
for c = 1, n do out[c + 1] = replies[c] end
return out`;

/** The commands ORDER_WRITE_IF_NEW carries: hash writes only, the first an HSETNX. */
export const ORDER_IF_NEW_COMMANDS = ["HSETNX", "HSET", "HDEL"] as const;

/** What ORDER_WRITE_IF_NEW answers when its first HSETNX's field was already there: nothing written, nothing charged. */
export const ORDER_IF_NEW_TAKEN = -2;

/**
 * ORDER_WRITE, unchanged below its first line, run only when its first command, an HSETNX, would set its field, so
 * the records that go with that field are written with it or not at all (lib/licence-keys.ts settle, 11 November
 * 2026: the sale's key line and the key's record had been two writes, and a process that stopped between them left
 * a key that no check could ever find). Before anything is written it holds the call to hash writes only, each
 * well formed, on keys that are hashes or not there, the room included, so no command can fail halfway; then, if
 * the HSETNX's field is already there, it answers {-2} and writes nothing. Otherwise ORDER_WRITE runs as it always
 * does, measured and charged the same way, in the same script.
 */
export const ORDER_IF_NEW_GUARD = `-- marktmorgen:order-write-if-new:v1
do
  local n = tonumber(ARGV[1])
  if not n or n < 1 or n > 48 or ARGV[2] ~= 'HSETNX' or ARGV[4] ~= '2' then return {-1} end
  local room = redis.call('TYPE', KEYS[1])['ok']
  if room ~= 'hash' and room ~= 'none' then return {-1} end
  local i = 2
  for c = 1, n do
    local name, k, argc = ARGV[i], tonumber(ARGV[i + 1]), tonumber(ARGV[i + 2])
    if not k or k < 2 or not KEYS[k] or not argc or i + 2 + argc > #ARGV then return {-1} end
    if not ((name == 'HSETNX' and argc == 2) or (name == 'HSET' and argc >= 2 and argc % 2 == 0) or (name == 'HDEL' and argc >= 1)) then return {-1} end
    local t = redis.call('TYPE', KEYS[k])['ok']
    if t ~= 'hash' and t ~= 'none' then return {-1} end
    i = i + 3 + argc
  end
  if i ~= #ARGV + 1 then return {-1} end
  if redis.call('HEXISTS', KEYS[tonumber(ARGV[3])], ARGV[5]) == 1 then return {-2} end
end`;

/** The guard, then ORDER_WRITE below its first line: written out whole so scripts/test_order_data_redis.py can put it together the same way. */
export const ORDER_WRITE_IF_NEW = `${ORDER_IF_NEW_GUARD}\n${ORDER_WRITE.slice(ORDER_WRITE.indexOf("\n") + 1)}`;

/** Whether a command is one an order's records may be written with, and names its key. */
function checked(command: Command): string | null {
  const [name, key] = command;
  return typeof name === "string" && ALLOWED.has(name) && typeof key === "string" && key.length > 0 && key.length <= 512 ? key : null;
}

/** One script's worth: its keys and arguments (ORDER_WRITE, or ORDER_WRITE_IF_NEW, which reads them the same way). */
function scriptOf(room: string, commands: Command[], script: string = ORDER_WRITE): (string | number)[] {
  const keys = [room];
  const index = new Map<string, number>();
  const argv: (string | number)[] = [commands.length];
  for (const command of commands) {
    const key = String(command[1]);
    let at = index.get(key);
    if (at === undefined) {
      keys.push(key);
      at = keys.length;
      index.set(key, at);
    }
    argv.push(String(command[0]), at, command.length - 2, ...command.slice(2).map(String));
  }
  return ["EVAL", script, keys.length, ...keys, ...argv];
}

/** Whether a reply is a whole count from `low` to `high` (inclusive). */
const between = (reply: unknown, low: number, high: number): boolean => typeof reply === "number" && Number.isSafeInteger(reply) && reply >= low && reply <= high;

/**
 * Whether one command's reply is in the exact shape and range that command answers when it ran (Codex G on #2719,
 * twice): "OK" for SET (or nothing only when it was asked NX or XX); a number for ZINCRBY and ZADD INCR; any whole
 * number for the counters, whose negatives are real; and for the rest, a whole count no larger than what the command
 * could have changed: a one-field HSET answers 0 or 1, never -1 or 2. Anything else, a null or a missing reply
 * included, is not a write that landed.
 */
function replyFits(command: Command, reply: unknown): boolean {
  const name = String(command[0]).toUpperCase();
  const args = command.slice(2).map((a) => String(a).toUpperCase());
  const count = typeof reply === "number" && Number.isSafeInteger(reply);
  const numeric = count || (typeof reply === "string" && reply.trim() !== "" && Number.isFinite(Number(reply)));
  switch (name) {
    case "SET":
      return reply === "OK" || (args.slice(1).some((a) => a === "NX" || a === "XX") && (reply === null || reply === false));
    case "ZINCRBY":
      return numeric;
    case "ZADD": {
      if (args.includes("INCR")) return numeric || reply === null;
      const flags = args.filter((a) => ["NX", "XX", "GT", "LT", "CH"].includes(a)).length;
      return between(reply, 0, Math.floor((args.length - flags) / 2));
    }
    case "INCR":
    case "INCRBY":
    case "DECR":
    case "DECRBY":
    case "HINCRBY":
      return count;
    case "HSET":
      return between(reply, 0, Math.floor(args.length / 2));
    case "HSETNX":
    case "EXPIRE":
    case "PEXPIRE":
    case "EXPIREAT":
    case "PEXPIREAT":
      return between(reply, 0, 1);
    case "SADD":
    case "SREM":
    case "HDEL":
    case "ZREM":
      return between(reply, 0, args.length);
    case "DEL":
      return between(reply, 0, args.length + 1);
    case "RPUSH":
    case "LPUSH":
      return between(reply, Math.max(1, args.length), Number.MAX_SAFE_INTEGER);
    default:
      return false;
  }
}

/**
 * What one script answered: what it charged, and each command's reply. Throws for a malformed call, a refused
 * command, or a reply not in its exact shape (Codex G on #2719: a charge that is not a whole count, or a command
 * answered null, is not a write that landed, so no caller may take it as done). An HSETNX answers exactly 0 or 1 (Codex G on #2809;
 * CX-123 rule 24), which replyFits holds with every other command.
 */
function readScript(reply: unknown, commands: Command[]): { charged: number; replies: unknown[] } {
  // What was charged is the script's Lua integer, which Redis and Upstash's REST API answer as a number: a whole
  // number from zero up, and nothing else (CX-123 rule 24). Null, text or a fraction is not "charged 0".
  const charged = Array.isArray(reply) && reply.length === commands.length + 1 ? countOf(reply[0]) : null;
  if (charged === null) throw new Error("an order's records could not be written");
  const replies = (reply as unknown[]).slice(1);
  const failed = replies.find((r) => typeof r === "string" && r.startsWith(ORDER_WRITE_ERROR));
  if (failed) throw new Error(`Redis error: ${String(failed).slice(ORDER_WRITE_ERROR.length)}`);
  // Every place, a hole included (Array.prototype.some skips holes): a reply that is not there is not a write that landed.
  for (let i = 0; i < commands.length; i++) if (!replyFits(commands[i], replies[i])) throw new UnknownReplyError("an order's write: a command's reply");
  return { charged, replies: replies.map((r) => (r === false ? null : r)) };
}

/**
 * Writes an order's records and charges the store's room what they really
 * add, in one script (ORDER_WRITE), and answers what was charged in all and
 * each command's reply, in order, the way redisPipeline does; throws when it
 * would. A store with no id at all (none has none) has its records written as
 * they are, charged nothing.
 */
export async function orderWriteCharged(owner: DataOwner, commands: Command[]): Promise<{ charged: number; replies: unknown[] }> {
  if (!commands.length) return { charged: 0, replies: [] };
  for (const command of commands) if (!checked(command)) throw new Error(`not a command an order's records are written with: ${String(command[0])}`);
  const room = dataKey(owner);
  if (!room || !isRedisConfigured()) return { charged: 0, replies: await redisPipeline(commands) };
  let charged = 0;
  const replies: unknown[] = [];
  for (let at = 0; at < commands.length; at += ORDER_WRITE_MAX) {
    const some = commands.slice(at, at + ORDER_WRITE_MAX);
    // Exactly one reply for the one script sent (Codex G on #2809): an answer of another length is unknown, never its first item.
    const reply = repliesFor(await redisPipeline([scriptOf(room, some)]), 1)?.[0];
    const read = readScript(reply, some);
    charged += read.charged;
    replies.push(...read.replies);
  }
  return { charged, replies };
}

/** The same, answering only each command's reply: what a writer that used redisPipeline reads. */
export async function orderWrite(owner: DataOwner, commands: Command[]): Promise<unknown[]> {
  return (await orderWriteCharged(owner, commands)).replies;
}

/**
 * Writes an order's records in one script, ORDER_WRITE_IF_NEW, only when the first command, an HSETNX, sets its
 * field: either every command is applied, charged as orderWrite charges it, or none is. Answers each command's reply,
 * the first being 1, or null when the field was already there and nothing was written. Every reply is read in its
 * exact shape (readScript); anything else throws, UnknownReplyError for a reply not known, never "written" and never
 * "already there". Not split across scripts and never sent as a plain pipeline: with no room to count it in, or more
 * commands than one script carries, it throws before writing anything.
 */
export async function orderWriteIfNew(owner: DataOwner, commands: Command[]): Promise<unknown[] | null> {
  const [first] = commands;
  if (!first || first[0] !== "HSETNX" || first.length !== 4 || commands.length > ORDER_WRITE_MAX) throw new Error("not a write an order's records are written with if new");
  for (const command of commands) {
    if (!checked(command) || !(ORDER_IF_NEW_COMMANDS as readonly string[]).includes(String(command[0]))) throw new Error(`not a command an order's records are written with if new: ${String(command[0])}`);
  }
  const room = dataKey(owner);
  if (!room || !isRedisConfigured()) throw new Error("an order's records could not be written");
  const reply = repliesFor(await redisPipeline([scriptOf(room, commands, ORDER_WRITE_IF_NEW)]), 1)?.[0];
  const slots = listSlots(reply);
  if (slots && slots.length === 1 && slots[0] === ORDER_IF_NEW_TAKEN) return null;
  const { replies } = readScript(reply, commands);
  // The field was not there when the script looked, in the same script: its HSETNX can only have set it.
  if (replies[0] !== 1) throw new UnknownReplyError("an order's write if new: its first HSETNX");
  return replies;
}

/**
 * What deleting one field an order wrote gives back to the room: its own
 * part of what it was charged (its name, its value and ORDER_ENTRY_BYTES, a
 * quarter more), rounded down, so a deletion never gives back more than the
 * write took. The key's own share stays counted.
 */
export function fieldReleaseBytes(field: string, value: string): number {
  const raw = Buffer.byteLength(field, "utf8") + Buffer.byteLength(value, "utf8") + ORDER_ENTRY_BYTES;
  return Math.floor((raw * 5) / 4 / DATA_STEP_BYTES) * DATA_STEP_BYTES;
}

/** Gives back to the room's slot for orders what records an order wrote freed, once they are deleted. Never refuses and never throws. */
export async function releaseOrderData(store: DataStore, bytes: number): Promise<void> {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  await giveData(store, [{ slot: "o", bytes: Math.floor(bytes) }]);
}
