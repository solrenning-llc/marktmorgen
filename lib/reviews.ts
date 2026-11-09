/**
 * Reviews that only buyers can write.
 *
 * On Stan a creator types their reviews in themselves. Here a review can only
 * come from somebody who paid: it is written from the thanks page, from the
 * list of purchases or from the link in the one email that asks for it, and
 * every one of those doors first asks the creator's own Stripe account
 * whether that order was paid and not refunded (lib/review-proof.ts). Each
 * review keeps the order it came from, so the creator can find the payment
 * behind any review in their own Stripe dashboard.
 *
 * The rules, all kept here so every page applies the same ones:
 *
 *   - One review per buyer per product: the id is made from the store, the
 *     product and the buyer's address, so buying twice is still one voice.
 *     The buyer can change it or delete it, through the same doors.
 *   - Stars from 1 to 5 and up to 1,000 characters, with the name the buyer
 *     chooses to show (or "Verified buyer"). Their email is never shown.
 *   - The creator can answer in public, and can hide a review only for one of
 *     the review rules (HIDE_REASONS: private information, abuse, not about
 *     the product, clearly false, unlawful), the same for every rating; the
 *     reason is kept with it. They cannot change a word of it, and there is
 *     no field for anything given in return for writing one.
 *   - Hiding takes a review's words off the page, never its stars out of the
 *     average: the average and the count include hidden reviews, and the
 *     page says how many are hidden ("2 reviews hidden by the creator"). So
 *     hiding can tidy a page but can never lift a rating.
 *   - A refund in full marks the review "refunded" and takes its stars out of
 *     the average and the count, because it no longer comes from a buyer who
 *     kept what they paid for. Its words stay, marked as such.
 *   - Stars show when at least one review counts, hidden or not. New reviews go live at once; the creator's queue in the
 *     studio lists what arrived since they last looked.
 *
 * Records in Redis, all under the store's statsId:
 *
 *   nl:rev:<s>:<product>      -> hash: review id -> the review, as JSON
 *   nl:rev:vis:<s>:<product>  -> sorted set of the ids on the page, by date
 *   nl:rev:sum:<s>            -> hash: product -> the numbers the pages show
 *   nl:rev:all:<s>            -> sorted set of "<product>|<id>", by date (studio)
 *   nl:rev:new:<s>            -> sorted set of the same, not seen yet (the queue)
 *   nl:rev:pay:<s>            -> hash: payment -> the reviews it paid for (refunds)
 *   nl:rev:stores             -> set of statsIds with any review (the refund pass, the daily recount)
 *   nl:rev:recount:at         -> where the daily recount of numbers left waiting stopped (a SSCAN cursor)
 *   nl:rev:bad:<s>:<product>  -> hash: review id -> a damaged record set aside, as it was (until its person, product or store goes)
 */
import { createHash, randomBytes } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, scanPage, stringList } from "@/lib/redis-reply";
import { LockBusyError, releaseLock, takeLock } from "@/lib/redis-lock";
import { type DataStore, giveData, needData, takeData } from "@/lib/store-data";
import { orderWrite } from "@/lib/order-data";
import { dataBytes } from "@/lib/store-data-rules";
import {
  EMPTY_SUMMARY,
  MAX_REPLY_TEXT,
  MAX_REVIEW_NAME,
  MAX_REVIEW_TEXT,
  MAX_REVIEWS_PER_PRODUCT,
  REVIEWS_ON_PAGE,
  REVIEW_ID_PATTERN,
  type Review,
  type ReviewPhoto,
  type ProductNumbers,
  type Summary,
  UNREAD_NUMBERS,
  summarise,
  type HideReason,
  isHideReason,
} from "@/lib/review-summary";
import { parseProductImage } from "@/lib/product-image";

export * from "@/lib/review-summary";

const PRODUCT_ID_PATTERN = /^[a-z0-9]{6,40}$/;
const STATS_ID_PATTERN = /^[0-9a-f]{32}$/;

const productKey = (s: string, p: string) => `nl:rev:${s}:${p}`;
const visibleKey = (s: string, p: string) => `nl:rev:vis:${s}:${p}`;
const summaryKey = (s: string) => `nl:rev:sum:${s}`;
const allKey = (s: string) => `nl:rev:all:${s}`;
const newKey = (s: string) => `nl:rev:new:${s}`;
const payKey = (s: string) => `nl:rev:pay:${s}`;
const lockKey = (s: string, p: string) => `nl:rev:lock:${s}:${p}`;
const asideKey = (s: string, p: string) => `nl:rev:bad:${s}:${p}`;
export const REVIEW_STORES_KEY = "nl:rev:stores";

/**
 * What a product's numbers hold while they wait to be counted again: written in the same request as every change to
 * its reviews (a review written, changed or deleted), and replaced by the recount that follows. A recount that cannot
 * be done (its read lost, thrown or in another shape, or a damaged record in the product's hash) leaves it there, so
 * the product shows no stars and says its numbers could not be read (UNREAD_NUMBERS), never the numbers kept from
 * before the change, which may still count a review hidden, refunded or deleted (rule 24; VR item 2). It is not the
 * numbers' exact shape (exactSummary), so every reader takes it as unread. A mark left by a failure that passes is
 * counted again by the daily pass (recountWaiting), never by a page that reads it: a recount on a public read would
 * cost every visit and race the change that wrote the mark.
 *
 * Each change's mark carries a token of its own ("recount:<random>"), and a recount writes its numbers only while the
 * mark is still the one it counted for (WRITE_NUMBERS_IF, in one step): a recount from before another change (its lock
 * ran out under it, or its write timed out on the client and ran later on the server) never writes what it counted
 * over that change's mark (pre-review of claude5/reviews-recount-exact, 9 November 2026).
 */
const RECOUNT_MARK = "recount:";
/** Any mark, whoever wrote it: a product's numbers waiting for their recount, read as unread, never as numbers. */
const isRecountMark = (value: unknown): value is string => typeof value === "string" && value.startsWith(RECOUNT_MARK);
const newMark = (): string => `${RECOUNT_MARK}${randomBytes(12).toString("hex")}`;
const numbersPending = (statsId: string, productId: string, mark: string): (string | number)[] => ["HSET", summaryKey(statsId), productId, mark];

/**
 * A product's counted numbers written over its mark only while the mark is still `ARGV[2]`, in one step: 1 when
 * written (the numbers, or the field deleted for "" when the product has no reviews left), 0 when another change
 * marked them since (or they are no longer marked), and nothing was written. Modelled by lib/redis-memory.ts; run on a
 * real Redis by scripts/test_review_recount_redis.py. Upstash bills it as the EVAL plus its HGET and, when written,
 * its HSET or HDEL (tests/plan-cost-registry.ts, lines public-requests and studio).
 */
export const WRITE_NUMBERS_IF = `-- marktmorgen:review-numbers-if:v1
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
if ARGV[3] == '' then redis.call('HDEL', KEYS[1], ARGV[1]) else redis.call('HSET', KEYS[1], ARGV[1], ARGV[3]) end
return 1`;

/**
 * A review's record that answered as text but does not read as that review (damaged, or another review's under its
 * field). Waiting never changes it, unlike an answer lost or in another shape; it is still an UnknownReplyError for
 * every caller that only knows that, and the refund pass (markRefunded) tells it apart.
 */
class DamagedReviewError extends UnknownReplyError {}

/** One buyer's review of one product, always the same id, whatever order they write it from. */
export function reviewId(statsId: string, productId: string, email: string): string {
  return createHash("sha256")
    .update(`nimbus-review:${statsId}|${productId}|${normaliseEmail(email)}`)
    .digest("hex")
    .slice(0, 24);
}

/**
 * The characters that turn the direction of text around (bidirectional
 * overrides and isolates). A buyer's name or words with one of them in can
 * be made to read differently from what was typed — or to spill into the
 * "Verified buyer" and the answer drawn next to them — so they are taken out.
 */
const DIRECTION_MARKS = /[\u202a-\u202e\u2066-\u2069]/g;

