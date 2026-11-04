/**
 * Queue item 256 [KJ1], unit 2: the studio demo's session door, on the rules
 * of lib/studio-demo-rules.ts (design: docs/studio-demo.md).
 *
 * Still off: STUDIO_DEMO_ON is false, so `openStudioDemo` refuses before it
 * reads anything, and `answerStudioDemoOpen` (the route's whole body) answers
 * as a path that does not exist. Nothing links here.
 *
 * What each function guarantees:
 *   - Every request that reaches Redis first reads, in one command, the day's
 *     count of refused demo requests and its own address's; past
 *     DEMO_REFUSALS_PER_DAY it is answered "closed", past its address's
 *     DEMO_REFUSALS_PER_ADDRESS_PER_DAY "address", after that one command and
 *     writing nothing. Every refusal after that read is counted by one script
 *     that checks both caps and counts both at once (STUDIO_DEMO_REFUSE_SCRIPT,
 *     or the door's own), so the day's count never passes its cap, what
 *     counted refusals send in a day has a ceiling, and one address can count
 *     no more than its own share of it.
 *   - `openStudioDemo` refuses, with its reason, when the demo is off, when
 *     Redis is not there, when the day's refusals are spent, when the bot
 *     check calls the request a program, when the address (a new-kind one by
 *     its network) has opened its sessions today, or when the day has no
 *     session or no room for one more session's whole worst. The day's and the
 *     address's checks and counts are one script (STUDIO_DEMO_DOOR_SCRIPT), so
 *     two doors at the last place cannot both take it. Only then is a session
 *     made: a random id, its record and the sandbox's fixed fictional drafts
 *     written in one script under `sandboxKey()` names only, every key ending
 *     at the same absolute moment (EXPIREAT), never extended.
 *   - `readStudioDemo` answers the live session named by the `nl_studio_demo`
 *     cookie, or null: the demo off (before any command), no cookie, a
 *     malformed id, an unknown or expired record, a record that does not read
 *     exactly as written, the day's or the address's refusals spent, or Redis
 *     out of reach. Nothing else in the request is read but its address.
 *   - `takeDemoAction` checks a session's actions and bytes, its life and the
 *     day's commands (`demoActionAllowed`), and counts them, before the action
 *     writes anything; the session's count is taken in one script so two
 *     actions at the last place cannot both pass. The session's day is read
 *     from its record, never taken from the caller. Unknown or impossible
 *     counts refuse.
 *
 * It imports nothing that reaches a store, the catalog, mail, AI, payments,
 * uploads or the house store: the demo store's values are copied below as
 * fixed fictional drafts, never read from the real demo store's records.
 */
