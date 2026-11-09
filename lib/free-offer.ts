import type { Listing, Store } from "@/lib/store";
import { isFree } from "@/lib/store-field-rules";

/**
 * Whether a product is offered for free: published (a draft, and a product
 * taken down after a notice about its content, are hidden; lib/takedown.ts),
 * at no price, and not a subscription. The one condition both the request for
 * a free copy (canGiveProduct, lib/free.ts) and the link it emails ask.
 */
export function offeredFree(product: Pick<Listing, "priceCents" | "hidden" | "recurring">): boolean {
  return isFree(product) && !product.hidden && product.recurring === null;
}

/**
 * Whether a free copy may still be handed over from a link emailed earlier:
 * the product is offered for free now, and its store has not been switched
 * off after notices about its content (lib/takedown.ts sets suspended, and
 * the report page promises its pages and sales are switched off). Read again
 * on every use, never trusted from the claim.
 */
export function stillGivenFree(store: Pick<Store, "suspended">, product: Pick<Listing, "priceCents" | "hidden" | "recurring">): boolean {
  return !store.suspended && offeredFree(product);
}
