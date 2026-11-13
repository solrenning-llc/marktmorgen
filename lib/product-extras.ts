/**
 * Two things a creator can add to a one-off product, and the rules for each.
 *
 * An order bump: another of their products, offered at a price of their own
 * choosing in a box the buyer can tick before paying. The box is never ticked
 * for them — an extra charge the buyer did not choose is not a sale, and in
 * Europe it is not allowed either. Up to three per product (MAX_BUMPS), each
 * its own box, each ticked or not on its own.
 *
 * A limited quantity: the product stops selling once that many have been
 * paid for. The number the page shows is the real one, counted from real
 * checkouts, because scarcity that is not true is a lie told to a buyer.
 *
 * A funnel of one-click offers after paying (lib/funnel.ts): each offer is
 * another product, and one press adds it, charged to the card the buyer just
 * used. The same rules apply to what can be offered as to a bump.
 *
 * A payment plan: the same product, paid in a fixed number of weekly or
 * monthly payments instead of at once, delivered after the first. It ends
 * by itself after the last payment.
 *
 * Pure, so the studio and the server apply the same rules.
 */
import type { Listing } from "@/lib/store";
import { formatMoney } from "@/lib/money";
import { MIN_BUNDLE_ITEMS } from "@/lib/bundle-rules";
import { MAX_OPTIONS, OPTION_ID, type ProductOption, optionDelivers, withInvitedOption } from "@/lib/product-option";

export type Bump = {
  /** Another product of the same store. */
  productId: string;
  /** What it costs when added this way, in the store currency's smallest unit. */
  priceCents: number;
  /** One line under the box, in the creator's words. */
  pitch: string;
};

export const MAX_PITCH_LENGTH = 140;

/**
 * How many boxes one product may offer at checkout.
 *
 * Measured before it was built (8 October 2026): Stan allows one per product
 * ("Right now, you can only add one Order Bump per product", its blog,
 * updated September 16, 2026); Hotmart and Kajabi allow more than one, and
 * Hotmart's own advice is to start with one, because several offers at once
 * lower how many buyers take any. Three is enough to offer a small, a
 * related and a bigger thing, and few enough that the checkout stays a
 * checkout.
 */
export const MAX_BUMPS = 3;
export const MAX_STOCK = 100_000;
/**
 * The lowest any currency lets a single charge be, in its smallest unit: the
 * floor a stored amount is read back with. The store's own currency sets the
 * real floor when it is saved (lib/money.ts, minCharge): fifty cents for the
 * dollar, as it always was.
 */
export const MIN_BUMP_CENTS = 50;

export function parseStock(raw: unknown): number | null {
  const n = typeof raw === "string" && raw.trim() ? Number(raw.trim()) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_STOCK) return null;
  return n;
}

export function parseBump(raw: unknown): Bump | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.productId !== "string" || !/^[a-z0-9]{6,40}$/.test(value.productId)) return null;
  if (typeof value.priceCents !== "number" || !Number.isInteger(value.priceCents)) return null;
  if (value.priceCents < MIN_BUMP_CENTS || value.priceCents > 10_000_000) return null;
  const pitch = typeof value.pitch === "string" ? value.pitch.replace(/\s+/g, " ").trim().slice(0, MAX_PITCH_LENGTH) : "";
  return { productId: value.productId, priceCents: value.priceCents, pitch };
}

/**
 * The boxes a product offers, in its own order. A record saved when a
 * product could offer one box (`bump`) reads back as a list of that one.
 * The same product twice is offered once.
 */
export function parseBumps(raw: unknown, single?: unknown): Bump[] {
  const list = Array.isArray(raw) ? raw : single ? [single] : [];
  const out: Bump[] = [];
  for (const item of list) {
    const bump = parseBump(item);
    if (bump && !out.some((b) => b.productId === bump.productId)) out.push(bump);
    if (out.length === MAX_BUMPS) break;
  }
  return out;
}

