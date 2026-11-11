/**
 * Who may listen to a private podcast (lib/podcast-rules.ts).
 *
 *   nl:pod:t:<sha(token)>              the feed a token opens: store, product, address
 *   nl:pod:by:<store>:<product>:<key>  the token an address already has, so it keeps one feed
 *   nl:pod:ok:<store>:<product>:<key>  whether that address holds the product, for a few minutes
 *   nl:pod:n:<sha(token)>:<day>        how often a feed was put together that day
 *   nl:pod:ls:<store>:<product>        every address with a feed of that product (since 9 November 2026), so
 *                                      removing the product finds each one's feed and deletes it
 *   nl:pod:gone:<store>                products removed whose feeds that list may not all name (made before it began):
 *                                      a person's erasure and the copy of their data look there too
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
import { UnknownReplyError, countOf, listSlots, repliesFor, scanPage, stringList } from "@/lib/redis-reply";
import { orderWrite } from "@/lib/order-data";
import { holdsProducts } from "@/lib/community-access";
import { sendEmail } from "@/lib/email";
import { withinLimit } from "@/lib/request-guard";
import { FEED_TOKEN } from "@/lib/podcast-rules";
import { coursesWords } from "@/lib/buyer-words/courses";
import type { Listing, Store } from "@/lib/store";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const addressKey = (email: string) => sha(`nimbus-podcast:${normaliseEmail(email)}`).slice(0, 32);
export const tokenKey = (token: string) => `nl:pod:t:${sha(token)}`;
const byKey = (sid: string, pid: string, email: string) => `nl:pod:by:${sid}:${pid}:${addressKey(email)}`;
const okKey = (sid: string, pid: string, email: string) => `nl:pod:ok:${sid}:${pid}:${addressKey(email)}`;
/** Every address with a feed of one product, by its addressKey (audit A1, 9 November 2026). */
const listenersKey = (sid: string, pid: string) => `nl:pod:ls:${sid}:${pid}`;
/** The products removed whose feeds listenersKey may not all name, so a person's erasure still reaches them. */
const goneKey = (sid: string) => `nl:pod:gone:${sid}`;
/**
 * The member of listenersKey a podcast is made with (app/api/store/podcast, "enable"): every feed of that product was
 * listed as it was made. A list without it may miss feeds made before lists began (a podcast made before 9 November
 * 2026), so removing that product also notes it in goneKey.
 */
const LISTED_FROM_START = "+";
const ADDRESS_KEY = /^[0-9a-f]{32}$/;

export type FeedGrant = { s: string; h: string; p: string; e: string };

/** The feed token for this address and product: the one it already has, or a new one. */
export async function feedToken(store: Store, productId: string, email: string): Promise<string | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  const sid = store.statsId;
  // An unknown read of the index is not "no feed yet" (CX-123 rule 24): nothing is written on it.
  const existing = await indexedToken(sid, productId, email);
  if (existing === undefined) return null;
  const grant: FeedGrant = { s: sid, h: store.handle, p: productId, e: normaliseEmail(email) };
  if (existing !== null && FEED_TOKEN.test(existing)) return withGrant(store, existing, grant);
  const token = randomBytes(24).toString("hex");
  // A listener's access is kept for good: counted in the store's room at what it adds (lib/order-data.ts).
  // Only "OK" made the index and only null says another token was kept first: any other reply is unknown, and
  // writing a grant then could leave one holding the address that no index leads to, which an erasure never finds.
  const [set] = await orderWrite(store, [["SET", byKey(sid, productId, email), token, "NX"]]);
  if (set === null) {
    const again = await indexedToken(sid, productId, email);
    return typeof again === "string" && FEED_TOKEN.test(again) ? withGrant(store, again, grant) : null;
  }
  if (set !== "OK") return null;
  // Only "OK" wrote the grant: on any other reply no link is given to a feed that may not open.
  // Listed with its product in the same write (audit A1), so removing the product finds this feed and deletes it.
  const [made] = await orderWrite(store, [["SET", tokenKey(token), JSON.stringify(grant)], ["SADD", listenersKey(sid, productId), addressKey(email)]]);
  return made === "OK" && (await stillIndexed(grant, token)) ? token : null;
}

