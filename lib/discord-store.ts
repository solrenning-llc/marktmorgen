/**
 * What is kept for Discord access (lib/discord-rules.ts), by the store's key
 * (lib/learn.ts, storeKey) and its id:
 *
 *   nl:dc:srv:<store key>                 the creator's server, and whether people are taken out when their access ends
 *   nl:dc:prod:<store key>                the roles each product gives (a hash)
 *   nl:dc:mem:<store key>                 each person given roles: their Discord id, the address that bought, what they hold and were given (a hash)
 *   nl:dc:addr:<store key>:<address key>  the Discord account an address brought in
 *   nl:dc:due                             who is checked next, and when: "<store id>|<Discord id>"
 *   nl:dc:state:<hash>                    a trip to Discord's page and back, for ten minutes, used once
 *
 * About the buyer, only what the door needs: their Discord id and name,
 * which address bought, which products it held and which roles it was
 * given. Forgotten when the creator disconnects the server, and a person
 * whose access ended is forgotten once their roles are taken back.
 */
import { createHash, randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { orderWrite } from "@/lib/order-data";
import { emailKey, storeKey } from "@/lib/learn";
import { normaliseEmail } from "@/lib/auth";
import type { Store } from "@/lib/store";
import { CHECK_HOURS, type DiscordServer, MAX_DISCORD_PRODUCTS, SNOWFLAKE, cleanRoles, parseServer } from "@/lib/discord-rules";

const serverKey = (room: string) => `nl:dc:srv:${room}`;
const productsKey = (room: string) => `nl:dc:prod:${room}`;
const membersKey = (room: string) => `nl:dc:mem:${room}`;
const addressKey = (room: string, email: string) => `nl:dc:addr:${room}:${emailKey(email)}`;
const DUE_KEY = "nl:dc:due";
const STATE_SECONDS = 10 * 60;
const stateKey = (token: string) => `nl:dc:state:${createHash("sha256").update(`nimbus-discord:${token}`).digest("hex").slice(0, 40)}`;

function parse<T>(raw: unknown): T | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the server

export async function readServer(room: string): Promise<DiscordServer | null> {
  if (!isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", serverKey(room)]]);
  return parseServer(parse(raw));
}

export async function saveServer(room: string, server: DiscordServer): Promise<void> {
  await redisPipeline([["SET", serverKey(room), JSON.stringify(server)]]);
}

/**
 * Forgets the server, the roles each product gave and everyone given them.
 * Returns who was given roles, so the caller can say how many; nothing is
 * taken back in Discord, where the bot is no longer.
 */
export async function forgetServer(room: string, sid: string): Promise<number> {
  const [ids] = await redisPipeline([["HKEYS", membersKey(room)]]);
  const people = Array.isArray(ids) ? ids.map(String) : [];
  const [rows] = await redisPipeline([["HVALS", membersKey(room)]]);
  const addresses = (Array.isArray(rows) ? rows : []).map((row) => parse<Member>(row)?.e).filter((e): e is string => typeof e === "string");
  await redisPipeline([
    ["DEL", serverKey(room), productsKey(room), membersKey(room), ...addresses.map((e) => addressKey(room, e))],
    ...(people.length ? [["ZREM", DUE_KEY, ...people.map((id) => `${sid}|${id}`)]] : []),
  ]);
  return people.length;
}

// ---------------------------------------------------------------- products

/** The roles each product gives. */
export async function productRoles(room: string): Promise<Map<string, string[]>> {
  if (!isRedisConfigured()) return new Map();
  const [flat] = await redisPipeline([["HGETALL", productsKey(room)]]);
  const pairs = Array.isArray(flat) ? flat : [];
  const out = new Map<string, string[]>();
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const roles = cleanRoles(parse(pairs[i + 1]));
    if (roles.length) out.set(String(pairs[i]), roles);
  }
  return out;
}

export type SetRoles = { ok: true } | { ok: false; reason: "too_many" };

/** Sets the roles a product gives; none takes the product off. */
export async function setProductRoles(room: string, productId: string, roles: string[]): Promise<SetRoles> {
  const clean = cleanRoles(roles);
  if (!clean.length) {
    await redisPipeline([["HDEL", productsKey(room), productId]]);
    return { ok: true };
  }
  const now = await productRoles(room);
  if (!now.has(productId) && now.size >= MAX_DISCORD_PRODUCTS) return { ok: false, reason: "too_many" };
  await redisPipeline([["HSET", productsKey(room), productId, JSON.stringify(clean)]]);
  return { ok: true };
}

// ---------------------------------------------------------------- people

/** One person given roles. */
export type Member = {
  /** The address that bought. */
  e: string;
  /** Their name on Discord, for the creator's list. */
  n: string;
  /** The products it held at the last check. */
  p: string[];
  /** The roles given, which are the only ones ever taken back. */
  r: string[];
  /** When they first came in, and were last checked, in seconds. */
  at: number;
  checked: number;
  /** Removals from the server Discord refused in a row, once their access ended (lib/discord-access.ts); absent for none. */
  k?: number;
};

export async function readMember(room: string, userId: string): Promise<Member | null> {
  if (!SNOWFLAKE.test(userId)) return null;
  const [raw] = await redisPipeline([["HGET", membersKey(room), userId]]);
  return parse<Member>(raw);
}

/** Everyone given roles in this store's server, newest first, at most `limit`. */
export async function membersOf(room: string, limit = 500): Promise<{ id: string; member: Member }[]> {
  if (!isRedisConfigured()) return [];
  const [flat] = await redisPipeline([["HGETALL", membersKey(room)]]);
  const pairs = Array.isArray(flat) ? flat : [];
  const out: { id: string; member: Member }[] = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const member = parse<Member>(pairs[i + 1]);
    if (member) out.push({ id: String(pairs[i]), member });
  }
  return out.sort((a, b) => b.member.at - a.member.at).slice(0, limit);
}

