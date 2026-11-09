/**
 * An amount or a currency Stripe gave in a shape that cannot be read is
 * unknown, never a zero or a guessed currency (CX-123 rule 24; VR 2: nothing
 * shown to a creator or a buyer says what is not so).
 *
 *   - lib/webhooks.ts fromStripe: a sale, a membership, an offer after paying,
 *     a refund or a dispute whose amount or currency cannot be read is not sent
 *     to the creator's webhook as a $0 sale in "usd": it waits, as any event
 *     our code cannot process, and is passed over with a line in the creator's
 *     log in the end. A sale without discount details says discount_cents null,
 *     as /api/v1/sales does (app/developers/page.tsx), never 0.
 *   - lib/calls.ts callFromRow: a paid booking whose amount or currency cannot
 *     be read makes the reading unknown (StripeListUnreadable), never a booking
 *     "paid 0", which the creator's email read as a package session.
 *   - lib/store-tip-checkout.ts readTip: a gift whose amount or currency cannot
 *     be read is "waiting", never a thank-you for $0.00.
 *
 * Synthetic Stripe answers only; the endpoint's name resolves to a private
 * address, so nothing leaves this machine.
 */
import { addEndpoint, recentMessages, setSendHooksForTests, watchStripe } from "@/lib/webhooks";
import { paidCalls } from "@/lib/calls";
import { readTip } from "@/lib/store-tip-checkout";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { StripeListUnreadable } from "@/lib/stripe-list";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_amounts_unknown_only";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const account = "acct_AmountsUnknown01";
const HANDLE = "amounts-shop";
const OWNER = "amounts@example.com";
const NOW = Math.floor(Date.now() / 1000);

let events: unknown[] = [];
let sessions: Record<string, unknown>[] = [];
let single: Record<string, unknown> = {};
const intents: Record<string, Record<string, string>> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || init?.method !== "GET" || new Headers(init.headers).get("Stripe-Account") !== account) throw new Error(`unexpected synthetic operation ${url}`);
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/events") return Response.json({ object: "list", data: events, has_more: false });
  if (path === "/checkout/sessions") return Response.json({ object: "list", data: sessions, has_more: false });
  if (path.startsWith("/checkout/sessions/")) return Response.json(single);
  const intent = path.match(/^\/payment_intents\/(pi_\w+)$/)?.[1];
  if (intent && intents[intent]) return Response.json({ id: intent, object: "payment_intent", metadata: intents[intent] });
  return Response.json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } }, { status: 404 });
}) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] } });
const said: string[] = [];
const logged = console.error;
console.error = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  if (line.startsWith("a webhook delivery failed")) return;
  said.push(line);
};

async function setup(listen: string[]) {
  redis.clear();
  said.length = 0;
  await claimHandle(OWNER, HANDLE, "Amounts Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, account, true);
  await setSubscription(OWNER, { customerId: "cus_Amounts01", subscriptionId: "sub_AmountsPlan01", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  if (listen.length) is(`an endpoint listening for ${listen.join(", ")} is kept`, (await addEndpoint(store, "https://hooks.example.net/in", listen)).ok, true);
  return store;
}

/** A completed checkout of this store, as checkout.session.completed carries it. */
const checkout = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `cs_test_amounts${String(n).padStart(8, "0")}`,
  object: "checkout.session",
  status: "complete",
  payment_status: "paid",
  mode: "payment",
  amount_total: 4900,
  currency: "usd",
  total_details: { amount_discount: 100, amount_shipping: 0, amount_tax: 0 },
  customer_details: { email: `buyer${n}@example.com`, name: `Buyer ${n}` },
  metadata: { store: HANDLE, product: "p_course", title: "A course" },
  ...extra,
});
const completed = (n: number, object: Record<string, unknown>) => ({ id: `evt_Sale${n}`, type: "checkout.session.completed", created: 1_790_000_000 + n, data: { object } });
const without = (row: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== key));
const amountsOf = async (store: Awaited<ReturnType<typeof setup>>, type: Parameters<typeof recentMessages>[1]) =>
  (await recentMessages(store, type, 20)).map((m) => {
    const d = m.data as Record<string, unknown>;
    return [d.checkout_session ?? d.dispute ?? d.charge ?? d.payment_intent, d.amount_cents, d.currency];
  });

