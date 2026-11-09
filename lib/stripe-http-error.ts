/**
 * Stripe answered with an HTTP status whose body is not JSON: a gateway's 502, 503 or 504 page, say. Its own error,
 * with the status kept, so a caller can tell a server error from a reply in a shape it cannot read
 * (lib/stripe-silence.ts); never a BillingError or a StripeError, which callers read as Stripe's own refusal.
 */
export class StripeUnreadableReply extends Error {
  readonly status: number;

  constructor(status: number, cause: unknown) {
    super(`Stripe answered ${status} with a body that is not JSON`, { cause });
    this.name = "StripeUnreadableReply";
    this.status = status;
  }
}

/** The body of a Stripe answer as JSON; a non-JSON body of a status that is not OK is a StripeUnreadableReply. */
export async function stripeJson(response: Response): Promise<Record<string, unknown>> {
  // A stand-in answer that has only json() is read as before.
  if (typeof response.text !== "function") return (await response.json()) as Record<string, unknown>;
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    if (!response.ok) throw new StripeUnreadableReply(response.status, error);
    throw error;
  }
}
