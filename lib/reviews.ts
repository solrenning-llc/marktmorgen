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
 *   nl:rev:stores             -> set of statsIds with any review (the refund pass)
 */
import { createHash, randomBytes } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
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
  type Summary,
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
export const REVIEW_STORES_KEY = "nl:rev:stores";

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

function parseSummary(raw: unknown): Summary {
  if (typeof raw !== "string" || !raw) return { ...EMPTY_SUMMARY, dist: [0, 0, 0, 0, 0] };
  try {
    const value = JSON.parse(raw) as Partial<Summary>;
    const n = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : 0);
    const dist = Array.isArray(value.dist) && value.dist.length === 5 ? value.dist.map(n) : [0, 0, 0, 0, 0];
    return {
      count: n(value.count),
      stars: n(value.stars),
      visible: n(value.visible),
      hidden: n(value.hidden),
      refunded: n(value.refunded),
      dist: dist as Summary["dist"],
    };
  } catch {
    return { ...EMPTY_SUMMARY, dist: [0, 0, 0, 0, 0] };
  }
}

/** The numbers of every product of a store that has reviews, in one read. */
export async function summaries(statsId: string | null): Promise<Map<string, Summary>> {
  const out = new Map<string, Summary>();
  if (!statsId || !STATS_ID_PATTERN.test(statsId) || !isRedisConfigured()) return out;
  const [raw] = await redisPipeline([["HGETALL", summaryKey(statsId)]]);
  const flat = Array.isArray(raw) ? (raw as unknown[]) : [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    if (typeof flat[i] === "string") out.set(flat[i] as string, parseSummary(flat[i + 1]));
  }
  return out;
}

export async function summaryOf(statsId: string | null, productId: string): Promise<Summary> {
  if (!statsId || !STATS_ID_PATTERN.test(statsId) || !isRedisConfigured()) return { ...EMPTY_SUMMARY, dist: [0, 0, 0, 0, 0] };
  const [raw] = await redisPipeline([["HGET", summaryKey(statsId), productId]]);
  return parseSummary(raw);
}

/** The reviews on a product's page, newest first. */
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
  const [ids] = await redisPipeline([
    ["ZREVRANGEBYSCORE", visibleKey(statsId, productId), "+inf", "-inf", "LIMIT", offset, limit],
  ]);
  const list = Array.isArray(ids) ? (ids as string[]).filter((id) => REVIEW_ID_PATTERN.test(id)) : [];
  const picked = offset === 0 ? first.filter((id) => REVIEW_ID_PATTERN.test(id)).slice(0, 3) : [];
  const wanted = [...new Set([...picked, ...list])];
  if (wanted.length === 0) return [];
  const [rows] = await redisPipeline([["HMGET", productKey(statsId, productId), ...wanted]]);
  const read = (Array.isArray(rows) ? rows : []).map(parseReview);
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
 * the numbers from two different moments. "busy" when it could not be had.
 */
async function locked<T>(statsId: string, productId: string, work: () => Promise<T>): Promise<T | "busy"> {
  // Under a token of this call's own, let go of in one step (lib/redis-lock.ts): a lock that ran out and was taken
  // by another call is never let go of by this one.
  let held;
  try {
    held = await takeLock(lockKey(statsId, productId), 10, 1_600);
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

/** Counts a product's numbers again from its reviews, and keeps them. */
async function recount(statsId: string, productId: string): Promise<Summary> {
  const [raw] = await redisPipeline([["HGETALL", productKey(statsId, productId)]]);
  const flat = Array.isArray(raw) ? (raw as unknown[]) : [];
  const reviews: Review[] = [];
  for (let i = 1; i < flat.length; i += 2) {
    const review = parseReview(flat[i]);
    if (review) reviews.push(review);
  }
  const summary = summarise(reviews);
  await redisPipeline([
    reviews.length ? ["HSET", summaryKey(statsId), productId, JSON.stringify(summary)] : ["HDEL", summaryKey(statsId), productId],
  ]);
  return summary;
}

/** Writes a review; `also` goes in the same request (the AI summary's deletion), so a failure fails the write too. */
async function write(statsId: string, review: Review, also: (string | number)[][] = []): Promise<void> {
  const member = `${review.productId}|${review.id}`;
  await redisPipeline([
    ["HSET", productKey(statsId, review.productId), review.id, JSON.stringify(review)],
    review.hidden
      ? ["ZREM", visibleKey(statsId, review.productId), review.id]
      : ["ZADD", visibleKey(statsId, review.productId), review.createdAt, review.id],
    ["ZADD", allKey(statsId), review.createdAt, member],
    ...also,
  ]);
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
    await write(statsId, review, before && before.text !== review.text && counted(before) ? summaryGone(statsId, review.productId, before.createdAt) : []);
    await redisPipeline([
      ["ZADD", newKey(statsId), now, `${review.productId}|${id}`],
      ["SADD", REVIEW_STORES_KEY, statsId],
    ]);
    // Which reviews a payment paid for, kept for its refund: counted in the
    // store's room at what it really adds (lib/order-data.ts).
    if (review.pi) await orderWrite(room, [["HSET", payKey(statsId), review.pi, await payEntry(statsId, review.pi, `${review.productId}|${id}`)]]);
    await recount(statsId, input.productId);
    return { state: before ? "updated" : "created", review };
  });
  return result === "busy" ? { state: "busy" } : result;
}

