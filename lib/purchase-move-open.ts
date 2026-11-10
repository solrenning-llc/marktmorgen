/**
 * Whether a buyer may move their purchases to another email (611 [WP10]) at
 * all: the page that asks, the two routes and the page each emailed link
 * opens.
 *
 * Nothing is shown that does not work (VR). A request is worth asking, and
 * its two emails worth sending, only if both confirmations then move the
 * purchases. Since unit 4a they are written into the index of moved
 * addresses (lib/purchase-move-index.ts). The emails kept for members
 * follow it since unit 4b (lib/letter-access.ts); the orders, courses,
 * community, membership, downloads, podcast, Discord, imported purchases and
 * library do not yet, unit 4c onward. Until the last of them sets PURCHASE_MOVE_DELIVERED, with its
 * tests, the pages are not
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
