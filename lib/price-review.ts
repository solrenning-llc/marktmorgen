/**
 * "Check what buyers pay" (487 [IT4], item 8: a "Check answers" summary
 * before a change buyers meet at once; added 2 November 2026): what a save
 * would change in what buyers pay for a product they can see, one row each,
 * the way it is now and the way it will be. Pure and browser-safe.
 *
 * Reviewed: how buyers pay (once, every day, week, month or year, or they
 * choose); the price, or the lowest price they may choose; the price their
 * box starts at; a membership's introductory price and its yearly price,
 * also when a change of schedule takes them away. On a product with several
 * price options, each priced in its own editor, only how buyers pay. Not
 * reviewed yet: a membership's free trial and its number of payments;
 * drafts, which no buyer sees. A save the product route would refuse is not
 * reviewed either (WCAG 3.3.6): the save says what is wrong.
 *
 * The price said is the store's price: a sale, an offer or a discount code
 * can lower what a buyer pays (lib/store-checkout.ts), and sales tax or VAT is
 * added on top when the store charges it that way (lib/tax.ts, applyTax).
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
import { introProblem } from "@/lib/intro-price";
import { yearlyProblem } from "@/lib/yearly-price";
import { fastMoneyRefusal } from "@/lib/terms-check-rules";
import { productPromptsLeft } from "@/lib/product-outline";

export type PricedProduct = {
  /** A draft is seen by no buyer: nothing to review. */
  hidden: boolean;
  /** How many price options it has; with any, prices are set in their own editor. */
  options: number;
  priceCents: number;
  interval: Interval | null;
  /** The pay-what-you-want box's starting price, or null when the price is set. */
  suggestedCents: number | null;
  /** A membership's introductory price as the checkout offers it now (lib/intro-price.ts, activeIntro), or null. */
  intro: { cents: number; count: number } | null;
  /** A monthly membership's yearly price as the checkout offers it now (lib/yearly-price.ts, activeYearly), or null. */
  yearlyCents: number | null;
  /** Its id, to tell whether it is one of the plans members switch between. */
  id: string;
  /** The plans members switch between (store.tiers): none takes an introductory or yearly price. */
  tiers: readonly string[];
  /** The least and the most the store's currency may charge (lib/money.ts, priceBounds). */
  bounds: { min: number; max: number };
  /**
   * What the product's kind or extras refuse (lib/store.ts, editProduct; lib/pay-what-you-want.ts,
   * pwywProblem): being free (a call, course, podcast, bundle or shipped product), a membership (a call,
   * bundle or shipped product), or a price buyers choose (a call, payment plan, checkout box, bundle or shipped product).
   */
  refuses: { free: boolean; membership: boolean; choose: boolean };
  /** Whether sales tax or VAT is added on top of the price at checkout (tax on, not included in the price). */
  taxOnTop: boolean;
  /** Its payment plan's payment (one price; null with price options or none), offered or not. */
  plan: { payments: number; cents: number } | null;
  /** Whether buyers are offered its payment plan now (lib/product-extras.ts, activePlan). */
  planBefore: boolean;
  /** Whether they would be once saved, at this price and schedule. */
  planAfter: (next: { priceCents: number; interval: Interval | null }) => boolean;
};

export type PriceDraft = { title: string; summary: string; about: string; price: string; every: string; pwyw: boolean; suggested: string; introPrice: string; introCount: string; yearlyPrice: string };

/** Which field a row's "Change" goes back to. */
export type PriceField = "every" | "pwyw" | "price" | "suggested" | "intro" | "yearly";

export type PriceRow = { key: string; label: string; now: string; then: string; field: PriceField };

export type PriceReview = { rows: PriceRow[]; note: string };

/** The rows that say an amount charged. */
const MONEY_ROWS = new Set(["price", "suggested", "intro", "yearly"]);

const EVERY: Record<string, string> = { day: "Every day", week: "Every week", month: "Every month", year: "Every year" };