/** The products a product's boxes offer, by id. */
export function bumpTargets(product: Pick<Listing, "bumps">): string[] {
  return product.bumps.map((bump) => bump.productId);
}

/** Whether a product is a plain one-off sale: the only kind these apply to. */
export function isOneOff(product: Listing): boolean {
  return product.priceCents > 0 && product.recurring === null && product.call === null;
}

/**
 * Whether a product can be the thing added: something with one price and one
 * delivery, so the buyer who ticks the box gets exactly one clear thing. A
 * product whose buyers choose the price has no one price to offer it at. A
 * bundle counts as one thing, at its one price: what it holds is handed over
 * with it (lib/bundle-rules.ts). A product with a limited number for sale is
 * not: only a checkout of its own counts it against that number.
 */
export function canBeBumped(product: Listing): boolean {
  return (
    isOneOff(product) &&
    product.options.length === 0 &&
    !product.pwyw &&
    product.stock === null &&
    (product.file !== null || product.link !== null || (product.bundle?.length ?? 0) >= MIN_BUNDLE_ITEMS)
  );
}

/**
 * Why a checkout offer a creator has set up is not being shown.
 *
 * Every one of these is reachable by changing a *different* product than the
 * one the offer is set on. Lower the price of the thing being offered below
 * what the box charges for it and the box stops appearing; give that product
 * several prices, a limited number, or its own monthly charge, and the same.
 * The studio used to go on saying "Offers X for $9 at checkout" through all
 * of it, so a creator could lose an add-on for months and only ever see it in
 * the takings.
 *
 * Kept beside the rule it explains, and exhaustive, so a rule added to one is
 * a compiler error in the other.
 */
export type BumpPause =
  /** This product is no longer a plain one-off sale. */
  | "kind"
  /** Buyers name their own price here, and a chosen amount is a checkout on its own. */
  | "pwyw"
  /** The product it offers is no longer in the store. */
  | "gone"
  /** It ended up pointing at itself. */
  | "itself"
  /** That product is given away now, and there is no price to offer it at. */
  | "targetFree"
  /** That product is charged again and again now, and this offers one payment. */
  | "targetRecurring"
  /** That product is a booking now, and a booking is made on its own page. */
  | "targetCall"
  /** That product has several prices to choose between. */
  | "targetOptions"
  /** Buyers name their own price on that product. */
  | "targetPwyw"
  /** That product has a limited number for sale, which only its own checkout counts. */
  | "targetLimited"
  /** Nothing is behind that product to hand over. */
  | "targetEmpty"
  /** That product is a bundle its buyers choose the contents of. */
  | "targetPick"
  /** The box charges more for it than buying it on its own does. */
  | "dearer";

/**
 * Why this product cannot be the thing offered, or null when it can.
 *
 * The same rules an offer after paying goes by (lib/funnel.ts), which is why
 * this is exported: one vocabulary of reasons for both, so a creator reads the
 * same sentence wherever they meet it.
 */
export function bumpTargetPause(target: Listing): BumpPause | null {
  // Three separate reasons, said separately. One sentence offering the creator
  // a choice of three things that might be wrong is the same defect the room's
  // refusals had: the code knows which, so it says which.
  if (target.call !== null) return "targetCall";
  if (target.recurring !== null) return "targetRecurring";
  if (target.priceCents <= 0) return "targetFree";
  if (target.options.length > 0) return "targetOptions";
  if (target.pwyw) return "targetPwyw";
  if (target.stock !== null) return "targetLimited";
  if (target.bundle && target.pick) return "targetPick";
  if (target.file === null && target.link === null && (target.bundle?.length ?? 0) < MIN_BUNDLE_ITEMS) return "targetEmpty";
  return null;
}

/**
 * The checkout offer as it stands: being shown, set up but not being shown, or
 * not set up at all.
 *
 * `activeBump` is this, with the reason thrown away. Both read from one set of
 * rules on purpose: a studio that decides for itself whether an offer is live
 * is a studio that will eventually disagree with the checkout.
 */
