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
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
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

/**
 * The one reply of a one-command read, exactly (CX-123 rule 24): a missing slot or a list of another length is
 * unknown, never "nothing kept". The exact null is what Redis answers for a key or field that is not there.
 */
function oneReply(replies: unknown, what: string): unknown {
  const slots = repliesFor(replies, 1);
  if (!slots) throw new UnknownReplyError(what);
  return slots[0];
}

// ---------------------------------------------------------------- the server

export async function readServer(room: string): Promise<DiscordServer | null> {
  if (!isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", serverKey(room)]]);
  return parseServer(parse(raw));
}

/**
 * The connected server, read exactly, for what takes roles back on it (lib/discord-access.ts: the check, a person's
 * deletion): null only when none is kept; a reply of another shape throws UnknownReplyError, so nothing reads an
 * unknown server as "disconnected" and forgets somebody whose roles are still given.
 */
export async function readServerOrThrow(room: string): Promise<DiscordServer | null> {
  const raw = oneReply(await redisPipeline([["GET", serverKey(room)]]), "the connected Discord server");
  if (raw === null) return null;
  const server = parseServer(parse(raw));
  if (!server) throw new UnknownReplyError("the connected Discord server");
  return server;
}

export async function saveServer(room: string, server: DiscordServer): Promise<void> {
  await redisPipeline([["SET", serverKey(room), JSON.stringify(server)]]);
}

/**
 * The people of a server read by forgetServer, deleted in one step (Codex G on #3017): KEYS[1] the people, KEYS[2] the
 * due list, KEYS[3..] each person's address link as read; ARGV[1] the server's sid, ARGV[2..] each person's id and the
 * row read for them. A person's address link goes while it still points at them (an address they no longer hold is
 * theirs no more); their row and due entry go only while the row is still the one read, so one rewritten meanwhile
 * (another address, from a join under way) is kept whole, with its new link, for the next try. Answers the people
 * deleted, the links deleted and the people left. lib/redis-memory.ts runs it the same way.
 */
export const FORGET_PEOPLE = `-- marktmorgen:discord-forget-people:v1
local gone, links = 0, 0
for i = 1, #KEYS - 2 do
  local id, row = ARGV[2 * i], ARGV[2 * i + 1]
  if redis.call("GET", KEYS[i + 2]) == id then links = links + redis.call("DEL", KEYS[i + 2]) end
  if redis.call("HGET", KEYS[1], id) == row then
    gone = gone + redis.call("HDEL", KEYS[1], id)
    redis.call("ZREM", KEYS[2], ARGV[1] .. "|" .. id)
  end
end
return {gone, links, redis.call("HLEN", KEYS[1])}`;

/**
 * Forgets the server, the roles each product gave and everyone given them.
 * Returns who was given roles, so the caller can say how many; nothing is
 * taken back in Discord, where the bot is no longer.
 *
 * Both reads are exact (CX-123 rule 24, lib/redis-reply.ts): a reply that is not a list of strings, or a person kept
 * in another shape, throws UnknownReplyError before anything is deleted. Deleting the people while their addresses
 * are unknown would leave each buyer's address linked to their Discord id for good (Claude 6's proof,
 * tests/discord-forget-server.test.ts); kept whole, the next try forgets everything. The two lists must match, and
 * only the people read are deleted, with their address links: the server goes only once nobody is left (Codex G).
 */
export async function forgetServer(room: string, sid: string): Promise<number> {
  const people = stringList(oneReply(await redisPipeline([["HKEYS", membersKey(room)]]), "the people given Discord roles"));
  if (!people) throw new UnknownReplyError("the people given Discord roles");
  const rows = stringList(oneReply(await redisPipeline([["HVALS", membersKey(room)]]), "the addresses of the people given Discord roles"));
  if (!rows) throw new UnknownReplyError("the addresses of the people given Discord roles");
  // One address a person, read as a whole (Codex G on #3017): a shorter list on either side, from a bent reply or a
  // person joining or leaving between the two reads, is not known.
  if (rows.length !== people.length) throw new UnknownReplyError("the addresses of the people given Discord roles");
  const addresses = rows.map((row) => {
    const email = parse<Partial<Member>>(row)?.e;
    if (typeof email !== "string" || !email) throw new UnknownReplyError("the addresses of the people given Discord roles");
    return email;
  });
  // Only the people read, with their address links and due entries, are deleted; then the list must be empty. Anybody
  // left (a reading that missed somebody, a person who joined meanwhile) keeps the server for the next try, which
  // forgets them with their address: no buyer's address is ever left linked to a Discord id with nobody to forget it.
  // Each person goes only while their row is still the one read, in one step (FORGET_PEOPLE; Codex G on #3017): a join
  // that rewrote them with another address meanwhile keeps its row, its new link and its due entry for the next try.
  if (people.length) {
    const command: (string | number)[] = [
      "EVAL",
      FORGET_PEOPLE,
      2 + people.length,
      membersKey(room),
      DUE_KEY,
      ...addresses.map((e) => addressKey(room, e)),
      sid,
      ...people.flatMap((id, i) => [id, rows[i]]),
    ];
    // The deletes are read too, as forgetMember's (#2932, CX-123 rule 24): a missing, short, long or queued answer is
    // not "forgotten". At most the people named go, and at most their address links.
    const reply = repliesFor(await redisPipeline([command]), 1)?.[0];
    const counts = Array.isArray(reply) && reply.length === 3 ? reply.map(countOf) : null;
    if (!counts || counts[0] === null || counts[1] === null || counts[2] === null || counts[0] > people.length || counts[1] > people.length) {
      throw new UnknownReplyError("the deletion of a Discord server's people");
    }
    if (counts[2] !== 0) throw new UnknownReplyError("the people given Discord roles, not all forgotten");
  } else {
    const left = repliesFor(await redisPipeline([["HLEN", membersKey(room)]]), 1)?.map(countOf);
    if (!left || left[0] === null) throw new UnknownReplyError("the deletion of a Discord server's people");
    if (left[0] !== 0) throw new UnknownReplyError("the people given Discord roles, not all forgotten");
  }
  const gone = repliesFor(await redisPipeline([["DEL", serverKey(room), productsKey(room), membersKey(room)]]), 1)?.map(countOf);
  if (!gone || gone[0] === null || (gone[0] as number) > 3) throw new UnknownReplyError("the deletion of a Discord server");
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

/**
 * The roles each product gives, read exactly, for the check that takes roles back (lib/discord-access.ts
 * checkMember): a reply that is not a whole list of field and value, or a value that is not a list, throws
 * UnknownReplyError, so an unknown read never counts as "no product gives a role" and takes a paying buyer's roles.
 */
export async function productRolesOrThrow(room: string): Promise<Map<string, string[]>> {
  const what = "the roles each product gives in Discord";
  const pairs = stringList(oneReply(await redisPipeline([["HGETALL", productsKey(room)]]), what));
  if (!pairs || pairs.length % 2 !== 0) throw new UnknownReplyError(what);
  const out = new Map<string, string[]>();
  for (let i = 0; i < pairs.length; i += 2) {
    const value = parse<unknown>(pairs[i + 1]);
    // Every member must be a role id, and a product kept at all gives one (setProductRoles deletes an empty list):
    // cleanRoles would drop an invalid member silently, so [7] would read as "no role" and end paid access (Codex Z on #2932).
    if (!Array.isArray(value) || !value.length || !value.every((role) => typeof role === "string" && SNOWFLAKE.test(role))) throw new UnknownReplyError(what);
    const roles = cleanRoles(value);
    if (roles.length) out.set(pairs[i], roles);
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

/**
 * One person given roles, read exactly: null only when none is kept for that id (the exact null). A missing slot or
 * a record of another shape (not JSON, no address, roles that are not a list of strings) throws UnknownReplyError,
 * so nothing takes an unknown read as "nobody", whose roles would never be taken back (sweep A2 finding 4).
 */
export async function readMember(room: string, userId: string): Promise<Member | null> {
  if (!SNOWFLAKE.test(userId)) return null;
  const raw = oneReply(await redisPipeline([["HGET", membersKey(room), userId]]), "a Discord member record");
  if (raw === null) return null;
  const member = parse<Record<string, unknown>>(raw);
  if (!member || typeof member !== "object" || Array.isArray(member) || typeof member.e !== "string" || !Array.isArray(member.r) || !member.r.every((r) => typeof r === "string")) {
    throw new UnknownReplyError("a Discord member record");
  }
  return member as unknown as Member;
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

/**
 * The Discord account an address brought in, if any: null only when no link is kept (the exact null). A missing
 * slot or a reply that is not a Discord id throws UnknownReplyError, never "no account" (sweep A2 finding 4).
 */
export async function accountOf(room: string, email: string): Promise<string | null> {
  const raw = oneReply(await redisPipeline([["GET", addressKey(room, email)]]), "the Discord account an address brought in");
  if (raw === null) return null;
  if (typeof raw === "string" && SNOWFLAKE.test(raw)) return raw;
  throw new UnknownReplyError("the Discord account an address brought in");
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
  // Read exactly: an unknown reply throws before anything is deleted, never leaving the address's link behind as "not this id's".
  // Only the exact null or a Discord id is a known link: any other present reply throws (Codex Z on #2932).
  const held = oneReply(await redisPipeline([["GET", addressKey(room, email)]]), "the Discord account an address brought in");
  if (held !== null && !(typeof held === "string" && SNOWFLAKE.test(held))) throw new UnknownReplyError("the Discord account an address brought in");
  const commands: (string | number)[][] = [
    ["HDEL", membersKey(room), userId],
    ["ZREM", DUE_KEY, `${sid}|${userId}`],
    ...(held === userId ? [["DEL", addressKey(room, email)]] : []),
  ];
  // The deletes are read too: a missing, short or queued answer is not "forgotten", so the erasure is retried.
  // Each command targets exactly one field, member or key, so only 0 or 1 is known; any other count is unknown (Codex Z on #2932).
  const replies = repliesFor(await redisPipeline(commands), commands.length);
  if (!replies || !replies.every((reply) => { const count = countOf(reply); return count === 0 || count === 1; })) {
    throw new UnknownReplyError("the deletion of a Discord member");
  }
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
