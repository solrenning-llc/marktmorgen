/**
 * Who may listen to a private podcast (lib/podcast-rules.ts).
 *
 *   nl:pod:t:<sha(token)>              the feed a token opens: store, product, address
 *   nl:pod:by:<store>:<product>:<key>  the token an address already has, so it keeps one feed
 *   nl:pod:ok:<store>:<product>:<key>  whether that address holds the product, for a few minutes
 *   nl:pod:n:<sha(token)>:<day>        how often a feed was put together that day
 *
 * A feed address is a secret: whoever has it can listen. So every read of it
 * and every episode fetched asks whether its address still holds the product
 * (lib/community-access.ts holdsProducts, the same answer a community's door
 * gives), and a feed that is fetched far more than any one person's apps do
 * is slowed down.
 *
 * What a feed costs, and why it is answered the way it is. A podcast app
 * asks for its feed about once an hour, day and night, whether or not
 * anybody is listening, and each time it was answered by putting the feed
 * together again: the store, the product, whether the address still holds
 * it, the episodes. A subscriber cost about three visits a day that way and
 * was counted as none. Two things now hold it:
 *
 *   - The feed is answered once and then kept by the CDN for
 *     FEED_SHARED_SECONDS, so an app's hourly question is answered without
 *     anything being put together. A new episode reaches an app within that
 *     time of being published. An address whose access has ended keeps its
 *     list of episodes that long too, and no longer: each episode itself is
 *     asked about every time it is fetched, and is refused at once.
 *   - A subscriber is one visit to the store on each day their app asks
 *     (lib/traffic.ts, recordListener), which is what the day costs at the
 *     most: the feed can be put together FEED_READS_A_DAY times a day for
 *     one address and no more.
 */
import { withinStore } from "@/lib/metered-limits";
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, scanPage, stringList } from "@/lib/redis-reply";
import { type DataOwner, orderWrite, orderWriteOnce } from "@/lib/order-data";
import { holdsProducts } from "@/lib/community-access";
import { sendEmail } from "@/lib/email";
import { essentialLimitState, withinLimit } from "@/lib/request-guard";
import { FEED_TOKEN } from "@/lib/podcast-rules";
import { coursesWords } from "@/lib/buyer-words/courses";
import { type Listing, MAX_STORE_BYTES, type Store, storeForHandle } from "@/lib/store";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const addressKey = (email: string) => sha(`nimbus-podcast:${normaliseEmail(email)}`).slice(0, 32);
export const tokenKey = (token: string) => `nl:pod:t:${sha(token)}`;
const byKey = (sid: string, pid: string, email: string) => `nl:pod:by:${sid}:${pid}:${addressKey(email)}`;
const okKey = (sid: string, pid: string, email: string) => `nl:pod:ok:${sid}:${pid}:${addressKey(email)}`;
/**
 * The store's products that ever had a private feed, noted with each new grant in the same counted write, so a
 * person's deletion still finds a product's feeds after the catalog forgot it (nuvem I privacy audit, 13 November
 * 2026). A removed product stays: its grants are reached by every deletion and by the walk at store closing.
 */
const pidsKey = (sid: string) => `nl:pod:pids:${sid}`;

export type FeedGrant = { s: string; h: string; p: string; e: string };

