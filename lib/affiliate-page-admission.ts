/**
 * Whether a store's affiliate page may be drawn, and its book, paid for
 * before it reads (4 November 2026, lib/public-read-rules.ts). Until then
 * the page read the whole program's records and the creator's Stripe
 * account on every load of a signed-in affiliate, and counted nothing.
 *
 *   - Somebody not signed in, or an affiliate waiting (who never sold), sees
 *     the program's terms and where they stand, and no book: a public page of
 *     the store, which rests with the others (isResting) and takes one more
 *     request for each PUBLIC_LISTINGS_PER_UNIT products it reads.
 *   - An affiliate declined or removed whose part is in the kept book (a
 *     balance, a commission, a payment made; one approved before) is an
 *     approved affiliate's load: the same units, and, when the book is out of
 *     date, the same refresh under the same lock, so they always see what
 *     they are owed. With no part kept they never refresh it, and see the
 *     page as somebody waiting does.
 *   - An approved affiliate sees their own page, which rests only once the
 *     whole window is used (as a buyer's pages do). Its load takes
 *     affiliateLoadUnits: the page, its own part of the kept book
 *     (lib/affiliate-book-snapshot.ts), its listings and its codes. The one
 *     load that finds the kept book out of date, holding the refresh lock and
 *     finding it still out of date once it holds it, also pays
 *     affiliatePageUnits for working it out for everybody, counted against
 *     the store's window but not against the asking connection's share of
 *     the day (lib/traffic.ts, `shared`): it is done for all the program's
 *     affiliates, at most once in BOOK_FRESH_SECONDS (BOOK_SHORT_SECONDS a
 *     few times for an incomplete one, and once more for an affiliate
 *     approved since, no sooner than BOOK_NEW_AFFILIATE_SECONDS), and alone
 *     it can be larger than one connection's share. When the book could not
 *     be kept (too large), each load until the next refresh works out its
 *     own, paid from its own connection's share.
 *
 * Not admitted means draw the resting page and read nothing more.
 */
import type { Affiliate, Book } from "@/lib/affiliates";
import { DISPUTE_PAGES, INVOICE_PAGES, REFUND_PAGES, affiliatesOn, bookSize, readBook } from "@/lib/affiliates";
import { type SnapshotState, BOOK_FRESH_SECONDS, bookSlice, claimRefresh, hasSomething, needsRefresh, readSlice, refreshBook, releaseRefresh, snapshotState } from "@/lib/affiliate-book-snapshot";
import { codeOwnerCount } from "@/lib/affiliate-codes";
import { affiliateLoadUnits, affiliatePageUnits, listingUnits } from "@/lib/public-read-rules";
import type { Store } from "@/lib/store";
import { isResting, takePublicRequest } from "@/lib/traffic";

export type AffiliatePageAdmission =
  | { admitted: false }
  /** No book on this page: a visitor, an affiliate waiting or declined, or one removed with nothing kept. */
  | { admitted: true; book: null }
  /** The affiliate's own part of the book, when it was worked out and whether it is worked out again only once a day; "soon" while another load is working it out and none is kept. */
  | { admitted: true; book: KeptBook | "soon" };

export type KeptBook = { book: Book; at: number; daily: boolean };

const REFUSED = { admitted: false } as const;

/** Listings the page reads: the products with a rate of their own, and a partner's own products. */
export function affiliatePageListings(store: Store, affiliate: Pick<Affiliate, "share"> | null): number {
  return Object.keys(store.affiliates.rates ?? {}).length + (affiliate?.share?.products.length ?? 0);
}

/** Whether the page reads the store's discount codes for this affiliate (app/[handle]/affiliates, myCodes). */
export function readsCodes(store: Store, affiliate: Pick<Affiliate, "status">): boolean {
  return affiliate.status === "approved" && affiliatesOn(store) && Boolean(store.hasDiscounts) && Boolean(store.stripeAccountId);
}

/** The requests working out the whole program's book takes, or null when it cannot be counted. */
export async function affiliatePageCost(store: Store): Promise<number | null> {
  const size = await bookSize(store);
  if (!size) return null;
  return affiliatePageUnits({
    ...size,
    // The products the invoices name, read for their titles: at most a page of a hundred each, and only the store's own.
    listings: Math.min(INVOICE_PAGES * 100, store.catalog.items.length),
    stripePages: store.stripeAccountId ? INVOICE_PAGES + REFUND_PAGES + DISPUTE_PAGES : 0,
  });
}