/**
 * After a grant is written, whether the index still leads to its token (Claude 4's focal on #3473, MEDIUM): a removal
 * or an erasure that deleted the index (and the grant) between the index read and this write would otherwise leave a
 * grant holding the address that no index, no list and no erasure reaches. When the index no longer leads to it, or its
 * read is unknown, the grant just written is deleted and no link is given; a deletion not confirmed throws
 * UnknownReplyError. While the index leads to it, any later removal or erasure deletes both in one DEL.
 */
async function stillIndexed(grant: FeedGrant, token: string): Promise<boolean> {
  if ((await indexedToken(grant.s, grant.p, grant.e)) === token) return true;
  const reply = repliesFor(await redisPipeline([["DEL", tokenKey(token)]]), 1);
  const gone = reply ? countOf(reply[0]) : null;
  if (gone === null || gone > 1) throw new UnknownReplyError("a podcast feed's grant written after its index was deleted");
  return false;
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
  const [made] = await orderWrite(store, [["SET", tokenKey(token), JSON.stringify(grant), "NX"], ["SADD", listenersKey(grant.s, grant.p), addressKey(grant.e)]]);
  if (made === "OK") return (await stillIndexed(grant, token)) ? token : null;
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
    const g = JSON.parse(raw) as FeedGrant;
    return typeof g.s === "string" && typeof g.p === "string" && typeof g.e === "string" ? g : null;
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
  if (!(await withinStore("podcast-link-ip", `${store.handle}:${input.ip}`, 10, 3_600, store, "buyer"))) return "limited";
  if (!(await withinLimit("podcast-link-address", sha(normaliseEmail(raw)), 5, 3_600))) return "limited";
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
export async function forgetPodcastPerson(store: Store, current: string[], email: string): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const sid = store.statsId;
  // And the products removed whose feeds no list may lead to (audit A1): a feed outlives its product only there.
  const productIds = await withGone(sid, current);
  if (!productIds.length) return 0;
  // Read exactly before anything is deleted (CX-123 rule 24): the index is the only way back to the grant that holds
  // the address, so on an unknown read both stay, the step throws and the erasure says it is not finished.
  const indexed = await indexedTokens(sid, productIds, email);
  const held = indexed.filter((t): t is string => t !== null);
  // And off each product's list of listeners (audit A1): an address is listed only beside a feed of that product.
  const listed = productIds.filter((_, i) => indexed[i] !== null).map((p): (string | number)[] => ["SREM", listenersKey(sid, p), addressKey(email)]);
  const reply = repliesFor(
    await redisPipeline([["DEL", ...productIds.flatMap((p) => [byKey(sid, p, email), okKey(sid, p, email)]), ...held.map(tokenKey)]]),
    1,
  );
  const gone = reply ? countOf(reply[0]) : null;
  if (gone === null) throw new UnknownReplyError("the deletion of a person's podcast feeds");
  if (listed.length) {
    const taken = repliesFor(await redisPipeline(listed), listed.length);
    if (!taken || !taken.every((r) => r === 0 || r === 1)) throw new UnknownReplyError("a person's place on a podcast's list of listeners");
  }
  return gone;
}

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
export async function feedsOf(store: Store, current: string[], email: string): Promise<string[]> {
  if (!store.statsId || !isRedisConfigured()) return [];
  const productIds = await withGone(store.statsId, current);
  if (!productIds.length) return [];
  const tokens = await indexedTokens(store.statsId, productIds, email);
  return productIds.filter((_, i) => typeof tokens[i] === "string" && FEED_TOKEN.test(tokens[i] as string));
}

/** The most products a store notes in goneKey; past it a removal that would need one more is refused (GoneFullError). */
export const GONE_MAX = 50;
/** A product's id as goneKey keeps it (lib/store.ts makes them so). */
const GONE_ID = /^[a-z0-9]{6,40}$/;

/**
 * The products asked about and those in goneKey, each once, in that order. The note is the only way to a removed
 * product's unlisted feeds, so it is read exactly (CX-123 rule 24): any other reply throws UnknownReplyError, and an
 * erasure says it is not finished instead of a receipt that left them.
 */
async function withGone(sid: string, current: string[]): Promise<string[]> {
  const reply = repliesFor(await redisPipeline([["SMEMBERS", goneKey(sid)]]), 1);
  const gone = stringList(reply?.[0]);
  if (!gone) throw new UnknownReplyError("the products removed with a podcast's feeds");
  return [...new Set([...current, ...gone.filter((id) => GONE_ID.test(id))])];
}