/** The feed token for this address and product: the one it already has, or a new one. */
export async function feedToken(store: Store, productId: string, email: string): Promise<string | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  const sid = store.statsId;
  // An unknown read of the index is not "no feed yet" (CX-123 rule 24): nothing is written on it.
  const existing = await indexedToken(sid, productId, email);
  if (existing === undefined) return null;
  const grant: FeedGrant = { s: sid, h: store.handle, p: productId, e: normaliseEmail(email) };
  if (existing !== null && FEED_TOKEN.test(existing)) return handedAgain(store, existing, grant);
  const token = randomBytes(24).toString("hex");
  // A listener's access is kept for good: counted in the store's room at what it adds (lib/order-data.ts).
  // The index, the product's note and the grant that holds the address are written in one script behind the index's
  // SET NX (orderWriteOnce; Codex V on #4471): a person's deletion sees all three or none of them, so it never deletes
  // an index whose grant is written after it, which would keep the address in a grant no index leads to. A refused
  // command takes the index back in the same script, so no index is left without its grant.
  const wrote = await orderWriteOnce(store, [
    ["SET", byKey(sid, productId, email), token, "NX"],
    ["SADD", pidsKey(sid), productId],
    ["SET", tokenKey(token), JSON.stringify(grant), "NX"],
  ]);
  // Another call kept a token first: that one is handed out, once its grant is there.
  if ("held" in wrote) return FEED_TOKEN.test(wrote.held) ? handedAgain(store, wrote.held, grant) : null;
  // Only "OK" wrote the grant: on any other reply no link is given to a feed that may not open.
  return wrote.replies[2] === "OK" ? token : null;
}

/**
 * A feed this address already has, handed out again: its product is noted first (Codex P, T, L and X5 on #4471). A
 * feed granted before the note existed (13 November 2026) was never noted, so once its product left the catalog a
 * person's deletion could not find it. The SADD is counted (lib/order-data.ts charges only a member it adds; one
 * already there charges nothing) and read exactly: orderWrite throws on any reply but 0 or 1, and no link is handed
 * out then. Feeds nobody asks for again are noted by the walk below (notePodcastProducts).
 */
async function handedAgain(store: Store, token: string, grant: FeedGrant): Promise<string | null> {
  await orderWrite(store, [["SADD", pidsKey(grant.s), grant.p]]);
  return withGrant(store, token, grant);
}

/**
 * An indexed token, handed out only once its grant is there (finding by Claude 6): an index whose grant write failed
 * would otherwise give a link that opens no feed, for good. The grant is read exactly; a missing one is written
 * again (SET NX, so a concurrent write is never overwritten), which keeps the buyer's existing feed address working.
 * An unknown reply, or a grant for another store, product or address, hands out nothing.
 */
async function withGrant(store: Store, token: string, grant: FeedGrant): Promise<string | null> {
  const held = await grantOf(token);
  if (held === undefined) return null;
  if (held !== null) return sameGrant(held, grant) ? token : null;
  const [made] = await orderWrite(store, [["SET", tokenKey(token), JSON.stringify(grant), "NX"]]);
  if (made === "OK") return token;
  if (made !== null) return null;
  // null: another call wrote it first; hand it out only if it is this address's grant.
  const again = await grantOf(token);
  return again && sameGrant(again, grant) ? token : null;
}

/** A grant's stored text: null where none, undefined where the reply is unknown. */
async function grantOf(token: string): Promise<string | null | undefined> {
  const reply = repliesFor(await redisPipeline([["GET", tokenKey(token)]]), 1);
  const value = reply?.[0];
  return value === null || typeof value === "string" ? value : undefined;
}

function sameGrant(raw: string, grant: FeedGrant): boolean {
  try {
    const g = JSON.parse(raw) as Partial<FeedGrant> | null;
    return !!g && g.s === grant.s && g.p === grant.p && g.e === grant.e;
  } catch {
    return false;
  }
}

/** The token one product's index holds for this address: text, null where none, undefined where the reply is unknown. */
async function indexedToken(sid: string, productId: string, email: string): Promise<string | null | undefined> {
  const reply = repliesFor(await redisPipeline([["GET", byKey(sid, productId, email)]]), 1);
  const value = reply?.[0];
  return value === null || typeof value === "string" ? value : undefined;
}

/**
 * The grant a feed token opens; null only when Redis says there is none. A reply in an unknown shape throws
 * UnknownReplyError, so the feed answers a server error its app asks again after, never "No such feed." (a 404).
 */
