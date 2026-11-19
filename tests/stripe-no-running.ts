/**
 * For a test that removes a paid product on a store with a Stripe account: the removal first asks Stripe whether any
 * membership or payment plan still runs for it (app/api/store/product/route.ts, runningSubscriptions). This answers
 * that list as empty (nothing running) and hands every other request to the fetch the test already set, unchanged.
 * Call it after the test sets its own globalThis.fetch.
 */
export function answerNoRunningSubscriptions(): void {
  process.env.STRIPE_SECRET_KEY ||= "sk_test_no_running_subscriptions_only";
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "api.stripe.com" && url.pathname === "/v1/subscriptions" && (init?.method ?? "GET") === "GET") {
      return Response.json({ object: "list", data: [], has_more: false });
    }
    return prior(input, init);
  }) as typeof fetch;
}