function how(interval: string | null, chooses: boolean): string {
  if (interval) return EVERY[interval] ?? `Every ${interval}`;
  return chooses ? "They choose what to pay" : "Once";
}

/**
 * What a new price does to a payment plan, from whether buyers are offered it
 * now and once saved (lib/product-extras.ts, activePlan), for the product's
 * own price or one of its options. `plan` is that price's payment in the
 * plan, when it has one: a price above what the payments add up to stops the
 * plan (planState "short"), a lower one can bring a paused plan back, and
 * below what they add up to, buyers who pay in parts still pay that.
 */
export function planWords(plan: { payments: number; cents: number } | null, before: boolean, after: boolean, price: number, money: (cents: number) => string): string[] {
  const total = plan ? plan.payments * plan.cents : 0;
  const parts = plan ? `Buyers who pay in ${plan.payments} payments` : "";
  if (before && !after) {
    const said = ["Your payment plan stops being offered on this product."];
    if (plan && total < price) said.push(`Its ${plan.payments} payments of ${money(plan.cents)} add up to ${money(total)}, less than ${money(price)}. Raise that payment in the plan to offer it again.`);
    return said;
  }
  if (!before && after) return ["Your payment plan is offered again on this product.", ...(plan && total > price ? [`${parts} pay ${money(plan.cents)} each, ${money(total)} in all.`] : [])];
  if (after && plan && total > price) return [`${parts} still pay ${money(plan.cents)} each, ${money(total)} in all, until you change it in the plan.`];
  return [];
}

/** Said under the rows of a price: what the store charges, before what can lower it, and the tax on top. */
export function storePriceWords(taxOnTop: boolean): string {
  return `Your store's price is this, before any sale, offer or discount code${taxOnTop ? ", plus sales tax or VAT where it applies" : ""}.`;
}

/**
 * The review for a save, or null when it changes nothing buyers pay, when
 * the product is not on the store, or when the save would be refused: a
 * price typed that cannot be read or is out of range, a membership or a
 * price buyers choose at $0, a starting price below the lowest price, an
 * introductory or yearly price the product cannot take (the save itself
 * says what is wrong with it).
 */
