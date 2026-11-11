/**
 * The check behind a code only for people who already bought from this
 * store (lib/returning-code-rules.ts has the rule; 554 [DS1], unit 2).
 *
 * What it costs: the store's own record, already read, for the code; then,
 * only when the code is one of the store's and the email is one, the same
 * reads and Stripe calls as the next product after a purchase (ownedHere),
 * taken from the store's month of public requests BEFORE they are made
 * (RETURNING_CODE_REQUEST_UNITS, priced in tests/plan-cost-registry.ts as
 * NEXT_OFFER_READ). A month that is used reads as unknown: the code is not
 * taken, the buyer can still buy at the full price. Each try is also inside
 * the route's own limit per connection (app/api/store/checkout/route.ts).
 */
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { takeBuyerRead } from "@/lib/buyer-actions";
import { ownedHere } from "@/lib/next-offer";
import { NEXT_OFFER_REQUEST_UNITS } from "@/lib/next-offer-rules";
import { type ReturningCode, type ReturningRefusal, returningCodeFor, returningDecision } from "@/lib/returning-code-rules";
import type { Store } from "@/lib/store";

/** Public requests one check counts as: the same reads and Stripe calls as ownedHere for the next product after a purchase. */
export const RETURNING_CODE_REQUEST_UNITS = NEXT_OFFER_REQUEST_UNITS;

/** How many tries one connection gets on one store in ten minutes: far past a buyer who mistyped, short of a script trying addresses. */
export const RETURNING_TRIES = 6;
export const RETURNING_TRIES_SECONDS = 600;

export type ReturningCheck =
  | { ok: true; code: ReturningCode; email: string }
  | { ok: false; reason: ReturningRefusal };

/**
 * The code and the email the buyer typed, checked: the code must be one of
 * this store's that has not ended, the email one, and that email must have
 * bought something here before, read in full. Nothing is read from Stripe
 * for a code the store does not have.
 */
export async function checkReturningCode(store: Store, typedCode: string, typedEmail: string, now = Date.now()): Promise<ReturningCheck> {
  const code = returningCodeFor(store.returningCodes, typedCode, Math.floor(now / 1000));
  if (!code) return { ok: false, reason: "code" };
  const email = normaliseEmail(typedEmail.slice(0, MAX_EMAIL_LENGTH + 1));
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return { ok: false, reason: "email" };
  if (!store.stripeAccountId) return { ok: false, reason: "unknown" };
  // The ceiling before the spend: no room this month is unknown, never a discount.
  const room = await takeBuyerRead(store, RETURNING_CODE_REQUEST_UNITS).catch(() => false);
  if (!room) return { ok: false, reason: "unknown" };
  const owned = await ownedHere(store, email).catch(() => null);
  const decided = returningDecision(code, owned);
  return decided.ok ? { ok: true, code: decided.code, email } : decided;
}
