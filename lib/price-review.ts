/**
 * "Check what buyers pay" (487 [IT4], item 8: a "Check answers" summary
 * before a change buyers meet at once; added 2 November 2026): what a save
 * would change in what buyers pay for a product they can see, one row each,
 * the way it is now and the way it will be. Pure and browser-safe.
 *
 * Reviewed: how buyers pay (once, every day, week, month or year, or they
 * choose); the price, or the lowest price they may choose; the price their
 * box starts at; a membership's introductory price and its yearly price,
 * also when a change of schedule takes them away; a membership's free trial
 * and the number of payments it ends after; and, in its own editor, the
 * price of one of several price options (optionPriceReview). Drafts, which
 * no buyer sees, are not reviewed.
 *
 * What it says about members is what the code does: a membership's checkout
 * makes the member's subscription at the price and schedule of that moment
 * (lib/store-checkout.ts, price_data), and saving the product changes no
 * subscription already made (app/api/store/product/route.ts, lib/store.ts
 * editProduct), nor cancels one. So members who already joined keep what they
 * joined at, also when the product stops being a membership, until they or
 * the creator cancel.
 */
import { readRecurring, type Interval } from "@/lib/product-recurring";

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
  /** A membership's free trial in days and the payments it ends after; 0 for none. Absent: none. */
  trialDays?: number;
  payments?: number;
};

export type PriceDraft = { price: string; every: string; pwyw: boolean; suggested: string; introPrice: string; introCount: string; yearlyPrice: string; trial?: string; payments?: string };

/** Which field a row's "Change" goes back to. */
export type PriceField = "every" | "pwyw" | "price" | "suggested" | "intro" | "yearly" | "trial" | "payments";

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
  // The free trial and the payments it ends after, read by the product route's own rule (lib/product-recurring.ts, readRecurring):
  // one it would refuse (out of range, not a whole number) is not reviewed, and the save says why.
  const recurring = every ? readRecurring(every, draft.trial?.trim() ?? "", draft.payments?.trim() ?? "") : null;
  if (recurring === "trial" || recurring === "payments") return null;
  const trial = recurring ? recurring.trialDays : 0;
  const payments = recurring ? recurring.payments : 0;
  // Nor a combination the route refuses: an introductory price with a trial or an end, a yearly price with an end.
  if ((intro && (trial > 0 || payments > 0)) || (yearly !== null && payments > 0)) return null;
  const trialWords = (days: number) => (days ? `${days} ${days === 1 ? "day" : "days"} free` : "None");
  // Something bought once neither ends nor runs: "None".
  const endsWords = (n: number, member: boolean) => (!member ? "None" : n ? `After ${n} payments` : "Runs until canceled");
  if (trial !== (product.trialDays ?? 0)) rows.push({ key: "trial", label: "Free trial", now: trialWords(product.trialDays ?? 0), then: trialWords(trial), field: "trial" });
  if (payments !== (product.payments ?? 0)) rows.push({ key: "payments", label: "Ends", now: endsWords(product.payments ?? 0, Boolean(product.interval)), then: endsWords(payments, Boolean(every)), field: "payments" });
  if (yearly !== product.yearlyCents) rows.push({ key: "yearly", label: "Yearly price", now: product.yearlyCents === null ? "None" : money(product.yearlyCents), then: yearly === null ? "None" : money(yearly), field: "yearly" });
  if (!rows.length) return null;

  const note = !product.interval
    ? "Your store shows this as soon as you save."
    : every
      ? "New members pay this once you save; a checkout already open keeps what it opened with. Members who already joined keep the price, schedule, trial and end they joined at."
      : "Members who already joined keep being charged the price and schedule they joined at until they or you cancel, or their last payment if theirs ends by itself: saving this does not cancel them. To stop them, cancel their memberships in your Stripe dashboard. New buyers pay what this summary shows once you save.";
  return { rows, note };
}

/**
 * The review for saving one of several price options of a product buyers
 * can see with a new price, or null when the price is the same, cannot be
 * read or is out of range (the save says why), the product is a draft, or the
 * option is not offered (`shown` false: it has nothing to hand over yet).
 * `label` is the name as typed. On a membership, members who joined at that
 * price keep it, as for the product's own price. With a payment plan offered
 * on the product, what the new price does to it is said: a price above what
 * the option's payments add up to stops the plan for the whole product (lib/
 * product-extras.ts, uncoveredOption), and below it buyers who pay in parts
 * still pay what the payments add up to.
 *
 * Not reviewed yet: adding or removing an option, and changing which is
 * recommended.
 */
