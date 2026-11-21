/**
 * Whether Stripe refused a list's `starting_after` (Claude 3 N, 6806672663 item 2 on #3215): a cursor kept between
 * runs names an object that may be gone, and Stripe answers 400 resource_missing on it. That cursor will never be
 * read again, so the caller drops it and reads the list from the top at once, never waiting for it to run out.
 * Read from the error's own status and code (lib/stripe-account.ts StripeError, lib/billing.ts BillingError), never
 * from its words. Anything else is not a refused cursor.
 */
export function cursorRefused(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 400 && code === "resource_missing";
}
