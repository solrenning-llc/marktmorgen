/**
 * Issue #4802 (reproduced by Claude 2): a paid, complete checkout whose amount or currency does not read was accepted
 * with an amount of 0 or the store's own currency. Synthetic store, Redis and Stripe only.
 */
// Synthetic store, Redis and Stripe only. A paid, complete checkout session of the store with unreadable money / time.
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readOrder } from "@/lib/store-checkout";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_o6_readorder";
const OWNER = "maker@example.com";
const ACCOUNT = "acct_1TestReadOrder01";
const NOW = Math.floor(Date.now() / 1000);
const oneSession: Record<string, Record<string, unknown>> = {};

globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  const one = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (one && oneSession[one[1]]) {
    // 1e999 is valid JSON that parses to Infinity; a number JSON.stringify cannot write.
    const body = JSON.stringify(oneSession[one[1]]).replace("-1234567", "1e999");
    return new Response(body, { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

const paid = (id: string, product: string, over: Record<string, unknown> = {}) => ({
  id, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid",
  created: NOW - 86_400, customer: "cus_TestBuyer0001", customer_details: { email: "buyer@example.com" },
  amount_total: 4900, currency: "usd", metadata: { store: "nightpaint", product }, payment_intent: null, ...over,
});

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "nightpaint", "Night Paint", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const guide = await addProduct(OWNER, "Brush Guide", "", "19", null);
  if (!guide.ok) throw new Error("no product");
  await setProductLink(OWNER, guide.product.id, "https://example.com/brush-guide");
  const store = (await storeForEmail(OWNER))!;
  const id = guide.product.id;
  const read = async (name: string, over: Record<string, unknown>) => {
    oneSession[name] = paid(name, id, over);
    const r = await readOrder(store, name);
    return r.state === "paid" ? { state: r.state, amount: r.amount, currency: r.currency, secondsLeft: r.secondsLeft } : { state: r.state };
  };

  part("control: a readable paid session is paid with its own money");
  is("49 dollars", await read("cs_test_o6control000001", {}), { state: "paid", amount: 4900, currency: "usd", secondsLeft: 172_799 });

  part("a paid checkout with unreadable money cannot invent zero in the store currency");
  is("amount_total null is an error", await read("cs_test_o6amountnull01", { amount_total: null }), { state: "error" });
  is("currency null is an error", await read("cs_test_o6currencynul01", { currency: null }), { state: "error" });
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
