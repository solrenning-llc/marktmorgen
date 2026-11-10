/**
 * The one door to a single product's checkout (lib/store-checkout.ts,
 * createCheckout): nothing kept for a child-safety report (lib/child-safety.ts)
 * is handed over through it. Claude 6's focal reviews of #3471 (6757630267,
 * 6758076515) found that only the checkout route asked heldInSale before
 * createCheckout, so a welcome offer on a bundle holding a held product opened
 * a Stripe checkout naming it. Every caller (the checkout route, the welcome
 * offer, the come-back offer, a moved member's checkout) now comes through
 * here, and tests/child-safety-checkout-doors.test.ts fails when any other file
 * calls createCheckout. The check would sit inside createCheckout itself, but
 * lib/store-checkout.ts is reserved by another agent (Codex A3, CX-101), so it
 * sits in front of it.
 *
 * Refused, before anything is built or anything reaches Stripe: a bundle
 * holding a held product, and a checked checkout box whose product is held or
 * is a bundle holding one. A hold that cannot be read refuses too (rule 24).
 * The product itself is held only when hidden, which canSellProduct already
 * refuses at every door. One pipeline of GETs, only when the checkout carries
 * a bundle or a checked box (heldInSale).
 */
import { heldInSale } from "@/lib/child-safety";
import { createCheckout } from "@/lib/store-checkout";

/** Why a checkout was refused for a product kept for a report: as heldInSale answers. */
export type HeldWhy = "bundle" | "box" | "unavailable";

/** Thrown before anything reaches Stripe, so no unit is held and nothing is charged (lib/stock.ts withdraws on it). */
export class HeldInSaleError extends Error {
  readonly why: HeldWhy;
  constructor(why: HeldWhy) {
    super(why === "unavailable" ? "A preservation hold could not be read" : "This would hand over a product kept for a report");
    this.name = "HeldInSaleError";
    this.why = why;
  }
}

/** createCheckout, refused first when it would hand over a product kept for a report. */
export async function createCheckoutUnlessHeld(...args: Parameters<typeof createCheckout>): ReturnType<typeof createCheckout> {
  const [store, product, , , extras = {}] = args;
  // The boxes createCheckout would read: none for a gift, a pre-order or a purchase for several people, which drop them.
  const boxes = extras.gift || extras.preorder || extras.group ? [] : (extras.bumps ?? []);
  const why = await heldInSale(store, product, boxes);
  if (why) throw new HeldInSaleError(why);
  return createCheckout(...args);
}
