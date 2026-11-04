import { storeForHandle } from "@/lib/store";
import { paidCalls } from "@/lib/calls";
import { bookedCalendar, cachedBookedCalendar, slotRooms, storeIdForToken } from "@/lib/calendar-sync";
import { readKind } from "@/lib/catalog";
import { countStudio } from "@/lib/studio-route";
import { CALENDAR_BUILD_UNITS, CALENDAR_READ_UNITS } from "@/lib/read-ceilings";

/** The store's studio requests could not pay for making the file again. */
class WindowSpent extends Error {}

/**
 * A store's bookings as a calendar to subscribe to, at its private address
 * (/api/store/calendar/<token>.ics). The token is the only key, so the
 * address is kept out of every page and can be replaced from the studio,
 * which turns this one off at once. Made at most every five minutes; Stripe
 * is the record of who booked what, and is read for it.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params;
  const missing = () =>
    new Response("Not found.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
    });
  const token = raw.replace(/\.ics$/i, "");
  const owner = await storeIdForToken(token).catch(() => null);
  if (!owner) return missing();
  const store = await storeForHandle(owner.handle).catch(() => null);
  if (!store || store.statsId !== owner.statsId) return missing();
  // The creator's own feed, so the creator's own window: every answer is
  // CALENDAR_READ_UNITS studio requests, taken before the kept file is read,
  // and making it again from Stripe CALENDAR_BUILD_UNITS more, taken first
  // (owner's rule MR; lib/read-ceilings.ts). Past them a calendar app is
  // asked to come back, and keeps what it had.
  const later = () =>
    new Response("Try again later.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "3600", "Cache-Control": "no-store" },
    });
  if (!(await countStudio(store, null, CALENDAR_READ_UNITS).catch(() => null))?.ok) return later();

  try {
    const ics = await cachedBookedCalendar(owner.statsId, async () => {
      if (!(await countStudio(store, null, CALENDAR_BUILD_UNITS).catch(() => null))?.ok) throw new WindowSpent();
      const calls = store.stripeAccountId ? await paidCalls(store) : [];
      const listings = await readKind(store, "call");
      return bookedCalendar(store, calls, Date.now(), listings, await slotRooms(store, calls, listings));
    });
    return new Response(ics, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="bookings.ics"',
        "Cache-Control": "private, max-age=300",
        "X-Robots-Tag": "noindex",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof WindowSpent) return later();
    // Stripe did not answer. A calendar app keeps what it had and asks again.
    console.error("making a booking calendar failed", error);
    return new Response("Try again in a few minutes.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "300", "Cache-Control": "no-store" },
    });
  }
}
