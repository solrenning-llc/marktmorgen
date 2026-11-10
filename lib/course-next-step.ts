/**
 * The course's "Next step" for one student, as its page shows it (560 [AS1],
 * unit 3; the rules are lib/course-next-step-rules.ts).
 *
 * Read in order, from the cheapest, and only as far as needed: the creator's
 * choice (kept on the course, no read), the "No thanks" this browser keeps (a
 * cookie, no read), the product (one listing read), and only when all of that
 * lets the card show, what the student already has from the store, read from
 * the creator's Stripe account and the purchases brought over
 * (lib/cart-offers.ts ownedBeforeCart), which takes CART_OFFER_REQUEST_UNITS
 * of the store's public requests before anything is read and answers null
 * without them. Null, or any read that fails, shows no card: unknown is never
 * "does not have it".
 *
 * The "No thanks" is kept in the student's own browser, under
 * nextStepCookie(course), for NEXT_STEP_NO_SECONDS: nothing about it is kept
 * on our side (privacy policy, #cookies).
 */
import type { Course } from "@/lib/course";
import type { Listing, Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { canSellProduct } from "@/lib/store-checkout";
import { offerable } from "@/lib/next-offer-rules";
import { ownedBeforeCart } from "@/lib/cart-offers";
import { nextStepShown } from "@/lib/course-next-step-rules";

/** How long a "No thanks" is kept in the browser: a year. */
export const NEXT_STEP_NO_SECONDS = 365 * 86_400;

/** The cookie a "No thanks" is kept under, one for each course; it holds only "1". */
export const nextStepCookie = (courseId: string) => `nl_ns_${courseId}`;

/** The product to show as the course's next step to this student, or null for none. */
export async function nextStepFor(input: {
  store: Store;
  course: Pick<Course, "id" | "nextStep">;
  courseProductId: string;
  email: string;
  /** Whether this browser keeps a "No thanks" for the course. */
  dismissed: boolean;
}): Promise<Listing | null> {
  const { store, course, courseProductId } = input;
  const step = course.nextStep ?? null;
  if (!step || input.dismissed) return null;
  const listing = await readListing(store, step.productId).catch(() => "unknown" as const);
  const sellable = (product: Listing) => canSellProduct(store, product);
  const product = listing === "unknown" ? "unknown" : listing ? { id: listing.id, onSale: offerable(listing, new Set(), sellable), left: null } : null;
  // Everything but what the student has: when this already keeps the card away, nothing more is read or paid for.
  if (!nextStepShown({ step, courseProductId, product, owned: false, dismissed: false }).shown || listing === "unknown" || !listing) return null;
  const owned = await ownedBeforeCart(store, input.email).catch(() => null);
  if (owned === null) return null;
  // Owned, or a bundle holding something owned (lib/next-offer-rules.ts offerable).
  const has = owned.has(step.productId) || !offerable(listing, owned, sellable);
  return nextStepShown({ step, courseProductId, product, owned: has, dismissed: false }).shown ? listing : null;
}
