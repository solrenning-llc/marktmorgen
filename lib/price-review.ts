/**
 * "Check what buyers pay" (487 [IT4], item 8: a "Check answers" summary
 * before a change buyers meet at once; added 2 November 2026): what a save
 * would change in what buyers pay for a product they can see, one row each,
 * the way it is now and the way it will be. Pure and browser-safe.
 *
 * Reviewed: how buyers pay (once, every day, week, month or year, or they
 * choose); the price, or the lowest price they may choose; the price their
 * box starts at; a membership's introductory price and its yearly price,
 * also when a change of schedule takes them away. Not reviewed yet: a
 * membership's free trial and its number of payments; products with several
 * price options, each priced in its own editor; drafts, which no buyer sees.
 *
 * What it says about members is what the code does: a membership's checkout
 * makes the member's subscription at the price and schedule of that moment
 * (lib/store-checkout.ts, price_data), and saving the product changes no
 * subscription already made (app/api/store/product/route.ts, lib/store.ts
 * editProduct), nor cancels one. So members who already joined keep what they
 * joined at, also when the product stops being a membership, until they or
 * the creator cancel.
 */
import type { Interval } from "@/lib/product-recurring";

export type PricedProduct = {
  /** A draft is seen by no buyer: nothing to review. */
  hidden: boolean;
  /** How many price options it has; with any, prices are set in their own editor. */
  options: number;
  priceCents: number;
  interval: Interval | null;
  /** The pay-what-you-want box's starting price, or null when the price is set. */
  suggestedCents: number | null;
  /** A membership's introductory price, or null. */
  intro: { cents: number; count: number } | null;
  /** A monthly membership's yearly price, or null. */
  yearlyCents: number | null;
};

export type PriceDraft = { price: string; every: string; pwyw: boolean; suggested: string; introPrice: string; introCount: string; yearlyPrice: string };

/** Which field a row's "Change" goes back to. */
export type PriceField = "every" | "pwyw" | "price" | "suggested" | "intro" | "yearly";

export type PriceRow = { key: string; label: string; now: string; then: string; field: PriceField };

export type PriceReview = { rows: PriceRow[]; note: string };

const EVERY: Record<string, string> = { day: "Every day", week: "Every week", month: "Every month", year: "Every year" };

function how(interval: string | null, chooses: boolean): string {
  if (interval) return EVERY[interval] ?? `Every ${interval}`;
  return chooses ? "They choose what to pay" : "Once";
}

/**
 * The review for a save, or null when it changes nothing buyers pay, when
 * the product is not on the store or has price options, or when a price typed
 * cannot be read (the save itself says what is wrong with it).
 */
export function priceReview(product: PricedProduct, draft: PriceDraft, read: (typed: string) => number | null, money: (cents: number) => string): PriceReview | null {
  if (product.hidden || product.options > 0) return null;
  // A free product is given for an email address, never sold for nothing.
  const priced = (cents: number) => (cents === 0 ? "Free, for an email address" : money(cents));
  const every = draft.every || null;
  const chooses = draft.pwyw && !every;
  const price = read(draft.price);
  if (price === null) return null;
  // What the form sends (components/product-editor.tsx, payloadOf): the starting price typed, or the lowest price when none is.
  const suggested = chooses ? read(draft.suggested.trim() || draft.price) : null;
  if (chooses && suggested === null) return null;
  const introCents = every && draft.introPrice.trim() ? read(draft.introPrice.trim()) : null;
  if (every && draft.introPrice.trim() && introCents === null) return null;
  const intro = introCents === null ? null : { cents: introCents, count: every === "month" ? Number(draft.introCount) || 1 : 1 };
  const yearly = every === "month" && draft.yearlyPrice.trim() ? read(draft.yearlyPrice.trim()) : null;
  if (every === "month" && draft.yearlyPrice.trim() && yearly === null) return null;

  const chose = product.suggestedCents !== null && !product.interval;
  const rows: PriceRow[] = [];
  const everyChanged = every !== product.interval;
  const howChanged = everyChanged || chooses !== chose;
  if (howChanged) rows.push({ key: "how", label: "How buyers pay", now: how(product.interval, chose), then: how(every, chooses), field: everyChanged ? "every" : "pwyw" });
  // With how they pay changed, the price is always shown, so the creator sees what buyers will pay.
  if (price !== product.priceCents || howChanged) rows.push({ key: "price", label: chooses ? "Lowest price" : "Price", now: priced(product.priceCents), then: priced(price), field: "price" });
  if (chooses && suggested !== product.suggestedCents) rows.push({ key: "suggested", label: "Price their box starts at", now: chose && product.suggestedCents !== null ? money(product.suggestedCents) : "None", then: money(suggested!), field: "suggested" });
  const introWords = (i: { cents: number; count: number } | null) => (i ? `${money(i.cents)} for the first ${i.count === 1 ? "payment" : `${i.count} payments`}` : "None");
  if (introWords(intro) !== introWords(product.intro)) rows.push({ key: "intro", label: "Introductory price", now: introWords(product.intro), then: introWords(intro), field: "intro" });
  if (yearly !== product.yearlyCents) rows.push({ key: "yearly", label: "Yearly price", now: product.yearlyCents === null ? "None" : money(product.yearlyCents), then: yearly === null ? "None" : money(yearly), field: "yearly" });
  if (!rows.length) return null;

  const note = !product.interval
    ? "Your store shows this as soon as you save."
    : every
      ? "New members pay this once you save; a checkout already open keeps what it opened with. Members who already joined keep the price and schedule they joined at."
      : "Members who already joined keep being charged the price and schedule they joined at until they or you cancel: saving this does not cancel them. To stop them, cancel their memberships in your Stripe dashboard. New buyers pay what this summary shows once you save.";
  return { rows, note };
}
