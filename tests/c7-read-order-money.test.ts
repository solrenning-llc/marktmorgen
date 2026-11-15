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
// The clock held half a second past NOW for the whole test, so a window's seconds left never depend on how long the
// test took to get there (a slow run read 172798 for 172799): readOrder reads Date.now().
const FROZEN_MS = NOW * 1000 + 500;
Date.now = () => FROZEN_MS;
const oneSession: Record<string, Record<string, unknown>> = {};
// A body sent as Stripe wrote it, for the values JSON.stringify cannot write (1e999 parses to Infinity).
const rawBody: Record<string, string> = {};

globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  const one = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (one && rawBody[one[1]]) return new Response(rawBody[one[1]], { status: 200 });
  if (one && oneSession[one[1]]) return new Response(JSON.stringify(oneSession[one[1]]), { status: 200 });
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
  is("a fraction of a cent is an error", await read("cs_test_o6amountfrac01", { amount_total: 4900.5 }), { state: "error" });
  is("a negative amount is an error", await read("cs_test_o6amountneg001", { amount_total: -4900 }), { state: "error" });
  is("an amount as text is an error", await read("cs_test_o6amounttext01", { amount_total: "4900" }), { state: "error" });
  is("an empty currency is an error", await read("cs_test_o6currencyemp1", { currency: "" }), { state: "error" });
  is("an uppercase currency is an error", await read("cs_test_o6currencyup01", { currency: "USD" }), { state: "error" });
  {
    const name = "cs_test_o6amountinf001";
    rawBody[name] = JSON.stringify(paid(name, id, { amount_total: 0 })).replace('"amount_total":0', '"amount_total":1e999');
    const r = await readOrder(store, name);
    is("an amount of 1e999 (Infinity) is an error", r.state, "error");
  }

  part("an unreadable creation time cannot open an unlimited download window (issue #4801)");
  {
    const name = "cs_test_o6createdinf01";
    rawBody[name] = JSON.stringify(paid(name, id)).replace(`"created":${NOW - 86_400}`, '"created":1e999');
    is("created 1e999 (Infinity) is an error", (await readOrder(store, name)).state, "error");
  }
  is("created an hour in the future is an error", await read("cs_test_o6createdfut01", { created: NOW + 3600 }), { state: "error" });
  is("created as text is an error", await read("cs_test_o6createdtxt01", { created: String(NOW - 86_400) }), { state: "error" });
  is("created with a fraction of a second is an error", await read("cs_test_o6createdfra01", { created: NOW - 86_400.5 }), { state: "error" });
  is("created before 1970 is an error", await read("cs_test_o6createdneg01", { created: -1 }), { state: "error" });
  is("created missing is an error", await read("cs_test_o6creatednul01", { created: null }), { state: "error" });
  is("created a minute ahead (the clocks' slack) is still a three-day window", await read("cs_test_o6createdskw01", { created: NOW + 60 }), { state: "paid", amount: 4900, currency: "usd", secondsLeft: 259_200 });

  part("a free checkout keeps Stripe's explicit 0 in its own currency");
  is("no_payment_required, 0 usd, is paid at 0", await read("cs_test_o6freezero0001", { payment_status: "no_payment_required", amount_total: 0 }), { state: "paid", amount: 0, currency: "usd", secondsLeft: 172_799 });
  is("no_payment_required with no amount is an error", await read("cs_test_o6freenull0001", { payment_status: "no_payment_required", amount_total: null }), { state: "error" });

  part("the error is logged with the session and the field, never the buyer");
  {
    const logged: unknown[][] = [];
    const real = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      await read("cs_test_o6logcurrency1", { currency: "US" });
      await read("cs_test_o6logamount001", { amount_total: null });
      await read("cs_test_o6logboth00001", { amount_total: null, currency: "USD" });
    } finally {
      console.error = real;
    }
    const lines = logged.filter((args) => args[0] === "a paid checkout's money does not read").map((args) => args[1]);
    is("one line per unreadable order, naming the session and every field that does not read", lines, [
      { session: "cs_test_o6logcurrency1", fields: ["currency"] },
      { session: "cs_test_o6logamount001", fields: ["amount_total"] },
      { session: "cs_test_o6logboth00001", fields: ["amount_total", "currency"] },
    ]);
    is("no buyer address in the log", JSON.stringify(logged).includes("buyer@example.com"), false);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
