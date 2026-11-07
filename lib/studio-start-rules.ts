/**
 * Which of a store's first steps "Getting your store ready" shows (484 [IT1],
 * checklist unit 1; added 2 November 2026). The request: on the studio's
 * first screen, a list of at most five steps to the first sale, each checked off
 * by itself when it is done, with its progress in sight and a way to
 * collapse it; nothing taken away, only the order and the way it is shown.
 *
 *   - The steps to the first sale come first, in this order: prepare the
 *     first offer, publish it, connect Stripe, turn on the checkout, share the
 *     address (FIRST_SALE_KEYS). Connecting Stripe and the checkout are there
 *     only where the studio lists them (where payments and plans are set up),
 *     so the list has three to five steps; with fewer than five it cannot
 *     reach a sale, and its words say "first steps" instead.
 *   - The other steps (what the store says, its photo and color, buying once
 *     yourself, a way back into the account) are shown once those are done,
 *     never more than MAX_START_STEPS at a time. Nothing is taken away: each
 *     is done where it always was (the store's details, its look, its own
 *     page, the account's recovery), at any time.
 *   - "Your address" is not shown: it is done the moment the store exists, so
 *     a step for it is a check mark for nothing.
 *   - Every check mark still comes from the store's own records (app/studio/page.tsx);
 *     nothing here checks a step off.
 *
 * Pure and browser-safe.
 */

/** The steps to the first sale, in the order they are shown. */
export const FIRST_SALE_KEYS = ["product", "publish", "stripe", "plan", "share"] as const;

/** Steps never shown: done the moment the store exists. */
export const ALWAYS_DONE_KEYS = ["address"] as const;

/**
 * Said under a step whose check mark could not be read just now (its read
 * failed): such a step is never marked done, never left out and never the next
 * step, so the list never looks complete over it (components/studio-start.tsx).
 */
export const START_STEP_UNKNOWN = "Could not be checked just now, so it is not marked done. Open this page again in a moment.";

/** The most steps the list shows at once. */
export const MAX_START_STEPS = 5;

export type StartPhase = "first-sale" | "after";

type Step = { key: string; done: boolean };

const isFirstSale = (key: string) => (FIRST_SALE_KEYS as readonly string[]).includes(key);
const isAlwaysDone = (key: string) => (ALWAYS_DONE_KEYS as readonly string[]).includes(key);

/**
 * The steps to show, and which part they are: the steps to the first sale
 * while one of them is not done; then the rest, at most MAX_START_STEPS. With
 * everything done, the steps to the first sale, all checked, so the list can
 * still say how long the first offer took; the list hides itself when there
 * is nothing more to say (components/studio-start.tsx).
 *
 * `toSale` says whether the list holds every step a sale needs: connecting
 * Stripe and turning on the checkout are listed only where the studio can
 * offer them, and a store cannot sell without both (lib/store-checkout.ts,
 * canSell), so without them the list never speaks of a first sale.
 */
export function startList<T extends Step>(steps: T[]): { phase: StartPhase; steps: T[]; toSale: boolean } {
  const firstSale = FIRST_SALE_KEYS.flatMap((key) => steps.filter((step) => step.key === key));
  const toSale = FIRST_SALE_KEYS.every((key) => firstSale.some((step) => step.key === key));
  const rest = steps.filter((step) => !isFirstSale(step.key) && !isAlwaysDone(step.key));
  if (firstSale.some((step) => !step.done) || !rest.some((step) => !step.done)) {
    return { phase: "first-sale", steps: firstSale.slice(0, MAX_START_STEPS), toSale };
  }
  // The ones still to do first, then the ones done, so a sixth step never hides one still open.
  const open = rest.filter((step) => !step.done);
  const done = rest.filter((step) => step.done);
  const shown = new Set([...open, ...done].slice(0, MAX_START_STEPS));
  return { phase: "after", steps: rest.filter((step) => shown.has(step)), toSale };
}

/**
 * The line under the list's title: how many are done, and of what. "Your
 * first sale" only when the list holds every step a sale needs (`toSale`).
 */
export function startProgressWords(phase: StartPhase, done: number, total: number, toSale: boolean): string {
  if (phase === "first-sale") {
    return `${done} of ${total} ${toSale ? "steps to your first sale" : "first steps"} done. Everything saves as you go, so you can stop and come back.`;
  }
  return `${toSale ? "The steps to your first sale are done." : "The first steps are done."} ${done} of ${total} more steps done.`;
}
