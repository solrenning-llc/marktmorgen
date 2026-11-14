/**
 * A funnel: what a buyer is offered after paying, one offer at a time.
 *
 * The one-click upsell grew into this. A product can now carry up to five
 * offers in a row, shown on its thanks page. Each offer is another product
 * of the same store, at a price the creator sets for it here, and each has
 * two ways on: the buyer takes it, or says no thanks. Either answer can lead
 * to another offer — a "no" leading to the same product for less is what is
 * usually called a downsell — or to the end.
 *
 * The rules that keep it honest are the ones the single upsell had, and they
 * are checked here so the studio and the server apply the same ones:
 *
 *   - every offer is a real product, one with one price and something to
 *     hand over, never offered for more than it costs on its own;
 *   - an answer only ever leads to an offer further down the list, so a
 *     funnel cannot loop and nobody is shown the same offer twice;
 *   - an offer that follows buying a product never offers that product again,
 *     and on the thanks page anything the buyer already has in this order is
 *     passed over, so nobody is sold the same thing twice.
 *
 * Pure, so the studio and the server apply the same rules.
 */
import type { Listing, Product } from "@/lib/store";
import {
  type Bump,
  type BumpPause,
  MIN_BUMP_CENTS,
  bumpPauseWords,
  bumpTargetPause,
  canBeBumped,
  isOneOff,
} from "@/lib/product-extras";

export type FunnelStep = {
  /** Its own id, so an answer can point at it. */
  id: string;
  /** The product offered: another product of the same store. */
  productId: string;
  /** What it costs in this offer, in the store currency's smallest unit. Never more than on its own. */
  priceCents: number;
  /** The big line, in the creator's words. Empty uses "<title> for <price>", in the store's currency. */
  headline: string;
  /** A few sentences under it. */
  text: string;
  /** Whose picture is shown with the offer: a product of the store, or none. */
  imageFrom: string | null;
  /** Where "yes" leads: the id of a later offer, or null for the end. */
  yes: string | null;
  /** Where "no thanks" leads: the id of a later offer, or null for the end. */
  no: string | null;
};

export type Funnel = { steps: FunnelStep[] };

/** Offers in one funnel, the same number Stan allows upsells and downsells. */
export const MAX_FUNNEL_STEPS = 5;
export const MAX_HEADLINE_LENGTH = 90;
export const MAX_STEP_TEXT_LENGTH = 400;
export const STEP_ID_PATTERN = /^[a-z0-9]{4,12}$/;
const PRODUCT_ID_PATTERN = /^[a-z0-9]{6,40}$/;

const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

/**
 * Whatever came back from storage or from the studio, made safe to use: the
 * right shapes, at most five offers, no repeated ids, and every answer
 * pointing further down the list or nowhere. Returns null for no funnel.
 */
export function parseFunnel(raw: unknown): Funnel | null {
  if (!raw || typeof raw !== "object") return null;
  const list = (raw as { steps?: unknown }).steps;
  if (!Array.isArray(list)) return null;
  const steps: FunnelStep[] = [];
  const seen = new Set<string>();
  for (const entry of list.slice(0, MAX_FUNNEL_STEPS)) {
    if (!entry || typeof entry !== "object") return null;
    const value = entry as Record<string, unknown>;
    if (typeof value.id !== "string" || !STEP_ID_PATTERN.test(value.id) || seen.has(value.id)) return null;
    if (typeof value.productId !== "string" || !PRODUCT_ID_PATTERN.test(value.productId)) return null;
    if (typeof value.priceCents !== "number" || !Number.isInteger(value.priceCents)) return null;
    if (value.priceCents < MIN_BUMP_CENTS || value.priceCents > 10_000_000) return null;
    seen.add(value.id);
    steps.push({
      id: value.id,
      productId: value.productId,
      priceCents: value.priceCents,
      headline: clean(value.headline, MAX_HEADLINE_LENGTH),
      text: clean(value.text, MAX_STEP_TEXT_LENGTH),
      imageFrom: typeof value.imageFrom === "string" && PRODUCT_ID_PATTERN.test(value.imageFrom) ? value.imageFrom : null,
      yes: typeof value.yes === "string" ? value.yes : null,
      no: typeof value.no === "string" ? value.no : null,
    });
  }
  if (steps.length === 0) return null;
  // An answer may only lead further down: that is what makes a loop, and an
  // offer shown twice, impossible.
  const at = new Map(steps.map((step, index) => [step.id, index]));
  for (const [index, step] of steps.entries()) {
    for (const next of [step.yes, step.no]) {
      if (next === null) continue;
      const to = at.get(next);
      if (to === undefined || to <= index) return null;
    }
  }
  return { steps };
}

