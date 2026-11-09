/**
 * Why a Stripe request failed, for the closing of a store whose Stripe never answers (owner's decision DONO-3).
 *
 * Only `silent` lets a closed store's deadline pass without Stripe (lib/plan-closing.ts, STRIPE_SILENT_DAYS):
 *   - the network failed, or Stripe took too long (lib/fetch-timeout.ts gives both up as `TypeError("fetch
 *     failed")`), but never a request cut short by our own run's time;
 *   - Stripe answered with a server error or a rate limit (5xx, 429), also when that answer is not JSON
 *     (lib/stripe-http-error.ts);
 *   - the creator's connected account refused us for good (403 account_invalid or permission_error on a call to
 *     that account: the creator disconnected Marktmorgen; it will never answer again).
 * The rest never lapses: `key` is our own key refused (401 or 403 on the platform, 401 on a connected call) or
 * Stripe not configured; `answer` is a reply in a shape or a status this code cannot use; `other` is anything of
 * ours (our run's time, Redis, the file store).
 */
import { BillingError } from "@/lib/billing";
import { NO_TIME_TO_ASK, RUN_TIME_RAN_OUT } from "@/lib/fetch-timeout";
import { StripeError } from "@/lib/stripe-account";
import { StripeUnreadableReply } from "@/lib/stripe-http-error";

export type StripeFailure = "silent" | "key" | "answer" | "other";

export function stripeFailure(error: unknown): StripeFailure {
  const serverSide = (status: number) => status >= 500 || status === 429;
  if (error instanceof StripeUnreadableReply) return serverSide(error.status) ? "silent" : "answer";
  if (error instanceof BillingError) return serverSide(error.status) ? "silent" : error.status === 401 || error.status === 403 ? "key" : "answer";
  if (error instanceof StripeError) {
    if (serverSide(error.status)) return "silent";
    if (error.status === 403 && (error.code === "account_invalid" || error.code === "permission_error")) return "silent";
    return error.status === 401 ? "key" : "answer";
  }
  if (error instanceof TypeError && error.message === "fetch failed") {
    const cause = (error as { cause?: unknown }).cause;
    const message = cause instanceof Error || cause instanceof DOMException ? cause.message : "";
    return message === RUN_TIME_RAN_OUT || message === NO_TIME_TO_ASK ? "other" : "silent";
  }
  if (error instanceof Error && (error.message === "Billing is not configured" || error.message === "Selling is not configured")) return "key";
  return "other";
}

export function stripeSilent(error: unknown): boolean {
  return stripeFailure(error) === "silent";
}