export function bumpState(products: Listing[], product: Listing, bump: Bump): { bump: Bump; target: Listing } | { paused: BumpPause; bump: Bump } {
  // Stripe lets a chosen amount be the only line of its checkout.
  if (!isOneOff(product)) return { paused: "kind", bump };
  if (product.pwyw) return { paused: "pwyw", bump };
  const target = products.find((p) => p.id === bump.productId);
  if (!target) return { paused: "gone", bump };
  if (target.id === product.id) return { paused: "itself", bump };
  const wrong = bumpTargetPause(target);
  if (wrong) return { paused: wrong, bump };
  // Never dearer than buying it on its own.
  if (bump.priceCents > target.priceCents) return { paused: "dearer", bump };
  return { bump, target };
}

/** Every box as it stands, in the product's order. */
export function bumpStates(products: Listing[], product: Listing): ({ bump: Bump; target: Listing } | { paused: BumpPause; bump: Bump })[] {
  return product.bumps.map((bump) => bumpState(products, product, bump));
}

/** The boxes a buyer may be offered on this product right now, in its order. */
export function activeBumps(products: Listing[], product: Listing): { bump: Bump; target: Listing }[] {
  return bumpStates(products, product).filter((state): state is { bump: Bump; target: Listing } => "target" in state);
}

/**
 * Where the offer sits, because the same reason has to read right in two
 * places: a box the buyer ticks before paying, and an offer shown after they
 * have paid (lib/funnel.ts). Rendering the sentences for the funnel showed the
 * words "the box charges more" under a list of offers where there is no box.
 */
export type OfferPlace = "box" | "offer";

/**
 * What the creator is told, and what to change to get the offer back.
 *
 * `offer` is the name of the product being offered, when the store still has
 * it. Every sentence names the product to change, because the thing that
 * broke the offer is almost never the product the offer is set on.
 */
export function bumpPauseWords(why: BumpPause, offer: string, where: OfferPlace = "box"): string {
  const it = offer || "that product";
  // "the box" / "this offer", so one set of reasons reads right in both places.
  const here = where === "box" ? "the box" : "this offer";
  const Here = where === "box" ? "The box" : "This offer";
  const its = where === "box" ? "the box's" : "this offer's";
  const kind = where === "box" ? "A checkout box" : "An offer after paying";
  switch (why) {
    case "kind":
      return "A checkout box only goes on a product with one price, sold once.";
    case "pwyw":
      return "Buyers name their own price here, and a chosen amount has to be the only thing in its checkout.";
    case "gone":
      return `The product ${here} offered is no longer in your store. Pick another one.`;
    case "itself":
      return `${Here} points at this same product. Pick another one.`;
    case "targetFree":
      return `${it} is given away now, so there is no price to offer it at. Put a price on ${it}, or offer something else.`;
    case "targetRecurring":
      return `${it} is charged again and again now, and ${here} is one payment. ${kind} offers a product sold once.`;
    case "targetCall":
      return `${it} is a booking now, and a booking is made on its own page, for a time. Offer something else.`;
    case "targetOptions":
      return `${it} has several prices to choose between, and ${here} offers one thing at one price. Take the options off ${it}, or offer something else.`;
    case "targetPwyw":
      return `Buyers name their own price on ${it}, so there is no one price to offer it at.`;
    case "targetLimited":
      return `${it} has a limited number for sale, and only its own checkout counts against that number. Take the limit off ${it}, or offer something else.`;
    case "targetEmpty":
      return `There is no file, link or bundle behind ${it} to hand over. Add one to ${it}.`;
    case "targetPick":
      return `Buyers choose which products ${it} holds, on its own page, and ${here} cannot ask them to choose. Offer something else.`;
    case "dearer":
      return `${Here} charges more for ${it} than buying it on its own does. Lower ${its} price, or raise the price of ${it}.`;
  }
}

/** Whether a product's quantity is limited right now. */
export function limitedStock(product: Listing): number | null {
  return product.stock !== null && isOneOff(product) ? product.stock : null;
}