async function webhooks() {
  part("A sale whose amount or currency cannot be read is never sent as $0 in usd");
  for (const [label, broken] of [
    ["no amount", without(checkout(2), "amount_total")],
    ["an amount in text", checkout(2, { amount_total: "4900" })],
    ["a negative amount", checkout(2, { amount_total: -1 })],
    ["no currency", without(checkout(2), "currency")],
    ["a currency that is not one", checkout(2, { currency: "US Dollar" })],
    ["discount details that cannot be read", checkout(2, { total_details: { amount_discount: "100" } })],
  ] as const) {
    const store = await setup(["sale.completed"]);
    // A readable sale before it, and one after: the one before is sent, the broken one waits, and so does what comes after it.
    events = [completed(3, checkout(3)), completed(2, broken), completed(1, checkout(1))];
    await watchStripe(Date.now() + 10_000);
    is(`${label}: only the readable sale before it is sent, with what Stripe said`, await amountsOf(store, "sale.completed"), [[checkout(1).id, 4900, "usd"]]);
    is(`${label}: said in the log as our code's, read again next run`, said.some((line) => line.includes("OUR CODE") && line.includes(HANDLE)), true);
  }

  part("A sale without discount details says its discount is not known");
  {
    const store = await setup(["sale.completed"]);
    events = [completed(1, without(checkout(1), "total_details"))];
    await watchStripe(Date.now() + 10_000);
    const sent = await recentMessages(store, "sale.completed", 5);
    is("sent, with discount_cents null (as /api/v1/sales), never 0", sent.map((m) => [(m.data as Record<string, unknown>).amount_cents, (m.data as Record<string, unknown>).discount_cents]), [[4900, null]]);
  }

  part("A membership's first payment, the same");
  {
    const store = await setup(["sale.completed", "membership.started"]);
    events = [completed(1, without(checkout(1, { mode: "subscription", subscription: "sub_Member01" }), "currency"))];
    await watchStripe(Date.now() + 10_000);
    is("neither the sale nor the membership goes out with a guessed currency", [(await recentMessages(store, "sale.completed")).length, (await recentMessages(store, "membership.started")).length], [0, 0]);
  }

  part("An offer after paying, a refund and a dispute, the same");
  {
    const store = await setup(["sale.completed"]);
    const upsell = (n: number, extra: Record<string, unknown> = {}) => ({ id: `evt_Up${n}`, type: "payment_intent.succeeded", created: 1_790_001_000 + n, data: { object: { id: `pi_Up${n}`, object: "payment_intent", amount: 2900, currency: "usd", receipt_email: "b@example.com", metadata: { kind: "upsell", store: HANDLE, product: "p_more" }, ...extra } } });
    events = [upsell(2, { amount: null }), upsell(1)];
    await watchStripe(Date.now() + 10_000);
    is("an offer whose amount cannot be read is not sent as $0", await amountsOf(store, "sale.completed"), [["pi_Up1", 2900, "usd"]]);
  }
  {
    const store = await setup(["refund.issued"]);
    const refund = (n: number, extra: Record<string, unknown> = {}) => ({ id: `evt_Ref${n}`, type: "charge.refunded", created: 1_790_002_000 + n, data: { object: { id: `ch_Ref${n}`, object: "charge", payment_intent: `pi_Ref${n}`, amount: 4900, amount_refunded: 4900, refunded: true, currency: "eur", metadata: { store: HANDLE, product: "p_course" }, ...extra }, previous_attributes: { amount_refunded: 0 } } });
    events = [refund(3, { amount: "4900" }), refund(2, { currency: undefined }), refund(1)];
    await watchStripe(Date.now() + 10_000);
    is("a refund whose amount or currency cannot be read is not sent", await amountsOf(store, "refund.issued"), [["ch_Ref1", 4900, "eur"]]);
  }
  {
    const store = await setup(["dispute.opened"]);
    intents.pi_Disp1 = { store: HANDLE, product: "p_course" };
    intents.pi_Disp2 = { store: HANDLE, product: "p_course" };
    const dispute = (n: number, extra: Record<string, unknown> = {}) => ({ id: `evt_Disp${n}`, type: "charge.dispute.created", created: 1_790_003_000 + n, data: { object: { id: `dp_${n}`, object: "dispute", charge: `ch_D${n}`, payment_intent: `pi_Disp${n}`, amount: 4900, currency: "usd", reason: "fraudulent", status: "needs_response", evidence_details: { due_by: 1_791_000_000 }, metadata: {}, ...extra } } });
    events = [dispute(2, { amount: 4900.5 }), dispute(1)];
    await watchStripe(Date.now() + 10_000);
    is("a dispute whose amount cannot be read is not sent", await amountsOf(store, "dispute.opened"), [["dp_1", 4900, "usd"]]);
  }
}

