/**
 * Looking an order up for a page or a file that only its buyer opens (the thanks page, the download, the calendar file).
 *
 * A store's public pages stop at 95% of its window (lib/traffic-rules.ts, publicVisitLimit); the last 5% is kept for what
 * buyers already have. A made-up order number must never spend that reserve, so:
 *
 *   1. an id that does not have the form of a Checkout Session id is not an order: nothing is counted and Stripe is not asked;
 *   2. the lookup itself is counted on the PUBLIC side (and the connection's short window), before Stripe is asked, and a
 *      lookup refused there is given back: the window has one count shared with the buyers' side (lib/traffic.ts,
 *      countRequest), so a refusal left counted would spend the reserve all the same;
 *   3. only an order Stripe says is paid is counted on the BUYERS' side, which is what the reserve is for.
 *
 * A refusal says which kind it is: "tries" (the connection's short window, back in minutes) or "window" (the store's own
 * window, back only when it turns), so the page does not promise minutes for the second.
 */
import { isSessionId, readOrder, type Order } from "@/lib/store-checkout";
import { holdPublicRequests, takePublicRequest } from "@/lib/traffic";
import type { Store } from "@/lib/store";

export type LookupRefusal = "tries" | "window";
export type AdmittedOrder = Order | { state: "slow" | "resting" };

export async function readOrderAdmitted(
  store: Store,
  sessionId: string | undefined,
  steps: {
    /** Counts the lookup before Stripe is asked; the reason when it is refused. */
    lookup: () => Promise<LookupRefusal | null>;
    /** Counts a paid order on the buyers' side; false when that side has no room. */
    paid: () => Promise<boolean>;
  },
): Promise<AdmittedOrder> {
  // Not an order's form: readOrder answers "invalid" (or "unavailable") without asking anyone, so nothing is counted.
  if (!isSessionId(sessionId)) return readOrder(store, sessionId);
  const refused = await steps.lookup();
  if (refused) return { state: refused === "tries" ? "slow" : "resting" };
  const order = await readOrder(store, sessionId);
  if (order.state === "paid" && !(await steps.paid())) return { state: "resting" };
  return order;
}

/** The buyers' side of the store's window, one request. */
export const takeBuyerRequest = (store: Store): Promise<boolean> => takePublicRequest(store, "buyer");
/** The public side of the store's window, one request, as a lookup's refusal; a refusal is not left counted (see below). */
export const takeLookupRequest = async (store: Store): Promise<LookupRefusal | null> => ((await holdPublicRequests(store, 1, Date.now())) ? null : "window");