/** The single upsell a product had before funnels, as a funnel of one offer. */
export function funnelFromUpsell(upsell: Bump | null): Funnel | null {
  if (!upsell) return null;
  return {
    steps: [
      {
        id: "first",
        productId: upsell.productId,
        priceCents: upsell.priceCents,
        headline: "",
        text: upsell.pitch,
        imageFrom: null,
        yes: null,
        no: null,
      },
    ],
  };
}

/** Every offer that can come after this one, by either answer, in any number of steps. */
function after(funnel: Funnel, from: string | null, into = new Set<string>()): Set<string> {
  if (from === null || into.has(from)) return into;
  const step = funnel.steps.find((s) => s.id === from);
  if (!step) return into;
  into.add(step.id);
  after(funnel, step.yes, into);
  after(funnel, step.no, into);
  return into;
}

export type FunnelProblem = "kind" | "target" | "price" | "repeat" | "shape";

/**
 * Why this funnel cannot be saved on this product, or null when it can.
 *
 * The same checks the thanks page makes before showing an offer, made once
 * more when it is saved, so the creator hears about a problem in the studio
 * and not from a buyer.
 */
export function funnelProblem(funnel: Funnel, products: Listing[], owner: Listing): FunnelProblem | null {
  if (!isOneOff(owner)) return "kind";
  if (funnel.steps.length === 0 || funnel.steps.length > MAX_FUNNEL_STEPS) return "shape";
  for (const step of funnel.steps) {
    const target = products.find((p) => p.id === step.productId);
    if (!target || target.id === owner.id || !canBeBumped(target)) return "target";
    if (step.priceCents < MIN_BUMP_CENTS || step.priceCents > target.priceCents) return "price";
    // Having just bought it, or a bundle that holds it, the buyer is never offered it again (DISC-B-2).
    const got = new Set([step.productId, ...(target.bundle ?? [])]);
    for (const id of after(funnel, step.yes)) {
      const later = funnel.steps.find((s) => s.id === id)?.productId;
      if (later !== undefined && got.has(later)) return "repeat";
    }
  }
  return null;
}

/**
 * Why one offer of a funnel is not being shown.
 *
 * The same vocabulary a checkout box uses (lib/product-extras.ts), plus the
 * one reason only an offer here can have: a price below the smallest a card
 * can be charged.
 */
export type StepPause = BumpPause | "tooLittle";

/** Why this offer cannot be shown as the store stands, or null when it can. */
export function stepPause(products: Listing[], step: FunnelStep, ownerId?: string): StepPause | null {
  const target = products.find((p) => p.id === step.productId);
  if (!target) return "gone";
  if (ownerId !== undefined && target.id === ownerId) return "itself";
  const wrong = bumpTargetPause(target);
  if (wrong) return wrong;
  if (step.priceCents < MIN_BUMP_CENTS) return "tooLittle";
  if (step.priceCents > target.priceCents) return "dearer";
  return null;
}

/**
 * What the creator is told about one offer, and what to change to get it back.
 *
 * The shared reasons are worded for an offer after paying rather than a box at
 * checkout: rendering these showed "the box charges more for Recipe Vault"
 * printed under a list of offers with no box anywhere near them.
 */
export function stepPauseWords(why: StepPause, offer: string): string {
  if (why === "tooLittle") {
    return "The price of this offer is below the smallest amount a card can be charged. Raise it.";
  }
  return bumpPauseWords(why, offer, "offer");
}

/** Whether an offer can be shown right now, as the store stands. */
export function stepOffered(products: Listing[], step: FunnelStep): Listing | null {
  if (stepPause(products, step)) return null;
  return products.find((p) => p.id === step.productId) ?? null;
}

/**
 * The funnel as it stands: how many of its offers a buyer would meet, which
 * ones are dark and why, and whether the whole thing is off.
 *
 * A funnel is the extra a creator is least likely to notice going quiet: it
 * lives behind a payment, on a page they see once while testing and never
 * again. Four offers where one product got a price cut is four offers that
 * still read as set up in the studio and are never shown to anybody.
 */