/** The reviews a payment paid for, with one more added. */
async function payEntry(statsId: string, pi: string, member: string): Promise<string> {
  const [raw] = await redisPipeline([["HGET", payKey(statsId), pi]]);
  const list = typeof raw === "string" && raw ? raw.split(";").filter(Boolean) : [];
  if (!list.includes(member)) list.push(member);
  return list.slice(-20).join(";");
}

/**
 * A review's field as read for a deletion (CX-123 rule 24): null only when it is confirmed absent; the review when it
 * reads. A reply in another shape, or a stored review that does not read, throws UnknownReplyError, never "no review",
 * so the deletion keeps it for the retry.
 */
function storedReview(raw: unknown, what: string): Review | null {
  if (raw === null) return null;
  const review = typeof raw === "string" ? parseReview(raw) : null;
  if (!review) throw new UnknownReplyError(what);
  return review;
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

/** Deletes a buyer's own review. Its stars leave the average with it. */
export async function deleteReview(statsId: string, productId: string, id: string, room: DataStore): Promise<"deleted" | "missing" | "busy"> {
  if (!REVIEW_ID_PATTERN.test(id) || !PRODUCT_ID_PATTERN.test(productId)) return "missing";
  const what = "a buyer's review (its deletion)";
  const result = await locked(statsId, productId, async () => {
    // Read exactly (CX-123 rule 24): only a confirmed absent field is "missing". A reply in another shape, or a stored
    // review that does not read, throws, so the review is kept and its deletion is never said as done.
    const read = repliesFor(await redisPipeline([["HGET", productKey(statsId, productId), id]]), 1);
    if (!read) throw new UnknownReplyError(what);
    const gone = storedReview(read[0], what);
    if (!gone) return "missing" as const;
    const deletion: (string | number)[][] = [
      ["HDEL", productKey(statsId, productId), id],
      ["ZREM", visibleKey(statsId, productId), id],
      ["ZREM", allKey(statsId), `${productId}|${id}`],
      ["ZREM", newKey(statsId), `${productId}|${id}`],
      // The AI summary that counted it goes in the same request: when it cannot, the deletion fails with it. One hidden or
      // refunded was never counted, and takes none away.
      ...(counted(gone) ? summaryGone(statsId, productId, gone.createdAt) : []),
    ];
    // Every reply in its exact shape, or the deletion is unknown: no room given back, and the field is read again
    // (below) before it is said as deleted or thrown.
    const replies = exactWriteReplies(await redisPipeline(deletion), deletion);
    // Its room given back only once its own HDEL answered that it removed the review: never twice for two
    // deletions racing. A request that failed may still have run the HDEL (an error on another command); the room
    // then stays counted, more than is used, never less.
    if (replies?.[0] === 1) await giveData(room, [{ slot: REVIEWS_SLOT(productId), bytes: reviewBytes(gone) }]);
    // Replies in an unknown shape: the field is read again, exactly. Confirmed absent means its HDEL ran, so the review
    // is deleted (the caller drops or hands over its photo; its room stays counted, as above). Still there, or read
    // again in another shape, throws.
    let removed = replies !== null;
    if (!removed) {
      const again = repliesFor(await redisPipeline([["HGET", productKey(statsId, productId), id]]), 1);
      removed = again !== null && again[0] === null;
    }
    await recount(statsId, productId);
    if (!removed) throw new UnknownReplyError(what);
    return "deleted" as const;
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
  return locked(statsId, productId, async () => {
    const [raw] = await redisPipeline([["HGET", productKey(statsId, productId), id]]);
    const before = parseReview(raw);
    if (!before) return "missing" as const;
    const after = change(before);
    // What the creator's answer grows the review by takes room first (DataRoomError when it does not fit);
    // `room` is null for what only flips a mark or swaps a photo's path, which never refuses.
    const grown = reviewBytes(after) - reviewBytes(before);
    if (room && grown > 0) await needData(room, [{ slot: REVIEWS_SLOT(productId), bytes: grown }]);
    // A review hidden or refunded leaves the product's AI summary of its reviews (lib/review-ai-summary.ts) behind:
    // it goes in the same request as the change, so a failure fails the change too.
    // One already hidden or refunded was never counted, so hiding or refunding it takes none away.
    const gone = counted(before) && ((after.hidden && !before.hidden) || (after.refunded && !before.refunded));
    await write(statsId, after, gone ? summaryGone(statsId, productId, before.createdAt) : []);
    // What a shorter answer frees is given back only once it is written.
    if (room && grown < 0) await giveData(room, [{ slot: REVIEWS_SLOT(productId), bytes: -grown }]);
    await recount(statsId, productId);
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
export async function markRefunded(statsId: string, pi: string): Promise<number> {
  if (!STATS_ID_PATTERN.test(statsId) || !pi) return 0;
  const [raw] = await redisPipeline([["HGET", payKey(statsId), pi]]);
  const members = typeof raw === "string" && raw ? raw.split(";").filter(Boolean) : [];
  let changed = 0;
  for (const member of members) {
    const [productId, id] = member.split("|");
    if (!productId || !id) continue;
    // Only while the review still rests on that payment: a buyer who wrote it
    // again from a later order that was kept is a buyer who kept one.
    let hit = false;
    const done = await creatorChange(statsId, productId, id, (review) => {
      if (review.pi !== pi || review.refunded) return review;
      hit = true;
      return { ...review, refunded: true };
    }, null);
    // A review busy just now is not marked: thrown, so the refund is not taken as seen and the sweep tries again.
    if (done === "busy") throw new Error("a review is busy; the refund is marked on the next try");
    if (hit) changed += 1;
  }
  return changed;
}

/** Marks a review refunded found some other way (an edit that found the order refunded). */
export async function markOneRefunded(statsId: string, productId: string, id: string): Promise<void> {
  const done = await creatorChange(statsId, productId, id, (review) => ({ ...review, refunded: true }), null);
  if (done === "busy") throw new Error("a review is busy; its refund is marked on the next try");
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
 * newest first, one page at a time.
 */
export async function studioReviews(
  statsId: string | null,
  options: { queue: boolean; offset: number; limit: number },
): Promise<{ rows: StudioRow[]; total: number; unseen: number }> {
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
  if (!Array.isArray(read) || read.length !== products.length) throw new Error("Review records incomplete");
  read.forEach((values, group) => {
    const [productId, ids] = products[group];
    if (!Array.isArray(values) || values.length !== ids.length) throw new Error("Review records incomplete");
    values.forEach((value, i) => {
      const review = parseReview(value);
      if (!review || review.productId !== productId || review.id !== ids[i]) throw new Error("Review record unreadable");
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
  return { rows, total: Number(total) || 0, unseen: Number(unseen) || 0 };
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
  const [raw, all] = await redisPipeline([["HKEYS", productKey(statsId, productId)], ["HVALS", productKey(statsId, productId)]]);
  const ids = Array.isArray(raw) ? (raw as string[]) : [];
  const photos = (Array.isArray(all) ? (all as unknown[]) : []).map((one) => parseReview(one)?.photo?.path).filter((path): path is string => Boolean(path));
  const members = ids.map((id) => `${productId}|${id}`);
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
  // A reply in another shape, or a stored review that does not read, throws, so the erasure is never said as done
  // while the review (name, words, photo) is still there.
  const raws = wanted.length ? repliesFor(await redisPipeline(wanted.map((p, i) => ["HGET", productKey(statsId, p), ids[i]])), wanted.length) : [];
  if (!raws) throw new UnknownReplyError(what);
  const reviews = raws.map((raw) => storedReview(raw, what));
  let records = 0;
  const photos: string[] = [];
  for (let i = 0; i < wanted.length; i += 1) {
    const review = reviews[i];
    if (!review) continue;
    // Its payment's list first and the review itself last: whatever fails on the way, a retry finds the review again
    // and does every step once more (each is the same the second time).
    if (review.pi) {
      const member = `${wanted[i]}|${ids[i]}`;
      const read = repliesFor(await redisPipeline([["HGET", payKey(statsId), review.pi]]), 1);
      const raw = read?.[0];
      // An unknown read is never an empty list: that would delete the other reviews this payment paid for.
      if (!read || (raw !== null && typeof raw !== "string")) throw new UnknownReplyError(`${what} (its payment's list)`);
      const rest = (raw === null ? [] : raw.split(";")).filter((m) => m && m !== member);
      const change: (string | number)[][] = [rest.length ? ["HSET", payKey(statsId), review.pi, rest.join(";")] : ["HDEL", payKey(statsId), review.pi]];
      if (!exactWriteReplies(await redisPipeline(change), change)) throw new UnknownReplyError(`${what} (its payment's list)`);
    }
    // Its photo is handed to the eraser's files before the delete is tried: the review is being erased anyway, and a
    // delete that ran but answered in an unknown shape leaves nothing for the retry to find the photo by.
    if (review.photo?.path) {
      photos.push(review.photo.path);
      files?.push(review.photo.path);
    }
    if ((await deleteReview(statsId, wanted[i], ids[i], room)) !== "deleted") throw new Error("a review could not be deleted just now");
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