export function priceReview(product: PricedProduct, draft: PriceDraft, read: (typed: string) => number | null, money: (cents: number) => string): PriceReview | null {
  if (product.hidden) return null;
  // Nor a save the route refuses for its words (app/api/store/product/route.ts): no title, or, on a
  // product buyers can see, a promise of fast money or a prompt of the ready outline left in.
  const words = { title: draft.title.trim(), summary: draft.summary, about: draft.about };
  if (!words.title || fastMoneyRefusal(words) || productPromptsLeft(words)[0]) return null;
  // With price options, buyers pay an option's price, set in its own editor: no price row here.
  const optioned = product.options > 0;
  // A free product is given for an email address, never sold for nothing.
  const priced = (cents: number) => (cents === 0 ? "Free, for an email address" : money(cents));
  const every = draft.every || null;
  const chooses = draft.pwyw && !every;
  const price = read(draft.price);
  if (price === null) return null;
  // The save's own rules (lib/store.ts, readFields and editProduct): free, or within the currency's range;
  // never free as a membership, with buyers choosing, with price options or for a kind that is always paid.
  if (price === 0 ? Boolean(every) || chooses || optioned || product.refuses.free : price < product.bounds.min || price > product.bounds.max) return null;
  if (every && product.refuses.membership) return null;
  // What the form sends (components/product-editor.tsx, payloadOf): the starting price typed, or the lowest price when none is.
  const suggested = chooses ? read(draft.suggested.trim() || draft.price) : null;
  if (chooses && suggested === null) return null;
  // A price buyers choose, as lib/pay-what-you-want.ts (pwywProblem) takes it: one price, nothing that refuses it, starting between the lowest price and the currency's most.
  if (chooses && (optioned || product.refuses.choose || suggested! < price || suggested! > product.bounds.max)) return null;
  const introCents = every && draft.introPrice.trim() ? read(draft.introPrice.trim()) : null;
  if (every && draft.introPrice.trim() && introCents === null) return null;
  const intro = introCents === null ? null : { cents: introCents, count: every === "month" ? Number(draft.introCount) || 1 : 1 };
  const yearly = every === "month" && draft.yearlyPrice.trim() ? read(draft.yearlyPrice.trim()) : null;
  if (every === "month" && draft.yearlyPrice.trim() && yearly === null) return null;
  // An introductory or yearly price the route refuses for the product as this save leaves it (lib/intro-price.ts, lib/yearly-price.ts):
  // below the least the currency charges, not under the price, beside each other, on price options or a plan members switch between.
  const after = { id: product.id, priceCents: price, recurring: every ? { interval: every as Interval, trialDays: 0, payments: 0 } : null, options: Array.from({ length: product.options }), pwyw: null, intro, yearly: yearly === null ? null : { cents: yearly } };
  if (intro && introProblem(after, intro, product.bounds.min, product.tiers)) return null;
  if (after.yearly && yearlyProblem(after, after.yearly, product.bounds.min, product.tiers)) return null;

  const chose = product.suggestedCents !== null && !product.interval;
  const rows: PriceRow[] = [];
  const everyChanged = every !== product.interval;
  const howChanged = everyChanged || chooses !== chose;
  if (howChanged) rows.push({ key: "how", label: "How buyers pay", now: how(product.interval, chose), then: how(every, chooses), field: everyChanged ? "every" : "pwyw" });
  // With how they pay changed, the price is always shown, so the creator sees what buyers will pay.
  if (!optioned && (price !== product.priceCents || howChanged)) rows.push({ key: "price", label: chooses ? "Lowest price" : "Price", now: priced(product.priceCents), then: priced(price), field: "price" });
  if (chooses && suggested !== product.suggestedCents) rows.push({ key: "suggested", label: "Price their box starts at", now: chose && product.suggestedCents !== null ? money(product.suggestedCents) : "None", then: money(suggested!), field: "suggested" });
  const introWords = (i: { cents: number; count: number } | null) => (i ? `${money(i.cents)} for the first ${i.count === 1 ? "payment" : `${i.count} payments`}` : "None");
  // A row's Change goes to its own field while the new schedule still has it; otherwise to the schedule that took it away.
  if (introWords(intro) !== introWords(product.intro)) rows.push({ key: "intro", label: "Introductory price", now: introWords(product.intro), then: introWords(intro), field: every ? "intro" : "every" });
  if (yearly !== product.yearlyCents) rows.push({ key: "yearly", label: "Yearly price", now: product.yearlyCents === null ? "None" : money(product.yearlyCents), then: yearly === null ? "None" : money(yearly), field: every === "month" ? "yearly" : "every" });
  if (!rows.length) return null;

  // Said only under a price that is charged: a sale, an offer or a code can lower it, and tax can be added on top.
  const store = price > 0 && rows.some((row) => MONEY_ROWS.has(row.key)) ? ` ${storePriceWords(product.taxOnTop)}` : "";
  // A price buyers choose is refused beside a plan (above), so the plan is read with none.
  const plan = planWords(optioned ? null : product.plan, product.planBefore, product.planAfter({ priceCents: price, interval: every as Interval | null }), price, money);
  const planned = plan.length ? ` ${plan.join(" ")}` : "";
  const note = !product.interval
    ? `Your store shows this as soon as you save.${store}`
    : every
      ? `New members join at this once you save.${store} A checkout already open keeps what it opened with. Members who already joined keep the price and schedule they joined at.`
      : `Members who already joined are still charged what they joined at. Saving does not cancel them. Each membership ends when they or you cancel it, or after its last payment. To stop them, cancel their memberships in your Stripe dashboard. New buyers see this once you save.${store}`;
  return { rows, note: note + planned };
}
