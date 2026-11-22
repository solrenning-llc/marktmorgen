/**
 * A buyer's list of purchases is read from two Stripe lists on the creator's
 * account: the address's checkouts and, for each customer a checkout made,
 * the payments taken in one click after it (lib/buyer-orders.ts, checkoutsOf
 * and oneClickList). A page that is not a Stripe list in its exact shape
 * (readStripePage: an object with its own `data` list and `has_more` true or
 * false) is not "bought nothing": before, `rows()` read it as an empty list,
 * so the page told a buyer who paid that there was nothing to download, and
 * the link email was never sent (rule 24; Claude 5, round 30). Now the read
 * throws, as a failed request does, and the page says it could not load.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { purchasesFor } from "@/lib/buyer-orders";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner-lists@example.com";
let checkouts: unknown = { object: "list", data: [], has_more: false };
let intents: unknown = { object: "list", data: [], has_more: false };
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/checkout/sessions" && method === "GET") return answer(checkouts);
  if (path === "/payment_intents" && method === "GET") return answer(intents);
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

async function outcome(email: string): Promise<string | string[]> {
  try {
    return (await purchasesFor((await storeForEmail(OWNER))!, email)).map((p) => p.reference);
  } catch {
    return "not read";
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_buyer_lists_only_a_stand_in";
  await claimHandle(OWNER, "listsproof", "Lists proof", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLists00001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() });
  const guide = await addProduct(OWNER, "Guide", "", "19", null);
  const sheet = await addProduct(OWNER, "Sheet", "", "9", null);
  if (!guide.ok || !sheet.ok) throw new Error("no products");
  await setProductLink(OWNER, guide.product.id, "https://example.com/guide");
  await setProductLink(OWNER, sheet.product.id, "https://example.com/sheet");
  const checkout = {
    id: "cs_test_" + "f".repeat(24),
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    created: Math.floor(Date.now() / 1000) - 60,
    amount_total: 1900,
    currency: "usd",
    customer: "cus_ListsBuyer0001",
    metadata: { store: "listsproof", product: guide.product.id },
    customer_details: { email: "buyer@example.com" },
    payment_intent: { id: "pi_ListsMain00001", status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
  };
  const oneClick = {
    id: "pi_ListsOffer0001",
    object: "payment_intent",
    status: "succeeded",
    created: Math.floor(Date.now() / 1000),
    amount: 900,
    currency: "usd",
    customer: "cus_ListsBuyer0001",
    metadata: { kind: "upsell", store: "listsproof", product: sheet.product.id, parent: checkout.id, title: "Sheet" },
    latest_charge: { refunded: false, amount_refunded: 0 },
  };

  part("Both lists read whole: the checkout and the offer taken after it");
  checkouts = { object: "list", data: [checkout], has_more: false };
  intents = { object: "list", data: [oneClick], has_more: false };
  const whole = await outcome("buyer@example.com");
  is("the checkout is on the list", Array.isArray(whole) && whole.includes(checkout.id), true);
  is("and the offer taken in one click after it", Array.isArray(whole) && whole.includes(oneClick.id), true);
  checkouts = { object: "list", data: [], has_more: false };
  is("an explicit empty list of checkouts is nothing bought", await outcome("buyer@example.com"), []);

  part("A list of checkouts not in its shape is not 'bought nothing'");
  for (const [what, page] of [
    ["no data", {}],
    ["data not a list", { data: { 0: checkout }, has_more: false }],
    ["has_more missing", { data: [checkout] }],
    ["not an object", [checkout]],
  ] as [string, unknown][]) {
    checkouts = page;
    is(`${what}: not read, never an empty list`, await outcome("buyer@example.com"), "not read");
  }

  part("A list of one-click payments not in its shape is not 'no offers taken'");
  checkouts = { object: "list", data: [checkout], has_more: false };
  for (const [what, page] of [
    ["no data", {}],
    ["data null", { data: null, has_more: false }],
    ["has_more missing", { data: [oneClick] }],
  ] as [string, unknown][]) {
    intents = page;
    is(`${what}: not read, never the checkout alone`, await outcome("buyer@example.com"), "not read");
  }

  done();
}

void main();