/**
 * A podcast made now has every feed of its product listed from the start (app/api/store/podcast, "enable"). true once
 * Redis confirms the mark; false when it is not known, and the podcast is not made. A product that already has a
 * list without the mark (a podcast of before 9 November 2026 turned off and on again) keeps it unmarked, so its removal
 * still notes it in goneKey: a mark there could hide a feed the list never held.
 */
export async function markListedFromStart(store: Store, productId: string): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured()) return false;
  const key = listenersKey(store.statsId, productId);
  const reply = repliesFor(await redisPipeline([["EXISTS", key], ["SISMEMBER", key, LISTED_FROM_START]]), 2);
  const exists = reply ? countOf(reply[0]) : null;
  const marked = reply ? countOf(reply[1]) : null;
  if (exists === null || exists > 1 || marked === null || marked > 1) return false;
  if (marked === 1 || exists === 1) return true;
  const [added] = await orderWrite(store, [["SADD", key, LISTED_FROM_START]]);
  return added === 0 || added === 1;
}

/** Thrown when a page of a product's listeners could not be paid for in studio requests: nothing of it was read. */
export class ListenersUnpaidError extends Error {
  constructor() {
    super("the studio requests to delete a podcast's listeners could not be taken");
    this.name = "ListenersUnpaidError";
  }
}

/** Thrown when goneKey already holds GONE_MAX products: nothing was deleted. */
export class GoneFullError extends Error {
  constructor() {
    super("too many removed podcasts wait for their old feeds to be reached");
    this.name = "GoneFullError";
  }
}

/**
 * The listeners one studio request deletes: a page of them read (SSCAN) and, for each, its index read (MGET) and its
 * index, its answer kept for a few minutes and its grant deleted (one DEL), then taken off the list (SREM). Four
 * commands and, for a hundred, at most about 45 KB through the database (an addressKey of 32 characters, three keys of
 * about 80 and a token of 48 each): inside one studio request's twenty commands and fifty kilobytes
 * (tests/plan-cost-registry.ts, UNIT_COST.studio).
 */
export const LISTENERS_PER_UNIT = 100;

/**
 * Deletes every listener's feed of one product (audit A1, 9 November 2026): the index, the cached answer and the grant
 * that holds the buyer's address, for each address the product's list names, then the list. Each page is paid for
 * before it is read: one studio request for the page, and one for each LISTENERS_PER_UNIT listeners on it (`pay`,
 * false when the studio will not: ListenersUnpaidError, nothing more read). Every reply is read exactly (rule 24); an
 * unknown one throws UnknownReplyError and what is left stays listed, so the next try finds it.
 *
 * `noteGone`, asked before the removal: a product whose list was not made with it (LISTED_FROM_START) may have feeds
 * no list names, so it is noted in goneKey first, before anything is deleted, and a person's erasure reaches them
 * there. A product that is not a podcast and has no list has no feeds to find, and is not noted.
 */
