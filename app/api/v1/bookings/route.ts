import { apiError, apiStore, takeMoreApi } from "@/lib/api-guard";
import { apiOkFields, badFields } from "@/lib/api-fields";
import { bookings } from "@/lib/api-read";

/**
 * GET /api/v1/bookings — paid calls and session seats, each at the time it is booked for now. With
 * Stripe connected it takes the further API requests its most costs, before reading (lib/api-read-rules.ts).
 */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  // A `?fields=` that cannot be read is refused before any further request is taken or anything read.
  const bad = badFields(request);
  if (bad) return bad;
  try {
    const found = await bookings(store, (more) => takeMoreApi(store, more));
    if (found instanceof Response) return found;
    return apiOkFields(request, { data: found });
  } catch (error) {
    console.error("api: bookings failed", error);
    return apiError(502, "unavailable", "Bookings could not be read just now. Try again in a moment.");
  }
}
