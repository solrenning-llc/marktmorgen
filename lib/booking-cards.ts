/**
 * The calls a booking block may draw (lib/sales-page.ts, BookingBlock; queue
 * item 552 [BB1], unit 1): each call's name, how long it is and where it
 * happens, and the link to its own booking page (/@<store>/book/<id>), where
 * the times are picked and the booking is held and paid exactly as today.
 *
 * Read from the listings the store record already carries (catalog.head), as
 * the cards of another product are (lib/featured-cards.ts): drawing the block
 * costs no request, so a page with one costs what a page without one does. A
 * call past the store's first page has no card and the block is not drawn.
 *
 * Nothing is drawn for a call that is gone, a draft, no longer a call, or not
 * on sale (canSellProduct: a store that cannot take payments, a call with
 * price options or a subscription). A free intro call (551 [FB1]) is not on
 * sale either until its own way of booking lands, so it is not drawn yet.
 * Dated sessions with none left say so in words, with no link to an empty
 * page. Never a count of seats, a count of people booked, or a hurry.
 */
import type { Listing, Store } from "@/lib/store";
import type { BookingCard } from "@/components/sales-blocks";
import { canSellProduct } from "@/lib/store-checkout";
import { hasDateOnSale } from "@/lib/call-on-sale";
import { type CallSetup, MEET_NAMES } from "@/lib/call-setup";
import { placeLine } from "@/lib/call-place";
import { wordsIn } from "@/lib/buyer-words";
import { type BookingWords, bookingWords } from "@/lib/buyer-words/booking";
import { parseLanguage } from "@/lib/store-language";

/**
 * How long a call is and where it happens, with the booking page's own words
 * (lib/buyer-words/booking.ts): the same line its page shows under its title,
 * without the number of people a group call takes, which a block about
 * booking leaves to the booking page.
 */
export function bookingLine(setup: CallSetup, b: BookingWords): string {
  // In person (lib/call-place.ts): the address, and no link at all.
  if (setup.place) {
    const address = placeLine(setup.place);
    return setup.kind === "live" ? b.inPersonLiveLine(address) : b.inPersonLine(setup.minutes, address);
  }
  // A meeting made on the creator's own Google or Zoom account comes first, as it does on the booking page.
  const where = setup.meet
    ? b.whereMeet(MEET_NAMES[setup.meet])
    : setup.video
      ? b.whereVideo
      : setup.room || (setup.kind === "live" && setup.sessions.every((s) => s.room))
        ? b.whereLink
        : null;
  if (setup.kind === "live") return where ? b.liveLine(where) : b.liveOnline;
  return where ? b.oneLine(setup.minutes, where) : b.oneOnline(setup.minutes);
}

/** One call's card, in the store's language; null when it is not a call, a draft, or not on sale (`sellable`). */
export function bookingCardOf(listing: Listing, handle: string, language: unknown, sellable: boolean, now = Date.now()): BookingCard | null {
  const call = listing.call;
  if (!call || listing.hidden || !sellable) return null;
  const code = parseLanguage(language);
  const w = wordsIn(code);
  const b = bookingWords(code);
  const open = hasDateOnSale(call, now);
  return {
    title: listing.title,
    line: bookingLine(call, b),
    href: open ? `/@${handle}/book/${encodeURIComponent(listing.id)}` : null,
    pick: call.kind === "live" ? w.pickSession : w.pickTime,
    colon: b.colon,
    closed: open ? "" : w.noDates,
  };
}

/** The cards of the calls `only` names, by id, from the store's first page of listings. */
export function bookingCards(store: Store, only: readonly string[], now = Date.now()): Record<string, BookingCard> {
  const out: Record<string, BookingCard> = {};
  if (only.length === 0) return out;
  for (const listing of store.catalog.head) {
    if (!only.includes(listing.id)) continue;
    const card = bookingCardOf(listing, store.handle, store.language, listing.call ? canSellProduct(store, listing) : false, now);
    if (card) out[listing.id] = card;
  }
  return out;
}