/**
 * Works the whole program's book out and keeps it, for the one load that
 * holds the refresh lock and, holding it, still finds the kept book out of
 * date (another load may have refreshed it meanwhile): affiliatePageUnits of
 * the store's window, not of the asking connection's share. This
 * affiliate's part of it; null when another load holds the lock, the book
 * was refreshed meanwhile, or the window has no room.
 */
async function refreshFor(store: Store, id: string, now: number): Promise<KeptBook | null> {
  const held = await claimRefresh(store);
  if (!held) return null;
  try {
    const seconds = Math.floor(now / 1000);
    const again = await snapshotState(store, id);
    if (!again || !needsRefresh(again, seconds)) return null;
    const units = await affiliatePageCost(store);
    if (units === null || !(await takePublicRequest(store, "buyer", now, units, { shared: true }))) return null;
    const { book, short } = await refreshBook(store, seconds);
    return { book: bookSlice(book, id), at: seconds, daily: !short };
  } finally {
    await releaseRefresh(held);
  }
}

/**
 * While the book is in date but could not be kept (too large): this load
 * works out the affiliate's own book, paid in full from its own
 * connection's share of the day.
 */
async function ownBook(store: Store, id: string, now: number): Promise<KeptBook | null> {
  const units = await affiliatePageCost(store);
  if (units === null || !(await takePublicRequest(store, "buyer", now, units))) return null;
  return { book: await readBook(store, id), at: Math.floor(now / 1000), daily: true };
}

/** What a load that has paid its own part reads: the refresh when it is due, the kept part, or its own book when none could be kept. */
async function bookFor(store: Store, id: string, state: SnapshotState, now: number): Promise<KeptBook | "soon"> {
  const seconds = Math.floor(now / 1000);
  const fresh = needsRefresh(state, seconds) ? await refreshFor(store, id, now) : null;
  if (fresh) return fresh;
  if (state.at && !state.kept && !needsRefresh(state, seconds)) return (await ownBook(store, id, now)) ?? "soon";
  // Another load is working it out, or the window has no room for it: the last one kept, when there is one.
  const kept = state.sliceBytes > 0 ? await readSlice(store, id) : null;
  return kept ? { ...kept, daily: state.freshFor === BOOK_FRESH_SECONDS } : "soon";
}

export async function admitAffiliatePage(store: Store, affiliate: Pick<Affiliate, "id" | "status" | "share"> | null, now = Date.now()): Promise<AffiliatePageAdmission> {
  const listings = affiliatePageListings(store, affiliate);
  if (affiliate && affiliate.status !== "approved" && affiliate.status !== "pending") {
    // Declined or removed: their own part when the kept book holds one, never a refresh of their own otherwise.
    const state = await snapshotState(store, affiliate.id);
    if (state && state.sliceBytes > 0) {
      if (!(await takePublicRequest(store, "buyer", now, affiliateLoadUnits({ sliceBytes: state.sliceBytes, listings, codes: null })))) return REFUSED;
      const kept = await bookFor(store, affiliate.id, state, now);
      if (kept !== "soon" && hasSomething(kept.book)) return { admitted: true, book: kept };
    }
  }
  if (!affiliate || affiliate.status !== "approved") {
    if (await isResting(store, now)) return REFUSED;
    const extra = listingUnits(listings);
    if (extra > 0 && !(await takePublicRequest(store, "public", now, extra))) return REFUSED;
    return { admitted: true, book: null };
  }
  const state = await snapshotState(store, affiliate.id);
  if (!state) return REFUSED;
  const codes = readsCodes(store, affiliate) ? await codeOwnerCount(store) : null;
  if (readsCodes(store, affiliate) && codes === null) return REFUSED;
  if (!(await takePublicRequest(store, "buyer", now, affiliateLoadUnits({ sliceBytes: state.sliceBytes, listings, codes })))) return REFUSED;
  return { admitted: true, book: await bookFor(store, affiliate.id, state, now) };
}