import { isAutomated } from "@/lib/bot-check";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { BodyTooLarge, clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import {
  DEMO_ACTIONS_PER_SESSION, DEMO_BYTES_PER_SESSION, DEMO_COMMANDS_PER_DAY, DEMO_COOKIE, DEMO_REFUSALS_PER_ADDRESS_PER_DAY, DEMO_REFUSALS_PER_DAY,
  DEMO_SESSIONS_PER_ADDRESS_PER_DAY,
  DEMO_SESSIONS_PER_DAY, DEMO_SESSION_SECONDS, DEMO_SESSION_WORST_COMMANDS, DEMO_START_COMMANDS, STUDIO_DEMO_ON,
  type DemoRefusal, demoActionAllowed, demoAddressKey, demoDayKey, demoSessionAllowed, isDemoSessionId, sandboxKey,
} from "@/lib/studio-demo-rules";
import { shareAddress } from "@/lib/traffic-rules";
import { deriveKey } from "@/lib/secret-box";
import { createHash, createHmac } from "node:crypto";

// ---------------------------------------------------------------- the sandbox's first drafts

/**
 * What a new sandbox starts from: the fictional demo store's own published
 * values (lib/demo-seed.ts, DEMO_PRODUCT, DEMO_PAGE, DEMO_EXTRAS), copied
 * here so the demo never reads the real demo store. The subscription and the
 * email start empty: making them is the visitor's step.
 */
export const STUDIO_DEMO_SEED = {
  product: {
    title: "Weekly Meal Planner",
    summary: "Simple family meal plans with breakfasts, lunches, dinners and a grocery list for each week.",
    priceCents: 2700,
    options: [{ label: "1 week", priceCents: 2700 }, { label: "5 weeks", priceCents: 3900 }],
  },
  page: {
    style: "bands",
    blocks: [
      {
        kind: "hero",
        headline: "Dinner, decided before the week begins",
        sub: "A printable plan for breakfast, lunch and dinner, with the grocery list that goes with it. One week to try, or five.",
      },
      {
        kind: "benefits",
        heading: "What you get",
        items: ["Breakfast, lunch and dinner for every day of the week", "One grocery list for the whole week", "One page for each week, ready to print", "A PDF you download the moment you pay"],
      },
    ],
  },
  offer: { product: "Grocery List Pack", priceCents: 500, line: "" },
  subscription: { name: "", monthlyCents: 0, trialDays: 0, perks: [] as string[] },
  email: { subject: "", body: "" },
} as const;

/** The families a new sandbox writes, in the order the seed script takes them after the session record. */
const SEED_FAMILIES = ["product", "page", "offer", "subscription", "email"] as const;

/** The seed's drafts as they are written. */
export const STUDIO_DEMO_SEED_VALUES: readonly string[] = SEED_FAMILIES.map((family) => JSON.stringify(STUDIO_DEMO_SEED[family]));
/** Their bytes, counted against the session's from the start, so what a session keeps never passes DEMO_BYTES_PER_SESSION. */
export const STUDIO_DEMO_SEED_BYTES = STUDIO_DEMO_SEED_VALUES.reduce((sum, value) => sum + new TextEncoder().encode(value).byteLength, 0);

// ---------------------------------------------------------------- the scripts

/**
 * The door: the day's refusals and the address's, the day's sessions and
 * commands and the address's sessions, checked and counted at once. A session
 * taken counts one more session, reserves its whole worst, counts the start's
 * own commands as sent and one more session for the address. A refusal counts
 * one refusal for the address and one for the day, as STUDIO_DEMO_REFUSE_SCRIPT
 * does. The day's checks are demoSessionAllowed's, on the counts read inside.
 * Answers {1, sessions, commands} when taken; {0, sessions, commands} as read
 * when the day refuses; {-3, ...} when the address's sessions do; {-2, ...}
 * when the day's refusals are spent and {-4, ...} when the address's are
 * (nothing written); {-1, 0, 0} when a count is not a plain number (nothing
 * written).
 * KEYS[1] the day, KEYS[2] the day's addresses; ARGV the sessions cap, the
 * commands cap, a session's worst, the start's commands, how long the day is
 * kept, the day's refusals cap, the address's field, the address's sessions
 * cap, when the addresses' counts end (seconds), the address's refusals field,
 * the address's refusals cap.
 */
export const STUDIO_DEMO_DOOR_SCRIPT = `-- marktmorgen:studio-demo-door:v2
local v = redis.call('HMGET', KEYS[1], 'sessions', 'commands', 'sent')
local function n(x)
  if not x then return 0 end
  if not string.match(x, '^%d+$') or string.len(x) > 15 then return -1 end
  return tonumber(x)
end
local s, c, u = n(v[1]), n(v[2]), n(v[3])
if s < 0 or c < 0 or u < 0 then return {-1, 0, 0} end
local w = redis.call('HMGET', KEYS[2], 'refused', ARGV[7], ARGV[10])
local r, a, q = n(w[1]), n(w[2]), n(w[3])
if r < 0 or a < 0 or q < 0 then return {-1, 0, 0} end
if r >= tonumber(ARGV[6]) then return {-2, s, c} end
if q >= tonumber(ARGV[11]) then return {-4, s, c} end
local function refuse(code)
  redis.call('HINCRBY', KEYS[2], 'refused', 1)
  redis.call('HINCRBY', KEYS[2], ARGV[10], 1)
  redis.call('EXPIREAT', KEYS[2], ARGV[9])
  return {code, s, c}
end
if a >= tonumber(ARGV[8]) then return refuse(-3) end
if s >= tonumber(ARGV[1]) or c + tonumber(ARGV[3]) > tonumber(ARGV[2]) then return refuse(0) end
redis.call('HINCRBY', KEYS[1], 'sessions', 1)
redis.call('HINCRBY', KEYS[1], 'commands', ARGV[3])
redis.call('HINCRBY', KEYS[1], 'sent', ARGV[4])
redis.call('EXPIRE', KEYS[1], ARGV[5])
redis.call('HINCRBY', KEYS[2], ARGV[7], 1)
redis.call('EXPIREAT', KEYS[2], ARGV[9])
return {1, s + 1, c + tonumber(ARGV[3])}`;

/**
 * One refusal counted, only while both caps leave room: the day's refusals
 * (DEMO_REFUSALS_PER_DAY) and the address's (DEMO_REFUSALS_PER_ADDRESS_PER_DAY),
 * read and counted in one step, so refusals at the same moment never count
 * past either. Answers 1 when counted; -2 when the day's are spent and -4 when
 * the address's are (nothing written); -1 when a count is not a plain number.
 * KEYS[1] the day's addresses; ARGV the address's refusals field, the day's
 * cap, the address's cap, when the addresses' counts end (seconds).
 */
export const STUDIO_DEMO_REFUSE_SCRIPT = `-- marktmorgen:studio-demo-refuse:v1
local w = redis.call('HMGET', KEYS[1], 'refused', ARGV[1])
local function n(x)
  if not x then return 0 end
  if not string.match(x, '^%d+$') or string.len(x) > 15 then return -1 end
  return tonumber(x)
end
local r, q = n(w[1]), n(w[2])
if r < 0 or q < 0 then return -1 end
if r >= tonumber(ARGV[2]) then return -2 end
if q >= tonumber(ARGV[3]) then return -4 end
redis.call('HINCRBY', KEYS[1], 'refused', 1)
redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
redis.call('EXPIREAT', KEYS[1], ARGV[4])
return 1`;

/**
 * A new session: its record and its first drafts, all or nothing, every key
 * ending at ARGV[1] (seconds). Refuses (0) when the record already exists.
 * KEYS[1] the record, KEYS[2..] the drafts; ARGV the end, the day, the start
 * and end in ms, the bytes already counted, then one value per draft.
 */
export const STUDIO_DEMO_SEED_SCRIPT = `-- marktmorgen:studio-demo-seed:v1
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'day', ARGV[2], 'startedAt', ARGV[3], 'expiresAt', ARGV[4], 'actions', '0', 'bytes', ARGV[5])
redis.call('EXPIREAT', KEYS[1], ARGV[1])
for i = 2, #KEYS do redis.call('SET', KEYS[i], ARGV[i + 4], 'EXAT', ARGV[1]) end
return 1`;

/**
 * One action of a session, counted only while it fits: alive at ARGV[1] (ms),
 * under the session's actions and, with ARGV[2] bytes more, its bytes.
 * Answers {1, actions, bytes} when taken; {0} when the record is gone; {-1}
 * when it does not read as written; {-2} expired; {-3} actions; {-4} bytes.
 * KEYS[1] the record; ARGV now, the bytes, the actions cap, the bytes cap.
 */
export const STUDIO_DEMO_TAKE_SCRIPT = `-- marktmorgen:studio-demo-take:v1
local v = redis.call('HMGET', KEYS[1], 'actions', 'bytes', 'expiresAt')
if not v[1] and not v[2] and not v[3] then return {0} end
for i = 1, 3 do
  if not v[i] or not string.match(v[i], '^%d+$') or string.len(v[i]) > 15 then return {-1} end
end
local a, b, e = tonumber(v[1]), tonumber(v[2]), tonumber(v[3])
if tonumber(ARGV[1]) >= e then return {-2} end
if a >= tonumber(ARGV[3]) then return {-3} end
if b + tonumber(ARGV[2]) > tonumber(ARGV[4]) then return {-4} end
redis.call('HINCRBY', KEYS[1], 'actions', 1)
redis.call('HINCRBY', KEYS[1], 'bytes', ARGV[2])
return {1, a + 1, b + tonumber(ARGV[2])}`;

/** How long a day's counts are kept (docs/studio-demo.md). */
export const DEMO_DAY_KEEP_SECONDS = 400 * 86_400;

/**
 * Commands takeDemoAction itself sends, as billed: the day's and the address's
 * refusals (1), the record (1), the day's commands sent (1), the counting script with what it runs
 * inside (4) and the day's count (1). An action costed below this cannot be
 * true and is refused.
 */
export const DEMO_TAKE_COMMANDS = 8;

// ---------------------------------------------------------------- the session

export type StudioDemoSession = { id: string; day: string; startedAt: number; expiresAt: number; actions: number; bytes: number };
export type StudioDemoOpenRefusal = DemoRefusal | "automated" | "address";
export type StudioDemoOpened = { ok: true; session: StudioDemoSession; cookie: string } | { ok: false; reason: StudioDemoOpenRefusal };

/** The seams a test sets; production passes nothing and gets the switch, the bot check and the clock. */
export type StudioDemoOptions = { on?: boolean; isAutomated?: () => Promise<boolean>; now?: () => number };

const plain = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const digits = (x: unknown): number | null => (typeof x === "string" && /^\d{1,15}$/.test(x) ? Number(x) : null);
const integers = (reply: unknown, length: number): number[] | null =>
  Array.isArray(reply) && reply.length === length && reply.every((x) => typeof x === "number" && Number.isSafeInteger(x)) ? (reply as number[]) : null;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function newSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return "sd" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The field an address is counted under: a one-way fingerprint of the address,
 * or of the network of a new-kind one, made with a key only this deployment
 * has (lib/secret-box.ts, as lib/traffic.ts does), so that somebody who read
 * the day's set could not find an address in it by trying every address there
 * is. Without the key (a local run) it is a plain hash.
 */
export function demoAddressField(request: Request): string {
  const block = shareAddress(clientAddress(request)) || "unknown";
  const of = `marktmorgen-studio-demo:${block}`;
  const key = deriveKey("studio-demo-address");
  const made = key ? createHmac("sha256", key).update(of) : createHash("sha256").update(of);
  return made.digest("hex").slice(0, 32);
}

/** The field an address's refusals are counted under, beside its sessions' field in the day's addresses. */
const refusalsField = (field: string) => `${field}:refused`;

/** Where a request's refusals are read and counted: the day's addresses, its address's field, and when the day ends. */
type RefusalPlace = { addressKey: string; field: string; dayEnds: number };

function refusalPlace(request: Request, now: number): RefusalPlace | null {
  const addressKey = demoAddressKey(dayOf(now));
  if (!addressKey) return null;
  return { addressKey, field: refusalsField(demoAddressField(request)), dayEnds: (Math.floor(now / 86_400_000) + 1) * 86_400 };
}

/**
 * The day's refusals and the address's, read in one command before anything
 * else: "open" while both are under their caps, "closed" past the day's,
 * "address" past the address's, "unknown" when unreadable.
 */
async function refusalsGate(place: RefusalPlace): Promise<"open" | "closed" | "address" | "unknown"> {
  try {
    const [held] = await redisPipeline([["HMGET", place.addressKey, "refused", place.field]]);
    if (!Array.isArray(held) || held.length !== 2) return "unknown";
    const [refused, mine] = held.map((x) => (x === null ? 0 : digits(x)));
    if (refused === null || mine === null) return "unknown";
    if (refused >= DEMO_REFUSALS_PER_DAY) return "closed";
    return mine >= DEMO_REFUSALS_PER_ADDRESS_PER_DAY ? "address" : "open";
  } catch {
    return "unknown";
  }
}

/**
 * One refusal more for the address and the day, in one script that counts it
 * only while both caps leave room. A count that cannot be made is a lost
 * count, never a reason to let the request through.
 */
async function countRefusal(place: RefusalPlace): Promise<void> {
  try {
    await redisPipeline([[
      "EVAL", STUDIO_DEMO_REFUSE_SCRIPT, 1, place.addressKey,
      place.field, DEMO_REFUSALS_PER_DAY, DEMO_REFUSALS_PER_ADDRESS_PER_DAY, place.dayEnds,
    ]]);
  } catch {
    // Already refused.
  }
}

/** The cookie that names a session, kept no longer than the session lives. */
export function studioDemoCookie(session: StudioDemoSession, now: number): string {
  const left = Math.max(0, Math.floor((session.expiresAt - now) / 1000));
  return `${DEMO_COOKIE}=${session.id}; Path=/; Max-Age=${left}; HttpOnly; Secure; SameSite=Lax`;
}

/** Opens a demo session, or says why not. Nothing is written past a refusal's step but the refusal's count. */
export async function openStudioDemo(request: Request, options: StudioDemoOptions = {}): Promise<StudioDemoOpened> {
  const on = options.on ?? STUDIO_DEMO_ON;
  if (!on) return { ok: false, reason: "off" };
  if (!isRedisConfigured()) return { ok: false, reason: "unknown" };
  const now = (options.now ?? Date.now)();
  if (!plain(now)) return { ok: false, reason: "unknown" };
  const day = dayOf(now);
  const dayKey = demoDayKey(day);
  const addressKey = demoAddressKey(day);
  if (!dayKey || !addressKey) return { ok: false, reason: "unknown" };

  const place = refusalPlace(request, now);
  if (!place) return { ok: false, reason: "unknown" };
  const gate = await refusalsGate(place);
  if (gate !== "open") return { ok: false, reason: gate };
  if (await (options.isAutomated ?? isAutomated)()) return { ok: false, reason: "automated" };

  const field = demoAddressField(request);
  let taken: number[] | null;
  try {
    const [reply] = await redisPipeline([[
      "EVAL", STUDIO_DEMO_DOOR_SCRIPT, 2, dayKey, addressKey,
      DEMO_SESSIONS_PER_DAY, DEMO_COMMANDS_PER_DAY, DEMO_SESSION_WORST_COMMANDS, DEMO_START_COMMANDS, DEMO_DAY_KEEP_SECONDS,
      DEMO_REFUSALS_PER_DAY, field, DEMO_SESSIONS_PER_ADDRESS_PER_DAY, place.dayEnds, place.field, DEMO_REFUSALS_PER_ADDRESS_PER_DAY,
    ]]);
    taken = integers(reply, 3);
  } catch {
    taken = null;
  }
  if (!taken || taken[0] === -1 || taken[0] < -4) return { ok: false, reason: "unknown" };
  if (taken[0] === -2) return { ok: false, reason: "closed" };
  if (taken[0] === -3 || taken[0] === -4) return { ok: false, reason: "address" };
  if (taken[0] !== 1) {
    const verdict = demoSessionAllowed({ today: day, sessionsToday: taken[1], commandsToday: taken[2] }, on);
    return { ok: false, reason: verdict.ok ? "unknown" : verdict.reason };
  }

  // Whole seconds, so the record, every draft and the session end at the same instant.
  const startedAt = Math.floor(now / 1000) * 1000;
  const expiresAt = startedAt + DEMO_SESSION_SECONDS * 1000;
  const id = newSessionId();
  const keys = [sandboxKey(id, "session"), ...SEED_FAMILIES.map((family) => sandboxKey(id, family))];
  if (!isDemoSessionId(id) || keys.some((key) => key === null)) return { ok: false, reason: "unknown" };
  let made: unknown;
  try {
    [made] = await redisPipeline([[
      "EVAL", STUDIO_DEMO_SEED_SCRIPT, keys.length, ...(keys as string[]),
      expiresAt / 1000, day, startedAt, expiresAt, STUDIO_DEMO_SEED_BYTES, ...STUDIO_DEMO_SEED_VALUES,
    ]]);
  } catch {
    made = null;
  }
  // The day's place stays taken when this fails: counted, never given back on a guess.
  if (made !== 1) return { ok: false, reason: "unknown" };
  const session: StudioDemoSession = { id, day, startedAt, expiresAt, actions: 0, bytes: STUDIO_DEMO_SEED_BYTES };
  return { ok: true, session, cookie: studioDemoCookie(session, now) };
}

/** The value of one cookie in a request's Cookie header; null when absent or given twice. */
function cookieOf(request: Request, name: string): string | null {
  const found = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return found.length === 1 ? found[0] : null;
}

/**
 * The live session the request's demo cookie names, or null. Off, nothing is
 * read. A well-formed cookie that names no live session is a refusal counted
 * against the request's address first, then the day.
 */
export async function readStudioDemo(request: Request, options: StudioDemoOptions = {}): Promise<StudioDemoSession | null> {
  if (!(options.on ?? STUDIO_DEMO_ON)) return null;
  const id = cookieOf(request, DEMO_COOKIE);
  if (!isDemoSessionId(id) || !isRedisConfigured()) return null;
  const key = sandboxKey(id, "session");
  const now = (options.now ?? Date.now)();
  if (!key || !plain(now)) return null;
  const place = refusalPlace(request, now);
  if (!place || (await refusalsGate(place)) !== "open") return null;
  let fields: unknown;
  try {
    [fields] = await redisPipeline([["HMGET", key, "day", "startedAt", "expiresAt", "actions", "bytes"]]);
  } catch {
    return null;
  }
  const session = sessionOf(id, fields, now);
  if (!session) await countRefusal(place);
  return session;
}

/** A session record as read, or null when it is gone, over or does not read exactly as written. */
function sessionOf(id: string, fields: unknown, now: number): StudioDemoSession | null {
  if (!Array.isArray(fields) || fields.length !== 5) return null;
  const [day, ...rest] = fields;
  const [startedAt, expiresAt, actions, bytes] = rest.map(digits);
  if (typeof day !== "string" || !demoDayKey(day) || startedAt === null || expiresAt === null || actions === null || bytes === null) return null;
  if (expiresAt !== startedAt + DEMO_SESSION_SECONDS * 1000 || dayOf(startedAt) !== day) return null;
  if (now >= expiresAt) return null;
  return { id, day, startedAt, expiresAt, actions, bytes };
}

export type DemoActionTaken = { ok: true; actions: number; bytes: number } | { ok: false; reason: DemoRefusal | "address" };

/**
 * Checks and counts one action of a session before it writes anything.
 * `cost` is the action's whole worst: its commands, these counting ones
 * included, and the bytes it will write. The session's counts and its day are
 * read afresh from its record, never taken from `session` as the caller holds it.
 * `request` is the one asking: its address's refusals are read and counted.
 */
export async function takeDemoAction(
  request: Request,
  session: StudioDemoSession,
  cost: { commands: number; bytes: number },
  options: StudioDemoOptions = {},
): Promise<DemoActionTaken> {
  const on = options.on ?? STUDIO_DEMO_ON;
  if (!on) return { ok: false, reason: "off" };
  if (!plain(cost?.commands) || !plain(cost?.bytes) || cost.commands < DEMO_TAKE_COMMANDS) return { ok: false, reason: "unknown" };
  if (!isRedisConfigured() || !isDemoSessionId(session?.id)) return { ok: false, reason: "unknown" };
  const key = sandboxKey(session.id, "session");
  const now = (options.now ?? Date.now)();
  if (!key || !plain(now)) return { ok: false, reason: "unknown" };
  const place = refusalPlace(request, now);
  if (!place) return { ok: false, reason: "unknown" };
  const gate = await refusalsGate(place);
  if (gate !== "open") return { ok: false, reason: gate };
  const refuse = async (reason: DemoRefusal): Promise<DemoActionTaken> => {
    await countRefusal(place);
    return { ok: false, reason };
  };

  let fields: unknown;
  try {
    [fields] = await redisPipeline([["HMGET", key, "actions", "bytes", "startedAt", "day"]]);
  } catch {
    return refuse("unknown");
  }
  if (!Array.isArray(fields) || fields.length !== 4) return refuse("unknown");
  if (fields.every((x) => x === null)) return refuse("expired");
  const [actions, bytes, startedAt] = fields.slice(0, 3).map(digits);
  const dayKey = typeof fields[3] === "string" ? demoDayKey(fields[3]) : null;
  if (actions === null || bytes === null || startedAt === null || !dayKey) return refuse("unknown");

  let sent: number | null;
  try {
    const [held] = await redisPipeline([["HGET", dayKey, "sent"]]);
    sent = digits(held);
  } catch {
    sent = null;
  }
  if (sent === null) return refuse("unknown");
  const verdict = demoActionAllowed({ actions, bytes, startedAt, now, commandsToday: sent }, cost, on);
  if (!verdict.ok) return refuse(verdict.reason);

  let taken: number[] | null;
  try {
    const [reply] = await redisPipeline([["EVAL", STUDIO_DEMO_TAKE_SCRIPT, 1, key, now, cost.bytes, DEMO_ACTIONS_PER_SESSION, DEMO_BYTES_PER_SESSION]]);
    taken = Array.isArray(reply) && reply.length === 1 ? integers(reply, 1) : integers(reply, 3);
  } catch {
    taken = null;
  }
  if (!taken) return refuse("unknown");
  const refused: Record<number, DemoRefusal> = { 0: "expired", [-1]: "unknown", [-2]: "expired", [-3]: "actions", [-4]: "bytes" };
  if (taken[0] !== 1 || taken.length !== 3) return refuse(refused[taken[0]] ?? "unknown");

  // The day's commands sent: under the reservation made at the door, so this only ever confirms it.
  let total: unknown;
  try {
    [total] = await redisPipeline([["HINCRBY", dayKey, "sent", cost.commands]]);
  } catch {
    total = null;
  }
  if (!plain(total)) return { ok: false, reason: "unknown" };
  return { ok: true, actions: taken[1], bytes: taken[2] };
}

// ---------------------------------------------------------------- the door, as the route answers

/** What the door's body may hold at the most: nothing is needed, a hidden field at the most. */
export const DEMO_DOOR_BODY_BYTES = 256;

const NO_STORE = { "Cache-Control": "no-store" };
const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

/** As a path that does not exist answers. */
export const studioDemoNotFound = () => new Response(null, { status: 404, headers: NO_STORE });

const STATUS: Record<StudioDemoOpenRefusal, number> = {
  off: 404, automated: 403, address: 429, closed: 503, sessions: 503, commands: 503, unknown: 503,
  expired: 503, actions: 503, bytes: 503, too_big: 503,
};

/**
 * POST /api/studio-demo. Off: a 404 before anything is read, Redis and the
 * body included. On: refused from another site, then the body (bounded, an
 * empty object at the most; the hidden field filled reads as a program),
 * then openStudioDemo, with the cookie on success.
 */
export async function answerStudioDemoOpen(request: Request, options: StudioDemoOptions = {}): Promise<Response> {
  if (!(options.on ?? STUDIO_DEMO_ON)) return studioDemoNotFound();
  if (fromAnotherSite(request)) return json({ ok: false, error: "forbidden" }, 403);
  let text: string;
  try {
    text = await (await limited(request, DEMO_DOOR_BODY_BYTES)).text();
  } catch (error) {
    return json({ ok: false, error: "invalid" }, error instanceof BodyTooLarge ? 413 : 400);
  }
  if (text.trim()) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ ok: false, error: "invalid" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "invalid" }, 400);
    const website = (body as Record<string, unknown>).website;
    if (typeof website === "string" && website.trim()) return json({ ok: false, error: "automated" }, 403);
  }
  const opened = await openStudioDemo(request, options);
  if (!opened.ok) return json({ ok: false, error: opened.reason }, STATUS[opened.reason]);
  return json({ ok: true, expiresAt: new Date(opened.session.expiresAt).toISOString() }, 200, { "Set-Cookie": opened.cookie });
}
