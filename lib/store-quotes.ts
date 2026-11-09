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
import { type Store, dropQuotes, setQuotes, storeRef } from "@/lib/store";
import { MAX_STORE_QUOTES, type StoreQuote, quoteText } from "@/lib/store-quotes-rules";

/** Words shorter than this say too little to quote. */
const MIN_QUOTE = 20;
/** How far down the newest reviews are looked for three with words. */
const LOOK_AT = 40;

/** Reads the newest reviews and keeps the ones to quote on the store's record. Never throws. */
export async function refreshStoreQuotes(store: Store): Promise<void> {
  if (!store.statsId) return;
  try {
    const { rows } = await studioReviews(store.statsId, { queue: false, offset: 0, limit: LOOK_AT });
    const quotes: StoreQuote[] = [];
    for (const row of rows) {
      if (row.hidden || row.refunded || row.text.replace(/\s+/g, " ").trim().length < MIN_QUOTE) continue;
      quotes.push({ p: row.productId, ti: "", r: row.rating, t: quoteText(row.text), n: row.name, at: row.editedAt || row.createdAt });
      if (quotes.length >= MAX_STORE_QUOTES) break;
    }
    // Each product's title as it is now, for the line under its review.
    const titles = new Map((await readListings(store, [...new Set(quotes.map((q) => q.p))])).map((p) => [p.id, p.title]));
    for (const quote of quotes) quote.ti = titles.get(quote.p) ?? "";
    const same = JSON.stringify(quotes) === JSON.stringify(store.quotes);
    if (!same) await setQuotes(storeRef(store), quotes);
  } catch (error) {
    console.error("keeping a store's newest reviews failed", error);
    // Not read is not "as before": since the last keep a review may have been hidden, refunded or deleted, or its
    // words changed, so nothing is quoted rather than words that may be off its page now; the next change keeps them.
    await setQuotes(storeRef(store), []).catch((cleared: unknown) => console.error("taking a store's quotes off failed", cleared));
  }
}

/**
 * Takes a review's words off the store's record in the request that hides, deletes or refunds it, before that
 * request answers done: refreshStoreQuotes runs only after the answer. Every quote of the review's product kept at or
 * after the review was first written goes (each version of its words, and any newer quote of that product, which
 * the refresh after the answer keeps again). Nothing is read or written when the record, as read for the request,
 * quotes none of them. Throws when the record is not read or not written, so the request does not answer done.
 */
export async function dropReviewQuote(store: Store, review: Pick<Review, "productId" | "createdAt">): Promise<void> {
  const gone = (quote: StoreQuote) => quote.p === review.productId && quote.at >= review.createdAt;
  if (!store.quotes.some(gone)) return;
  if (!(await dropQuotes(storeRef(store), gone))) throw new Error("the store's record was not read; its quotes are taken off on the next try");
}
