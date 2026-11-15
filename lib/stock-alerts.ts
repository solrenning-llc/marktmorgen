/**
 * Back-in-stock lists, kept (623 [SZ7], unit 2, 10 November 2026; the rules
 * are in lib/stock-alert-rules.ts).
 *
 *   nl:sa:<store>:<product>   hash    address → AlertEntry, ending WAIT_SECONDS after its latest write
 *   nl:sa:t:<sha(token)>      string  what a confirm or leave link is for, ending with its link
 *
 * <store> is the store's statsId. The waitlist's pattern (lib/waitlist.ts),
 * with its own keys and links, so a back-in-stock link can never confirm or
 * leave a waitlist place, nor the other way round.
 *
 * Every write ends by itself and takes its room from the store's data room
 * (lib/store-data.ts) before it is made; an address's place and its leave
 * link for as long as the list, its confirm link for CONFIRM_SECONDS. A
 * reply that is not exactly what was asked for is unknown, never "nobody"
 * or "done" (rule 24).
 *
 *   nl:sa:due                 sorted set  "<store id>|<product>" → when the
 *                                         restock job next looks at it
 *                                         (lib/stock-alert-send.ts)
 *
 * Asking returns the two links for the caller to email (lib/stock-alert-send.ts,
 * which takes the email from the store's figure first); confirming puts the
 * product on the restock job's list.
 */
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { noteForErasure } from "@/lib/erasure-index";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { MAX_STOCK_ALERTS, stockAlertSignup } from "@/lib/stock-alert-rules";
import { type DataChange, type DataStore, giveData, takeData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { CONFIRM_SECONDS, WAIT_SECONDS } from "@/lib/waitlist-rules";

/** A link's secret: 48 hex characters. */
export const ALERT_TOKEN = /^[0-9a-f]{48}$/;

/** One address's place: when it asked, when it confirmed (0: not yet), and its leave link. */
type AlertEntry = { at: number; ok: number; t: string };
type Grant = { s: string; p: string; e: string; k: "confirm" | "leave" };

const listKey = (sid: string, pid: string) => `nl:sa:${sid}:${pid}`;
/** The products the restock job looks at (lib/stock-alert-send.ts), by the store's own id, which no change of handle moves. */
export const STOCK_ALERT_DUE = "nl:sa:due";
export const dueMember = (storeId: string, productId: string) => `${storeId}|${productId}`;
const tokenKey = (token: string) => `nl:sa:t:${createHash("sha256").update(token).digest("hex")}`;
const slotOf = (pid: string) => `sa:${pid}`;
const newToken = () => randomBytes(24).toString("hex");
/** A place's confirm link for one day (UTC): derived from its secret leave link, 48 hex characters as every link. */
const confirmFor = (leave: string, now: number) => createHash("sha256").update(`confirm|${leave}|${new Date(now).toISOString().slice(0, 10)}`).digest("hex").slice(0, 48);
const nowSeconds = (ms: number) => Math.floor(ms / 1000);

function parseEntry(raw: unknown): AlertEntry | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { at, ok, t } = value;
    if (typeof at !== "number" || !Number.isInteger(at) || at <= 0) return null;
    if (typeof ok !== "number" || !Number.isInteger(ok) || ok < 0) return null;
    if (typeof t !== "string" || !ALERT_TOKEN.test(t)) return null;
    return { at, ok, t };
  } catch {
    return null;
  }
}

function parseGrant(raw: unknown): Grant | null {
  if (typeof raw !== "string" || raw.length > 1024) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { s, p, e, k } = value;
    if (typeof s !== "string" || !s || typeof p !== "string" || !p || typeof e !== "string" || !e) return null;
    if (k !== "confirm" && k !== "leave") return null;
    return { s, p, e, k };
  } catch {
    return null;
  }
}

