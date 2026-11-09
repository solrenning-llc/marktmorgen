/**
 * "What buyers say" on the store page (added 9 October 2026): the newest
 * reviews with words, from every product, kept on the store's own record so
 * the page shows them without reading anything more.
 *
 * Kept again after every change that could alter them — a review written,
 * changed or deleted by its buyer, hidden or shown by the creator, or its
 * purchase refunded — from the store's own list of reviews, newest first.
 * Only reviews on the page whose stars count are kept: never a hidden one,
 * never a refunded one. Nothing is picked for its stars: these are simply
 * the newest, and the page says so.
 */
import { type Review, studioReviews } from "@/lib/reviews";
import { readListings } from "@/lib/catalog";
import { type Store, dropQuotes, keepQuotes, setQuotes, storeRef } from "@/lib/store";
import { MAX_STORE_QUOTES, type StoreQuote, quoteText } from "@/lib/store-quotes-rules";

/** Words shorter than this say too little to quote. */
const MIN_QUOTE = 20;
/** How far down the newest reviews are looked for three with words. */
const LOOK_AT = 40;

/**
 * Reads the newest reviews and keeps the ones to quote on the store's record, read and written with the store's lock
 * held (keepQuotes): a hide, delete, refund or erasure takes that lock after its own change (dropReviewQuote), so a
 * list read before the change is written before it and taken off by it, never written after it. Never throws.
 */
export async function refreshStoreQuotes(store: Store): Promise<void> {
  try {
    await keepStoreQuotes(store);
  } catch (error) {
    console.error("keeping a store's newest reviews failed", error);
  }
}

/**
 * refreshStoreQuotes for a caller that must know it worked (a person's erasure, lib/person-erasure.ts): the quotes as
 * the reviews now stand, whatever an earlier run of that caller found. Throws when the record is not read or not
 * written, after taking every quote off, so the caller does not answer done.
 */
export async function keepStoreQuotes(store: Store): Promise<void> {
  const statsId = store.statsId;
  if (!statsId) return;
  try {
    const kept = await keepQuotes(storeRef(store), async (current) => {
      const { rows } = await studioReviews(statsId, { queue: false, offset: 0, limit: LOOK_AT });
      const quotes: StoreQuote[] = [];
      for (const row of rows) {
        if (row.hidden || row.refunded || row.text.replace(/\s+/g, " ").trim().length < MIN_QUOTE) continue;
        quotes.push({ p: row.productId, ti: "", r: row.rating, t: quoteText(row.text), n: row.name, at: row.editedAt || row.createdAt });
        if (quotes.length >= MAX_STORE_QUOTES) break;
      }
      // Each product's title as it is now, for the line under its review.
      const titles = new Map((await readListings(current, [...new Set(quotes.map((q) => q.p))])).map((p) => [p.id, p.title]));
      for (const quote of quotes) quote.ti = titles.get(quote.p) ?? "";
      return quotes;
    });
    if (!kept) throw new Error("the store's record was not read");
  } catch (error) {
    // Not read is not "as before": since the last keep a review may have been hidden, refunded or deleted, or its
    // words changed, so nothing is quoted rather than words that may be off its page now; the next change keeps them.
    await setQuotes(storeRef(store), []).catch((cleared: unknown) => console.error("taking a store's quotes off failed", cleared));
    throw error;
  }
}

/**
 * Takes a review's words off the store's record in the request that hides, deletes or refunds it, before that
 * request answers done: refreshStoreQuotes runs only after the answer. Every quote of the review's product kept at or
 * after the review was first written goes (each version of its words, and any newer quote of that product, which
 * the refresh after the answer keeps again). The record is read as it is now, under the store's lock, never decided
 * from the request's own copy of the store, which may predate a quote kept since; nothing is written when it quotes
 * none of them. Throws when the record is not read or not written, so the request does not answer done.
 */
export async function dropReviewQuote(store: Store, review: Pick<Review, "productId" | "createdAt">): Promise<void> {
  await dropReviewQuotes(store, [review]);
}

/** dropReviewQuote for several reviews at once, in one read of the record (a person's erasure, lib/person-erasure.ts). */
export async function dropReviewQuotes(store: Store, reviews: Pick<Review, "productId" | "createdAt">[]): Promise<void> {
  if (!reviews.length) return;
  const gone = (quote: StoreQuote) => reviews.some((review) => quote.p === review.productId && quote.at >= review.createdAt);
  if (!(await dropQuotes(storeRef(store), gone))) throw new Error("the store's record was not read; its quotes are taken off on the next try");
}