export function optionPriceReview(
  option: { label: string; priceCents: number },
  typed: string,
  product: { hidden: boolean; interval: Interval | null; shown: boolean; plan: { payments: number; cents: number } | null },
  read: (typed: string) => number | null,
  money: (cents: number) => string,
): PriceReview | null {
  if (product.hidden || !product.shown) return null;
  const price = read(typed.trim());
  if (price === null || price === option.priceCents) return null;
  const notes = [
    product.interval
      ? "New members who pick it pay this once you save; a checkout already open keeps what it opened with. Members who already joined keep the price they joined at."
      : "Your store shows this as soon as you save.",
  ];
  if (product.plan) {
    const total = product.plan.payments * product.plan.cents;
    if (total < price) notes.push(`Your payment plan stops being offered on this product: its ${product.plan.payments} payments of ${money(product.plan.cents)} for this price add up to ${money(total)}, less than ${money(price)}. Raise that payment in the plan to offer it again.`);
    else if (total > price) notes.push(`Buyers who pay in ${product.plan.payments} payments still pay ${money(product.plan.cents)} each, ${money(total)} in all, until you change that payment in the plan.`);
  }
  return {
    rows: [{ key: "option", label: `“${option.label}”`, now: money(option.priceCents), then: money(price), field: "price" }],
    note: notes.join(" "),
  };
}

/**
 * What removing one price option really changes, said after "Remove “…”."
 * in its confirmation (VR: nothing said may be untrue):
 *
 *   - the file on it goes with it (app/api/store/option/route.ts);
 *   - anyone who bought at it, when it handed over its own file or link,
 *     can no longer get that from their order (lib/buyer-orders.ts,
 *     deliveryOf: a removed option leaves the order's delivery empty), unless
 *     it was the last and the product has its own file or link, which they
 *     then get instead. A course or podcast is opened by the product, not the
 *     option, so its buyers keep it;
 *   - the last one: buyers then pay the product's own price, with its
 *     introductory and yearly prices kept from before, or, when the product
 *     hands nothing over on its own, it cannot be bought until it does, said
 *     by what it lacks (lib/store-checkout.ts, canSellProduct);
 *   - on a membership, members who joined at it keep being charged;
 *   - a payment plan that starts or stops being offered without it
 *     (lib/product-extras.ts, activePlan).
 *
 * "Nothing else on the product changes" only when none of that is so.
 */
export function optionRemovalWords(
  option: { hasFile: boolean; delivers: boolean },
  product: {
    options: number;
    interval: Interval | null;
    hidden: boolean;
    ownPriceCents: number;
    /** What the product lacks to be sold on its own, or null when it hands something over by itself. */
    missing: "lesson" | "episode" | "delivery" | null;
    /** Whether it has a file or link of its own, which buyers of a removed last option then get. */
    ownDelivery: boolean;
    introStored: boolean;
    yearlyStored: boolean;
    planBefore: boolean;
    planAfter: boolean;
  },
  money: (cents: number) => string,
): string {
  const said: string[] = [];
  const last = product.options === 1;
  if (option.hasFile) said.push("The file on it is deleted with it.");
  if (option.delivers) {
    said.push(
      last && product.ownDelivery
        ? "Anyone who bought at it gets the product's own file or link from their order instead."
        : "Anyone who bought at it can no longer get its file or link from their order.",
    );
  }
  if (last) {
    if (product.missing) {
      const lacks = product.missing === "lesson" ? "a lesson" : product.missing === "episode" ? "an episode" : "its own file or link";
      said.push(`It is the last price, so this cannot be bought until it has ${lacks}.`);
    } else {
      const kept = product.introStored && product.yearlyStored ? ", with its introductory and yearly prices" : product.introStored ? ", with its introductory price" : product.yearlyStored ? ", with its yearly price" : "";
      said.push(`It is the last price, so buyers ${product.hidden ? "will pay, once you publish it," : "then pay"} its own price, ${money(product.ownPriceCents)}${kept}.`);
    }
  }
  if (product.interval) said.push("Members who joined at it keep being charged what they joined at until they or you cancel.");
  if (product.planBefore && !product.planAfter) said.push("Your payment plan stops being offered.");
  if (!product.planBefore && product.planAfter) said.push("Your payment plan is offered again.");
  return said.length ? said.join(" ") : "Nothing else on the product changes.";
}
