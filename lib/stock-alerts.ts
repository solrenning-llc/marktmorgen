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
 * No route, page or email uses this yet (the next unit): asking returns the
 * two links for the caller to email, after taking the email from the store's
 * allowance.
 */
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { noteForErasure } from "@/lib/erasure-index";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { stockAlertSignup } from "@/lib/stock-alert-rules";
import { type DataChange, type DataStore, giveData, takeData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { CONFIRM_SECONDS, WAIT_SECONDS } from "@/lib/waitlist-rules";

/** A link's secret: 48 hex characters. */
export const ALERT_TOKEN = /^[0-9a-f]{48}$/;

/** One address's place: when it asked, when it confirmed (0: not yet), and its leave link. */
type AlertEntry = { at: number; ok: number; t: string };
type Grant = { s: string; p: string; e: string; k: "confirm" | "leave" };

const listKey = (sid: string, pid: string) => `nl:sa:${sid}:${pid}`;
const tokenKey = (token: string) => `nl:sa:t:${createHash("sha256").update(token).digest("hex")}`;
const slotOf = (pid: string) => `sa:${pid}`;
const newToken = () => randomBytes(24).toString("hex");
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
  const confirm = newToken();
  const entry: AlertEntry = { at: before?.at ?? nowSeconds(now), ok: before?.ok ?? 0, t: leave };
  const grant = (k: Grant["k"]): Grant => ({ s: sid, p: productId, e: email, k });
  const changes: DataChange[] = [{ until: now + CONFIRM_SECONDS * 1000, bytes: dataBytes([tokenKey(confirm), JSON.stringify(grant("confirm"))], 1) }];
  if (!before) changes.push({ slot: slotOf(productId), bytes: placeBytes(email, entry, grant("leave")) });
  const taken = await takeData(store, changes, now);
  if (!taken.ok) return { ok: false, reason: taken.reason === "full" ? "full" : "unknown" };

  const commands: (string | number)[][] = [
    ["HSET", key, email, JSON.stringify(entry)],
    ["EXPIRE", key, WAIT_SECONDS],
    ["SET", tokenKey(confirm), JSON.stringify(grant("confirm")), "EX", CONFIRM_SECONDS],
    ["SET", tokenKey(leave), JSON.stringify(grant("leave")), "EX", WAIT_SECONDS],
    ...noteForErasure(sid, email, tokenKey(confirm), now),
    ...noteForErasure(sid, email, tokenKey(leave), now),
  ];
  const wrote = repliesFor(await redisPipeline(commands), commands.length);
  // Not exactly written: no link goes out. The room stays taken, the safe way to be wrong.
  if (!wrote || countOf(wrote[0]) === null || wrote[1] !== 1 || wrote[2] !== "OK" || wrote[3] !== "OK") return { ok: false, reason: "unknown" };
  return { ok: true, confirm, leave, again: Boolean(before) };
}

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

/** The confirm link used on the store's own page: the place now counts. */
export async function confirmStockAlert(token: string, store: DataStore, now = Date.now()): Promise<{ ok: true; productId: string } | { ok: false }> {
  const grant = await readGrant(token);
  if (!grant || grant.k !== "confirm" || !store.statsId || store.statsId !== grant.s) return { ok: false };
  const key = listKey(grant.s, grant.p);
  // Read again when the place changed under the write (asked again meanwhile, say), a few times at most.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const read = repliesFor(await redisPipeline([["HGET", key, grant.e]]), 1);
    if (!read) throw new UnknownReplyError("a back-in-stock place");
    const entry = parseEntry(read[0]);
    if (!entry) return { ok: false };
    if (entry.ok) return { ok: true, productId: grant.p };
    const wrote = repliesFor(await redisPipeline([["EVAL", CONFIRM_PLACE, 1, key, grant.e, String(read[0]), JSON.stringify({ ...entry, ok: nowSeconds(now) }), WAIT_SECONDS]]), 1);
    const done = wrote ? countOf(wrote[0]) : null;
    if (done === null || done > 1) throw new UnknownReplyError("a back-in-stock confirmation");
    if (done === 1) return { ok: true, productId: grant.p };
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
  if (!gone) throw new UnknownReplyError("clearing a back-in-stock list");
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
