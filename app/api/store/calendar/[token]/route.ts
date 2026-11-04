import { storeForHandle } from "@/lib/store";
import { paidCalls } from "@/lib/calls";
import { FeedGone, bookedCalendar, bookedCalendarFeed, slotRooms, storeIdForToken } from "@/lib/calendar-sync";
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
  const owner = await storeIdForToken(token).catch(() => null);
  if (!owner) return missing();

  try {
    const answer = await bookedCalendarFeed(owner, async () => {
      const store = await storeForHandle(owner.handle);
      if (!store || store.statsId !== owner.statsId) throw new FeedGone();
      const calls = store.stripeAccountId ? await paidCalls(store) : [];
      const listings = await readKind(store, "call");
      return bookedCalendar(store, calls, Date.now(), listings, await slotRooms(store, calls, listings));
    });
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
