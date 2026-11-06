/**
 * Talking to Stripe as the creator, not as us.
 *
 * Every call here carries the creator's connected account in the Stripe-Account
 * header, so it acts on their account with their data. That is the same fact
 * the whole company rests on: the money is theirs from the first second, the
 * customers are theirs, and so are the coupons and the sales records. Nothing
 * in this file ever touches the Marktmorgen account.
 *
 * It lives on its own rather than inside the checkout because more than one
 * thing needs it now, and two copies of the code that signs a request to
 * somebody else's account is exactly the kind of duplication that ends with
 * one of them quietly missing a header.
 */

import { STRIPE_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";
import { DEMO_CONNECTED_ACCOUNT, demoKey } from "@/lib/demo-account";

/** Local tests may point this at a mock on 127.0.0.1; nothing else is taken. */
const STRIPE_API = /^http:\/\/127\.0\.0\.1:\d+$/.test(
  process.env.STRIPE_CONNECT_API_BASE ?? "",
)
  ? `${process.env.STRIPE_CONNECT_API_BASE}/v1`
  : "https://api.stripe.com/v1";

export function platformKey(): string | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key || !/^(sk|rk)_(test|live)_/.test(key)) return null;
  return key;
}

/**
 * The key a request on this account is signed with.
 *
 * Ours, for every creator's account. The demo store's own test key for the
 * demo store's account (lib/demo-account.ts), and never ours: that account
 * lives in Stripe's test mode, and a key from another mode cannot reach it —
 * so on the day our own key is a live one the demo store would otherwise
 * stop selling, and, worse, anything that did get through would be the demo
 * asking Stripe for real money. Decided here, in the one function every
 * request on a creator's account passes through, so no caller can choose.
 */
export function keyFor(account: string): string | null {
  return account === DEMO_CONNECTED_ACCOUNT ? demoKey() : platformKey();
}

/**
 * How long a checkout that holds something stays open.
 *
 * Stripe keeps a checkout open for at least thirty minutes, counted from the
 * moment it makes it, and refuses an earlier closing time. So the time is
 * worked out right before the request that makes the checkout, with a minute
 * to spare for the journey there. Whatever it holds — a call's time, a
 * limited unit — is held for a minute longer still (HOLD_SECONDS), so it
 * is never let go while the page that pays for it is open.
 */
export const CHECKOUT_OPEN_SECONDS = 31 * 60;
export const HOLD_SECONDS = CHECKOUT_OPEN_SECONDS + 60;

/** When a holding checkout made right now closes, in seconds. */
export function checkoutClosesAt(): number {
  return Math.floor(Date.now() / 1000) + CHECKOUT_OPEN_SECONDS;
}

export class StripeError extends Error {
  readonly status: number;
  readonly code: string;
  /** Stripe's own sentence, alone, for a person to read (lib/checkout-trouble.ts). */
  readonly stripeMessage: string;

  constructor(status: number, code: string, stripeMessage: string) {
    // Stripe's own sentence is kept, because a bare code in a log is a trip
    // through the Stripe dashboard before anyone knows what went wrong.
    super(`Stripe request failed (${status} ${code}): ${stripeMessage}`);
    this.status = status;
    this.code = code;
    this.stripeMessage = stripeMessage;
  }
}

/**
 * One request, made on a connected account.
 *
 * `version` pins the API version for this call. Left out, Stripe uses whatever
 * our platform account currently defaults to — which is fine for shapes that
 * have not changed in years, and is a trap for the ones that have. A caller
 * that sends a parameter whose name depends on the version pins it, so the
 * request and the version can never disagree, today or after an upgrade.
 */
export async function onAccount(
  /** DELETE: a subscription ended at once (lib/closed-store-data.ts, stopRenewals). */
  method: "GET" | "POST" | "DELETE",
  account: string,
  path: string,
  body?: URLSearchParams,
  version?: string,
  /**
   * For a charge that must never happen twice: Stripe answers a repeat of
   * the same key with the first result instead of doing it again.
   */
  idempotencyKey?: string,
  /** A read-only workflow may choose a shorter ceiling; existing callers keep the default. */
  timeoutMs = STRIPE_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > STRIPE_TIMEOUT_MS) {
    throw new Error("Invalid Stripe request ceiling");
  }
  const key = keyFor(account);
  if (!key) throw new Error("Selling is not configured");

  // Given up after STRIPE_TIMEOUT_MS (lib/fetch-timeout.ts) as a network
  // failure is: never a StripeError, so a charge that timed out is "no
  // answer" to its caller — kept pending and settled from what Stripe says
  // later, with the same idempotency key — never "declined".
  const { response, data } = await timed(timeoutMs, async (signal) => {
    const response = await fetch(`${STRIPE_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        // The whole point: this acts on the creator's account, not ours.
        "Stripe-Account": account,
        ...(version ? { "Stripe-Version": version } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey.slice(0, 255) } : {}),
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body,
      cache: "no-store",
      signal,
    });
    return { response, data: (await response.json()) as Record<string, unknown> };
  });
  if (!response.ok) {
    const error = data.error as
      | { code?: string; type?: string; message?: string }
      | undefined;
    throw new StripeError(
      response.status,
      error?.code ?? error?.type ?? "unknown",
      error?.message ?? "Stripe gave no reason.",
    );
  }
  return data;
}