/** What a link is for, read exactly: a grant, none (null), or unknown (throws). */
async function readGrant(token: string): Promise<Grant | null> {
  if (!ALERT_TOKEN.test(token) || !isRedisConfigured()) return null;
  const replies = repliesFor(await redisPipeline([["GET", tokenKey(token)]]), 1);
  if (!replies) throw new UnknownReplyError("a back-in-stock link");
  if (replies[0] === null) return null;
  return parseGrant(replies[0]);
}

/**
 * What a link is for, for the page that shows its button (a link only shows
 * it, because mail scanners open links too): its store, product and kind,
 * never its address. Null for none; throws when it cannot be read.
 */
export async function stockAlertLink(token: string): Promise<{ statsId: string; productId: string; kind: "confirm" | "leave" } | null> {
  const grant = await readGrant(token);
  return grant ? { statsId: grant.s, productId: grant.p, kind: grant.k } : null;
}

/** The bytes one address's place and its leave link take in the data room. */
function placeBytes(email: string, entry: AlertEntry, leave: Grant): number {
  return dataBytes([email, JSON.stringify(entry)], 1) + dataBytes([tokenKey(entry.t), JSON.stringify(leave)], 1);
}

export type AlertAsk = { ok: true; confirm: string; leave: string; again: boolean } | { ok: false; reason: "email" | "closed" | "full" | "unknown" };

/**
 * An address asks to be emailed when a sold-out limited product is back.
 * `left` is the product's units left as lib/stock.ts reads them. The place
 * counts only once its confirm link is used; asking again keeps the same
 * place and leave link and makes a new confirm link.
 */
export async function askStockAlert(input: { store: DataStore; productId: string; email: unknown; left: unknown; now?: number }): Promise<AlertAsk> {
  const { store, productId } = input;
  const now = input.now ?? Date.now();
  const raw = typeof input.email === "string" ? input.email.trim() : "";
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return { ok: false, reason: "email" };
  const shape = stockAlertSignup(input.left, 0);
  if (shape === "unknown") return { ok: false, reason: "unknown" };
  if (shape !== "open") return { ok: false, reason: "closed" };
  if (!store.statsId || !isRedisConfigured()) return { ok: false, reason: "unknown" };
  const sid = store.statsId;
  const email = normaliseEmail(raw);
  const key = listKey(sid, productId);

  const read = repliesFor(await redisPipeline([["HGET", key, email], ["HLEN", key]]), 2);
  const size = read ? countOf(read[1]) : null;
  if (!read || size === null) return { ok: false, reason: "unknown" };
  const before = read[0] === null ? null : parseEntry(read[0]);
  if (read[0] !== null && !before) return { ok: false, reason: "unknown" };
  if (!before && stockAlertSignup(input.left, size) === "full") return { ok: false, reason: "full" };

  const leave = before?.t ?? newToken();
  // The confirm link is the leave link's, for the day (never guessable: the leave link is secret): asking again the
  // same day makes the same email under the same key, which the service answers once (Codex G on #3620).
  const confirm = confirmFor(leave, now);
  const entry: AlertEntry = { at: before?.at ?? nowSeconds(now), ok: before?.ok ?? 0, t: leave };
  const grant = (k: Grant["k"]): Grant => ({ s: sid, p: productId, e: email, k });
  const changes: DataChange[] = [{ until: now + CONFIRM_SECONDS * 1000, bytes: dataBytes([tokenKey(confirm), JSON.stringify(grant("confirm"))], 1) }];
  if (!before) changes.push({ slot: slotOf(productId), bytes: placeBytes(email, entry, grant("leave")) });
  const taken = await takeData(store, changes, now);
  if (!taken.ok) return { ok: false, reason: taken.reason === "full" ? "full" : "unknown" };

  // The place, written in one step only over what was read: a new address only while it is still absent and the list
  // has room, an address asking again only over its own entry as read (Codex G on #3616: two new addresses at once for
  // the last place). 1 written, 0 changed since it was read, -1 full.
  const placed = repliesFor(await redisPipeline([["EVAL", ADD_PLACE, 1, key, email, read[0] === null ? "" : String(read[0]), JSON.stringify(entry), MAX_STOCK_ALERTS, WAIT_SECONDS]]), 1);
  const outcome = placed ? placed[0] : null;
  if (outcome === -1 || outcome === 0) {
    // Nothing written: the room taken for it comes back, and no link goes out.
    await giveData(store, changes, now).catch((error) => console.error("giving back a back-in-stock place's room failed", error));
    return { ok: false, reason: outcome === -1 ? "full" : "unknown" };
  }
  // Not exactly written: no link goes out. The room stays taken, the safe way to be wrong.
  if (outcome !== 1) return { ok: false, reason: "unknown" };
  const commands: (string | number)[][] = [
    ["SET", tokenKey(confirm), JSON.stringify(grant("confirm")), "EX", CONFIRM_SECONDS],
    ["SET", tokenKey(leave), JSON.stringify(grant("leave")), "EX", WAIT_SECONDS],
    ...noteForErasure(sid, email, tokenKey(confirm), now),
    ...noteForErasure(sid, email, tokenKey(leave), now),
  ];
  const wrote = repliesFor(await redisPipeline(commands), commands.length);
  if (!wrote || wrote[0] !== "OK" || wrote[1] !== "OK") return { ok: false, reason: "unknown" };
  return { ok: true, confirm, leave, again: Boolean(before) };
}