export type Plan = {
  /** How many payments in all, the first one today. */
  payments: number;
  interval: "week" | "month";
  /**
   * Each payment, in the store currency's smallest unit. On a product with
   * several prices it is the smallest of `options`, which is what "from" means.
   */
  amountCents: number;
  /**
   * On a product with several prices (lib/product-option.ts): each payment
   * for each of them, by the option's id. The buyer picks a price and then
   * how to pay it, and each price is spread in the same number of payments.
   * Added 10 October 2026; a plan saved before has none.
   */
  options?: Record<string, number>;
};

export const MIN_PLAN_PAYMENTS = 2;
export const MAX_PLAN_PAYMENTS = 12;

export function parsePlan(raw: unknown): Plan | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const payments = Number(value.payments);
  if (!Number.isInteger(payments) || payments < MIN_PLAN_PAYMENTS || payments > MAX_PLAN_PAYMENTS) return null;
  if (value.interval !== "week" && value.interval !== "month") return null;
  const fair = (cents: unknown): cents is number => typeof cents === "number" && Number.isInteger(cents) && cents >= MIN_BUMP_CENTS && cents <= 10_000_000;
  // Each price's payment, kept only for ids an option can have and amounts a payment can be.
  const options: Record<string, number> = {};
  if (value.options && typeof value.options === "object" && !Array.isArray(value.options)) {
    for (const [id, cents] of Object.entries(value.options as Record<string, unknown>).slice(0, MAX_OPTIONS)) {
      if (OPTION_ID.test(id) && fair(cents)) options[id] = cents;
    }
  }
  const each = Object.values(options);
  if (each.length > 0) return { payments, interval: value.interval, amountCents: Math.min(...each), options };
  if (!fair(value.amountCents)) return null;
  return { payments, interval: value.interval, amountCents: value.amountCents };
}

/**
 * The options a plan has to cover: the ones a buyer is offered (lib/store-checkout.ts, sellableOptions), so
 * never one the creator took off sale (642 [WG2]): it needs no payment and never pauses the plan for the rest.
 */
function offeredOptions(product: Listing): ProductOption[] {
  const opens = Boolean(product.course || product.podcast || product.shipping);
  return product.options.filter((option) => !option.offSale && optionDelivers(option, opens));
}

/** The first price on a product with several that its plan does not cover, and why; null when it covers them all. */
export function uncoveredOption(product: Listing, plan: Plan): { option: ProductOption; why: "none" | "short" } | null {
  for (const option of offeredOptions(product)) {
    const cents = plan.options?.[option.id];
    if (!cents) return { option, why: "none" };
    if (plan.payments * cents < option.priceCents) return { option, why: "short" };
  }
  return null;
}

/** Why a payment plan a creator has set up is not being offered. */
export type PlanPause =
  /** No longer a plain one-off sale. */
  | "kind"
  /** Several prices to choose between, and one of them has no payment set in the plan. */
  | "options"
  /** Buyers name their own price, so there is nothing fixed to spread. */
  | "pwyw"
  /** The payments no longer add up to the full price — usually because the price went up. */
  | "short";

/**
 * The payment plan as it stands, with the reason when it is not being offered.
 *
 * `short` is the one that catches creators out: raise the product's price and
 * the plan that used to cover it stops being offered, silently, while the
 * studio goes on printing "3 monthly payments of $110".
 */
export function planState(product: Listing): { plan: Plan } | { paused: PlanPause; plan: Plan } | null {
  const plan = product.plan;
  if (!plan) return null;
  if (!isOneOff(product)) return { paused: "kind", plan };
  if (product.options.length > 0) {
    // Every price the buyer can pick has its own payment, adding up to at
    // least that price; one without would be a choice the button cannot keep.
    if (offeredOptions(product).length === 0) return { paused: "options", plan };
    const gap = uncoveredOption(product, plan);
    return gap ? { paused: gap.why === "none" ? "options" : "short", plan } : { plan };
  }
  if (product.pwyw) return { paused: "pwyw", plan };
  if (plan.payments * plan.amountCents < product.priceCents) return { paused: "short", plan };
  return { plan };
}