export async function readFeedToken(token: string): Promise<FeedGrant | null> {
  if (!FEED_TOKEN.test(token) || !isRedisConfigured()) return null;
  const reply = repliesFor(await redisPipeline([["GET", tokenKey(token)]]), 1);
  const raw = reply?.[0];
  if (raw === null) return null;
  if (typeof raw !== "string") throw new UnknownReplyError("a podcast feed's grant");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    // JSON.parse discards duplicate members and normalises escaped member names. Only its exact canonical text proves
    // that no competing routing evidence was lost while decoding (Codex N, #2608). Extra non-routing claims may remain
    // in storage, but are stripped from the returned grant below.
    if (raw !== JSON.stringify(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    if (![row.s, row.h, row.p, row.e].every((value) => typeof value === "string" && value.length > 0)) return null;
    return { s: row.s as string, h: row.h as string, p: row.p as string, e: row.e as string };
  } catch {
    return null;
  }
}

/** Whether this address may listen now: the creator always, a buyer while they hold it. */
export async function mayListen(store: Store, productId: string, email: string): Promise<boolean> {
  if (!store.statsId) return false;
  if (normaliseEmail(email) === normaliseEmail(store.email)) return true;
  return holdsProducts(store, [productId], email, okKey(store.statsId, productId, email), "1");
}

/** An episode fetched: counted, and refused past what any one listener's apps ask. */
export async function feedAllowed(token: string): Promise<boolean> {
  return withinLimit("podcast-feed", sha(token).slice(0, 32), 600, 3_600);
}

/** How long the CDN keeps a feed it was given, in seconds. */
export const FEED_SHARED_SECONDS = 4 * 60 * 60;
/**
 * How often a day one address's feed is put together again, at the most.
 * The CDN asks six times a day; the rest is for an app that moves between
 * parts of the world, each of which keeps its own copy.
 */
export const FEED_READS_A_DAY = 8;

/**
 * A feed about to be put together: counted, and refused past
 * FEED_READS_A_DAY in a day. Two commands in one request each time, the
 * count and its expiry (EXPIRE NX), because this runs every time a feed is
 * put together and is part of what that costs (tests/traffic-cost.ts,
 * COMMANDS.feed): sent with every count, an expiry lost once is given again
 * by the next, so no day key outlives its two days (finding L1 of Claude 4's
 * team on #2888). A count or an expiry that cannot be kept or read never
 * lets the feed through (CX-123 rule 24): it throws, and the feed answers a
 * server error that the app asks again after, never "Too many requests" for
 * hours. EXPIRE NX answers 1 when it set the expiry and 0 when one was
 * already there, which the day's first count cannot be.
 */
export async function feedReadAllowed(token: string, now = Date.now()): Promise<boolean> {
  if (!isRedisConfigured()) return true;
  const key = `nl:pod:n:${sha(token).slice(0, 32)}:${new Date(now).toISOString().slice(0, 10)}`;
  const reply = repliesFor(await redisPipeline([["INCR", key], ["EXPIRE", key, 2 * 86_400, "NX"]]), 2);
  const count = reply ? countOf(reply[0]) : null;
  if (count === null || count < 1) throw new UnknownReplyError("a podcast feed's day count");
  const expiry = reply ? countOf(reply[1]) : null;
  if (expiry === null || expiry > 1 || (count === 1 && expiry !== 1)) throw new UnknownReplyError("a podcast feed's day count expiry");
  return count <= FEED_READS_A_DAY;
}

/** What a feed's subscriber is told apart by for the day's visit: never the feed's address itself. */
export function listenerOf(token: string): string {
  return sha(`nimbus-listener:${token}`).slice(0, 32);
}

export type LinkResult = "sent" | "email" | "limited" | "error";

/**
 * Emails an address the page with its own feed, if it holds the product.
 * "sent" either way, so the form tells nobody who bought what.
 */
export async function sendFeedLink(input: { store: Store; product: Listing; email: string; ip: string; base: string; from: string }): Promise<LinkResult> {
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  const { store, product } = input;
  if (!(await withinStore("podcast-link-ip", `${store.handle}|${input.ip}`, 10, 3_600, store, "buyer"))) return "limited";
  const byAddress = await essentialLimitState("podcast-link-address", sha(normaliseEmail(raw)), 5, 3_600);
  if (byAddress !== "within") return byAddress === "exceeded" ? "limited" : "error";
  if (!(await mayListen(store, product.id, raw))) return "sent";
  const token = await feedToken(store, product.id, raw);
  if (!token) return "error";
  // In the store's language (lib/buyer-words/courses.ts).
  const w = coursesWords(store.language);
  const sent = await sendEmail({ meter: { by: "store", store: store, kind: "transactional" },
    from: input.from,
    to: normaliseEmail(raw),
    subject: w.podcastSubject(product.title).slice(0, 200),
    text: [
      w.podcastLead(product.title, store.name),
      "",
      `${input.base}/podcast/${product.id}?t=${token}`,
      "",
      w.podcastBody,
      "",
      w.sentBy(store.name),
    ].join("\n"),
  });
  return sent ? "sent" : "error";
}

/**
 * Deletes one person's private feeds in this store (lib/person-erasure.ts):
 * the feed's address stops working in their podcast app. A buyer who still
 * holds the podcast asks for a new one, as on a new device.
 */
export async function forgetPodcastPerson(store: Store, catalogIds: string[], email: string): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const sid = store.statsId;
  const productIds = await podcastProductIds(sid, store.createdAt, catalogIds, email);
  if (!productIds.length) return 0;
  // Read exactly before anything is deleted (CX-123 rule 24): the index is the only way back to the grant that holds
  // the address, so on an unknown read both stay, the step throws and the erasure says it is not finished.
  const held = (await indexedTokens(sid, productIds, email)).filter((t): t is string => t !== null);
  const reply = repliesFor(
    await redisPipeline([["DEL", ...productIds.flatMap((p) => [byKey(sid, p, email), okKey(sid, p, email)]), ...held.map(tokenKey)]]),
    1,
  );
  const gone = reply ? countOf(reply[0]) : null;
  if (gone === null) throw new UnknownReplyError("the deletion of a person's podcast feeds");
  return gone;
}

