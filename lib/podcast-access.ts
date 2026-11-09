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
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { orderWrite } from "@/lib/order-data";
import { holdsProducts } from "@/lib/community-access";
import { sendEmail } from "@/lib/email";
import { withinLimit } from "@/lib/request-guard";
import { FEED_TOKEN } from "@/lib/podcast-rules";
import { coursesWords } from "@/lib/buyer-words/courses";
import type { Listing, Store } from "@/lib/store";
import { holdsProductsOrThrow } from "@/lib/community-access";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const addressKey = (email: string) => sha(`nimbus-podcast:${normaliseEmail(email)}`).slice(0, 32);
export const tokenKey = (token: string) => `nl:pod:t:${sha(token)}`;
const byKey = (sid: string, pid: string, email: string) => `nl:pod:by:${sid}:${pid}:${addressKey(email)}`;
const okKey = (sid: string, pid: string, email: string) => `nl:pod:ok:${sid}:${pid}:${addressKey(email)}`;

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
  const [made] = await orderWrite(store, [["SET", tokenKey(token), JSON.stringify(grant)]]);
  return made === "OK" && (await stillIndexed(token, grant)) ? token : null;
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
  if (made === "OK") return (await stillIndexed(token, grant)) ? token : null;
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
export async function forgetPodcastPerson(store: Store, productIds: string[], email: string): Promise<number> {
  if (!store.statsId || !productIds.length || !isRedisConfigured()) return 0;
  const sid = store.statsId;
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
export async function feedsOf(store: Store, productIds: string[], email: string): Promise<string[]> {
  if (!store.statsId || !productIds.length || !isRedisConfigured()) return [];
  const tokens = await indexedTokens(store.statsId, productIds, email);
  return productIds.filter((_, i) => typeof tokens[i] === "string" && FEED_TOKEN.test(tokens[i] as string));
}

/**
 * Whether the index still leads to a grant just written (audit of private podcasts, M3): a feed replaced or ended
 * (revokeFeed) between the read of the index and the write of its grant must not come back to life, nor leave a grant
 * holding the address that no index leads to, which an erasure would never find. When the index holds another token,
 * none, or cannot be read, the grant just written is deleted again and no link is given.
 */
async function stillIndexed(token: string, grant: FeedGrant): Promise<boolean> {
  if ((await indexedToken(grant.s, grant.p, grant.e)) === token) return true;
  await redisPipeline([["DEL", tokenKey(token)]]);
  return false;
}

/**
 * Whether this address may listen now, for a door that takes something away on a no (the episode route deletes the
 * grant of a token whose address no longer holds the podcast): Stripe that cannot be asked throws instead of saying
 * no (lib/community-access.ts, holdsProductsOrThrow). The same cached answer as mayListen.
 */
export async function mayListenOrThrow(store: Store, productId: string, email: string): Promise<boolean> {
  if (!store.statsId) return false;
  if (normaliseEmail(email) === normaliseEmail(store.email)) return true;
  return holdsProductsOrThrow(store, [productId], email, okKey(store.statsId, productId, email), "1");
}

/**
 * Ends one token whose address no longer holds the podcast, on a confirmed no (audit of private podcasts, M1): its
 * grant is deleted, so every later request on it is one read that answers "Not found", and nothing more is asked of
 * Stripe for it. Its index stays: the next time a feed is handed to the address with access (the page after paying,
 * the list of purchases, "Email me my feed"), the same address is written back and the buyer's app works again
 * (withGrant). A failed delete leaves the grant, and the next request asks again.
 */
export async function endGrant(token: string): Promise<void> {
  if (!FEED_TOKEN.test(token) || !isRedisConfigured()) return;
  await redisPipeline([["DEL", tokenKey(token)]]);
}

/**
 * Ends the feed an address has of a product, index and grant (audit of private podcasts, M3): its address stops
 * working at once, and the next feed handed to the address is a new one. True when there was one, false when there
 * was none. Read exactly first (CX-123 rule 24): an unknown read or delete throws UnknownReplyError.
 */
export async function revokeFeed(store: Store, productId: string, email: string): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured()) return false;
  const sid = store.statsId;
  const held = await indexedToken(sid, productId, email);
  if (held === undefined) throw new UnknownReplyError("a podcast feed's index");
  if (held === null) return false;
  const reply = repliesFor(await redisPipeline([["DEL", byKey(sid, productId, email), okKey(sid, productId, email), tokenKey(held)]]), 1);
  if ((reply ? countOf(reply[0]) : null) === null) throw new UnknownReplyError("the end of a podcast feed");
  return true;
}

/**
 * "Get a new feed address", asked by the buyer from their feed's page or by the creator for one listener from the
 * studio (audit of private podcasts, M3: a feed that got out played for anyone, on the store's requests, until a
 * refund). The address's old feed stops working at once; while the address still holds the podcast, a new one is
 * emailed to it, never shown to whoever asked, so a person who only has the old address cannot take the new one.
 *
 *   sent    the old feed ended, and the new one was emailed
 *   ended   the old feed ended; the address no longer holds the podcast, so nothing was sent
 *   none    the address had no feed of this podcast; nothing changed
 *   unsent  the old feed ended, and the email with the new one could not be sent ("Email me my feed" sends it)
 *   error   nothing was changed: the access or the feed could not be read
 *
 * The access is asked before anything is changed. The caller takes the store's request and its limits first.
 */
export type ReplaceResult = "sent" | "ended" | "none" | "unsent" | "error";
export async function replaceFeed(input: { store: Store; product: Listing; email: string; base: string; from: string }): Promise<ReplaceResult> {
  const { store, product } = input;
  const email = normaliseEmail(input.email);
  let holds: boolean;
  let had: boolean;
  try {
    holds = await mayListenOrThrow(store, product.id, email);
    had = await revokeFeed(store, product.id, email);
  } catch {
    return "error";
  }
  if (!had) return "none";
  if (!holds) return "ended";
  const token = await feedToken(store, product.id, email);
  if (!token) return "unsent";
  // In the store's language (lib/buyer-words/courses.ts), as "Email me my feed" sends it, with what changed first.
  const w = coursesWords(store.language);
  const sent = await sendEmail({ meter: { by: "store", store: store, kind: "transactional" },
    from: input.from,
    to: email,
    subject: w.podcastSubject(product.title).slice(0, 200),
    text: [
      w.podcastReplaced,
      "",
      w.podcastLead(product.title, store.name),
      "",
      `${input.base}/podcast/${product.id}?t=${token}`,
      "",
      w.podcastBody,
      "",
      w.sentBy(store.name),
    ].join("\n"),
  });
  return sent ? "sent" : "unsent";
}
