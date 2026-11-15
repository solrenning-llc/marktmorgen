/**
 * What is still missing before a store drafted with AI can sell (219 [OP5],
 * unit 7; lib/store-setup.ts keeps the draft). Every kept product is a hidden
 * draft: it goes on sale only once the creator adds what it hands over and
 * chooses Publish, and a paid one needs a Stripe account that takes payments.
 * These steps say so, in order, each with a link to the studio section where
 * it is done. Nothing here publishes anything or asks a model.
 *
 * Browser-safe: plain data and a pure function.
 */

/** One thing still to do, with the studio page where it is done. */
export type SetupStep = { id: string; label: string; href: string };

/** A product kept from the draft, as the steps need it. */
export type SetupDraft = { id: string; title: string; priceCents: number };

/** The studio's Stripe section (app/studio/page.tsx, id="stripe"), as the checkup links it. */
export const SETUP_STRIPE_STEP: SetupStep = { id: "stripe", label: "Connect Stripe, so buyers can pay you", href: "/studio#stripe" };

/** The studio's products list opened on one product, as the payments panel links it: searched by its first 80 characters. */
export function setupProductHref(title: string): string {
  return `/studio?q=${encodeURIComponent(title.slice(0, 80))}#products`;
}

/**
 * The steps still missing, Stripe first when a kept product has a price and
 * the store cannot take payments yet, then each kept product by name, in the
 * order it was kept. Nothing kept means nothing to do.
 */
export function setupSteps(input: { stripeReady: boolean; drafts: SetupDraft[] }): SetupStep[] {
  const steps: SetupStep[] = [];
  if (!input.stripeReady && input.drafts.some((draft) => draft.priceCents > 0)) steps.push(SETUP_STRIPE_STEP);
  for (const draft of input.drafts) {
    steps.push({ id: `product:${draft.id}`, label: `Add what "${draft.title}" hands over, then choose Publish`, href: setupProductHref(draft.title) });
  }
  return steps;
}
