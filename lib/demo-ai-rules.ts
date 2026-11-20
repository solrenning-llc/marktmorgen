/**
 * The demo store's own AI ceiling (owner, 20/11/2026, decision 1 to Claude 4, "Revisão comercial, trava 2").
 *
 * The demo store (lib/house-store.ts, Harbor Kitchen) is on Studio so the public demo shows AI, but it earns nothing:
 * every cent it spends is a fixed cost of the LLC, paid 100% by Marktmorgen (FX275). So it gets its own, smaller
 * allowance instead of Studio's: visitor answers and store-guide replies only, the AI a visitor can see, and no
 * writing jobs, since only the operator opens its studio (lib/house-store.ts). Each answer is taken from the month's
 * allowance before the model is asked (lib/answers.ts takeAnswer) and is priced at the answer model's worst request
 * (lib/ai-entitlement-rules.ts), so the month can never cost more than DEMO_AI_CEILING_MICRO_USD, which stays under
 * the owner's cap of US$3.35. Once the month's answers are used up, the demo shows a fixed answer written in advance,
 * labeled as an example: never an error, and never one that looks generated on the spot.
 *
 * Pure and browser-safe: no environment, no network, no database.
 */
import { AI_ENTITLEMENT_RULES, AI_SLOT_MICRO_USD } from '@/lib/ai-entitlement-rules';
import { isHouseAddress } from '@/lib/house-store';

/** Whether a store is the demo store; false for anything without an owner's address, never a throw. */
export function isDemoStore(store: { email?: unknown } | null | undefined): boolean {
  return !!store && typeof store.email === 'string' && isHouseAddress(store.email);
}

/** Visitor answers and store-guide replies the demo store may give in a month (Studio publishes 250). */
export const DEMO_AI_ANSWERS_MONTHLY = 250;
/** Writing jobs the demo store may run in a month: none, as no visitor can open its studio. */
export const DEMO_AI_WRITING_JOBS_MONTHLY = 0;
/** The owner's cap for the demo's AI, US$3.35 a month (20/11/2026), in micro-USD. A limit, not a price. */
export const DEMO_AI_OWNER_CAP_MICRO_USD = 3_350_000;

/** The most the demo's AI can cost in a month: every allowed call at its worst request, from the cost table. */
export const DEMO_AI_CEILING_MICRO_USD =
  DEMO_AI_ANSWERS_MONTHLY * AI_ENTITLEMENT_RULES.visitorCallsPerAttempt * AI_SLOT_MICRO_USD.answer
  + DEMO_AI_WRITING_JOBS_MONTHLY * AI_ENTITLEMENT_RULES.writingCallsPerJob * AI_SLOT_MICRO_USD.writing;
if (!Number.isSafeInteger(DEMO_AI_CEILING_MICRO_USD) || DEMO_AI_CEILING_MICRO_USD > DEMO_AI_OWNER_CAP_MICRO_USD) {
  throw new Error("The demo store's AI allowance costs more than the owner's cap");
}

/** Drawn by the page above an example answer or example picks, never by a model. */
export const DEMO_EXAMPLE_LABEL = "Example answer, written in advance. This demo store's AI answers are used up for this month.";

/** What the demo shows in place of a visitor answer once the month's are used up: true of the demo, never generated. */
export const DEMO_EXAMPLE_ANSWER =
  "This is Marktmorgen's demo store. Jenny is a fictional cook. The checkout runs in Stripe's test mode, so no real money moves: pay with the test card 4242 4242 4242 4242, any future date and any CVC. The file you get is a real PDF.";

/** The reason shown with each example pick of the store guide. */
export const DEMO_EXAMPLE_PICK_WHY = "One of this demo store's products, picked in advance.";
