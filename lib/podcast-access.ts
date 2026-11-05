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

export type FeedGrant = { s: string; h: string; p: string; e: string };

/** The feed token for this address and product: the one it already has, or a new one. */
export async function feedToken(store: Store, productId: string, email: string): Promise<string | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  const sid = store.statsId;
  const [existing] = await redisPipeline([["GET", byKey(sid, productId, email)]]);
  if (typeof existing === "string" && FEED_TOKEN.test(existing)) return existing;
  const token = randomBytes(24).toString("hex");
  const grant: FeedGrant = { s: sid, h: store.handle, p: productId, e: normaliseEmail(email) };
  // A listener's access is kept for good: counted in the store's room at what it adds (lib/order-data.ts).
  const [set] = await orderWrite(store, [["SET", byKey(sid, productId, email), token, "NX"]]);
  if (set === null) {
    const [again] = await redisPipeline([["GET", byKey(sid, productId, email)]]);
    return typeof again === "string" ? again : null;
  }
  await orderWrite(store, [["SET", tokenKey(token), JSON.stringify(grant)]]);
  return token;
}

export async function readFeedToken(token: string): Promise<FeedGrant | null> {
  if (!FEED_TOKEN.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", tokenKey(token)]]);
  if (typeof raw !== "string") return null;
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
 * FEED_READS_A_DAY in a day. One command, and a second with a day's first,
 * because this runs every time a feed is put together and is part of what
 * that costs. A count that cannot be kept lets the feed through.
 */
export async function feedReadAllowed(token: string, now = Date.now()): Promise<boolean> {
  if (!isRedisConfigured()) return true;
  try {
    const key = `nl:pod:n:${sha(token).slice(0, 32)}:${new Date(now).toISOString().slice(0, 10)}`;
    const [count] = await redisPipeline([["INCR", key]]);
    if (Number(count) === 1) await redisPipeline([["EXPIRE", key, 2 * 86_400]]);
    return Number(count) <= FEED_READS_A_DAY;
  } catch {
    return true;
  }
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
  const tokens = await redisPipeline(productIds.map((p) => ["GET", byKey(sid, p, email)]));
  const held = tokens.filter((t): t is string => typeof t === "string" && FEED_TOKEN.test(t));
  const [gone] = await redisPipeline([["DEL", ...productIds.flatMap((p) => [byKey(sid, p, email), okKey(sid, p, email)]), ...held.map(tokenKey)]]);
  return Number(gone) || 0;
}

/**
 * The products whose private podcast feed a person has, for the copy of their
 * data (619 [SZ3], lib/person-copy.ts). The feed's secret address is not
 * given: it is a key, and the person has it in the email that sent it. Only
 * reads; never makes a feed.
 */
export async function feedsOf(store: Store, productIds: string[], email: string): Promise<string[]> {
  if (!store.statsId || !productIds.length || !isRedisConfigured()) return [];
  const sid = store.statsId;
  const tokens = await redisPipeline(productIds.map((p) => ["GET", byKey(sid, p, email)]));
  return productIds.filter((_, i) => typeof tokens[i] === "string" && FEED_TOKEN.test(tokens[i] as string));
}