/**
 * The products a person's feeds are looked for in: the catalog and every product the store's set notes, removed
 * ones included. Read exactly: an unreadable set throws, so a deletion says it could not finish, never that there
 * was nothing to delete (rule 24). The set is whole only once the walk below has noted the products of every feed
 * granted before the set existed (Codex N1, P, T and X5 on #4471). A store made after the walk started cannot hold
 * such a feed: only the code before the note wrote them, and the walk runs only once this code is live (Claude 6 on
 * #4471). For any other store, until the walk is done, this person's own indexes in this store are looked for by a
 * read-only SCAN of at most NOTE_INLINE_PAGES pages; a SCAN that does not reach its end there, or does not read, throws,
 * so a deletion is never said to be done while an old grant may be left, and the copy of a person's data never leaves
 * out a feed the deletion would take away. A store's making time that does not read as a time is not "after": it waits
 * too. Nothing is written here. One run of the walk covers the whole database the daily backup accepts
 * (NOTE_PAGES_PER_RUN), so the wait is the time to the first hourly run after an update, where that holds.
 */
async function podcastProductIds(sid: string, createdAt: string, catalogIds: string[], email: string): Promise<string[]> {
  const read = await notedProducts(sid);
  const made = Date.parse(createdAt);
  const madeAfter = read.started !== null && /^\d{4}-\d{2}-\d{2}T/.test(createdAt) && Number.isFinite(made) && made >= read.started;
  const found = read.walked || madeAfter ? [] : await oldProductsOf(sid, email);
  return [...new Set([...catalogIds, ...read.members, ...found])];
}