export async function dropListeners(
  store: Store,
  productId: string,
  options: { podcast: boolean; noteGone: boolean; pay: (units: number) => Promise<boolean> },
): Promise<{ dropped: number; noted: boolean }> {
  if (!store.statsId || !isRedisConfigured()) return { dropped: 0, noted: false };
  const sid = store.statsId;
  const key = listenersKey(sid, productId);
  const head = repliesFor(await redisPipeline([["EXISTS", key], ["SISMEMBER", key, LISTED_FROM_START]]), 2);
  const exists = head ? countOf(head[0]) : null;
  const marked = head ? countOf(head[1]) : null;
  if (exists === null || exists > 1 || marked === null || marked > 1) throw new UnknownReplyError("a podcast's list of listeners");
  let noted = false;
  if (options.noteGone && marked === 0 && (options.podcast || exists === 1)) {
    const counted = repliesFor(await redisPipeline([["SCARD", goneKey(sid)], ["SISMEMBER", goneKey(sid), productId]]), 2);
    const size = counted ? countOf(counted[0]) : null;
    const already = counted ? countOf(counted[1]) : null;
    if (size === null || already === null || already > 1) throw new UnknownReplyError("the products removed with a podcast's feeds");
    if (already === 0) {
      if (size >= GONE_MAX) throw new GoneFullError();
      // Not the room's (a few ids, capped): bounded by GONE_MAX in tests/store-data-registry.ts.
      const added = repliesFor(await redisPipeline([["SADD", goneKey(sid), productId]]), 1)?.[0];
      if (added !== 1 && added !== 0) throw new UnknownReplyError("the note of a removed podcast");
    }
    noted = true;
  }
  if (exists === 0) return { dropped: 0, noted };
  let dropped = 0;
  for (let pass = 0; ; pass += 1) {
    let cursor = "0";
    do {
      if (!(await options.pay(1))) throw new ListenersUnpaidError();
      const page = scanPage(await redisPipeline([["SSCAN", key, cursor, "COUNT", LISTENERS_PER_UNIT]]));
      if (!page) throw new UnknownReplyError("a page of a podcast's listeners");
      const listed = page.items.filter((member) => member !== LISTED_FROM_START);
      const addresses = listed.filter((member) => ADDRESS_KEY.test(member));
      // The page off the list first, before its feeds are read and deleted (Claude 3's review of #3473, MEDIUM 1): a feed
      // made again after this lists its address again, so the read below finds it and deletes it, and a feed made after
      // that read is still listed for the next pass or the erasure; taken off after the deletion, a feed made in between
      // was named by no list and stayed for good.
      if (listed.length) {
        const taken = repliesFor(await redisPipeline([["SREM", key, ...listed]]), 1);
        if ((taken ? countOf(taken[0]) : null) === null) throw new UnknownReplyError("a podcast's list of listeners");
      }
      if (addresses.length) {
        if (!(await options.pay(Math.ceil(addresses.length / LISTENERS_PER_UNIT)))) throw new ListenersUnpaidError();
        const indexes = addresses.map((address) => `nl:pod:by:${sid}:${productId}:${address}`);
        const tokens = repliesFor(await redisPipeline([["MGET", ...indexes]]), 1);
        const held = listSlots(tokens?.[0]);
        if (!held || held.length !== addresses.length || !held.every((t) => t === null || typeof t === "string")) {
          throw new UnknownReplyError("a podcast's listeners' feeds");
        }
        const grants = (held as (string | null)[]).filter((t): t is string => t !== null && FEED_TOKEN.test(t)).map(tokenKey);
        const answers = addresses.map((address) => `nl:pod:ok:${sid}:${productId}:${address}`);
        const reply = repliesFor(await redisPipeline([["DEL", ...indexes, ...answers, ...grants]]), 1);
        const gone = reply ? countOf(reply[0]) : null;
        if (gone === null) throw new UnknownReplyError("the deletion of a podcast's listeners' feeds");
        dropped += addresses.length;
      }
      cursor = page.next;
    } while (cursor !== "0");
    // Every listed feed is gone; the list, its mark with it, only while it lists nothing else, in one step: a feed made
    // again while this ran is listed again and read in one more pass, never wiped off with the list (Claude 3's review of
    // #3473, MEDIUM 1). Still listed after LISTENER_PASSES, the removal is not finished, and a retry goes on.
    const last = repliesFor(await redisPipeline([["EVAL", LISTENERS_DROP, 1, key, LISTED_FROM_START]]), 1)?.[0];
    if (last === 1) break;
    if (last !== 0) throw new UnknownReplyError("a podcast's list of listeners");
    if (pass + 1 >= LISTENER_PASSES) throw new Error("a podcast's listeners kept coming back while their feeds were deleted");
  }
  return { dropped, noted };
}

/** How many passes over a removed podcast's listeners one removal makes at most (dropListeners). */
const LISTENER_PASSES = 3;
/**
 * A podcast's list of listeners deleted only while it lists nothing but its mark (dropListeners): 1 when deleted, 0
 * when an address is listed again. Modeled step for step in lib/redis-memory.ts.
 */
export const LISTENERS_DROP = `-- marktmorgen:pod-listeners-drop:v1
local left = redis.call("SCARD", KEYS[1]) - redis.call("SISMEMBER", KEYS[1], ARGV[1])
if left ~= 0 then return 0 end
redis.call("DEL", KEYS[1])
return 1`;
