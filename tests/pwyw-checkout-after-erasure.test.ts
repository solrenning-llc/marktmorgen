/**
 * Codex L-20261119-1405 (#5010 row 83, HIGH, money and erasure): pwywPriceId keeps a newly made choose-your-price
 * Price only while its store is live (Codex G-1346), but it discarded what the keeper answered and handed the Price
 * back, so createCheckout went on and opened a checkout session: a buyer still got a payment page for a store whose
 * erasure began while Stripe was making the Price.
 *
 * Checked with the real createCheckout against the in-memory Redis, Stripe stood in by a fetch stub that begins the
 * store's erasure (its erasing mark, lib/store.ts ERASING_KEY) inside the POST /prices:
 * - the checkout is refused and no checkout session is asked of Stripe;
 * - no Price is kept under nl:pwyw:;
 * - the control, a live store, still opens its checkout with the creator's choose-your-price Price.
 *
 * Synthetic store and replies only; nothing real is called.
 */
import { addProduct, claimHandle, ensureStatsId, erasingField, ERASING_KEY, setStripeAccount, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "pwyw-erasure@example.com";
let erase: (() => Promise<void>) | null = null;
let sessions = 0;
let prices = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/prices" && method === "POST") {
    // The store's erasure begins while Stripe is making the Price.
    if (erase) await erase();
    prices += 1;
    return answer({ id: `price_pwywErase${String(prices).padStart(4, "0")}` });
  }
  if (path === "/checkout/sessions" && method === "POST") {
    sessions += 1;
    return answer({ id: `cs_test_${"p".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const kept = () => redis.keys().filter((key) => key.startsWith("nl:pwyw:")).length;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_pwyw_erasure_only_a_stand_in";
  await claimHandle(OWNER, "pwywerase", "Pwyw Erase", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPwywErase01", true);
  await setSubscription(OWNER, { customerId: "cus_PwywErase01", subscriptionId: "sub_PwywErase01", active: true, period: paidPeriod() });
  const added = await addProduct(OWNER, "Field Notes", "A guide.", "10", null, "15");
  if (!added.ok) throw new Error(`no product: ${JSON.stringify(added)}`);
  const store = (await storeForEmail(OWNER))!;
  const product = (await readProduct(store, added.product.id))!;

  part("A store whose erasure begins while Stripe makes the choose-your-price Price");
  erase = async () => { redis.run(["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]); };
  const outcome = await createCheckout(store, product, "https://marktmorgen.com", "", { digitalConsent: TEST_CONSENT }).then(() => "opened", () => "refused");
  is("the checkout is refused", outcome, "refused");
  is("no checkout session is asked of Stripe", sessions, 0);
  is("no Price is kept for the store", kept(), 0);

  part("Control: a live store");
  erase = null;
  redis.run(["HDEL", ERASING_KEY, await erasingField(storeRef(store))]);
  const before = sessions;
  const live = await createCheckout(store, product, "https://marktmorgen.com", "", { digitalConsent: TEST_CONSENT }).then(() => "opened", (error: unknown) => `refused: ${String(error)}`);
  is("the checkout opens", [live, sessions - before], ["opened", 1]);
  is("and its Price is kept", kept(), 1);
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
