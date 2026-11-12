/**
 * A monthly membership paid yearly, with a free trial before it (both allowed
 * together: lib/yearly-price.ts, "a free trial is fine, before either"). The
 * checkout makes the subscription at the year's price (lib/store-checkout.ts),
 * so what the buyer is told will be taken when the trial ends must be the
 * year's price, never the monthly one. Synthetic store, mocked Stripe.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setProductYearly, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { confirmationFor } from "@/lib/purchase-email";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";
const checkouts: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"t".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_yearly_trial_stand_in";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 7, payments: 0 });
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/club");
  is("a yearly price beside a 7-day trial is kept", (await setProductYearly(OWNER, made.product.id, { cents: 20000 })).ok, true);

  part("The checkout charges the year's price after the trial");
  const store = (await storeForEmail(OWNER))!;
  await createCheckout(store, (await readProduct(store, made.product.id))!, "https://marktmorgen.com", "", { yearly: true, digitalConsent: TEST_CONSENT });
  const sent = checkouts[0];
  is(
    "yearly price, once a year, after a 7-day trial",
    [sent.get("line_items[0][price_data][unit_amount]"), sent.get("line_items[0][price_data][recurring][interval]"), sent.get("subscription_data[trial_period_days]"), sent.get("metadata[every]"), sent.get("metadata[trial_days]")],
    ["20000", "year", "7", "year", "7"],
  );

  part("The confirmation names that same amount");
  const listing = (await readListing(store, made.product.id))!;
  const session = {
    id: "cs_test_yearlytrial000001",
    object: "checkout.session",
    status: "complete",
    payment_status: "no_payment_required",
    mode: "subscription",
    amount_total: 0,
    amount_subtotal: 0,
    currency: "usd",
    created: Math.floor(Date.now() / 1000),
    customer_details: { email: "buyer@example.com" },
    metadata: { store: "harbor", product: made.product.id, every: "year", trial_days: "7" },
  };
  const text = confirmationFor(store, session as never, Date.now() / 1000, [], [listing])?.text ?? "";
  const trialLine = text.split("\n").find((line) => line.includes("trial ends")) ?? "";
  is("the trial line is there", trialLine !== "", true);
  is("the first payment after the trial is the year's $200, never the monthly $20", [trialLine.includes("$200"), /\$20(?![0-9])/.test(trialLine)], [true, false]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
