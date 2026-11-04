/**
 * What the studio says about an extra that is set up but not being shown.
 *
 * Every extra a creator adds to a product — a box at checkout, a payment plan,
 * offers after paying — depends on things that can be changed somewhere else.
 * Lower the price of the product your checkout box offers and the box stops
 * appearing. Raise a product's price and the payment plan that used to cover it
 * stops being offered. Give a product a limited number for sale and every offer
 * pointing at it goes dark.
 *
 * None of that was wrong; a box that charges more than the product costs on its
 * own should not appear. What was wrong is that the studio went on saying
 * "Offers Templates for $9 at checkout" and "Payment plan: 3 monthly payments
 * of $110" the whole time, so the only way a creator could find out was to
 * notice the money missing. An extra that is not being shown now says so, in
 * the same place it is set up, and says which product to change to get it back.
 *
 * The sentences are assembled on the server, because working out *why* needs
 * the whole store: the product a box offers may be one the studio is not
 * showing on this page, or one that no longer qualifies to be offered at all
 * and so is not in the list of choices the page was given.
 */
import type { Listing, Product } from "@/lib/store";
import { bumpPauseWords, bumpState, bumpStates, planPauseWords, planState } from "@/lib/product-extras";
import { funnelHealth, stepPauseWords } from "@/lib/funnel";
import { listedLengths } from "@/lib/call-lengths";

export type ExtraNotes = {
  /**
   * Why each box at checkout is not being shown, in the product's order:
   * null for a box that is. Absent when every box is shown.
   */
  bumps?: (string | null)[];
  /** Why the payment plan is not being offered. */
  plan?: string;
  /** The funnel: one line for the whole of it, then one per offer gone dark. */
  funnel?: string[];
  /**
   * True only when *nothing* follows the sale any more. A funnel with one of
   * three offers dark is still a funnel that runs, and greying its heading for
   * that says something untrue in the other direction.
   */
  funnelOff?: boolean;
};

/**
 * What is quiet on one product, and why. An empty object means everything set
 * up on it is being shown, which is the ordinary case.
 */
export function extraNotes(product: Product, all: Listing[], currency: string): ExtraNotes {
  const notes: ExtraNotes = {};
  const title = (id: string) => all.find((p) => p.id === id)?.title ?? "";

  const boxes = bumpStates(all, product).map((state) => ("paused" in state ? bumpPauseWords(state.paused, title(state.bump.productId)) : null));
  if (boxes.some(Boolean)) notes.bumps = boxes;

  const plan = planState(product);
  if (plan && "paused" in plan) notes.plan = planPauseWords(plan.paused, plan.plan, product, currency);

  const funnel = funnelHealth(all, product);
  if (funnel && (funnel.off !== null || funnel.dark.length > 0)) {
    const lines: string[] = [];
    const total = product.funnel?.steps.length ?? 0;
    if (funnel.off === "kind") {
      lines.push("Offers after paying only follow a product with one price, sold once.");
    } else if (funnel.off === "none") {
      lines.push(
        total === 1
          ? "The one offer here cannot be shown as your store stands."
          : `None of these ${total} offers can be shown as your store stands.`,
      );
    } else {
      lines.push(
        funnel.dark.length === 1
          ? `One of these ${total} offers is not being shown:`
          : `${funnel.dark.length} of these ${total} offers are not being shown:`,
      );
    }
    // Each dark offer named, so the creator knows which one to open.
    for (const { step, why } of funnel.dark) {
      const name = title(step.productId);
      lines.push(`${name || "An offer"}: ${stepPauseWords(why, name)}`);
    }
    notes.funnel = lines;
    if (funnel.off !== null) notes.funnelOff = true;
  }

  return notes;
}

/** Every product's notes, keyed by product id. Products with nothing quiet are left out. */
export function allExtraNotes(products: Product[], all: Listing[], currency: string): Record<string, ExtraNotes> {
  const out: Record<string, ExtraNotes> = {};
  for (const product of products) {
    const notes = extraNotes(product, all, currency);
    if (notes.bumps || notes.plan || notes.funnel) out[product.id] = notes;
  }
  return out;
}

/**
 * What a change to one product has just silenced, said at the moment it
 * happens.
 *
 * The panel on each product tells the truth from now on, but the creator who
 * cut a price is looking at the product they cut, not at the three others whose
 * checkout boxes offered it. So the save answers with the damage: every product
 * whose box or offer pointed at the one that changed and is now quiet, and the
 * changed product's own payment plan when the new price outgrew it.
 *
 * `products` needs to hold, read in full, every product of the store that
 * carries a funnel; a listing is enough for all the rest. The caller has the
 * catalog and knows which those are, so it is not read here.
 */
export function quietedBy(
  changedId: string,
  products: Product[],
  all: Listing[],
  currency: string,
): string[] {
  const lines: string[] = [];
  const say = (title: string, sentence: string) => lines.push(`${title}: ${sentence}`);

  for (const product of products) {
    const title = product.title || "A product";
    // A box or an offer that pointed at the product just changed.
    for (const bump of product.bumps) {
      if (bump.productId !== changedId) continue;
      const state = bumpState(all, product, bump);
      if ("paused" in state) say(title, bumpPauseWords(state.paused, all.find((p) => p.id === changedId)?.title ?? ""));
    }
    const funnel = product.funnel ? funnelHealth(all, product) : null;
    for (const { step, why } of funnel?.dark ?? []) {
      if (step.productId !== changedId) continue;
      say(title, stepPauseWords(why, all.find((p) => p.id === changedId)?.title ?? ""));
    }
    // Its own plan, which only its own price and shape can silence.
    if (product.id === changedId) {
      const plan = planState(product);
      if (plan && "paused" in plan) say(title, planPauseWords(plan.paused, plan.plan, product, currency));
      // A call's other lengths (lib/call-lengths.ts), which a new price takes off sale until they are saved again
      // (bookingLength): only the call's own length is booked meanwhile. A deposit never offers them, so it is not this.
      const call = product.call;
      if (call && call.kind === "weekly" && (call.lengths?.length ?? 0) > 1 && !call.deposit && listedLengths(call, product.priceCents).length === 0) {
        say(title, lengthsPausedWords(call.minutes));
      }
    }
  }
  return lines;
}

/** What the save says when a new price took a call's other lengths off sale: what still sells, and how to offer the others. */
export function lengthsPausedWords(minutes: number): string {
  return `Buyers can book only the ${minutes}-minute length now, because the price changed. To offer the other lengths again, open \u201cChange the hours\u201d on this product and save.`;
}