/**
 * A place written in one step: ARGV[2] empty for a new address, written only while the field is absent and the list
 * holds fewer than ARGV[4]; otherwise only over exactly the entry read. 1 written, 0 changed since read, -1 full.
 */
export const ADD_PLACE = `-- marktmorgen:stock-alert-add:v1
local current = redis.call('HGET', KEYS[1], ARGV[1])
if ARGV[2] == '' then
  if current then return 0 end
  if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[4]) then return -1 end
elseif current ~= ARGV[2] then
  return 0
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[5])
return 1`;

/**
 * A place confirmed only over exactly the entry the confirmation read, in one step: a leave pressed in between (its
 * HDEL) is never undone by the confirmation's write (Codex G on #3616). 1 written, 0 changed since it was read.
 */
export const CONFIRM_PLACE = `-- marktmorgen:stock-alert-confirm:v1
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
  redis.call('EXPIRE', KEYS[1], ARGV[4])
  return 1
end
return 0`;

/**
 * The confirm link used on the store's own page: the place now counts, and
 * the product is put on the restock job's list (STOCK_ALERT_DUE), to be
 * looked at on its next run. Pressing again puts it there again, so a lost
 * write is mended by the same button.
 */
export async function confirmStockAlert(token: string, store: DataStore, now = Date.now()): Promise<{ ok: true; productId: string } | { ok: false }> {
  const grant = await readGrant(token);
  if (!grant || grant.k !== "confirm" || !store.statsId || store.statsId !== grant.s) return { ok: false };
  // Without the store's own id the restock job could not find it again: nothing is confirmed (unknown, rule 24).
  if (!store.sid) throw new UnknownReplyError("the store a back-in-stock list belongs to");
  const key = listKey(grant.s, grant.p);
  const due: (string | number)[] = ["ZADD", STOCK_ALERT_DUE, now, dueMember(store.sid, grant.p)];
  // Read again when the place changed under the write (asked again meanwhile, say), a few times at most.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const read = repliesFor(await redisPipeline([["HGET", key, grant.e]]), 1);
    if (!read) throw new UnknownReplyError("a back-in-stock place");
    const entry = parseEntry(read[0]);
    if (!entry) return { ok: false };
    if (!entry.ok) {
      // Confirmed only over exactly the entry read (CONFIRM_PLACE): a leave pressed in between is never undone.
      const wrote = repliesFor(await redisPipeline([["EVAL", CONFIRM_PLACE, 1, key, grant.e, String(read[0]), JSON.stringify({ ...entry, ok: nowSeconds(now) }), WAIT_SECONDS]]), 1);
      const done = wrote ? countOf(wrote[0]) : null;
      if (done === null || done > 1) throw new UnknownReplyError("a back-in-stock confirmation");
      if (done === 0) continue;
    }
    const added = repliesFor(await redisPipeline([due]), 1);
    if (!added || countOf(added[0]) === null) throw new UnknownReplyError("a back-in-stock confirmation");
    return { ok: true, productId: grant.p };
  }
  throw new UnknownReplyError("a back-in-stock confirmation");
}

