import { createBillingCheckout, trialOffered } from "@/lib/billing";
import { PLAN_NAMES, PLAN_PRICES, TRIAL_DAYS, type Tier, type Cycle } from "@/lib/plan";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

const origin = "https://marktmorgen.example.test";
const fresh = { statsId: "trial-policy-identity", handle: "trial-policy", email: "owner@example.test", stripeCustomerId: null, subscriptionId: null, extra: false } as unknown as Store;
let choice: { tier: Tier; cycle: Cycle } = { tier: "creator", cycle: "month" };
let catalog = false;
let refusal: "customer" | "price" | null = null;
const sent: { body: URLSearchParams; headers: Headers }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com") throw new Error("Unexpected synthetic checkout host");
  if (url.pathname === "/v1/prices" && (init?.method ?? "GET") === "GET") {
    return catalog
      ? Response.json({ data: [{ id: "price_TrialPolicy0001", unit_amount: PLAN_PRICES[choice.tier][choice.cycle], currency: "usd", recurring: { interval: choice.cycle, interval_count: 1 } }] })
      : Response.json({ error: { message: "Synthetic catalog unavailable" } }, { status: 404 });
  }
  if (url.pathname !== "/v1/checkout/sessions" || init?.method !== "POST") throw new Error("Unexpected synthetic checkout operation");
  const body = new URLSearchParams(String(init.body ?? ""));
  sent.push({ body, headers: new Headers(init.headers) });
  if (sent.length === 1 && refusal) {
    return Response.json({ error: { message: refusal === "customer" ? "No such customer" : "No such price" } }, { status: 400 });
  }
  return Response.json({ url: "https://checkout.stripe.example.test/synthetic" });
}) as typeof fetch;

function policy(body: URLSearchParams, trial: boolean): void {
  is("collection remains explicit on each attempt", body.get("payment_method_collection"), "always");
  is("original trial duration is preserved", body.get("subscription_data[trial_period_days]"), trial ? String(TRIAL_DAYS) : null);
  is("only a trial cancels if its method is missing at the end", body.get("subscription_data[trial_settings][end_behavior][missing_payment_method]"), trial ? "cancel" : null);
  is("subscription, English and no automatic promotion change", [body.get("mode"), body.get("locale"), body.has("allow_promotion_codes")], ["subscription", "en", false]);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_trial_policy_only_a_stand_in";
  part("Every plan and cycle collects a method during its existing free trial");
  is("fixture is eligible for the existing trial", trialOffered(fresh), true);
  for (const tier of Object.keys(PLAN_NAMES) as Tier[]) {
    for (const cycle of ["month", "year"] as Cycle[]) {
      choice = { tier, cycle };
      sent.length = 0;
      const result = await createBillingCheckout(fresh, origin, choice, null);
      is("returns only the simulated checkout", result, "https://checkout.stripe.example.test/synthetic");
      is("one checkout attempt", sent.length, 1);
      policy(sent[0].body, true);
      is("published inline price is unchanged", sent[0].body.get("line_items[0][price_data][unit_amount]"), String(PLAN_PRICES[tier][cycle]));
      is("platform scope and credential are preserved", [sent[0].headers.get("Stripe-Account"), sent[0].headers.get("Authorization")], [null, "Bearer sk_test_trial_policy_only_a_stand_in"]);
      is("annual authentication rule is preserved", sent[0].body.get("payment_method_options[card][request_three_d_secure]"), cycle === "year" ? "any" : null);
    }
  }
  part("Checkout fallbacks cannot remove the collection policy");
  choice = { tier: "creator", cycle: "month" };
  catalog = true; refusal = "price"; sent.length = 0;
  await createBillingCheckout(fresh, origin, choice, null);
  is("archived price uses the existing single fallback", sent.length, 2);
  for (const request of sent) policy(request.body, true);
  is("price fallback keeps the published amount", [sent[0].body.get("line_items[0][price]"), sent[1].body.get("line_items[0][price_data][unit_amount]")], ["price_TrialPolicy0001", String(PLAN_PRICES.creator.month)]);
  catalog = false; refusal = "customer"; sent.length = 0;
  await createBillingCheckout(fresh, origin, choice, "cus_TrialPolicy0001");
  is("missing customer uses the existing single fallback", sent.length, 2);
  for (const request of sent) policy(request.body, true);
  is("only the stale customer reference changes", [sent[0].body.get("customer"), sent[1].body.get("customer"), sent[1].body.get("customer_email")], ["cus_TrialPolicy0001", null, fresh.email]);

  part("No additional store or returning customer receives a new trial");
  refusal = null;
  for (const previous of [
    { ...fresh, extra: true },
    { ...fresh, stripeCustomerId: "cus_TrialPolicy0001" },
    { ...fresh, subscriptionId: "sub_TrialPolicy0001" },
  ] as Store[]) {
    sent.length = 0;
    await createBillingCheckout(previous, origin, choice, previous.stripeCustomerId);
    is("existing eligibility remains unchanged", trialOffered(previous), false);
    is("no additional checkout attempt", sent.length, 1);
    policy(sent[0].body, false);
  }
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