async function calls() {
  part("A paid booking whose amount or currency cannot be read makes the reading unknown");
  const store = await setup([]);
  const booking = (n: number, extra: Record<string, unknown> = {}) => ({
    id: `cs_test_amountcall${String(n).padStart(8, "0")}`,
    object: "checkout.session",
    created: NOW - 3600,
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    amount_total: 9000,
    currency: "usd",
    metadata: { kind: "call", store: HANDLE, product: "p_call", title: "A call", start: String((NOW + 86_400 * n) * 1000), end: String((NOW + 86_400 * n + 1800) * 1000) },
    customer_details: { email: `caller${n}@example.com`, name: `Caller ${n}` },
    payment_intent: { id: `pi_amountcall${n}`, object: "payment_intent", latest_charge: { object: "charge", id: `ch_amountcall${n}`, refunded: false, amount: 9000, amount_refunded: 0, disputed: false } },
    ...extra,
  });
  sessions = [booking(1)];
  is("a readable one: what was paid, in its currency", (await paidCalls(store)).map((c) => [c.amount, c.currency]), [[9000, "usd"]]);
  for (const [label, broken] of [
    ["no amount", without(booking(2), "amount_total")],
    ["an amount in text", booking(2, { amount_total: "9000" })],
    ["no currency", without(booking(2), "currency")],
    ["a currency that is not one", booking(2, { currency: "" })],
  ] as const) {
    sessions = [broken, booking(1)];
    const read = await paidCalls(store).then((rows) => rows.map((c) => [c.session, c.amount, c.currency]), (error: unknown) => (error instanceof StripeListUnreadable ? "unknown" : String(error)));
    is(`${label}: unknown, never a booking paid 0 or in the store's currency`, read, "unknown");
  }
  // A checkout that is not a booking of this store is not asked for its amount.
  sessions = [without(booking(3, { metadata: { kind: "tip", store: HANDLE } }), "amount_total"), booking(1)];
  is("a checkout that is not a booking is not read for it", (await paidCalls(store)).length, 1);
}

async function tips() {
  part("A gift whose amount or currency cannot be read is never thanked for $0.00");
  const store = await setup([]);
  const id = `cs_test_${"t".repeat(24)}`;
  const gift = { id, status: "complete", payment_status: "paid", amount_total: 500, currency: "usd", metadata: { store: HANDLE, kind: "tip" } };
  single = gift;
  is("a readable one: thanked, with what Stripe took", await readTip(store, id), { state: "paid", amount: 500, currency: "usd" });
  for (const [label, broken] of [
    ["no amount", without(gift, "amount_total")],
    ["an amount in text", { ...gift, amount_total: "500" }],
    ["no currency", without(gift, "currency")],
    ["a currency that is not one", { ...gift, currency: "dollars" }],
  ] as const) {
    single = broken;
    is(`${label}: nothing confirmed, no figure`, await readTip(store, id), { state: "waiting" });
  }
}

async function main() {
  await webhooks();
  await calls();
  await tips();
  console.error = logged;
  done();
}

main().catch((error: unknown) => {
  console.error = logged;
  console.error(error);
  process.exit(1);
});