/** The products of this address's feeds in this store, found by their indexes' names; throws unless the SCAN ends. */
async function oldProductsOf(sid: string, email: string): Promise<string[]> {
  const found = new Set<string>();
  let cursor = "0";
  for (let pages = 0; pages < NOTE_INLINE_PAGES; pages += 1) {
    const page = scanPage(await redisPipeline([["SCAN", cursor, "MATCH", `nl:pod:by:${sid}:*:${addressKey(email)}`, "COUNT", NOTE_PAGE_KEYS]]));
    if (!page) throw new UnknownReplyError("a person's private podcast feeds granted before the product note");
    for (const key of page.items) {
      const named = OLD_INDEX.exec(key);
      if (named && named[1] === sid) found.add(named[2]);
    }
    if (page.next === "0") return [...found];
    cursor = page.next;
  }
  throw new Error("the private podcast feeds granted before 13 November 2026 are still being noted");
}

/**
 * How many products the store's set notes (SCARD), for what a deletion may cost before it runs (lib/erasure-rules.ts,
 * ERASE_PER.podcastProducts). Read exactly: any reply but a whole count throws, and the deletion is not run.
 */
export async function podcastProductCount(sid: string | null): Promise<number> {
  if (!sid || !isRedisConfigured()) return 0;
  const count = countOf(repliesFor(await redisPipeline([["SCARD", pidsKey(sid)]]), 1)?.[0]);
  if (count === null) throw new UnknownReplyError("how many products have private podcast feeds");
  return count;
}

/**
 * Whether the walk is done, when it started (milliseconds, null before its first run), and the store's noted products,
 * in one request; any reply not in its exact shape throws. A start that is not a whole number of milliseconds is unknown.
 */
async function notedProducts(sid: string): Promise<{ walked: boolean; started: number | null; members: string[] }> {
  const replies = repliesFor(await redisPipeline([["HMGET", NOTE_WALK_KEY, "phase", "started"], ["SMEMBERS", pidsKey(sid)]]), 2);
  const fields = replies?.[0];
  const members = stringList(replies?.[1]);
  if (!replies || !Array.isArray(fields) || fields.length !== 2 || !fields.every((v) => v === null || typeof v === "string") || !members) {
    throw new UnknownReplyError("the products with private podcast feeds");
  }
  const [phase, started] = fields as (string | null)[];
  if (started !== null && !/^[0-9]{1,16}$/.test(started)) throw new UnknownReplyError("when the walk of feeds granted before the product note started");
  return { walked: phase === NOTE_DONE, started: started === null ? null : Number(started), members };
}

/**
 * The one-time walk that notes, in each store's set, the product of every private feed granted before the set
 * existed (13 November 2026; Codex N1, P, T and X5 on #4471): until then a feed's index was the only record of its
 * product, so a feed whose product left the catalog was out of a person's deletion's reach. Every index from before
 * is read by SCAN (MATCH NOTE_MATCH): a full walk returns every key that was there from its start to its end, and
 * every feed granted since notes its product in the same script as its index (feedToken), so once the walk ends the
 * sets name every product with a feed. It ends once: the company key NOTE_WALK_KEY says "done" and is kept, so later
 * runs read it and do nothing.
 *
 * Each page's products are noted before the cursor moves on: SADD through orderWrite, counted in the room of the store
 * the feed's grant names (its handle, read back to the same statsId) and, where no store answers to it, in the room
 * keyed by the statsId, as lib/product-updates.ts does for a grant; a member already noted charges nothing. Any reply
 * not in its exact shape throws and the cursor stays where it was, so the page is walked again (SADD is idempotent);
 * two runs at once can only walk a page twice. A key that does not read as an index is not one this code wrote.
 *
 * Bounded: `maxPages` pages (NOTE_PAGES_PER_RUN, from the hourly one-time jobs, app/api/cron/recount, which run it
 * first), the deadline,
 * and NOTE_STORE_READS stores whose products are not all noted yet: NOTE_RUN_COMMANDS commands and NOTE_RUN_BYTES bytes
 * at the most, a page taken at NOTE_PAGE_KEYS names (COUNT is a hint to Redis). How many runs the whole walk takes
 * depends on the size of the shared database, which is not known: its total cost is unknown, never zero
 * (docs/funded-exposure-review.md).
 */