/** One line: control characters and runs of space made one space. */
function oneLine(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(DIRECTION_MARKS, "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Text as a message box writes it: line breaks kept, one blank line at most, the length capped. */
export function cleanReviewText(value: unknown, max = MAX_REVIEW_TEXT): string {
  if (typeof value !== "string") return "";
  return value
    .replace(DIRECTION_MARKS, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/g, " ")
    .split("\n")
    .map((row) => row.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

export function cleanReviewName(value: unknown): string {
  return oneLine(value, MAX_REVIEW_NAME);
}

/** A whole number of stars from 1 to 5, or null. */
export function readRating(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

/** Whatever came back from storage, made safe to use; null when it cannot be a review. */
/** A kept review photo, made safe: a picture in a store's picture folder, of a sensible size; null otherwise. */
export function parseReviewPhoto(raw: unknown): ReviewPhoto | null {
  const image = parseProductImage(raw && typeof raw === "object" ? { ...(raw as object), alt: "", small: null } : null);
  return image && image.width <= 4_000 && image.height <= 4_000 ? { path: image.path, width: image.width, height: image.height } : null;
}

export function parseReview(raw: unknown): Review | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const rating = readRating(value.rating);
    if (typeof value.id !== "string" || !REVIEW_ID_PATTERN.test(value.id) || rating === null) return null;
    if (typeof value.productId !== "string" || !PRODUCT_ID_PATTERN.test(value.productId)) return null;
    const reply =
      value.reply && typeof value.reply === "object" && typeof (value.reply as { text?: unknown }).text === "string"
        ? {
            text: cleanReviewText((value.reply as { text: string }).text, MAX_REPLY_TEXT),
            at: Number((value.reply as { at?: unknown }).at) || 0,
          }
        : null;
    return {
      id: value.id,
      productId: value.productId,
      reference: typeof value.reference === "string" ? value.reference.slice(0, 220) : "",
      pi: typeof value.pi === "string" ? value.pi.slice(0, 220) : "",
      rating,
      text: cleanReviewText(value.text),
      name: cleanReviewName(value.name),
      createdAt: Number(value.createdAt) || 0,
      editedAt: Number(value.editedAt) || 0,
      hidden: value.hidden === true,
      hiddenReason: value.hidden === true && isHideReason(value.hiddenReason) ? value.hiddenReason : null,
      refunded: value.refunded === true,
      reply: reply && reply.text ? reply : null,
      photo: parseReviewPhoto(value.photo),
      ...(Number.isSafeInteger(value.paidAt) && (value.paidAt as number) > 0 ? { paidAt: value.paidAt as number } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * A product's kept numbers, only in their exact shape (CX-123 rule 24): each a whole number of at least 0, the spread
 * five of them, and all of them adding up as summarise() writes them (the spread to the count and the stars, the
 * shown and hidden to the counted and refunded). Null for anything else, never "no reviews".
 */
function exactSummary(raw: string): Summary | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { count, stars, visible, hidden, refunded, dist } = value as Record<string, unknown>;
  const whole = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
  if (!Array.isArray(dist) || dist.length !== 5 || !dist.every(whole)) return null;
  if (!whole(count) || !whole(stars) || !whole(visible) || !whole(hidden) || !whole(refunded)) return null;
  const spread = dist as number[];
  if (spread.reduce((sum, n) => sum + n, 0) !== count) return null;
  if (spread.reduce((sum, n, i) => sum + n * (i + 1), 0) !== stars) return null;
  if (visible + hidden !== count + refunded) return null;
  return { count, stars, visible, hidden, refunded, dist: [spread[0], spread[1], spread[2], spread[3], spread[4]] };
}

/**
 * The numbers of every product of a store that has reviews, in one read. Throws UnknownReplyError when the reply is
 * not in its exact shape (a flat list of texts, each field a product's id): a page says the numbers could not be read,
 * never that there are none (rule 24; VR item 2). Only an exact empty hash is a store with no numbers. Each product's
 * numbers are read on their own: one whose numbers are not in their exact shape is UNREAD_NUMBERS (no stars, never a
 * number made up), and the others are shown, so one product's damaged numbers never take every product's stars.
 */
export async function summaries(statsId: string | null): Promise<ProductNumbers> {
  const out: ProductNumbers = new Map();
  if (!statsId || !STATS_ID_PATTERN.test(statsId) || !isRedisConfigured()) return out;
  const read = repliesFor(await redisPipeline([["HGETALL", summaryKey(statsId)]]), 1);
  const flat = read && stringList(read[0]);
  if (!flat || flat.length % 2 !== 0 || flat.some((field, i) => i % 2 === 0 && !PRODUCT_ID_PATTERN.test(field))) {
    throw new UnknownReplyError("a store's review numbers");
  }
  for (let i = 0; i < flat.length; i += 2) {
    const summary = exactSummary(flat[i + 1]);
    if (!summary && isRecountMark(flat[i + 1])) console.error(`reviews: the numbers of product ${flat[i]} wait to be counted again; no stars are shown for it until they are`);
    else if (!summary) console.error(`reviews: the numbers of product ${flat[i]} did not read; no stars are shown for it until they are counted again`);
    out.set(flat[i], summary ?? UNREAD_NUMBERS);
  }
  return out;
}

/**
 * A product's numbers: none when they are confirmed absent (an exact nil). Throws UnknownReplyError when the reply or
 * the numbers are not in their exact shape, never "no reviews" (rule 24; VR item 2).
 */
export async function summaryOf(statsId: string | null, productId: string): Promise<Summary> {
  if (!statsId || !STATS_ID_PATTERN.test(statsId) || !isRedisConfigured()) return { ...EMPTY_SUMMARY, dist: [0, 0, 0, 0, 0] };
  const read = repliesFor(await redisPipeline([["HGET", summaryKey(statsId), productId]]), 1);
  const raw = read?.[0];
  if (read && raw === null) return { ...EMPTY_SUMMARY, dist: [0, 0, 0, 0, 0] };
  const summary = read && typeof raw === "string" ? exactSummary(raw) : null;
  // A recount mark (numbers waiting to be counted again) is unread, as anything else not in the numbers' exact shape.
  if (!summary && isRecountMark(raw)) console.error(`reviews: the numbers of product ${productId} wait to be counted again; no stars are shown for it until they are`);
  if (!summary) throw new UnknownReplyError("a product's review numbers");
  return summary;
}

/** The reviews on a product's page, newest first. Throws UnknownReplyError when a reply is not in its exact shape. */
export async function visibleReviews(
  statsId: string | null,
  productId: string,
  offset = 0,
  limit = REVIEWS_ON_PAGE,
  /**
   * Reviews the creator picked to show before the others (lib/sales-page.ts,
   * ReviewsBlock), read in the same request as the rest. Only a visible review
   * that was not refunded is put first; the others keep their order after it.
   */
  first: string[] = [],
): Promise<Review[]> {
  if (!statsId || !STATS_ID_PATTERN.test(statsId) || !isRedisConfigured()) return [];
  // Read exactly (rule 24): a reply lost or in another shape throws UnknownReplyError, so a page says its reviews could
  // not be read rather than showing none. A record that answered exactly nil is gone since, and is left out.
  const listed = repliesFor(
    await redisPipeline([["ZREVRANGEBYSCORE", visibleKey(statsId, productId), "+inf", "-inf", "LIMIT", offset, limit]]),
    1,
  );
  const ids = listed && stringList(listed[0]);
  if (!ids) throw new UnknownReplyError("a product's reviews");
  const list = ids.filter((id) => REVIEW_ID_PATTERN.test(id));
  const picked = offset === 0 ? first.filter((id) => REVIEW_ID_PATTERN.test(id)).slice(0, 3) : [];
  const wanted = [...new Set([...picked, ...list])];
  if (wanted.length === 0) return [];
  const answered = repliesFor(await redisPipeline([["HMGET", productKey(statsId, productId), ...wanted]]), 1);
  const rows = answered && repliesFor(answered[0], wanted.length);
  if (!rows || rows.some((row) => row !== null && typeof row !== "string")) throw new UnknownReplyError("a product's review records");
  const read = rows.map(parseReview);
  const byId = new Map<string, Review>();
  wanted.forEach((id, i) => {
    const review = read[i];
    if (review && review.id === id && !review.hidden) byId.set(id, review);
  });
  const shownFirst = picked.map((id) => byId.get(id)).filter((r): r is Review => r !== undefined && !r.refunded);
  const firstIds = new Set(shownFirst.map((r) => r.id));
  const rest = list.map((id) => byId.get(id)).filter((r): r is Review => r !== undefined && !firstIds.has(r.id));
  return [...shownFirst, ...rest].slice(0, Math.max(limit, shownFirst.length));
}

/** One review, when it exists; null when it does not. Throws when the answer is not in its exact shape. */
export async function readReview(statsId: string, productId: string, id: string): Promise<Review | null> {
  if (!REVIEW_ID_PATTERN.test(id) || !PRODUCT_ID_PATTERN.test(productId) || !isRedisConfigured()) return null;
  // Only in its exact shape (CX-123 rule 24, inventory R24 item 13): one reply, the review as text or nil when there is
  // none. Anything else is unknown and throws, never "no review yet", so a buyer is never shown a blank form over the
  // review they already wrote.
  const one = repliesFor(await redisPipeline([["HGET", productKey(statsId, productId), id]]), 1);
  const raw = one?.[0];
  if (!one || (raw !== null && typeof raw !== "string")) throw new UnknownReplyError("a buyer's review");
  return parseReview(raw);
}

/**
 * Runs `work` holding the product's lock, so two changes at once cannot count
 * the numbers from two different moments. "busy" when it could not be had
 * within `waitMs` (the daily recount does not wait: a change holding the lock
 * counts the numbers itself).
 */
async function locked<T>(statsId: string, productId: string, work: () => Promise<T>, waitMs = 1_600): Promise<T | "busy"> {
  // Under a token of this call's own, let go of in one step (lib/redis-lock.ts): a lock that ran out and was taken
  // by another call is never let go of by this one.
  let held;
  try {
    held = await takeLock(lockKey(statsId, productId), 10, waitMs);
  } catch (error) {
    if (error instanceof LockBusyError) return "busy";
    throw error;
  }
  try {
    return await work();
  } finally {
    await releaseLock(held);
  }
}

/**
 * A product's review records as HGETALL answers them, for counting or dropping them (CX-123 rule 24): null when the
 * reply is not a flat list of texts with each field a review's id (unknown: nothing is counted or dropped). Otherwise
 * every field's id, the reviews that read as this product's under their own id, and the records that do not
 * (damaged: their ids, and each with its text as it was, for setting it aside).
 */
function recordsOf(reply: unknown, productId: string): { ids: string[]; reviews: Review[]; unreadable: string[]; damaged: [string, string][] } | null {
  const flat = stringList(reply);
  if (!flat || flat.length % 2 !== 0) return null;
  const ids: string[] = [];
  const reviews: Review[] = [];
  const unreadable: string[] = [];
  const damaged: [string, string][] = [];
  for (let i = 0; i < flat.length; i += 2) {
    if (!REVIEW_ID_PATTERN.test(flat[i])) return null;
    ids.push(flat[i]);
    const review = parseReview(flat[i + 1]);
    if (review && review.id === flat[i] && review.productId === productId) reviews.push(review);
    else {
      unreadable.push(flat[i]);
      damaged.push([flat[i], flat[i + 1]]);
    }
  }
  return { ids, reviews, unreadable, damaged };
}

/**
 * The most records of one product a recount sets aside at once; past it, or past half of the product's records,
 * nothing is moved and the recount is "unsure" (pre-review of a8737e12a6, 9 November 2026): so many records that do not
 * read are more likely a reader that became stricter in a deploy than records damaged one by one, and moving them
 * would take reviews off their pages that still read under the old reader.
 */
export const REVIEW_ASIDE_MOST = 3;

/**
 * Moves damaged review records out of their product, in one step (lib/redis-memory.ts models it; run on a real Redis
 * by scripts/test_review_recount_redis.py). KEYS: the product's records, its records set aside, its page list, the
 * studio list, the creator's queue. ARGV: the product's id, then each record's id and the text it was read as. A record
 * is moved only while it is still exactly that text: written into the set-aside hash as it was, then taken out of the
 * records and of the three lists. A review written into the field meanwhile (a lock that ran out under a slow request)
 * is never moved or deleted. Answers how many were moved. Upstash bills the EVAL and every call it runs.
 */
export const SET_ASIDE_IF = `-- marktmorgen:review-set-aside:v1
local moved = 0
for i = 2, #ARGV, 2 do
  local id = ARGV[i]
  if redis.call('HGET', KEYS[1], id) == ARGV[i + 1] then
    redis.call('HSET', KEYS[2], id, ARGV[i + 1])
    redis.call('HDEL', KEYS[1], id)
    redis.call('ZREM', KEYS[3], id)
    redis.call('ZREM', KEYS[4], ARGV[1] .. '|' .. id)
    redis.call('ZREM', KEYS[5], ARGV[1] .. '|' .. id)
    moved = moved + 1
  end
end
return moved`;

/**
 * Sets a product's damaged review records aside (owner's decision 11, 9 November 2026: quarantine and recount). The AI
 * summary that may have counted them goes first (no date known: more taken away than counted, never less; the same
 * again is harmless), then SET_ASIDE_IF moves each record, in one step, into its product's hash of records set aside
 * (nl:rev:bad:<store>:<product>, field its id) while it is still the text read, so a reply damaged on its way is never
 * taken for a damaged record, and a review written meanwhile stays. A record set aside has no time of its own (pre-review
 * of a8737e12a6): it stays until its buyer's delete or erasure (deleteOwnReview, forgetReviewsPerson), its product's
 * removal (dropReviews) or its store's closing (lib/data-families.ts) takes it, with its photo; its room stays counted
 * until then. The payment's list keeps its id, which then reads as gone. True when every record was moved; false on
 * an answer in another shape or a record that changed, and the caller leaves the product unread (its mark).
 */
async function setAside(statsId: string, productId: string, damaged: [string, string][]): Promise<boolean> {
  const summary = summaryGone(statsId, productId, 0);
  if (!exactWriteReplies(await redisPipeline(summary), summary)) return false;
  const keys = [productKey(statsId, productId), asideKey(statsId, productId), visibleKey(statsId, productId), allKey(statsId), newKey(statsId)];
  const moved = repliesFor(await redisPipeline([["EVAL", SET_ASIDE_IF, keys.length, ...keys, productId, ...damaged.flat()]]), 1);
  const n = moved ? countOf(moved[0]) : null;
  const members = damaged.map(([id]) => `${productId}|${id}`);
  if (n !== damaged.length) {
    console.error(`reviews: the damaged review records of product ${productId} (${members.join(", ")}) were not all set aside (${n === null ? "an answer in an unknown shape" : `${n} moved, the others changed since`}); its numbers are left waiting`);
    return false;
  }
  console.error(`reviews: ${damaged.length} damaged review record(s) of product ${productId} set aside (${members.join(", ")}); its numbers are counted from the others`);
  return true;
}

/**
 * Counts a product's numbers again from its reviews, and keeps them. Read exactly (CX-123 rule 24): only an exact
 * empty hash is a product with no reviews, whose numbers go. A read lost or in another shape writes nothing: the
 * numbers are never deleted and never counted without a review that did not answer; the recount is left for the daily
 * pass (recountWaiting) or the product's next change ("unsure"), and the log says so. So is a write of the numbers
 * answered in another shape. A record that answered as text but does not read as its review (damaged: waiting never
 * changes it) is set aside first (setAside) and the product counted from the others (owner's decision 11, 9 November
 * 2026); one that cannot be set aside leaves the recount "unsure", as above.
 * Every caller has already marked the numbers as waiting (numbersPending, in the same request as its change), so what
 * stays meanwhile is that mark (no stars, said as unread), never the numbers from before the change. `mark` is that
 * mark, known before the reviews are read (written by the change, or read by the daily pass): the numbers are written
 * only while it is still there (WRITE_NUMBERS_IF). Another change's mark since is "unsure" too: nothing is written, and
 * that change's own recount, or the daily pass, counts them.
 */
async function recount(statsId: string, productId: string, mark: string): Promise<Summary | "unsure"> {
  const read = repliesFor(await redisPipeline([["HGETALL", productKey(statsId, productId)]]), 1);
  const records = read ? recordsOf(read[0], productId) : null;
  if (!records) {
    console.error(`reviews: the numbers of product ${productId} were not counted again (its reviews read in an unknown shape); left waiting for the daily recount or its next change`);
    return "unsure";
  }
  // A damaged record (text that does not read as its review) never changes by waiting: it is set aside, and the
  // product is counted from the others (owner's decision 11). Set aside unconfirmed leaves the product unread.
  // More than REVIEW_ASIDE_MOST, or more than half of the product's records (one alone may be), is not moved at all.
  if (records.damaged.length > REVIEW_ASIDE_MOST || records.damaged.length * 2 > Math.max(records.ids.length, 2)) {
    console.error(`reviews: ${records.damaged.length} of the ${records.ids.length} review records of product ${productId} do not read; too many to set aside, its numbers are left waiting`);
    return "unsure";
  }
  if (records.damaged.length && !(await setAside(statsId, productId, records.damaged))) {
    console.error(`reviews: the damaged review records of product ${productId} could not be set aside (an answer in an unknown shape); its numbers are left waiting`);
    return "unsure";
  }
  const reviews = records.reviews;
  const summary = summarise(reviews);
  const written = repliesFor(
    await redisPipeline([["EVAL", WRITE_NUMBERS_IF, 1, summaryKey(statsId), productId, mark, reviews.length ? JSON.stringify(summary) : ""]]),
    1,
  );
  if (written?.[0] === 0) {
    console.error(`reviews: the numbers of product ${productId} were marked again by a newer change before this recount wrote them; that change's recount, or the daily recount, counts them`);
    return "unsure";
  }
  if (written?.[0] !== 1) {
    console.error(`reviews: the numbers of product ${productId} were written with an answer in an unknown shape; counted again by the daily recount or at its next change`);
    return "unsure";
  }
  return summary;
}

/**
 * Writes a review; `also` goes in the same request (the AI summary's deletion), so a failure fails the write too. The
 * product's numbers are marked as waiting for their recount in the same request (numbersPending): a review is never
 * written while its product's numbers from before it are still shown. Returns that mark, for the recount that follows.
 */
async function write(statsId: string, review: Review, also: (string | number)[][] = []): Promise<string> {
  const member = `${review.productId}|${review.id}`;
  const mark = newMark();
  await redisPipeline([
    ["HSET", productKey(statsId, review.productId), review.id, JSON.stringify(review)],
    review.hidden
      ? ["ZREM", visibleKey(statsId, review.productId), review.id]
      : ["ZADD", visibleKey(statsId, review.productId), review.createdAt, review.id],
    ["ZADD", allKey(statsId), review.createdAt, member],
    ...also,
    numbersPending(statsId, review.productId, mark),
  ]);
  return mark;
}

export type SaveInput = {
  productId: string;
  email: string;
  reference: string;
  pi: string;
  rating: number;
  text: string;
  name: string;
  /** When the order was paid, in seconds, from the order's proof (606 [WP5]); 0 when not known. */
  paidAt?: number;
};

export type SaveResult = { state: "created" | "updated"; review: Review } | { state: "full" | "noroom" | "busy" | "invalid" };

/**
 * Where a product's reviews are counted in the store's data room
 * (lib/store-data.ts): each review's record and its places in the lists,
 * the buyer's words taken before they are written, the creator's answer the
 * same way.
 */
const REVIEWS_SLOT = (productId: string) => `rv:${productId}`;
const reviewBytes = (review: Review | null) => (review ? dataBytes([JSON.stringify(review)], 5) : 0);

/**
 * Writes a buyer's review, or changes the one they wrote. The caller has
 * already proved the order is theirs, paid and not refunded. An edit keeps
 * the review's first date (its place on the page) and the creator's choice
 * to hide it; the creator's answer stays, and the edit goes back into the
 * creator's queue so they see what changed.
 */
export async function saveReview(statsId: string, input: SaveInput, room: DataStore, now = Date.now()): Promise<SaveResult> {
  const rating = readRating(input.rating);
  if (!STATS_ID_PATTERN.test(statsId) || !PRODUCT_ID_PATTERN.test(input.productId) || rating === null) return { state: "invalid" };
  const id = reviewId(statsId, input.productId, input.email);
  const result = await locked(statsId, input.productId, async (): Promise<SaveResult> => {
    const replies = repliesFor(await redisPipeline([
      ["HGET", productKey(statsId, input.productId), id],
      ["HLEN", productKey(statsId, input.productId)],
    ]), 2);
    // Only in their exact shape (audit SG2, CX-123 rule 24): the buyer's
    // review as text, or null when they have none yet, and the count of the
    // product's reviews as a whole number. Anything else lets no review past
    // the ceiling: thrown, and the review page says nothing was changed.
    const raw = replies?.[0];
    const size = countOf(replies?.[1]);
    if (!replies || (raw !== null && typeof raw !== "string") || size === null) throw new UnknownReplyError("a product's reviews or their count");
    const before = parseReview(raw);
    if (!before && size >= MAX_REVIEWS_PER_PRODUCT) return { state: "full" };
    const review: Review = {
      id,
      productId: input.productId,
      reference: input.reference,
      pi: input.pi,
      rating,
      text: cleanReviewText(input.text),
      name: cleanReviewName(input.name),
      createdAt: before?.createdAt || now,
      editedAt: before ? now : 0,
      hidden: before?.hidden ?? false,
      hiddenReason: before?.hiddenReason ?? null,
      refunded: false,
      reply: before?.reply ?? null,
      // A photo stays through an edit; it is added or taken off by setReviewPhoto.
      photo: before?.photo ?? null,
    };
    // When the order was paid: kept from the first writing of the same order, else as the order's proof says.
    const paidAt = before && before.reference === input.reference && before.paidAt ? before.paidAt : input.paidAt;
    if (Number.isSafeInteger(paidAt) && (paidAt as number) > 0) review.paidAt = paidAt;
    const grown = reviewBytes(review) - reviewBytes(before);
    if (grown > 0 && !(await takeData(room, [{ slot: REVIEWS_SLOT(input.productId), bytes: grown }], now)).ok) return { state: "noroom" };
    // Words rewritten (perhaps to take something out): the AI summary built from the old words goes, in the same request.
    // A review hidden or refunded was never counted by one (lib/review-ai-summary-rules.ts, summaryInputs): it takes none away.
    const mark = await write(statsId, review, before && before.text !== review.text && counted(before) ? summaryGone(statsId, review.productId, before.createdAt) : []);
    await redisPipeline([
      ["ZADD", newKey(statsId), now, `${review.productId}|${id}`],
      ["SADD", REVIEW_STORES_KEY, statsId],
    ]);
    // Which reviews a payment paid for, kept for its refund: counted in the
    // store's room at what it really adds (lib/order-data.ts).
    if (review.pi) await orderWrite(room, [["HSET", payKey(statsId), review.pi, await payEntry(statsId, review.pi, `${review.productId}|${id}`)]]);
    await recount(statsId, input.productId, mark);
    return { state: before ? "updated" : "created", review };
  });
  return result === "busy" ? { state: "busy" } : result;
}

/** The reviews a payment paid for, with one more added. */
async function payEntry(statsId: string, pi: string, member: string): Promise<string> {
  // Read exactly (CX-123 rule 24): only an exact nil is a payment with no list yet. A reply lost or in another shape
  // throws, never an empty list: the list written from it would drop the other reviews this payment paid for, and a
  // refund of it would never reach them.
  const read = repliesFor(await redisPipeline([["HGET", payKey(statsId), pi]]), 1);
  const raw = read?.[0];
  if (!read || (raw !== null && typeof raw !== "string")) throw new UnknownReplyError("a payment's reviews");
  const list = raw ? raw.split(";").filter(Boolean) : [];
  if (!list.includes(member)) list.push(member);
  return list.slice(-20).join(";");
}

/**
 * A write's replies, each in its exact shape (CX-123 rule 24): one per command; for HDEL, ZREM, DEL and HSET a whole
 * number no larger than the fields, members or keys it names; for ZREMRANGEBYSCORE any whole number; "OK" for a SET.
 * Null for anything else, and the caller says the write as unknown.
 */
function exactWriteReplies(replies: unknown, commands: (string | number)[][]): unknown[] | null {
  const list = repliesFor(replies, commands.length);
  if (!list) return null;
  for (let i = 0; i < commands.length; i += 1) {
    const [name, , ...rest] = commands[i];
    const reply = list[i];
    if (name === "SET") {
      if (reply !== "OK") return null;
      continue;
    }
    const count = countOf(reply);
    const most =
      name === "HDEL" || name === "ZREM" ? rest.length : name === "DEL" ? rest.length + 1 : name === "HSET" ? rest.length / 2 : name === "ZREMRANGEBYSCORE" ? Number.MAX_SAFE_INTEGER : -1;
    if (count === null || count > most) return null;
  }
  return list;
}

/** A photo's path as a review keeps it (lib/product-image.ts), and a payment's id as a review keeps it. */
const PHOTO_PATH_PATTERN = /^images\/[0-9a-f]{24}\/[0-9a-f]{32}\.(webp|jpg)$/;
const PAYMENT_ID_PATTERN = /^[A-Za-z0-9_]{1,220}$/;

/**
 * What a review's record answered for its own buyer's deletion or erasure, read under the field the buyer's own id
 * names (reviewId: the field is the proof the record is theirs). Null only when confirmed absent. A reply that is not
 * text throws UnknownReplyError (rule 24: a lost or off-shape reply is unknown, the record kept for the retry).
 *
 * Text that does not read as this review (damaged, or another review's under this field) is not unknown: waiting never
 * changes it, and deleting the buyer's own field is always the safe side of their erasure. Its photo and its payment
 * are looked for where a record keeps them, only when the record still says it is this review: its JSON's own fields,
 * or, in text cut short, the fields after its own id and product (written first, lib/reviews.ts saveReview). `photo`
 * and `pi` are undefined when they cannot be found (never another review's: a record under this field that reads as
 * another review may be a copy of that review, whose photo is that buyer's).
 */
type OwnRecord = { review: Review | null; photo: string | null | undefined; pi: string | null | undefined };

function ownRecord(raw: unknown, productId: string, id: string, what: string): OwnRecord | null {
  if (raw === null) return null;
  if (typeof raw !== "string") throw new UnknownReplyError(what);
  const review = parseReview(raw);
  if (review && review.id === id && review.productId === productId) {
    return { review, photo: review.photo?.path ?? null, pi: review.pi || null };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  if (value !== undefined) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { review: null, photo: undefined, pi: undefined };
    const fields = value as Record<string, unknown>;
    if (fields.id !== id || fields.productId !== productId) return { review: null, photo: undefined, pi: undefined };
    const photo = fields.photo === null || fields.photo === undefined ? null : parseReviewPhoto(fields.photo)?.path ?? undefined;
    const pi = fields.pi === undefined || fields.pi === "" ? null : typeof fields.pi === "string" && fields.pi.length <= 220 ? fields.pi : undefined;
    return { review: null, photo, pi };
  }
  // Text cut short or broken: read on only when it begins as this review's own record.
  if (!raw.startsWith(`{"id":${JSON.stringify(id)},"productId":${JSON.stringify(productId)},`)) return { review: null, photo: undefined, pi: undefined };
  // A field's name never follows a backslash: inside the buyer's words, every quote is escaped. Exactly one, or none.
  const one = (pattern: RegExp): string | undefined => {
    const found = [...raw.matchAll(pattern)].map((match) => match[1]);
    return found.length === 1 ? found[0] : undefined;
  };
  const photoField = one(/(?<!\\)"photo":(null|\{"path":"[^"\\]*")/g);
  const photo = photoField === undefined ? undefined : photoField === "null" ? null : (() => {
    const path = photoField.slice('{"path":"'.length, -1);
    return PHOTO_PATH_PATTERN.test(path) ? path : undefined;
  })();
  const piField = one(/(?<!\\)"pi":"([^"\\]*)"/g);
  const pi = piField === undefined ? undefined : piField === "" ? null : PAYMENT_ID_PATTERN.test(piField) ? piField : undefined;
  return { review: null, photo, pi };
}

/**
 * A buyer's own deletion, done: the photo it found ("photoFound" false when it could not be found), and whether the
 * numbers were counted again. `alsoPhoto` is a second photo, only when an older record of the same buyer set aside as
 * damaged had one of its own (pre-review of a8737e12a6): the caller drops both.
 */
export type OwnDeletion = { state: "deleted"; photo: string | null; photoFound: boolean; damaged: boolean; recounted: boolean; alsoPhoto?: string };

/** The room a record set aside holds, as a review's was taken (reviewBytes): given back when it is deleted. */
const asideBytes = (raw: string) => dataBytes([raw], 5);

/** The photos of a buyer's record and of their older record set aside, each once, the first as `photo`. */
function photosOf(own: OwnRecord | null, aside: OwnRecord | null): { photo: string | null; photoFound: boolean; alsoPhoto?: string } {
  const paths = [...new Set([own?.photo, aside?.photo].filter((path): path is string => typeof path === "string"))];
  const found = (own ? own.photo !== undefined : true) && (aside ? aside.photo !== undefined : true);
  return { photo: paths[0] ?? null, photoFound: found, ...(paths[1] ? { alsoPhoto: paths[1] } : {}) };
}

/** Deletes a buyer's own review. Its stars leave the average with it. */
export async function deleteReview(statsId: string, productId: string, id: string, room: DataStore): Promise<"deleted" | "missing" | "busy"> {
  const done = await deleteOwnReview(statsId, productId, id, room);
  return typeof done === "string" ? done : "deleted";
}

/**
 * Deletes a buyer's own review, by the id their own address makes (the review route and a person's erasure), and says
 * what became of it: the photo to drop, and whether the product's numbers were counted again (when not, the page does
 * not say its stars left the average). A damaged record under that id is deleted too (ownRecord): its index entries
 * with it, the AI summary that may have counted it, its room left counted (its size is unknown: more than used, never
 * less), and the log names its id, never anything personal.
 */
export async function deleteOwnReview(statsId: string, productId: string, id: string, room: DataStore): Promise<OwnDeletion | "missing" | "busy"> {
  if (!REVIEW_ID_PATTERN.test(id) || !PRODUCT_ID_PATTERN.test(productId)) return "missing";
  const what = "a buyer's review (its deletion)";
  const result = await locked(statsId, productId, async () => {
    // Read exactly (CX-123 rule 24): only a confirmed absent field is "missing". A reply in another shape throws, so the
    // review is kept and its deletion is never said as done. A damaged record is deleted (ownRecord), in the product's
    // hash or where a recount set it aside (setAside, owner's decision 11): read in the same request, deleted with it.
    const read = repliesFor(await redisPipeline([["HGET", productKey(statsId, productId), id], ["HGET", asideKey(statsId, productId), id]]), 2);
    if (!read) throw new UnknownReplyError(what);
    const aside = ownRecord(read[1], productId, id, what);
    const own = ownRecord(read[0], productId, id, what);
    // Its room given back once its own HDEL answered that it removed it (as a review's, never twice).
    const asideRoom = async (removed: unknown) => {
      if (aside && removed === 1) await giveData(room, [{ slot: REVIEWS_SLOT(productId), bytes: asideBytes(read[1] as string) }]);
    };
    if (!own && aside) {
      // Only the record set aside: it was never counted since, so the numbers stay as they are (counted without it).
      const drop: (string | number)[][] = [["HDEL", asideKey(statsId, productId), id]];
      const dropped = exactWriteReplies(await redisPipeline(drop), drop);
      if (!dropped) throw new UnknownReplyError(what);
      await asideRoom(dropped[0]);
      console.error(`reviews: a damaged review record set aside (${productId}|${id}) was deleted for its buyer${aside.photo === undefined ? "; its photo could not be found" : ""}`);
      return { state: "deleted" as const, ...photosOf(null, aside), damaged: true, recounted: true };
    }
    if (!own) return "missing" as const;
    const gone = own.review;
    const mark = newMark();
    const deletion: (string | number)[][] = [
      ["HDEL", productKey(statsId, productId), id],
      ["ZREM", visibleKey(statsId, productId), id],
      ["ZREM", allKey(statsId), `${productId}|${id}`],
      ["ZREM", newKey(statsId), `${productId}|${id}`],
      // The AI summary that counted it goes in the same request: when it cannot, the deletion fails with it. One hidden or
      // refunded was never counted, and takes none away. A damaged one may have been: the summary goes (no date known).
      ...(!gone ? summaryGone(statsId, productId, 0) : counted(gone) ? summaryGone(statsId, productId, gone.createdAt) : []),
      // Its numbers wait for their recount from the same request: never shown counting the review just deleted.
      numbersPending(statsId, productId, mark),
      // An older record of the same buyer set aside as damaged goes with it (its photo is answered too).
      ...(aside ? [["HDEL", asideKey(statsId, productId), id]] : []),
    ];
    // Every reply in its exact shape, or the deletion is unknown: no room given back, and the field is read again
    // (below) before it is said as deleted or thrown.
    const replies = exactWriteReplies(await redisPipeline(deletion), deletion);
    // Its room given back only once its own HDEL answered that it removed the review: never twice for two
    // deletions racing. A request that failed may still have run the HDEL (an error on another command); the room
    // then stays counted, more than is used, never less. A damaged record's size is unknown: it stays counted.
    if (gone && replies?.[0] === 1) await giveData(room, [{ slot: REVIEWS_SLOT(productId), bytes: reviewBytes(gone) }]);
    if (aside) await asideRoom(replies?.[deletion.length - 1]);
    // Replies in an unknown shape: the field is read again, exactly. Confirmed absent means its HDEL ran, so the review
    // is deleted (the caller drops or hands over its photo; its room stays counted, as above). Still there, or read
    // again in another shape, throws.
    let removed = replies !== null;
    if (!removed) {
      const again = repliesFor(await redisPipeline([["HGET", productKey(statsId, productId), id]]), 1);
      removed = again !== null && again[0] === null;
    }
    const recounted = (await recount(statsId, productId, mark)) !== "unsure";
    if (!removed) throw new UnknownReplyError(what);
    if (!gone) {
      console.error(`reviews: a damaged review record (${productId}|${id}) was deleted for its buyer; its room stays counted${own.photo === undefined ? "; its photo could not be found" : ""}`);
    }
    return { state: "deleted" as const, ...photosOf(own, aside), damaged: !gone, recounted };
  });
  return result;
}

/** Changes one review as the creator may: hide or show it, or answer it. Never its words or its stars. */
async function creatorChange(
  statsId: string,
  productId: string,
  id: string,
  change: (review: Review) => Review,
  room: DataStore | null,
): Promise<Review | "missing" | "busy"> {
  if (!REVIEW_ID_PATTERN.test(id) || !PRODUCT_ID_PATTERN.test(productId)) return "missing";
  const what = "a review (the creator's change)";
  return locked(statsId, productId, async () => {
    // Read exactly (CX-123 rule 24): only a confirmed absent field is "missing". A reply in another shape throws; so
    // does a stored review that does not read or is another's (DamagedReviewError): never "missing", which would let a
    // refund pass take the refund as marked while the review's stars still count.
    const read = repliesFor(await redisPipeline([["HGET", productKey(statsId, productId), id]]), 1);
    if (!read) throw new UnknownReplyError(what);
    const raw = read[0];
    if (raw !== null && typeof raw !== "string") throw new UnknownReplyError(what);
    if (raw === null) return "missing" as const;
    const before = parseReview(raw);
    if (!before || before.id !== id || before.productId !== productId) throw new DamagedReviewError(what);
    const after = change(before);
    // What the creator's answer grows the review by takes room first (DataRoomError when it does not fit);
    // `room` is null for what only flips a mark or swaps a photo's path, which never refuses.
    const grown = reviewBytes(after) - reviewBytes(before);
    if (room && grown > 0) await needData(room, [{ slot: REVIEWS_SLOT(productId), bytes: grown }]);
    // A review hidden or refunded leaves the product's AI summary of its reviews (lib/review-ai-summary.ts) behind:
    // it goes in the same request as the change, so a failure fails the change too.
    // One already hidden or refunded was never counted, so hiding or refunding it takes none away.
    const gone = counted(before) && ((after.hidden && !before.hidden) || (after.refunded && !before.refunded));
    const mark = await write(statsId, after, gone ? summaryGone(statsId, productId, before.createdAt) : []);
    // What a shorter answer frees is given back only once it is written.
    if (room && grown < 0) await giveData(room, [{ slot: REVIEWS_SLOT(productId), bytes: -grown }]);
    await recount(statsId, productId, mark);
    return after;
  });
}

/**
 * What takes the product's AI summary of its reviews (lib/review-ai-summary.ts) away when a review it counted goes
 * or changes, sent in the same request as that change, so a failure fails the change too. A new mark first: a
 * summary being made now is kept only while the mark it read is still there (it cannot yet say which reviews it
 * read), so it is not kept either; the mark is kept eight days, as the summary. Then the kept summary's themes,
 * in one command: they are scored by the newest review the summary read (nl:rsum:<statsId>:<productId>:themes),
 * so only a review created at or before that (`createdAt`, ms; "all" when the product goes) removes them, and a
 * review written after the summary was made never takes it away. Its head (nl:rsum:) is never read without them.
 * A review older than the oldest the summary read (past its MAX_SUMMARY_REVIEWS newest) still takes it away: the
 * score holds one bound only, and both bounds in one step would need a script (lib/redis-memory.ts, its stand-in in
 * the tests, is reserved by another agent); more taken away than counted, never less.
 * When the week's last summary was made (nl:rsum:last:) is never deleted here.
 */
/** Whether an AI summary may have counted this review: only words a page shows, never a hidden or refunded review's. */
const counted = (review: Review): boolean => !review.hidden && !review.refunded;

const summaryGone = (statsId: string, productId: string, createdAt: number | "all"): (string | number)[][] => [
  ["SET", `nl:rsum:ver:${statsId}:${productId}`, randomBytes(12).toString("hex"), "EX", 8 * 86_400],
  createdAt === "all" || !Number.isSafeInteger(createdAt) || createdAt <= 0
    ? ["DEL", `nl:rsum:${statsId}:${productId}:themes`]
    : ["ZREMRANGEBYSCORE", `nl:rsum:${statsId}:${productId}:themes`, createdAt, "+inf"],
  ...(createdAt === "all" ? [["DEL", `nl:rsum:${statsId}:${productId}`]] : []),
];

/**
 * Puts a photo on a review, or takes it off (null): the buyer's own, or the
 * creator taking one off. What comes back is the photo it displaced, for the
 * caller to delete once this is written.
 */
export async function setReviewPhoto(statsId: string, productId: string, id: string, photo: ReviewPhoto | null): Promise<{ review: Review; removed: ReviewPhoto | null } | "missing" | "busy"> {
  let removed: ReviewPhoto | null = null;
  const done = await creatorChange(statsId, productId, id, (review) => {
    removed = review.photo && review.photo.path !== photo?.path ? review.photo : null;
    return { ...review, photo };
  }, null);
  return typeof done === "string" ? done : { review: done, removed };
}

/**
 * Hides a review for one of the review rules (HIDE_REASONS), or shows it again.
 * Null, and nothing changed, when it is hidden without a listed reason. The
 * rating is never read: the same rules for every review.
 */
export async function setHidden(statsId: string, productId: string, id: string, hidden: boolean, reason?: unknown) {
  if (hidden && !isHideReason(reason)) return null;
  const hiddenReason: HideReason | null = hidden && isHideReason(reason) ? reason : null;
  return creatorChange(statsId, productId, id, (review) => ({ ...review, hidden, hiddenReason }), null);
}

/** The creator's public answer; empty text takes it away. */
export function setReply(statsId: string, productId: string, id: string, text: string, room: DataStore, now = Date.now()) {
  const clean = cleanReviewText(text, MAX_REPLY_TEXT);
  return creatorChange(statsId, productId, id, (review) => ({
    ...review,
    reply: clean ? { text: clean, at: review.reply?.text === clean ? review.reply.at : now } : null,
  }), room);
}

/**
 * Marks as refunded every review a payment paid for, once Stripe says the
 * payment was given back in full. Returns how many changed.
 */
export async function markRefunded(statsId: string, pi: string, onDamaged?: (productId: string) => void): Promise<number> {
  if (!STATS_ID_PATTERN.test(statsId) || !pi) return 0;
  // Read exactly (CX-123 rule 24): only an exact nil is a payment that paid for no review. A reply lost or in another
  // shape throws, so the refund is not taken as seen and the next pass tries again.
  const read = repliesFor(await redisPipeline([["HGET", payKey(statsId), pi]]), 1);
  const raw = read?.[0];
  if (!read || (raw !== null && typeof raw !== "string")) throw new UnknownReplyError("a refunded payment's reviews");
  const members = raw ? raw.split(";").filter(Boolean) : [];
  let changed = 0;
  // A review that is busy, or whose read is lost or in another shape, is not marked: the first such failure is thrown
  // once every other review of the payment has been tried, so the refund is not taken as seen (the sweep tries again)
  // and one review never keeps the others' stars counting. A damaged record (text that does not read as that review)
  // is not thrown: waiting never changes it, and thrown on every pass it would stop the refunds sweep there for good
  // (lib/review-proof.ts), leaving every later refund's reviews counted. It is skipped as handled, never said as
  // marked (not in the count returned) and never rewritten from a guess; the log names it by its ids, never anything
  // personal; and its product's numbers are marked as waiting for a recount (no stars, said as unread), and its AI
  // summary taken away, since they may count it. A mark that cannot be written is thrown as the others, so the next pass tries again.
  // `onDamaged` is told its product, so the caller refreshes what quotes the store page keeps (a quote of the damaged
  // record would otherwise stay on top of the store, since nothing was said as marked).
  let failed: unknown = null;
  for (const member of members) {
    const [productId, id] = member.split("|");
    if (!productId || !id) continue;
    // Only while the review still rests on that payment: a buyer who wrote it
    // again from a later order that was kept is a buyer who kept one.
    let hit = false;
    let done: Awaited<ReturnType<typeof creatorChange>>;
    try {
      done = await creatorChange(statsId, productId, id, (review) => {
        if (review.pi !== pi || review.refunded) return review;
        hit = true;
        return { ...review, refunded: true };
      }, null);
    } catch (error) {
      if (!(error instanceof DamagedReviewError)) {
        failed ??= error;
        continue;
      }
      onDamaged?.(productId);
      // The AI summary that may have counted it goes in the same request, as a damaged record's own deletion does
      // (no date known): more taken away than counted, never less.
      const mark = [numbersPending(statsId, productId, newMark()), ...summaryGone(statsId, productId, 0)];
      let marked = false;
      try {
        marked = exactWriteReplies(await redisPipeline(mark), mark) !== null;
      } catch (markError) {
        failed ??= markError;
        continue;
      }
      if (!marked) {
        failed ??= new UnknownReplyError("a damaged review's numbers (their mark)");
        continue;
      }
      console.error(`reviews: a refunded payment's review record (${productId}|${id}) is damaged; not marked refunded, its product shows no stars until counted again`);
      continue;
    }
    if (done === "busy") failed ??= new Error("a review is busy; the refund is marked on the next try");
    if (hit) changed += 1;
  }
  if (failed !== null) throw failed;
  return changed;
}

/** Marks a review refunded found some other way (an edit that found the order refunded). */
export async function markOneRefunded(statsId: string, productId: string, id: string): Promise<void> {
  const done = await creatorChange(statsId, productId, id, (review) => ({ ...review, refunded: true }), null);
  if (done === "busy") throw new Error("a review is busy; its refund is marked on the next try");
}

/**
 * The daily recount of numbers left waiting (a recount mark, isRecountMark): a change marks its product's numbers in the same
 * request and its own recount replaces the mark, but a recount that fails for a moment (a read lost, a timeout) left
 * the mark until the product's next change, which may never come, and the product showed no stars, said as unread, for
 * good. Once a day the hourly recount job (app/api/cron/recount, at REVIEW_RECOUNT_HOUR_UTC) walks the stores with
 * reviews (nl:rev:stores, by SSCAN from where the last pass stopped), reads each store's numbers in one request per
 * page of stores, and counts again, under the product's lock and without waiting for it, each product still marked.
 *
 * Bounded before it reads (a company job, its cost in tests/plan-cost-registry.ts, NOT_A_COST): at most
 * REVIEW_RECOUNT_STORES_PER_DAY stores' numbers read, REVIEW_RECOUNTS_PER_DAY products tried (recounted, unsure or
 * busy) and RECOUNT_PAGES pages of the walk a pass, inside the deadline the job gives it. The mark is replaced only by recount(): numbers read whole from
 * the product's reviews in their exact shape; a read lost or in another shape, a damaged record, a store's numbers in
 * another shape, a busy lock or a thrown request leave the mark (no stars, said as unread), never numbers made up. A
 * page cut short by the deadline is read again next pass; one cut by a cap goes on from the next page, so a product
 * that never counts (a damaged record) cannot hold the walk on one page; the others wait for the walk's next round.
 */
export const REVIEW_RECOUNT_HOUR_UTC = 4;
export const REVIEW_RECOUNTS_PER_DAY = 50;
export const REVIEW_RECOUNT_STORES_PER_DAY = 500;
const RECOUNT_SCAN_COUNT = 100;
/** Pages of the walk a pass reads at the most, so pages with no store on them (SSCAN may give some) cannot fill it. */
const RECOUNT_PAGES = 20;
const RECOUNT_CURSOR_KEY = "nl:rev:recount:at";
const RECOUNT_CURSOR_SECONDS = 8 * 86_400;

export type WaitingPass = { stores: number; recounted: number; unsure: number; busy: number; capped: boolean; complete: boolean };

export async function recountWaiting(deadline: number): Promise<WaitingPass> {
  const out: WaitingPass = { stores: 0, recounted: 0, unsure: 0, busy: 0, capped: false, complete: false };
  if (!isRedisConfigured() || Date.now() >= deadline) return out;
  // Where the last pass stopped, read exactly: only an exact nil is a walk not started (or run out); anything else
  // that is not a cursor stops the pass, never a walk from the top taken for a kept place.
  const at = repliesFor(await redisPipeline([["GET", RECOUNT_CURSOR_KEY]]), 1);
  const kept = at?.[0];
  if (!at || (kept !== null && (typeof kept !== "string" || !/^[0-9]+$/.test(kept)))) throw new UnknownReplyError("the daily review recount's place");
  let cursor: string = kept ?? "0";
  const tried = () => out.recounted + out.unsure + out.busy;
  for (let pages = 0; Date.now() < deadline; pages += 1) {
    if (pages >= RECOUNT_PAGES || out.stores >= REVIEW_RECOUNT_STORES_PER_DAY || tried() >= REVIEW_RECOUNTS_PER_DAY) {
      out.capped = true;
      break;
    }
    const page = scanPage(await redisPipeline([["SSCAN", REVIEW_STORES_KEY, cursor, "COUNT", RECOUNT_SCAN_COUNT]]));
    if (!page) throw new UnknownReplyError("a page of the stores with reviews");
    const room = REVIEW_RECOUNT_STORES_PER_DAY - out.stores;
    const stores = page.items.filter((id) => STATS_ID_PATTERN.test(id));
    // A page larger than what is left is read whole by the next pass; only a pass's first page is cut to the cap
    // (its rest waits for the walk's next round), so the walk always moves.
    if (stores.length > room && out.stores > 0) {
      out.capped = true;
      break;
    }
    if (stores.length > room) out.capped = true;
    const ended = await recountStores(stores.slice(0, room), deadline, out);
    if (ended === "late") break;
    cursor = page.next;
    if (ended === "capped") out.capped = true;
    if (cursor === "0") {
      out.complete = !out.capped;
      break;
    }
  }
  const place: (string | number)[][] = [["SET", RECOUNT_CURSOR_KEY, cursor, "EX", RECOUNT_CURSOR_SECONDS]];
  if (!exactWriteReplies(await redisPipeline(place), place)) console.error("reviews: the daily recount's place was written with an answer in an unknown shape; the next pass may read the same stores again");
  return out;
}

/** One page of stores: their numbers in one request, then each product still marked, while the caps and the deadline allow. */
async function recountStores(stores: string[], deadline: number, out: WaitingPass): Promise<"done" | "late" | "capped"> {
  if (!stores.length) return "done";
  const read = repliesFor(await redisPipeline(stores.map((statsId) => ["HGETALL", summaryKey(statsId)])), stores.length);
  if (!read) throw new UnknownReplyError("the numbers of a page of stores");
  out.stores += stores.length;
  for (const [i, statsId] of stores.entries()) {
    const flat = stringList(read[i]);
    if (!flat || flat.length % 2 !== 0 || flat.some((field, j) => j % 2 === 0 && !PRODUCT_ID_PATTERN.test(field))) {
      console.error(`reviews: a store's numbers (${statsId}) read in an unknown shape; none of its products counted again this pass`);
      continue;
    }
    for (let j = 0; j < flat.length; j += 2) {
      // The mark as read here, before the product's reviews: its numbers are written only while it is still that one.
      const mark = flat[j + 1];
      if (!isRecountMark(mark)) continue;
      if (Date.now() >= deadline) return "late";
      if (out.recounted + out.unsure + out.busy >= REVIEW_RECOUNTS_PER_DAY) return "capped";
      const productId = flat[j];
      try {
        const done = await locked(statsId, productId, () => recount(statsId, productId, mark), 0);
        if (done === "busy") out.busy += 1;
        else if (done === "unsure") out.unsure += 1;
        else out.recounted += 1;
      } catch (error) {
        out.unsure += 1;
        console.error(`reviews: the daily recount of product ${productId} failed; its numbers stay waiting`, error);
      }
    }
  }
  return "done";
}

/** Takes reviews out of the creator's queue: those named, or all of them. */
export async function markSeen(statsId: string, members: string[] | "all"): Promise<void> {
  if (!STATS_ID_PATTERN.test(statsId)) return;
  if (members === "all") {
    await redisPipeline([["DEL", newKey(statsId)]]);
    return;
  }
  const valid = members.filter((m) => /^[a-z0-9]{6,40}\|[0-9a-f]{24}$/.test(m)).slice(0, 200);
  if (valid.length) await redisPipeline([["ZREM", newKey(statsId), ...valid]]);
}

export type StudioRow = Review & { unseen: boolean };

/**
 * What the studio lists: the queue (reviews not seen yet), or every review,
 * newest first, one page at a time. A record on the page that does not read
 * is left out and counted in `unreadable`, so the page says so and lists the
 * others; a reply in another shape still refuses the page.
 */
export async function studioReviews(
  statsId: string | null,
  options: { queue: boolean; offset: number; limit: number },
): Promise<{ rows: StudioRow[]; total: number; unseen: number; /** Records on this page that did not read (damaged), when any. */ unreadable?: number }> {
  if (!statsId || !STATS_ID_PATTERN.test(statsId) || !isRedisConfigured()) throw new Error("Review list unavailable");
  const source = options.queue ? newKey(statsId) : allKey(statsId);
  const index = await redisPipeline([
    ["ZREVRANGEBYSCORE", source, "+inf", "-inf", "LIMIT", options.offset, options.limit],
    ["ZCARD", source],
    ["ZCARD", newKey(statsId)],
  ]);
  if (!Array.isArray(index) || index.length !== 3) throw new Error("Review index incomplete");
  const [members, total, unseen] = index;
  if (!Array.isArray(members) || members.length > options.limit || new Set(members).size !== members.length ||
      !Number.isSafeInteger(total) || Number(total) < 0 || !Number.isSafeInteger(unseen) || Number(unseen) < 0 ||
      (options.queue && total !== unseen) || members.length > Number(total)) throw new Error("Review index unavailable");
  const list: string[] = [];
  for (const member of members) {
    if (typeof member !== "string") throw new Error("Review index unreadable");
    const [product, id, ...extra] = member.split("|");
    if (extra.length || !PRODUCT_ID_PATTERN.test(product) || !REVIEW_ID_PATTERN.test(id)) throw new Error("Review reference unreadable");
    list.push(member);
  }
  if (options.offset < Number(total) && list.length !== Math.min(options.limit, Number(total) - options.offset)) throw new Error("Review page incomplete");
  const byProduct = new Map<string, string[]>();
  for (const member of list) {
    const [productId, id] = member.split("|");
    if (!productId || !id) continue;
    byProduct.set(productId, [...(byProduct.get(productId) ?? []), id]);
  }
  const products = [...byProduct.entries()];
  const read = products.length
    ? await redisPipeline(products.map(([productId, ids]) => ["HMGET", productKey(statsId, productId), ...ids]))
    : [];
  const found = new Map<string, Review>();
  let unreadable = 0;
  if (!Array.isArray(read) || read.length !== products.length) throw new Error("Review records incomplete");
  read.forEach((values, group) => {
    const [productId, ids] = products[group];
    if (!Array.isArray(values) || values.length !== ids.length) throw new Error("Review records incomplete");
    values.forEach((value, i) => {
      // Anything but a text is unknown, and the page is refused. A text that does not read as this review is a damaged
      // record: waiting would never change it, so it is counted and said (`unreadable`), and the page lists the others
      // instead of refusing every review on it.
      if (typeof value !== "string") throw new Error("Review record unreadable");
      const review = parseReview(value);
      if (!review || review.productId !== productId || review.id !== ids[i]) {
        unreadable += 1;
        return;
      }
      found.set(`${review.productId}|${review.id}`, review);
    });
  });
  // Which of these are still in the queue: one score each, in one round trip.
  const flags = options.queue || list.length === 0 ? [] : await redisPipeline(list.map((member) => ["ZSCORE", newKey(statsId), member]));
  if (!options.queue && list.length && (!Array.isArray(flags) || flags.length !== list.length ||
      flags.some((flag) => flag !== null && !(typeof flag === "number" && Number.isFinite(flag)) && !(typeof flag === "string" && flag.trim() !== "" && Number.isFinite(Number(flag)))))) throw new Error("Review flags unreadable");
  const rows: StudioRow[] = [];
  list.forEach((member, i) => {
    const review = found.get(member);
    if (!review) return;
    rows.push({ ...review, unseen: options.queue ? true : flags[i] !== null && flags[i] !== undefined });
  });
  return { rows, total: Number(total) || 0, unseen: Number(unseen) || 0, ...(unreadable ? { unreadable } : {}) };
}

/** The most reviews the studio's overview reads at once (636 [GL4](c)). */
export const OVERVIEW_READ_MAX = 1_000;

/**
 * Every review written since `since` (milliseconds), newest first, for the
 * studio's overview by month (lib/review-overview.ts): at most
 * OVERVIEW_READ_MAX, with `complete` false when there were more. Throws when
 * the index or a record cannot be read, so a gap is never shown as no reviews.
 */
export async function reviewsSince(statsId: string | null, since: number): Promise<{ reviews: Review[]; complete: boolean }> {
  if (!statsId || !STATS_ID_PATTERN.test(statsId) || !isRedisConfigured()) throw new Error("Review list unavailable");
  const [members] = await redisPipeline([["ZREVRANGEBYSCORE", allKey(statsId), "+inf", since, "LIMIT", 0, OVERVIEW_READ_MAX + 1]]);
  if (!Array.isArray(members)) throw new Error("Review index unavailable");
  const complete = members.length <= OVERVIEW_READ_MAX;
  const byProduct = new Map<string, string[]>();
  for (const member of members.slice(0, OVERVIEW_READ_MAX)) {
    if (typeof member !== "string") throw new Error("Review index unreadable");
    const [product, id, ...extra] = member.split("|");
    if (extra.length || !PRODUCT_ID_PATTERN.test(product) || !REVIEW_ID_PATTERN.test(id)) throw new Error("Review reference unreadable");
    byProduct.set(product, [...(byProduct.get(product) ?? []), id]);
  }
  const products = [...byProduct.entries()];
  const read = products.length ? await redisPipeline(products.map(([productId, ids]) => ["HMGET", productKey(statsId, productId), ...ids])) : [];
  if (!Array.isArray(read) || read.length !== products.length) throw new Error("Review records incomplete");
  const reviews: Review[] = [];
  read.forEach((values, group) => {
    const [productId, ids] = products[group];
    if (!Array.isArray(values) || values.length !== ids.length) throw new Error("Review records incomplete");
    for (const value of values) {
      const review = parseReview(value);
      // A record gone since the index was read (its buyer deleted it) is simply not there.
      if (value === null) continue;
      if (!review || review.productId !== productId) throw new Error("Review record unreadable");
      reviews.push(review);
    }
  });
  return { reviews: reviews.sort((a, b) => b.createdAt - a.createdAt), complete };
}

/** Forgets every review of a product that is gone. Returns their photos' paths, for the caller to delete. */
export async function dropReviews(statsId: string | null, productId: string, tries = 1): Promise<string[]> {
  if (!statsId || !STATS_ID_PATTERN.test(statsId) || !isRedisConfigured()) return [];
  // Read once: a deletion that ran but did not answer in time leaves nothing to read again, and its photos would be lost.
  // Read exactly (CX-123 rule 24), in one command, before anything is deleted: a reply lost or in another shape throws
  // and nothing is deleted. Dropped without their ids, the reviews would stay in the studio's lists; without their
  // records, their photos would stay in the picture folder with nothing to find them by.
  // A record that answered in its exact place but does not read as this product's review under its own id is damaged,
  // not unknown: waiting would never change it, and the removal drops every record of the product anyway. It goes with
  // the rest, by its field (its id); only its photo cannot be found, and the log names it.
  // Its records set aside as damaged (setAside) are read in the same request and go with it, their photos handed over
  // where a record still says whose they are (ownRecord, by the field's id): no erasure looks for them once the
  // product is gone from the catalog (pre-review of a8737e12a6).
  const read = repliesFor(await redisPipeline([["HGETALL", productKey(statsId, productId)], ["HGETALL", asideKey(statsId, productId)]]), 2);
  const records = read ? recordsOf(read[0], productId) : null;
  const asideFlat = read ? stringList(read[1]) : null;
  if (!records || !asideFlat || asideFlat.length % 2 !== 0 || asideFlat.some((field, i) => i % 2 === 0 && !REVIEW_ID_PATTERN.test(field))) {
    throw new UnknownReplyError("a removed product's reviews");
  }
  const asidePhotos: string[] = [];
  for (let i = 0; i < asideFlat.length; i += 2) {
    const photo = ownRecord(asideFlat[i + 1], productId, asideFlat[i], "a removed product's reviews set aside")?.photo;
    if (photo) asidePhotos.push(photo);
  }
  if (records.unreadable.length) {
    console.error(`reviews: product ${productId} was removed with ${records.unreadable.length} review record(s) that did not read (${records.unreadable.join(", ")}); dropped with the others, a photo of theirs could not be found`);
  }
  const photos = [...new Set([...records.reviews.map((review) => review.photo?.path).filter((path): path is string => Boolean(path)), ...asidePhotos])];
  const members = records.ids.map((id) => `${productId}|${id}`);
  // Only the deletion is tried again (it can run twice: every command in it is the same the second time).
  for (let attempt = 1; ; attempt += 1) {
    try {
      await dropReviewRecords(statsId, productId, members);
      return photos;
    } catch (error) {
      if (attempt >= tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

/** A product's reviews, their index entries and their AI summary, deleted in one request. */
async function dropReviewRecords(statsId: string, productId: string, members: string[]): Promise<void> {
  await redisPipeline([
    ["DEL", productKey(statsId, productId)],
    ["DEL", asideKey(statsId, productId)],
    ["DEL", visibleKey(statsId, productId)],
    ["HDEL", summaryKey(statsId), productId],
    ...summaryGone(statsId, productId, "all"),
    ...(members.length ? [["ZREM", allKey(statsId), ...members], ["ZREM", newKey(statsId), ...members]] : []),
  ]);
}

/**
 * Deletes every review one buyer wrote in this store (lib/person-erasure.ts),
 * as their own delete does: its stars leave the average with it. Returns the
 * photos to delete from the picture folder; each also goes into `files`, when
 * given, before its review's delete is tried.
 */
export async function forgetReviewsPerson(
  statsId: string | null,
  productIds: string[],
  email: string,
  room: DataStore,
  files?: string[],
): Promise<{ records: number; photos: string[] }> {
  if (!statsId || !productIds.length || !isRedisConfigured()) return { records: 0, photos: [] };
  const wanted = productIds.filter((p) => PRODUCT_ID_PATTERN.test(p));
  const ids = wanted.map((p) => reviewId(statsId, p, email));
  const what = "a person's reviews (their erasure)";
  // Read exactly (CX-123 rule 24), every one before anything is deleted: only a confirmed absent field is "no review".
  // A reply in another shape throws, so the erasure is never said as done while the review (name, words, photo) is
  // still there. A damaged record under the person's own id is theirs (the field is their id): it is erased too,
  // its photo and payment looked for where a record keeps them (ownRecord); another person's record is never read.
  // A record set aside as damaged (setAside, owner's decision 11) is read in the same request, under the field the
  // person's own id names, and erased with the review (deleteOwnReview finds it there): both, when the person wrote
  // again after it was set aside, each with its photo and its payment (pre-review of a8737e12a6).
  const raws = wanted.length
    ? repliesFor(await redisPipeline([...wanted.map((p, i) => ["HGET", productKey(statsId, p), ids[i]]), ...wanted.map((p, i) => ["HGET", asideKey(statsId, p), ids[i]])]), wanted.length * 2)
    : [];
  if (!raws) throw new UnknownReplyError(what);
  const found = wanted.map((p, i) => [ownRecord(raws[i], p, ids[i], what), ownRecord(raws[wanted.length + i], p, ids[i], what)].filter((r): r is OwnRecord => r !== null));
  let records = 0;
  const photos: string[] = [];
  for (let i = 0; i < wanted.length; i += 1) {
    if (!found[i].length) continue;
    // Its payment's list first and the review itself last: whatever fails on the way, a retry finds the review again
    // and does every step once more (each is the same the second time).
    const pis = [...new Set(found[i].map((own) => own.pi))];
    for (const pi of pis) {
      if (pi) {
        const member = `${wanted[i]}|${ids[i]}`;
        const read = repliesFor(await redisPipeline([["HGET", payKey(statsId), pi]]), 1);
        const raw = read?.[0];
        // An unknown read is never an empty list: that would delete the other reviews this payment paid for.
        if (!read || (raw !== null && typeof raw !== "string")) throw new UnknownReplyError(`${what} (its payment's list)`);
        const rest = (raw === null ? [] : raw.split(";")).filter((m) => m && m !== member);
        const change: (string | number)[][] = [rest.length ? ["HSET", payKey(statsId), pi, rest.join(";")] : ["HDEL", payKey(statsId), pi]];
        if (!exactWriteReplies(await redisPipeline(change), change)) throw new UnknownReplyError(`${what} (its payment's list)`);
      } else if (pi === undefined) {
        console.error(`reviews: a damaged review record (${wanted[i]}|${ids[i]}) is erased; its payment's list could not be found, so its id may stay there`);
      }
    }
    // Its photos are handed to the eraser's files before the delete is tried: the review is being erased anyway, and a
    // delete that ran but answered in an unknown shape leaves nothing for the retry to find the photo by.
    for (const photo of new Set(found[i].map((own) => own.photo))) {
      if (!photo) continue;
      photos.push(photo);
      files?.push(photo);
    }
    if (typeof (await deleteOwnReview(statsId, wanted[i], ids[i], room)) === "string") throw new Error("a review could not be deleted just now");
    records += 1;
  }
  return { records, photos };
}

/** Narrow Path witness: current buyer-posted text, scoped to listed products.
 * No review content or buyer reference is returned to the Path page. */
export async function pathBuyerReview(statsId:string|null,listed:ReadonlySet<string>,limit:number):Promise<boolean|null>{
 if(!statsId||!STATS_ID_PATTERN.test(statsId)||!isRedisConfigured())return null;
 if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw new Error("Invalid review witness bound");
 const index=await redisPipeline([["ZREVRANGEBYSCORE",allKey(statsId),"+inf","-inf","LIMIT",0,limit],["ZCARD",allKey(statsId)]]);
 if(!Array.isArray(index)||index.length!==2||!Array.isArray(index[0])||!Number.isSafeInteger(index[1])||Number(index[1])<0)return null;
 const members=index[0] as unknown[];
 if(members.length>limit||new Set(members).size!==members.length)return null;
 const refs: {product:string;id:string}[]=[];
 for(const member of members){
  if(typeof member!=="string")return null;
  const [product,id,...extra]=member.split("|");
  if(extra.length||!PRODUCT_ID_PATTERN.test(product)||!REVIEW_ID_PATTERN.test(id))return null;
  refs.push({product,id});
 }
 if(!refs.length)return index[1]===0?false:null;
 const raw=await redisPipeline(refs.map(ref=>["HGET",productKey(statsId,ref.product),ref.id]));
 if(!Array.isArray(raw)||raw.length!==refs.length)return null;
 let unknown=false;
 for(let i=0;i<refs.length;i++){
  const review=parseReview(raw[i]);
  if(!review||review.id!==refs[i].id||review.productId!==refs[i].product){unknown=true;continue;}
  if(!listed.has(review.productId)||review.hidden||review.refunded||!review.text.trim())continue;
  if(/^cs_live_[A-Za-z0-9]{10,200}$/.test(review.reference))return true;
  // An intent id does not prove live mode; no test or ambiguous order is promoted.
  unknown=true;
 }
 return unknown||Number(index[1])>refs.length?null:false;
}