/** The leave link: the place and the link go, and their room comes back. */
export async function leaveStockAlert(token: string, store: DataStore, now = Date.now()): Promise<boolean> {
  const grant = await readGrant(token);
  if (!grant || grant.k !== "leave" || !store.statsId || store.statsId !== grant.s) return false;
  const key = listKey(grant.s, grant.p);
  const read = repliesFor(await redisPipeline([["HGET", key, grant.e]]), 1);
  if (!read) throw new UnknownReplyError("a back-in-stock place");
  const entry = parseEntry(read[0]);
  // The place goes first and its answer is checked before the link is spent:
  // a delete not known (anything but 0 or 1) is unknown, never "you left", and
  // the link still works for another try (Claude 1 on #3616, rule 24).
  const what = "leaving a back-in-stock list";
  const place = repliesFor(await redisPipeline([["HDEL", key, grant.e]]), 1);
  const removed = place ? countOf(place[0]) : null;
  if (removed === null || removed > 1) throw new UnknownReplyError(what);
  if (entry && removed === 1) await giveData(store, [{ slot: slotOf(grant.p), bytes: placeBytes(grant.e, entry, grant) }], now);
  const link = repliesFor(await redisPipeline([["DEL", tokenKey(token)]]), 1);
  const linkGone = link ? countOf(link[0]) : null;
  if (linkGone === null || linkGone > 1) throw new UnknownReplyError(what);
  return true;
}

/** Every address read from one list, each place exactly; throws when any part cannot be read. */
async function readList(sid: string, productId: string): Promise<[string, AlertEntry][]> {
  const what = "a back-in-stock list";
  const replies = repliesFor(await redisPipeline([["HGETALL", listKey(sid, productId)]]), 1);
  const flat = replies ? stringList(replies[0]) : null;
  if (!flat || flat.length % 2 !== 0) throw new UnknownReplyError(what);
  const out: [string, AlertEntry][] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const entry = parseEntry(flat[i + 1]);
    if (!entry) throw new UnknownReplyError(what);
    out.push([flat[i], entry]);
  }
  return out;
}

/** Every address on one list, each with whether it confirmed. Throws UnknownReplyError rather than answer "nobody". */
export async function stockAlertAddresses(store: DataStore, productId: string): Promise<{ email: string; confirmed: boolean }[]> {
  if (!store.statsId || !isRedisConfigured()) throw new UnknownReplyError("a back-in-stock list");
  return (await readList(store.statsId, productId)).map(([email, entry]) => ({ email, confirmed: entry.ok > 0 }));
}

/**
 * Whether each of these addresses still has a confirmed place, read exactly
 * just before an email goes: its leave link when it has, null for one that
 * left (an exact nil) or is not confirmed; throws UnknownReplyError when any
 * reply is out of shape.
 */
export async function stillWaiting(store: DataStore, productId: string, emails: string[]): Promise<(string | null)[]> {
  if (!emails.length) return [];
  if (!store.statsId || !isRedisConfigured()) throw new UnknownReplyError("a back-in-stock list");
  const what = "a back-in-stock list";
  const replies = repliesFor(await redisPipeline([["HMGET", listKey(store.statsId, productId), ...emails]]), 1);
  const rows = replies ? repliesFor(replies[0], emails.length) : null;
  if (!rows) throw new UnknownReplyError(what);
  return rows.map((row) => {
    if (row === null) return null;
    const entry = parseEntry(row);
    if (!entry) throw new UnknownReplyError(what);
    return entry.ok > 0 ? entry.t : null;
  });
}