export function funnelHealth(
  products: Listing[],
  product: Listing & Pick<Product, "funnel">,
): { shown: number; dark: { step: FunnelStep; why: StepPause }[]; off: "kind" | "none" | null } | null {
  const funnel = product.funnel;
  if (!funnel) return null;
  if (!isOneOff(product)) return { shown: 0, dark: [], off: "kind" };
  const dark: { step: FunnelStep; why: StepPause }[] = [];
  let shown = 0;
  for (const step of funnel.steps) {
    const why = stepPause(products, step, product.id);
    if (why) dark.push({ step, why });
    else shown += 1;
  }
  return { shown, dark, off: shown === 0 ? "none" : null };
}

/** The funnel that follows paying for this product, or null. */
export function activeFunnel(products: Listing[], product: Listing & Pick<Product, "funnel">): Funnel | null {
  const health = funnelHealth(products, product);
  return health && health.off === null ? product.funnel : null;
}

/** Offers nothing leads to: kept, but never shown until something does. */
export function unreachedSteps(funnel: Funnel): Set<string> {
  const reached = after(funnel, funnel.steps[0]?.id ?? null);
  return new Set(funnel.steps.filter((s) => !reached.has(s.id)).map((s) => s.id));
}

/**
 * Where one order's answers are kept: the first offer under the name the
 * single upsell always used, so an upsell taken before funnels existed is
 * still found, and every other offer under its own id.
 */
export function stepSlot(funnel: Funnel, step: FunnelStep): string {
  return funnel.steps[0]?.id === step.id ? "" : step.id;
}

export type StepAnswer = "paid" | "declined" | "failed" | "pending";

export type FunnelPosition =
  /** This offer is the one to show. */
  | { kind: "offer"; step: FunnelStep; target: Listing; index: number }
  /** An answer is still waiting on Stripe or the bank: nothing more is shown yet. */
  | { kind: "waiting"; step: FunnelStep }
  /** The card turned an offer down: nothing more is offered. */
  | { kind: "stopped"; step: FunnelStep }
  /** Every path has been walked. */
  | { kind: "done" };

/**
 * Walks one order's answers from the first offer to where the buyer is now.
 *
 * `answers` is keyed by slot (stepSlot). `owned` is what this order already
 * holds — the product bought and anything ticked at checkout — and grows with
 * each offer taken, so an offer of something the buyer has is passed over as
 * if they had said no to it.
 */
export function funnelPosition(
  funnel: Funnel,
  products: Listing[],
  answers: Map<string, StepAnswer>,
  owned: Set<string>,
): FunnelPosition {
  const have = new Set(owned);
  let id: string | null = funnel.steps[0]?.id ?? null;
  // Each answer leads further down the list, so this ends within five turns.
  for (let turn = 0; turn <= MAX_FUNNEL_STEPS && id !== null; turn += 1) {
    const index = funnel.steps.findIndex((s) => s.id === id);
    if (index < 0) break;
    const step = funnel.steps[index];
    const answer = answers.get(stepSlot(funnel, step));
    if (answer === "paid") {
      have.add(step.productId);
      // A bundle paid for hands over what it holds: none of it is offered again (DISC-B-2).
      for (const item of products.find((p) => p.id === step.productId)?.bundle ?? []) have.add(item);
      id = step.yes;
      continue;
    }
    if (answer === "declined") {
      id = step.no;
      continue;
    }
    if (answer === "failed") return { kind: "stopped", step };
    if (answer === "pending") return { kind: "waiting", step };
    const target = stepOffered(products, step);
    if (!target || have.has(target.id)) {
      id = step.no;
      continue;
    }
    return { kind: "offer", step, target, index };
  }
  return { kind: "done" };
}

/** "Yes" leads to, "No thanks" leads to — as a person reads it in the studio. */
export function stepLabel(funnel: Funnel, id: string | null): string {
  if (id === null) return "The end";
  const index = funnel.steps.findIndex((s) => s.id === id);
  return index < 0 ? "The end" : `Offer ${index + 1}`;
}

/** Every product a funnel names: those it offers and those whose pictures it shows. */
export function funnelProductIds(funnel: Funnel | null): string[] {
  if (!funnel) return [];
  return [...new Set(funnel.steps.flatMap((step) => [step.productId, ...(step.imageFrom ? [step.imageFrom] : [])]))];
}
