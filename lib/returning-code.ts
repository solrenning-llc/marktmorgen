/**
 * The check behind a code only for people who already bought from this
 * store (lib/returning-code-rules.ts has the rule; 554 [DS1], unit 2).
 *
 * Whose email it is: proved, never typed. The buyer opens the link we
 * emailed to their library (lib/buyer-library.ts, requestLibraryLink), and
 * only the address that link was sent to is read (libraryOwner). A typed
 * email would let anyone with the code learn whether someone else bought
 * here, and give the price to anyone who knows a past buyer's address
 * (review of #3666, HIGH and MEDIUM): without the link the answer is the
 * same, "proof", whether or not any email bought, and nothing is read.
 *
 * What it costs: the store's own record, already read, for the code; then,
 * only when the code is one of the store's and the link has its shape, one
 * read of the link and the same
 * reads and Stripe calls as the next product after a purchase (ownedHere),
 * taken from the store's month of public requests BEFORE they are made
 * (RETURNING_CODE_REQUEST_UNITS, priced in tests/plan-cost-registry.ts as
 * NEXT_OFFER_READ). A month that is used reads as unknown: the code is not
 * taken, the buyer can still buy at the full price. Each try is also inside
 * the route's own limit per connection (app/api/store/checkout/route.ts).
 */
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { takeBuyerRead } from "@/lib/buyer-actions";
import { LIBRARY_TOKEN, libraryOwner } from "@/lib/buyer-library";
import { ownedHere } from "@/lib/next-offer";
import { NEXT_OFFER_REQUEST_UNITS } from "@/lib/next-offer-rules";
import { type ReturningCode, type ReturningRefusal, returningCodeFor, returningDecision } from "@/lib/returning-code-rules";
import type { Store } from "@/lib/store";

/** Public requests one check counts as: the same reads and Stripe calls as ownedHere for the next product after a purchase, and the link's one read inside the product reads it never makes (tests/plan-cost-registry.test.ts). */
export const RETURNING_CODE_REQUEST_UNITS = NEXT_OFFER_REQUEST_UNITS;

/** How many tries one connection gets on one store in ten minutes: far past a buyer who mistyped, short of a script trying addresses. */
export const RETURNING_TRIES = 6;
export const RETURNING_TRIES_SECONDS = 600;

export type ReturningCheck =
  | { ok: true; code: ReturningCode; email: string }
  | { ok: false; reason: ReturningRefusal };

/**
 * The code the buyer typed and the library link that proves their email,
 * checked: the code must be one of this store's that has not ended, the link
 * one we sent and still kept, and the address it was sent to must have
 * bought something here before, read in full. Nothing is read from Stripe
 * for a code the store does not have, and nothing at all without a link of
 * the right shape. The answer before the proof never depends on any email.
 */
export async function checkReturningCode(store: Store, typedCode: string, proof: string, now = Date.now()): Promise<ReturningCheck> {
  const code = returningCodeFor(store.returningCodes, typedCode, Math.floor(now / 1000));
  if (!code) return { ok: false, reason: "code" };
  if (!LIBRARY_TOKEN.test(proof)) return { ok: false, reason: "proof" };
  if (!store.stripeAccountId) return { ok: false, reason: "unknown" };
  // The ceiling before the spend: no room this month is unknown, never a discount.
  const room = await takeBuyerRead(store, RETURNING_CODE_REQUEST_UNITS).catch(() => false);
  if (!room) return { ok: false, reason: "unknown" };
  // The link's own address, or none: an unreadable answer is unknown, never a guess at whose email it is.
  let proved: string | null;
  try {
    proved = await libraryOwner(proof);
  } catch {
    return { ok: false, reason: "unknown" };
  }
  if (proved === null) return { ok: false, reason: "proof" };
  const email = normaliseEmail(proved.slice(0, MAX_EMAIL_LENGTH + 1));
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return { ok: false, reason: "unknown" };
  const owned = await ownedHere(store, email).catch(() => null);
  const decided = returningDecision(code, owned);
  return decided.ok ? { ok: true, code: decided.code, email } : decided;
}