/**
 * The plan a buyer may choose for this product, or null. A plan never adds up
 * to less than paying at once. On a product with several prices this is the
 * plan as a whole; what each payment is depends on the price picked (planFor).
 */
export function activePlan(product: Listing): Plan | null {
  const state = planState(product);
  return state && !("paused" in state) ? state.plan : null;
}

/**
 * The lowest payment of a plan with one payment per price, among the prices
 * on sale only: what "from $X each" may name. Null when no price on sale has
 * a payment set (Claude 5 on #2690: an off-sale price's payment is never it).
 */
export function lowestPaymentOnSale(plan: Plan, options: ProductOption[]): number | null {
  const each: number[] = [];
  for (const option of options) {
    if (option.offSale) continue;
    const cents = plan.options?.[option.id];
    if (typeof cents === "number" && Number.isSafeInteger(cents) && cents > 0) each.push(cents);
  }
  return each.length > 0 ? Math.min(...each) : null;
}

/**
 * Whether putting this price back on sale stops a payment plan offered now:
 * the plan has no payment for it, or one that falls short, so planState turns
 * to "options" or "short" for every price. False when there is no plan, the
 * plan is paused already, the price is on sale already or the id names none.
 */
export function planPausedByRestore(product: Listing, optionId: string): boolean {
  if (product.options.find((option) => option.id === optionId)?.offSale !== true || activePlan(product) === null) return false;
  // The same step as an invited member's way in (withInvitedOption): only this price, back on sale.
  return activePlan(withInvitedOption(product, optionId)) === null;
}

/**
 * The plan for the price the buyer picked: on a product with one price, the
 * plan itself; on one with several, the same payments at that price's amount.
 * Null when there is no plan, or the id names no price the plan covers.
 */
export function planFor(product: Listing, optionId: string | null): Plan | null {
  const plan = activePlan(product);
  if (!plan) return null;
  if (product.options.length === 0) return { payments: plan.payments, interval: plan.interval, amountCents: plan.amountCents };
  // Only a price on sale: one taken off sale keeps no plan, whatever payment was saved for it.
  if (!optionId || !offeredOptions(product).some((option) => option.id === optionId)) return null;
  const cents = plan.options?.[optionId];
  return cents ? { payments: plan.payments, interval: plan.interval, amountCents: cents } : null;
}

/** What the creator is told, and what to change to get the plan back. */
export function planPauseWords(why: PlanPause, plan: Plan, product: Listing, currency: string): string {
  const gap = product.options.length > 0 ? uncoveredOption(product, plan) : null;
  switch (why) {
    case "kind":
      return "A payment plan only goes on a product sold once.";
    case "options":
      return gap
        ? `The plan has no payment for the \u201c${gap.option.label}\u201d price. Change the plan and set one, so every price can be paid in it.`
        : "This product has several prices, and none of them can be sold right now.";
    case "pwyw":
      return "Buyers name their own price here, so there is no fixed price to spread.";
    case "short": {
      const each = gap ? (plan.options?.[gap.option.id] ?? plan.amountCents) : plan.amountCents;
      const price = gap ? gap.option.priceCents : product.priceCents;
      const of = gap ? `the \u201c${gap.option.label}\u201d price of ${formatMoney(price, currency)}` : `the ${formatMoney(price, currency)} price`;
      return `${plan.payments} payments of ${formatMoney(each, currency)} come to ${formatMoney(plan.payments * each, currency)}, less than ${of}. Raise each payment, add one, or lower the price.`;
    }
  }
}

/** "3 monthly payments of $110", or "3 monthly payments" on a product with several prices, in the store's currency. */
export function planWords(plan: Plan, currency: string): string {
  const count = `${plan.payments} ${plan.interval === "week" ? "weekly" : "monthly"} payments`;
  return plan.options && Object.keys(plan.options).length > 0 ? count : `${count} of ${formatMoney(plan.amountCents, currency)}`;
}