export async function notePodcastProducts(deadline: number, maxPages = NOTE_PAGES_PER_RUN): Promise<NoteWalkReport> {
  const report: NoteWalkReport = { pages: 0, noted: 0, storeReads: 0, done: false };
  if (!isRedisConfigured()) return report;
  // Its start is written once, by its first run (HSETNX): a store made after it cannot hold a feed from before the note.
  const read = repliesFor(await redisPipeline([["HSETNX", NOTE_WALK_KEY, "started", String(Date.now())], ["HMGET", NOTE_WALK_KEY, "phase", "cursor"]]), 2);
  const state = read?.[1];
  const fields = Array.isArray(state) && state.length === 2 && state.every((v) => v === null || typeof v === "string") ? (state as (string | null)[]) : null;
  if (!read || (read[0] !== 0 && read[0] !== 1) || !fields) throw new UnknownReplyError("where the walk of feeds granted before the product note is");
  if (fields[0] === NOTE_DONE) return { ...report, done: true };
  let cursor = fields[1] ?? "0";
  if (!/^[0-9]+$/.test(cursor)) throw new UnknownReplyError("the walk of feeds granted before the product note: its cursor");
  while (report.pages < maxPages && Date.now() < deadline) {
    const page = scanPage(await redisPipeline([["SCAN", cursor, "MATCH", NOTE_MATCH, "COUNT", NOTE_PAGE_KEYS]]));
    if (!page) throw new UnknownReplyError("the walk of feeds granted before the product note: a page");
    const stores = new Map<string, { index: string; products: Set<string> }>();
    for (const key of page.items) {
      const named = OLD_INDEX.exec(key);
      if (!named) continue;
      const entry = stores.get(named[1]) ?? { index: key, products: new Set<string>() };
      entry.products.add(named[2]);
      stores.set(named[1], entry);
    }
    for (const [sid, { index, products }] of stores) {
      const ids = [...products];
      const there = repliesFor(await redisPipeline([["SMISMEMBER", pidsKey(sid), ...ids]]), 1)?.[0];
      if (!Array.isArray(there) || there.length !== ids.length || !there.every((v) => v === 0 || v === 1)) {
        throw new UnknownReplyError("the walk of feeds granted before the product note: whether a product is noted");
      }
      const missing = ids.filter((_, i) => there[i] === 0);
      if (!missing.length) continue;
      // The run's reads of stores are spent: it stops here, the cursor where it was. The next run walks this page again
      // and finds the products noted so far already there, so every run goes further (NOTE_STORE_READS).
      if (report.storeReads === NOTE_STORE_READS) return report;
      report.storeReads += 1;
      await orderWrite(await ownerOf(sid, index), missing.map((p) => ["SADD", pidsKey(sid), p]));
      report.noted += missing.length;
    }
    const done = page.next === "0";
    const moved = countOf(repliesFor(await redisPipeline([["HSET", NOTE_WALK_KEY, "phase", done ? NOTE_DONE : "walk", "cursor", page.next]]), 1)?.[0]);
    if (moved === null || moved > 2) throw new UnknownReplyError("where the walk of feeds granted before the product note is");
    report.pages += 1;
    cursor = page.next;
    if (done) return { ...report, done: true };
  }
  return report;
}

/** The room an old feed's product note is counted in: its store's, found by the handle its grant names. */
async function ownerOf(sid: string, index: string): Promise<DataOwner> {
  const token = repliesFor(await redisPipeline([["GET", index]]), 1)?.[0];
  if (token !== null && typeof token !== "string") throw new UnknownReplyError("an old private feed's index");
  const grant = token === null ? null : await readFeedToken(token);
  if (grant && grant.s === sid) {
    const store = await storeForHandle(grant.h);
    if (store && store.statsId === sid) return store;
  }
  return { statsId: sid };
}

