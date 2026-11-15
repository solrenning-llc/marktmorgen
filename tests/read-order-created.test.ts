/**
 * #4801 (Codex X5): a paid checkout whose creation time Stripe answered as Infinity, or another number that is not a
 * whole second, opened the download with no three-day limit: the age came out as -Infinity, so the link never
 * expired. A creation time decides the window only when it is a safe whole second that is not in the future; anything
 * else is an error, never an open window. Synthetic store, Redis and Stripe only.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readOrder } from "@/lib/store-checkout";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_read_order_created";
const OWNER = "maker@example.com";
const ACCOUNT = "acct_1TestReadOrder01";
const NOW = Math.floor(Date.now() / 1000);
const oneSession: Record<string, Record<string, unknown>> = {};

globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input instanceof Request ? input.url : input)).pathname.replace(/^\/v1/, "");
  const one = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (one && oneSession[one[1]]) {
    // 1e999 is valid JSON that parses to Infinity, a number JSON.stringify cannot write.
    const body = JSON.stringify(oneSession[one[1]]).replace("-1234567", "1e999");
    return new Response(body, { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

const paid = (id: string, product: string, over: Record<string, unknown> = {}) => ({
  id,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400,
  customer: "cus_TestBuyer0001",
  customer_details: { email: "buyer@example.com" },
  amount_total: 4900,
  currency: "usd",
  metadata: { store: "nightpaint", product },
  payment_intent: null,
  ...over,
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
  let n = 0;
  const read = async (over: Record<string, unknown>) => {
    n += 1;
    const name = `cs_test_created${String(n).padStart(8, "0")}`;
    oneSession[name] = paid(name, id, over);
    const r = await readOrder(store, name);
    return r.state === "paid" ? { state: r.state, finite: Number.isFinite(r.secondsLeft) && r.secondsLeft > 0 } : { state: r.state };
  };

  part("(control) a readable paid session keeps its three days");
  is("a day old: paid, with a finite time left", await read({}), { state: "paid", finite: true });
  is("a minute old: paid, with a finite time left", await read({ created: NOW - 60 }), { state: "paid", finite: true });
  is("four days old: expired", await read({ created: NOW - 4 * 86_400 }), { state: "expired" });

  part("A creation time that does not read can never open an unlimited download window");
  is("created 1e999 (Infinity) is an error", await read({ created: -1234567 }), { state: "error" });
  is("created a day in the future is an error", await read({ created: NOW + 86_400 }), { state: "error" });
  is("created as a fraction of a second is an error", await read({ created: NOW - 60.5 }), { state: "error" });
  is("created as text is not paid", (await read({ created: String(NOW - 60) })).state === "paid", false);
  is("created absent is not paid", (await read({ created: undefined })).state === "paid", false);
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
