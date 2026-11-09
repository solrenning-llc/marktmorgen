/**
 * Whether a failed Stripe request means Stripe gave no answer (owner's decision DONO-3, 9 November 2026).
 *
 * Only this lets a closed store's deadline pass without Stripe (lib/plan-closing.ts, STRIPE_SILENT_DAYS): the
 * network failed or the request timed out (lib/fetch-timeout.ts gives both up as `TypeError("fetch failed")`),
 * or Stripe answered with a server error or a rate limit (5xx, 429). Anything else is not silence and never lapses:
 * an answer in a shape or a funding this code cannot read, a client error (a key or a request of ours), Stripe not
 * configured, a run that had no time left to ask, or any failure of ours (Redis, the file store).
 */
import { BillingError } from "@/lib/billing";
import { StripeError } from "@/lib/stripe-account";

export function stripeSilent(error: unknown): boolean {
  if (error instanceof BillingError || error instanceof StripeError) return error.status >= 500 || error.status === 429;
  if (error instanceof TypeError && error.message === "fetch failed") {
    const cause = (error as { cause?: unknown }).cause;
    // Our own run's time, not Stripe's silence.
    return !(cause instanceof Error && cause.message === "there was no time left to ask");
  }
  return false;
}