export type NoteWalkReport = { pages: number; noted: number; storeReads: number; done: boolean };
/** The company's key for the walk: its phase ("walk", then NOTE_DONE for good), its cursor and when it started. */
export const NOTE_WALK_KEY = "nl:podnote:walk";
const NOTE_DONE = "done";
/** The names the walk reads: every feed's index. */
const NOTE_MATCH = "nl:pod:by:*";
const OLD_INDEX = /^nl:pod:by:([A-Za-z0-9_-]{1,80}):([A-Za-z0-9_-]{1,80}):[0-9a-f]{32}$/;
/**
 * Keys one SCAN examines (its COUNT, a hint to Redis): one command whatever the COUNT, and only the names that match
 * come back (Claude 6 on #4471); a page is still taken at this many names in what it may cost.
 */
export const NOTE_PAGE_KEYS = 1_000;
/**
 * Pages one run walks at the most: 200,000 keys, twice the whole database the daily backup accepts (lib/backup-parts.ts,
 * BACKUP_SCAN_PAGES pages of 500; a larger one fails the backup), so on such a database one run ends the walk.
 */
export const NOTE_PAGES_PER_RUN = 200;
/** Stores whose products one run notes at the most: each is a read of its index, its grant and its record, and a script. */
export const NOTE_STORE_READS = 50;
/** Commands each of those stores costs: the index's GET, the grant's GET, the handle's GET, the record's GET, the script. */
export const NOTE_STORE_COMMANDS = 5;
/**
 * Commands one run sends at the most: its start's HSETNX and where the walk is (HMGET); per page its SCAN, its cursor's
 * HSET and one SMISMEMBER per store on it, taken at one a name; and NOTE_STORE_READS stores. Priced in
 * tests/plan-cost-registry.ts (PODCAST_NOTE_RUN_USD) with NOTE_RUN_BYTES.
 */
export const NOTE_RUN_COMMANDS = 2 + NOTE_PAGES_PER_RUN * (2 + NOTE_PAGE_KEYS) + NOTE_STORE_READS * NOTE_STORE_COMMANDS;
/**
 * Bytes one run moves at the most: every name on its pages (an index's name is at most 204 bytes, counted at 256, with
 * its SMISMEMBER reply), and per store read its record (MAX_STORE_BYTES), its grant and the replies around it (4 KB).
 */
export const NOTE_RUN_BYTES = NOTE_PAGES_PER_RUN * NOTE_PAGE_KEYS * 256 + NOTE_STORE_READS * (MAX_STORE_BYTES + 4_096);
/** Pages of its own indexes a deletion or a copy reads at the most while the walk is unfinished (read only). */
export const NOTE_INLINE_PAGES = 4;

/**
 * The feed token each product's index holds for this address, in product order; null where none. A reply of
 * another length or shape, or a slot that is neither null nor text, throws UnknownReplyError. Text that is not a
 * token is kept as it is: deleting the key it would name is harmless, and its index goes with the erasure.
 */
async function indexedTokens(sid: string, productIds: string[], email: string): Promise<(string | null)[]> {
  const replies = repliesFor(await redisPipeline(productIds.map((p) => ["GET", byKey(sid, p, email)])), productIds.length);
  if (!replies || !replies.every((t) => t === null || typeof t === "string")) throw new UnknownReplyError("a person's podcast feed tokens");
  return replies as (string | null)[];
}

/**
 * The products whose private podcast feed a person has, for the copy of their
 * data (619 [SZ3], lib/person-copy.ts). The feed's secret address is not
 * given: it is a key, and the person has it in the email that sent it. Only
 * reads; never makes a feed.
 */
export async function feedsOf(store: Store, catalogIds: string[], email: string): Promise<string[]> {
  if (!store.statsId || !isRedisConfigured()) return [];
  // The same products a deletion reaches, so the copy shows every feed the deletion would take away.
  const productIds = await podcastProductIds(store.statsId, store.createdAt, catalogIds, email);
  if (!productIds.length) return [];
  const tokens = await indexedTokens(store.statsId, productIds, email);
  return productIds.filter((_, i) => typeof tokens[i] === "string" && FEED_TOKEN.test(tokens[i] as string));
}
