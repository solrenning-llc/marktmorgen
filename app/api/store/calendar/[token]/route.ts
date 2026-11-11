import { storeForHandle } from "@/lib/store";
import { listForNaming } from "@/lib/store-readings";
import { paidCalls } from "@/lib/calls";
import { FeedGone, bookedCalendar, bookedCalendarFeed, ensureFeedToken, slotRooms, storeIdForToken, withoutErasedBookers } from "@/lib/calendar-sync";
import { readKind } from "@/lib/catalog";

/**
 * A store's bookings as a calendar to subscribe to, at its private address
 * (/api/store/calendar/<token>.ics). The token is the only key, so the
 * address is kept out of every page and can be replaced from the studio,
 * which turns this one off at once. Stripe is the record of who booked what.
 *
 * A calendar app asks on its own, every thirty minutes as the file asks, so asking spends
 * nothing the creator sees counted (since 4 November 2026, C4-4): it is
 * answered from the last good copy of the file, made again only after a
 * booking changed or every few hours, a few times a day at most, all of it
 * one cost line of its own (lib/calendar-sync.ts, bookedCalendarFeed).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params;
  const missing = () =>
    new Response("Not found.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
    });
  const later = (status: 429 | 503, seconds: number) =>
    new Response("Try again later.", {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": String(seconds), "Cache-Control": "no-store" },
    });
  const token = raw.replace(/\.ics$/i, "");
  // An address read in another shape is unknown: the app is told to come back, never "Not found", which many
  // calendar apps take as the end of the subscription (rule 24).
  let owner: Awaited<ReturnType<typeof storeIdForToken>>;
  try {
    owner = await storeIdForToken(token);
  } catch (error) {
    console.error("reading a calendar feed's address failed", error);
    return later(503, 900);
  }
  if (!owner) return missing();

  try {
    const answer = await bookedCalendarFeed(owner, async () => {
      let store = await storeForHandle(owner.handle);
      if (!store || store.statsId !== owner.statsId) throw new FeedGone();
      // Renamed, or settings from before they named the store's calls: written again, so its changes are read from now on.
      await ensureFeedToken(store).catch(() => {});
      // Who deleted their details from the store is not named, though Stripe keeps the booking (review of #2111).
      const paid = store.stripeAccountId ? await paidCalls(store) : [];
      // A store from before lists has none to keep deleted people's prints in: tried once a day before anyone is
      // named (lib/store-readings.ts, listForNaming; review of fe4cb5e56). With none, nobody is named: the times stay,
      // each booker "A buyer" (review of 2c1af02e0). Safe: an erasure always gives the store a list first.
      if (!store.listId && paid.some((c) => c.email || c.name)) {
        const listId = await listForNaming(store);
        if (listId) store = { ...store, listId };
      }
      const calls = store.listId ? await withoutErasedBookers(store, paid) : paid.map((c) => (c.email || c.name ? { ...c, email: null, name: null, unnamed: true } : c));
      const listings = await readKind(store, "call");
      const ics = bookedCalendar(store, calls, Date.now(), listings, await slotRooms(store, calls, listings));
      // Who the file may name, checked again where its copy is kept: a deletion meanwhile is not undone by it.
      return { ics, listId: store.listId, named: calls.map((c) => c.email).filter((e): e is string => Boolean(e)) };
    });
    // The store was deleted or closed: its copy, which names its buyers, is never answered again.
    if (answer.state === "gone") return missing();
    // Asked more often than its own refresh: the app keeps what it had.
    if (answer.state === "paced") return later(429, 900);
    if (!("ics" in answer)) return later(503, 3600);
    return new Response(answer.ics, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="bookings.ics"',
        "Cache-Control": "private, max-age=300",
        "X-Robots-Tag": "noindex",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof FeedGone) return missing();
    // Stripe did not answer and there is no copy yet. A calendar app asks again.
    console.error("making a booking calendar failed", error);
    return later(503, 300);
  }
}
