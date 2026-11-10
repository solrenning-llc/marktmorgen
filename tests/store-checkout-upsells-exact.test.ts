/**
 * The products taken in one click after paying are sales on the creator's
 * list (lib/store-checkout.ts, listSales). A page of payments that is not a
 * Stripe list in its exact shape (readStripePage: an object with its own
 * `data` list and `has_more` true or false) is not "none were taken": before,
 * `Array.isArray(intents.data) ? intents.data : []` showed the checkouts as the
 * whole of what was sold, and the creator never saw a paid upsell (rule 24;
 * Claude 5, round 30). Now the list says it could not be verified, as it does
 * for an unreadable page of checkouts, and an offer row it cannot read is not
 * shown as $0 or as an order of 1970.
 */
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_upsell_list_only_a_stand_in";
  process.env.STRIPE_CONNECT_API_BASE = "http://127.0.0.1:4998";
  let intents: unknown = { object: "list", data: [], has_more: false };
  const checkouts = { object: "list", data: [], has_more: false };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== "http://127.0.0.1:4998" || (init?.method ?? "GET") !== "GET") throw new Error("Only synthetic order reads are allowed");
    if (url.pathname === "/v1/checkout/sessions") return new Response(JSON.stringify(checkouts));
    if (url.pathname === "/v1/payment_intents") return new Response(JSON.stringify(intents));
    throw new Error(`Unexpected synthetic endpoint ${url.pathname}`);
  }) as typeof fetch;

  redis.clear();
  const { claimHandle, setStripeAccount, setSubscription, storeForEmail } = await import("@/lib/store");
  const { listSales } = await import("@/lib/store-checkout");
  const email = "upsell-list-proof@example.test";
  await claimHandle(email, "upsellproof", "Upsell proof", "");
  await setStripeAccount(email, "acct_fixture009", true);
  await setSubscription(email, { customerId: "cus_UpsellListProof1", subscriptionId: "sub_UpsellListProof1", active: true, period: paidPeriod() });
  const store = (await storeForEmail(email))!;
  const now = Math.floor(Date.now() / 1000);
  const offer = (over: Record<string, unknown> = {}) => ({
    id: "pi_UpsellProof0001",
    object: "payment_intent",
    status: "succeeded",
    created: now,
    amount: 1900,
    currency: "usd",
    receipt_email: "buyer@example.test",
    metadata: { kind: "upsell", store: "upsellproof", title: "Workbook" },
    ...over,
  });

  part("A page of payments read whole: the offer is a sale");
  intents = { object: "list", data: [offer()], has_more: false };
  const read = await listSales(store);
  is("the offer taken after paying is listed", read.state === "ok" ? read.sales.map((s) => [s.reference, s.amount, s.title]) : read.state, [["pi_UpsellProof0001", 1900, "Workbook (added after paying)"]]);
  intents = { object: "list", data: [], has_more: false };
  const none = await listSales(store);
  is("an explicit empty page is no offer", none.state === "ok" ? none.sales.length : none.state, 0);

  part("A page of payments not in its shape is not 'no offers': the list is not verified");
  for (const [what, page] of [
    ["no data", {}],
    ["data not a list", { data: { 0: offer() }, has_more: false }],
    ["data null", { data: null, has_more: false }],
    ["has_more missing", { data: [offer()] }],
    ["not an object", [offer()]],
  ] as [string, unknown][]) {
    intents = page;
    is(`${what}: the list says it could not be verified`, (await listSales(store)).state, "error");
  }

  part("An offer of this store that does not read is not shown as $0 or as never paid");
  for (const [what, over] of [
    ["amount missing", { amount: undefined }],
    ["amount in words", { amount: "1900" }],
    ["paid at unknown", { created: null }],
    ["currency unknown", { currency: 5 }],
  ] as [string, Record<string, unknown>][]) {
    intents = { object: "list", data: [offer(over)], has_more: false };
    is(`${what}: the list says it could not be verified`, (await listSales(store)).state, "error");
  }
  intents = { object: "list", data: [{ id: 7, status: "succeeded" }], has_more: false };
  is("a row with no id it can read: not verified, it may be an offer", (await listSales(store)).state, "error");
  intents = { object: "list", data: [offer({ metadata: { kind: "call" } }), offer({ id: "pi_OtherStore0001", metadata: { kind: "upsell", store: "elsewhere" }, amount: "x" })], has_more: false };
  const others = await listSales(store);
  is("another kind of payment, or another store's offer, is not this store's sale and decides nothing", others.state === "ok" ? others.sales.length : others.state, 0);

  done();
}

void main();