/** The confirmed addresses to email when the product is back. Throws UnknownReplyError rather than answer "nobody". */
export async function confirmedForRestock(store: DataStore, productId: string): Promise<string[]> {
  if (!store.statsId || !isRedisConfigured()) throw new UnknownReplyError("a back-in-stock list");
  return (await readList(store.statsId, productId)).filter(([, entry]) => entry.ok > 0).map(([email]) => email);
}

/** After the restock email: the addresses it went to are deleted, with their leave links, and their room comes back. */
export async function clearStockAlerts(store: DataStore, productId: string, emails: string[], now = Date.now()): Promise<number> {
  if (!store.statsId || !emails.length || !isRedisConfigured()) return 0;
  const sid = store.statsId;
  const key = listKey(sid, productId);
  const addresses = emails.map(normaliseEmail);
  const read = repliesFor(await redisPipeline(addresses.map((email) => ["HGET", key, email])), addresses.length);
  if (!read) throw new UnknownReplyError("a back-in-stock list");
  const places = addresses.flatMap((email, i) => {
    const entry = parseEntry(read[i]);
    return entry ? [{ email, entry }] : [];
  });
  if (!places.length) return 0;
  const gone = repliesFor(
    await redisPipeline(places.flatMap(({ email, entry }) => [["HDEL", key, email], ["DEL", tokenKey(entry.t)]])),
    places.length * 2,
  );
  // Every reply a count: one out of shape is unknown, never "not there" (rule 24), so the restock job keeps its batch.
  if (!gone || gone.some((reply) => countOf(reply) === null)) throw new UnknownReplyError("clearing a back-in-stock list");
  const cleared = places.filter((_, i) => gone[i * 2] === 1);
  const leave = (email: string): Grant => ({ s: sid, p: productId, e: email, k: "leave" });
  if (cleared.length) await giveData(store, [{ slot: slotOf(productId), bytes: cleared.reduce((sum, p) => sum + placeBytes(p.email, p.entry, leave(p.email)), 0) }], now);
  return cleared.length;
}

/**
 * Takes one address off every back-in-stock list of the store
 * (lib/person-erasure.ts). Its links are noted for erasure when made
 * (lib/erasure-index.ts), and go with the person's other links.
 */
export async function forgetStockAlertPerson(sid: string | null, productIds: string[], email: string): Promise<number> {
  if (!sid || !productIds.length || !isRedisConfigured()) return 0;
  const address = normaliseEmail(email);
  const replies = repliesFor(await redisPipeline(productIds.map((p) => ["HDEL", listKey(sid, p), address])), productIds.length);
  if (!replies) throw new UnknownReplyError("forgetting a person's back-in-stock places");
  let gone = 0;
  for (const reply of replies) {
    const n = countOf(reply);
    if (n === null) throw new UnknownReplyError("forgetting a person's back-in-stock places");
    gone += n;
  }
  return gone;
}

/**
 * A person's back-in-stock places, for the copy of their data (lib/person-copy.ts):
 * when they asked and when they confirmed (0: not yet). The secret in their
 * links is left out. Only reads; anything unreadable throws.
 */
export async function stockAlertsOf(sid: string | null, productIds: string[], email: string): Promise<{ product: string; asked: number; confirmed: number }[]> {
  if (!sid || !productIds.length || !isRedisConfigured()) return [];
  const address = normaliseEmail(email);
  const what = "a person's back-in-stock places";
  const replies = repliesFor(await redisPipeline(productIds.map((p) => ["HGET", listKey(sid, p), address])), productIds.length);
  if (!replies) throw new UnknownReplyError(what);
  return productIds.flatMap((product, i) => {
    if (replies[i] === null) return [];
    const entry = parseEntry(replies[i]);
    if (!entry) throw new UnknownReplyError(what);
    return [{ product, asked: entry.at, confirmed: entry.ok }];
  });
}
