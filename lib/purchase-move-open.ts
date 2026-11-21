/**
 * Whether a buyer may move their purchases to another email (611 [WP10]) at
 * all: the page that asks, the two routes and the page each emailed link
 * opens.
 *
 * Nothing is shown that does not work (VR). A request is worth asking, and
 * its two emails worth sending, only if both confirmations then move the
 * purchases: the library, the orders, the imported purchases and the email
 * of the creator's Stripe customer, a later unit. Until the unit that builds
 * that move sets PURCHASE_MOVE_DELIVERED, with its tests, the pages are not
 * found and the routes answer 404 before reading anything, whatever the
 * store. After that, only where the store's purchases can be listed at all
 * (lib/buyer-orders.ts canRecover).
 */
import type { Store } from "@/lib/store";
import { canRecover } from "@/lib/buyer-orders";

/** Set only with the unit that moves the purchases once both addresses confirmed. */
export const PURCHASE_MOVE_DELIVERED = false;

export function purchaseMoveOpen(store: Store, delivered = PURCHASE_MOVE_DELIVERED): boolean {
  return delivered && canRecover(store);
}
