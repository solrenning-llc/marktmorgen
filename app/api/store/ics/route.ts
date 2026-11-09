import type { NextRequest } from "next/server";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { readOrderAdmitted, takeBuyerRequest, takeLookupRequest } from "@/lib/order-lookup";
import { buyerNote, callInvite } from "@/lib/calls";
import { roomOf } from "@/lib/call-rooms";
import { bookingWords } from "@/lib/buyer-words/booking";
import { linkUpdates } from "@/lib/meet-links";

/**
 * The calendar file for a booked call, for the "Add to your calendar" button.
 *
 * The session id is the key, exactly as on the thanks page, and it is checked
 * against Stripe before anything is handed over. It is also linked from the
 * reminder emails, so it answers until the call is over, at the time the
 * booking has now if its buyer moved it.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const handle = normaliseHandle(url.searchParams.get("handle") ?? "");
  const sessionId = url.searchParams.get("session_id") ?? "";
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return new Response("Not found.", { status: 404 });
  // Counted as the download is (lib/order-lookup.ts): the lookup of an id of an order's form is one of the store's public
  // requests for its window (lib/traffic.ts), an id that is not of that form is not counted, and only a paid order takes
  // the buyers' side, so made-up ids never spend what the store keeps for its buyers.
  const order = await readOrderAdmitted(store, sessionId, { lookup: () => takeLookupRequest(store), paid: () => takeBuyerRequest(store) });
  if (order.state === "slow" || order.state === "resting") return new Response("Please try again later.", { status: 429, headers: { "Cache-Control": "no-store" } });
  if (order.state !== "paid" || !order.call || !order.product.call) {
    return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const room = order.product.call.place ? null : await roomOf(store.callsId, {
    product: order.product.id,
    setup: order.product.call,
    session: sessionId,
    start: order.call.start,
    end: order.call.end,
  });
  const words = bookingWords(store.language);
  // In person (lib/call-place.ts): the address is where it is, and there is no link.
  const place = order.product.call.place ?? null;
  const ics = callInvite({
    // A link replaced after a failure counts, like a move (lib/meet-links.ts).
    sequence: order.call.moves + (await linkUpdates(store.callsId, { session: sessionId, product: order.product.id, start: order.call.start })),
    uid: sessionId,
    start: order.call.start,
    end: order.call.end,
    title: order.product.title,
    storeName: store.name,
    room,
    place,
    // A buyer's file, in the store's language (lib/buyer-words/booking.ts).
    note: buyerNote(words, store, room, place),
    words,
  });
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="call.ics"',
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
