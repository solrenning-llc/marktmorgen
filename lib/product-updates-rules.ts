/**
 * The rules of telling a product's buyers about an update, which the studio's
 * browser reads too. The sending is lib/product-updates.ts, server only.
 */
import type { Listing } from "@/lib/store";

/** How often one product's buyers may be told of an update. */
export const UPDATE_GAP_SECONDS = 7 * 86_400;
/** The most buyers one update goes to. */
export const MAX_UPDATE_RECIPIENTS = 5_000;
/**
 * Redis commands one update email costs at the most while it is sent (lib/product-updates.ts, advanceUpdate), every
 * script's own commands counted: a run whose one batch holds one recipient, which pays the batch's own reads and
 * writes alone (its lock, its page of the list, the three checks, the month's reservation, the stop link with its
 * erasure note and the note read again since #4781, the send and the job saved). Measured, with each further
 * recipient of a batch at 10, by tests/i4781-update-commands.test.ts; priced on every monthly email of a plan (line
 * product-update-commands in tests/plan-cost-registry.ts).
 */
export const UPDATE_EMAIL_COMMANDS = 29;
/** The longest the creator's own words may be. */
export const MAX_UPDATE_NOTE = 1_500;

/** Whether a product's buyers can be told of an update: one bought once that hands something over. */
export function canTellBuyers(product: Pick<Listing, "priceCents" | "recurring" | "call" | "shipping">): boolean {
  // Not something shipped: there is no new version to get from the orders page (lib/shipping.ts).
  return product.priceCents > 0 && product.recurring === null && product.call === null && !product.shipping;
}
