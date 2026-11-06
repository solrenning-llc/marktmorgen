/**
 * A partner's standing share of a product.
 *
 * What Hotmart calls Coprodução and files under its own "sales management and
 * strategy" section: somebody who helped make the product, or who lent their
 * audience to its launch, takes a percentage of every sale of it — not only
 * the sales they personally referred. It is the difference between an
 * affiliate and a partner, and it is the reason a creator with no audience can
 * borrow one: an affiliate earns on the buyers they bring, a partner earns on
 * the product, so they have a reason to keep selling it after the launch week.
 *
 * Why ours is not a split at the moment of payment, which is how Hotmart does
 * it. Hotmart can divide a charge because Hotmart holds it. Here the money goes
 * from the buyer straight into the creator's own Stripe account and never
 * touches us — dividing it in flight would make us the intermediary this whole
 * product exists to not be. So a partner's share is recorded against each sale
 * and paid by the creator, automatically, out of their own PayPal, on the day
 * they already promised their affiliates (lib/paypal-payouts.ts). The partner
 * needs no account anywhere: an email address that can receive PayPal is all.
 *
 * Two guards that Hotmart does not appear to have, and that matter because the
 * creator is the one left holding the product:
 *
 *   - the shares committed on one product are capped, so a creator cannot
 *     accidentally promise away more of a sale than it contains. An affiliate
 *     commission rides on the same sale, so the cap has to count both;
 *   - a partner never earns on their own purchase, for the same reason an
 *     affiliate does not: a 50% partner buying their own product at 50% off
 *     is not a sale, it is a discount with extra steps.
 */

/** What a partner takes, and of which products. */
export type PartnerShare = {
  /** Percent of what the buyer paid before tax, 1 to MAX_PARTNER_SHARE. */
  percent: number;
  /**
   * The products it applies to. Never empty: a share of "everything" would
   * silently start applying to products made months later, which is not
   * something anybody agreed to. The creator names them.
   */
  products: string[];
  /**
   * When it ends, in seconds: sales from that moment on earn nothing. Absent
   * means "until revoked" (630 [HN6](39); lib/partner-terms-rules.ts).
   */
  until?: number;
};

export const MIN_PARTNER_SHARE = 1;
/**
 * The most one partner can take of a sale.
 *
 * Below 100 on purpose. A product whose whole price is promised away earns the
 * creator nothing and still costs them the card fee, the delivery and the
 * support, so it is a product sold at a loss — and this is the one place a
 * creator could set that up in two clicks without noticing.
 */
export const MAX_PARTNER_SHARE = 80;

/**
 * How much of one sale may be promised away in all — partners and the
 * affiliate who brought the buyer, together.
 *
 * 90 leaves a tenth of every sale with the creator at the very worst, which
 * still has to cover Stripe's 2.9% + 30c. It is a guard against a mistake, not
 * a recommendation: a creator who wants to give away more than this can, by
 * lowering the affiliate commission on that product themselves, which is a
 * deliberate act rather than an accident.
 */
export const MAX_COMMITTED_SHARE = 90;

/** How many partners one product may have. */
export const MAX_PARTNERS_PER_PRODUCT = 10;

export type ShareProblem =
  /** Not a whole percentage inside the allowed range. */
  | "percent"
  /** No product named, or more than one store could hold. */
  | "products"
  /** This product already has as many partners as it may have. */
  | "crowded"
  /** Partners plus the affiliate commission would pass MAX_COMMITTED_SHARE. */
  | "committed";

export const SHARE_PROBLEMS: Record<ShareProblem, string> = {
  percent: `A partner's share is a whole number from ${MIN_PARTNER_SHARE} to ${MAX_PARTNER_SHARE} percent.`,
  products: "Choose at least one product for them to share in.",
  crowded: `A product can have up to ${MAX_PARTNERS_PER_PRODUCT} partners.`,
  committed: `Partners and the affiliate commission together cannot pass ${MAX_COMMITTED_SHARE}% of a sale. Lower one of them first.`,
};

/** Whatever came back from storage or a form, made safe to use, or null. */
export function parsePartnerShare(raw: unknown): PartnerShare | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { percent?: unknown; products?: unknown; until?: unknown };
  const percent = typeof value.percent === "string" ? Number(value.percent.trim()) : value.percent;
  if (typeof percent !== "number" || !Number.isInteger(percent)) return null;
  if (percent < MIN_PARTNER_SHARE || percent > MAX_PARTNER_SHARE) return null;
  const list = Array.isArray(value.products) ? value.products : [];
  const products = [...new Set(list.filter((id): id is string => typeof id === "string" && /^[a-z0-9]{6,40}$/.test(id)))].slice(0, 200);
  if (!products.length) return null;
  const until = typeof value.until === "number" && Number.isSafeInteger(value.until) && value.until > 0 ? value.until : null;
  return until === null ? { percent, products } : { percent, products, until };
}

/**
 * What this partner takes of a sale of this product, in percent; 0 when none.
 * `atSeconds` is when the sale was paid: a share with an end earns nothing on
 * a sale paid at or after it. Without `atSeconds` the end is not read, for
 * callers that only ask what a share covers.
 */
export function shareOn(share: PartnerShare | null, productId: string, atSeconds?: number): number {
  if (!share || !productId) return 0;
  if (share.until !== undefined && atSeconds !== undefined && atSeconds >= share.until) return 0;
  return share.products.includes(productId) ? share.percent : 0;
}

/** A percentage of an amount, in whole cents, rounded down. */
export function shareCents(baseCents: number, percent: number): number {
  if (baseCents <= 0 || percent <= 0) return 0;
  return Math.floor((baseCents * percent) / 100);
}

/**
 * Whether a share can be set, given what this product already promises.
 *
 * `others` is every other partner's share of this product, and
 * `affiliatePercent` is what an affiliate earns on it today — both ride on the
 * same sale, so the cap counts them together. `null` means it is allowed.
 */
export function shareProblem(input: {
  percent: number;
  products: string[];
  /** Per product: the shares other partners already hold of it. */
  others: Record<string, number[]>;
  /** Per product: what an affiliate earns on it, in percent. */
  affiliatePercent: Record<string, number>;
}): ShareProblem | null {
  if (!Number.isInteger(input.percent) || input.percent < MIN_PARTNER_SHARE || input.percent > MAX_PARTNER_SHARE) {
    return "percent";
  }
  if (!input.products.length) return "products";
  for (const id of input.products) {
    const held = input.others[id] ?? [];
    if (held.length >= MAX_PARTNERS_PER_PRODUCT) return "crowded";
    const committed = held.reduce((sum, n) => sum + n, 0) + input.percent + (input.affiliatePercent[id] ?? 0);
    if (committed > MAX_COMMITTED_SHARE) return "committed";
  }
  return null;
}

/**
 * What is left of a sale of this product after everything promised on it, in
 * percent. For the studio, so a creator sees the consequence while they set it
 * rather than on an invoice. Never below zero.
 */
export function creatorKeeps(input: { partners: number[]; affiliatePercent: number }): number {
  const given = input.partners.reduce((sum, n) => sum + n, 0) + input.affiliatePercent;
  return Math.max(0, 100 - given);
}