/** The Discord account an address brought in, if any. */
export async function accountOf(room: string, email: string): Promise<string | null> {
  const [raw] = await redisPipeline([["GET", addressKey(room, email)]]);
  return typeof raw === "string" && SNOWFLAKE.test(raw) ? raw : null;
}

/** Keeps a person, and when they are checked next. */
export async function keepMember(room: string, sid: string, userId: string, member: Member, now = Date.now()): Promise<void> {
  // A person given roles is kept for good: counted in the store's room at what it adds (lib/order-data.ts).
  await orderWrite({ sid }, [
    ["HSET", membersKey(room), userId, JSON.stringify({ ...member, e: normaliseEmail(member.e) })],
    ["SET", addressKey(room, member.e), userId],
    ["ZADD", DUE_KEY, Math.floor(now / 1000) + CHECK_HOURS * 3_600, `${sid}|${userId}`],
  ]);
}

/** Forgets a person: their access ended and their roles were taken back, or they left. */
export async function forgetMember(room: string, sid: string, userId: string, email: string): Promise<void> {
  const [held] = await redisPipeline([["GET", addressKey(room, email)]]);
  await redisPipeline([
    ["HDEL", membersKey(room), userId],
    ["ZREM", DUE_KEY, `${sid}|${userId}`],
    ...(held === userId ? [["DEL", addressKey(room, email)]] : []),
  ]);
}

/** Puts a person first in line to be checked: a refund made in the studio, say. */
export async function checkSoon(sid: string, userId: string): Promise<void> {
  await redisPipeline([["ZADD", DUE_KEY, 0, `${sid}|${userId}`]]);
}

/** Who is due to be checked, taken off the line; they are put back when kept. */
export async function dueMembers(now = Date.now(), limit = 200): Promise<{ sid: string; userId: string }[]> {
  if (!isRedisConfigured()) return [];
  const [due] = await redisPipeline([["ZRANGEBYSCORE", DUE_KEY, 0, Math.floor(now / 1000), "LIMIT", 0, limit]]);
  const entries = (Array.isArray(due) ? due : []).filter((m): m is string => typeof m === "string");
  if (entries.length) await redisPipeline([["ZREM", DUE_KEY, ...entries]]);
  return entries.flatMap((entry) => {
    const [sid, userId] = entry.split("|");
    return sid && userId && SNOWFLAKE.test(userId) ? [{ sid, userId }] : [];
  });
}

// ---------------------------------------------------------------- trips to Discord's page

export type Trip =
  | { k: "install"; sid: string; by: string; redirect: string }
  | { k: "join"; sid: string; email: string; redirect: string; back: string };

/** A state for one trip to Discord's page and back. */
export async function startTrip(trip: Trip): Promise<string> {
  const token = randomBytes(24).toString("hex");
  await redisPipeline([["SET", stateKey(token), JSON.stringify(trip), "EX", STATE_SECONDS]]);
  return token;
}

/** The trip a state stands for, once. */
export async function takeTrip(token: string): Promise<Trip | null> {
  if (!/^[0-9a-f]{48}$/.test(token)) return null;
  const [raw] = await redisPipeline([["GETDEL", stateKey(token)]]);
  const trip = parse<Trip>(raw);
  return trip && (trip.k === "install" || trip.k === "join") ? trip : null;
}

/**
 * The products of a store that open its Discord server now, or null when
 * none is connected: for a page deciding whether to offer the way in.
 */
export async function discordFor(store: Store): Promise<Set<string> | null> {
  const room = storeKey(store);
  const server = await readServer(room);
  if (!server) return null;
  return new Set((await productRoles(room)).keys());
}
