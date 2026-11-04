/**
 * Honest labels on a product's card (639 [GL7](31), unit 1; owner's
 * HighLevel audit, 2 November 2026): "New" for a few days, "Pre-order" and
 * "Coming soon" while that is true, "Bundle" for a bundle. Pure and
 * browser-safe; drawing them on the cards is the next unit.
 *
 * Every label is worked out from the product's own record at the moment the
 * page is drawn, never typed by anyone, so none can say something that is not
 * so:
 *
 *   - "New" only within NEW_DAYS of the day the product was made. The day it
 *     was made is never later than the day it went on sale, so the label can
 *     only ever be shown for less time than the product has really been new,
 *     never more. A product whose day cannot be read, or lies in the future,
 *     gets no "New".
 *   - "Pre-order" only while the page takes pre-orders (lib/preorders.ts,
 *     preorderDay), and "Coming soon" only while it waits without them.
 *   - "Bundle" only for a product that is one (lib/bundle-rules.ts, isBundle).
 *
 * Never "Best seller", "Popular", "Trending", "Limited" or any count: nothing
 * here measures other buyers, and a stock limit is already said on the page in
 * its own words with the real number (lib/stock.ts). BADGE_WORDS is the
 * whole list of what can be shown; tests/product-badges.test.ts fails when
 * a word that claims something about other buyers or about time running out
 * is added to it.
 */

/** How long after it was made a product is labeled "New". */
export const NEW_DAYS = 14;

/** At most this many labels on one card, so the title stays the first thing read. */
export const MAX_BADGES = 2;

export type Badge = "preorder" | "soon" | "bundle" | "new";

/** What each label says, in US English; the buyer's language comes with the card's own words when they are drawn. */
export const BADGE_WORDS: Readonly<Record<Badge, string>> = {
  preorder: "Pre-order",
  soon: "Coming soon",
  bundle: "Bundle",
  new: "New",
};

/** The order they are shown in: what changes what the buyer can do now comes first. */
const ORDER: readonly Badge[] = ["preorder", "soon", "bundle", "new"];

const DAY_MS = 86_400_000;

export type BadgeFacts = {
  /** When the product was made (Product.createdAt), an ISO date; "" when unknown. */
  createdAt: string;
  /** It is a bundle (lib/bundle-rules.ts, isBundle). */
  bundle: boolean;
  /** It is coming soon (lib/waitlist.ts). */
  soon: boolean;
  /** It takes pre-orders now (lib/preorders.ts, preorderDay is not null). */
  preorder: boolean;
};

/** Whether a product made at `createdAt` is still new at `now`. */
export function isNew(createdAt: string, now = Date.now()): boolean {
  const made = Date.parse(createdAt);
  if (!createdAt || !Number.isFinite(made) || made > now) return false;
  return now - made < NEW_DAYS * DAY_MS;
}

/** The labels a card shows, in order, at most MAX_BADGES. */
export function productBadges(facts: BadgeFacts, now = Date.now()): Badge[] {
  const on: Record<Badge, boolean> = {
    preorder: facts.preorder,
    // Pre-order already says it is not out yet.
    soon: facts.soon && !facts.preorder,
    bundle: facts.bundle,
    // Something not out yet is not "New" either: it has not arrived.
    new: !facts.soon && !facts.preorder && isNew(facts.createdAt, now),
  };
  return ORDER.filter((badge) => on[badge]).slice(0, MAX_BADGES);
}
