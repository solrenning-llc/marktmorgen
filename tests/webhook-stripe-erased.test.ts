/**
 * Stripe-read webhook events name no buyer whose data was deleted from the store (R38): refund.issued, and the
 * other Stripe events that name a buyer (sale.completed, membership.started, an offer's sale.completed and
 * membership.canceled; rule 30). The deletion is the store's own print (lib/suppression.ts, nl:erased:), written
 * by every deletion, the team's or the person's own (lib/person-erasure.ts), before anything is deleted. A print
 * written at or after the payment sends the event with no address and no name; a person deleted before they paid
 * again is named as before; a print that is there but not in its exact shape (CX-123 rule 24) sends no address
 * either, the event itself still sent; and a read with no answer sends nothing yet: the event is read again next
 * run and named from what that read says (review of #3491). Only a store whose endpoints hear the event pays the
 * read. The PayPal sibling is lib/paypal-delivery.ts (#3449). Synthetic Stripe
 * answers only; the endpoint's name resolves to a private address, so nothing leaves this machine.
 */
import { addEndpoint, recentMessages, setSendHooksForTests, watchStripe } from "@/lib/webhooks";
import { claimHandle, ensureListId, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { suppressCommand, suppressedKey, suppressionPrint } from "@/lib/suppression";
import { paidPeriod } from "./billing-period-fixture";
import { WEBHOOK_ERASED_READ_COMMANDS } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_stripe_erased_only";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const account = "acct_StripeErased01";
const HANDLE = "stripe-erased-shop";
const OWNER = "stripe-erased@example.com";

let timeline: Record<string, unknown>[] = [];
const customers: Record<string, string> = {};
const intents: Record<string, Record<string, string>> = {};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  if (url.origin !== "https://api.stripe.com" || init?.method !== "GET" || headers.get("Stripe-Account") !== account) throw new Error(`unexpected synthetic operation ${url}`);
  if (url.pathname === "/v1/events") {
    const before = url.searchParams.get("ending_before");
    const at = before ? timeline.findIndex((e) => e.id === before) : -1;
    const rows = (at >= 0 ? timeline.slice(at + 1) : timeline).slice().reverse();
    return Response.json({ data: rows, has_more: false });
  }
  const intent = url.pathname.match(/^\/v1\/payment_intents\/(pi_\w+)$/)?.[1];
  if (intent && intents[intent]) return Response.json({ id: intent, object: "payment_intent", metadata: intents[intent] });
  const customer = url.pathname.match(/^\/v1\/customers\/(cus_\w+)$/)?.[1];
  if (customer && customers[customer]) return Response.json({ id: customer, object: "customer", email: customers[customer] });
  return Response.json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } }, { status: 404 });
}) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] } });
const logged = console.error;
console.error = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  if (line.startsWith("a webhook delivery failed")) return;
  logged(...args);
};

/** Replies the store's deletion hash gives for one print, in a shape that is not a time or nothing. */
const oddReplies = new Map<string, unknown>();
/** Prints whose read fails outright (the pipeline throws). */
const failingPrints = new Set<string>();
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const odd = commands.find((c) => c[0] === "HGET" && String(c[1]).startsWith("nl:erased:") && (oddReplies.has(String(c[2])) || failingPrints.has(String(c[2]))));
  if (odd && failingPrints.has(String(odd[2]))) throw new Error("synthetic: the read had no answer");
  const replies = await pipeline(commands);
  return commands.map((c, i) => (c[0] === "HGET" && String(c[1]).startsWith("nl:erased:") && oddReplies.has(String(c[2])) ? oddReplies.get(String(c[2])) : replies[i]));
}) as typeof redis.pipeline;

const PAID = 1_790_000_000;
const evt = (id: string, type: string, created: number, object: Record<string, unknown>, previous?: Record<string, unknown>) =>
  ({ id, type, created, data: { object, ...(previous ? { previous_attributes: previous } : {}) } });
const refund = (id: string, email: string, created: number | undefined = PAID) => ({
  id, object: "charge", ...(created === undefined ? {} : { created }), payment_intent: `pi_${id}`, amount: 2900, amount_refunded: 2900, refunded: true, currency: "usd",
  metadata: { store: HANDLE, product: "p_course" }, billing_details: { email, name: `Name of ${email}` }, receipt_email: email,
});
const buyerOf = async (type: "refund.issued" | "sale.completed" | "membership.started" | "membership.canceled", key: string, id: string) => {
  const found = (await recentMessages((await storeForEmail(OWNER))!, type, 50)).find((m) => (m.data as Record<string, unknown>)[key] === id);
  return found ? (found.data as { buyer: Record<string, unknown> }).buyer : "not sent";
};

let listId = "";
async function setup(listen: string[]) {
  redis.clear();
  oddReplies.clear();
  failingPrints.clear();
  await claimHandle(OWNER, HANDLE, "Stripe Erased", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, account);
  await setSubscription(OWNER, { customerId: "cus_StripeErasedSetup", subscriptionId: "sub_StripeErasedSetup", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  listId = store.listId as string;
  is("an endpoint listening for them is kept", (await addEndpoint(store, "https://hooks.example.net/in", listen)).ok, true);
}
/** The store's deletion print for this address, written at `seconds` (the same command erasePerson writes first). */
const erase = (email: string, seconds: number) => redis.pipeline([suppressCommand(listId, email, seconds)]);

async function main() {
  part("refund.issued: no address and no name for a person deleted at or after the payment");
  await setup(["refund.issued"]);
  await erase("gone@example.com", PAID + 100);
  await erase("same@example.com", PAID);
  await erase("before@example.com", PAID - 100);
  timeline = [
    evt("evt_RfGone", "charge.refunded", PAID + 200, refund("ch_gone", "gone@example.com")),
    evt("evt_RfSame", "charge.refunded", PAID + 210, refund("ch_same", "same@example.com")),
    evt("evt_RfKept", "charge.refunded", PAID + 220, refund("ch_kept", "kept@example.com")),
    evt("evt_RfBefore", "charge.refunded", PAID + 230, refund("ch_before", "before@example.com")),
    evt("evt_RfNoTime", "charge.refunded", PAID + 240, refund("ch_notime", "gone@example.com", undefined)),
  ];
  await watchStripe(Date.now() + 10_000);
  is("deleted after the payment: sent, with no address and no name", await buyerOf("refund.issued", "charge", "ch_gone"), { email: null, name: null });
  is("deleted in the second of the payment: the same", await buyerOf("refund.issued", "charge", "ch_same"), { email: null, name: null });
  is("a charge whose time does not read, its person deleted: the same", await buyerOf("refund.issued", "charge", "ch_notime"), { email: null, name: null });
  is("never deleted: named as before", await buyerOf("refund.issued", "charge", "ch_kept"), { email: "kept@example.com", name: "Name of kept@example.com" });
  is("deleted before they paid again: named as before", await buyerOf("refund.issued", "charge", "ch_before"), { email: "before@example.com", name: "Name of before@example.com" });
  const gone = (await recentMessages((await storeForEmail(OWNER))!, "refund.issued", 50)).find((m) => (m.data as { charge: string }).charge === "ch_gone")!.data as Record<string, unknown>;
  is("the rest of the refund is unchanged", [gone.amount_refunded_cents, gone.total_refunded_cents, gone.fully_refunded, (gone.product as { id: string }).id], [2900, 2900, true, "p_course"]);
  is("the address appears nowhere in what is kept for the endpoint", JSON.stringify(await recentMessages((await storeForEmail(OWNER))!, "refund.issued", 50)).includes("gone@example.com"), false);

  part("refund.issued: a deletion print that does not read exactly sends no address (rule 24)");
  // At most RECENT_MESSAGES_MAX messages are read back, so the shapes are sent in two runs of a few each.
  const shapes: [string, unknown][] = [["number", PAID + 5], ["words", "soon"], ["empty", ""], ["list", ["1"]], ["object", { at: 1 }], ["negative", "-5"], ["decimal", "1.5"], ["long", "1".repeat(13)]];
  for (const [half, from, to] of [[0, 0, 4], [1, 4, shapes.length]] as const) {
    await setup(["refund.issued"]);
    timeline = shapes.slice(from, to).map(([name, reply], j) => {
      const email = `odd-${name}@example.com`;
      oddReplies.set(suppressionPrint(listId, email), reply);
      return evt(`evt_RfOdd${from + j}`, "charge.refunded", PAID + 300 + from + j, refund(`ch_odd${from + j}`, email));
    });
    timeline.push(evt(`evt_RfHealthy${half}`, "charge.refunded", PAID + 410 + half, refund(`ch_healthy${half}`, `healthy${half}@example.com`)));
    await watchStripe(Date.now() + 10_000);
    for (let i = from; i < to; i += 1) {
      is(`a print read as ${shapes[i][0]}: sent, with no address and no name`, await buyerOf("refund.issued", "charge", `ch_odd${i}`), { email: null, name: null });
    }
    is("a healthy read in the same run, nobody deleted: named as before", await buyerOf("refund.issued", "charge", `ch_healthy${half}`), { email: `healthy${half}@example.com`, name: `Name of healthy${half}@example.com` });
  }

  part("A read with no answer sends nothing yet: the next run reads it again and names the buyer (review of #3491)");
  for (const [name, broken] of [["the pipeline throws", (print: string) => failingPrints.add(print)], ["no reply in the slot", (print: string) => oddReplies.set(print, undefined)]] as const) {
    await setup(["refund.issued"]);
    const email = `flaky-${name.replace(/\W+/g, "-")}@example.com`;
    broken(suppressionPrint(listId, email));
    timeline = [evt("evt_RfFlaky", "charge.refunded", PAID + 450, refund("ch_flaky", email))];
    await watchStripe(Date.now() + 10_000);
    is(`${name}: not sent in this run, so nothing goes out without a known read`, await buyerOf("refund.issued", "charge", "ch_flaky"), "not sent");
    failingPrints.clear();
    oddReplies.clear();
    await watchStripe(Date.now() + 10_000);
    is(`${name}, then a healthy read next run, never deleted: named`, await buyerOf("refund.issued", "charge", "ch_flaky"), { email, name: `Name of ${email}` });
    is(`${name}: sent once`, (await recentMessages((await storeForEmail(OWNER))!, "refund.issued", 50)).length, 1);
  }
  await setup(["refund.issued"]);
  await erase("flaky-gone@example.com", PAID + 100);
  failingPrints.add(suppressionPrint(listId, "flaky-gone@example.com"));
  timeline = [evt("evt_RfFlakyGone", "charge.refunded", PAID + 460, refund("ch_flaky_gone", "flaky-gone@example.com"))];
  await watchStripe(Date.now() + 10_000);
  failingPrints.clear();
  await watchStripe(Date.now() + 10_000);
  is("a read with no answer, then a healthy read of a deletion: no address and no name", await buyerOf("refund.issued", "charge", "ch_flaky_gone"), { email: null, name: null });

  part("The other Stripe events that name a buyer (rule 30)");
  await setup(["sale.completed", "membership.started", "membership.canceled"]);
  await erase("sale-gone@example.com", PAID + 50);
  await erase("sub-gone@example.com", PAID + 50);
  await erase("offer-gone@example.com", PAID + 50);
  await erase("member-gone@example.com", PAID + 50);
  const session = (id: string, email: string, mode = "payment", extra: Record<string, unknown> = {}) => ({
    id, object: "checkout.session", created: PAID, status: "complete", payment_status: "paid", mode, amount_total: 4900, currency: "usd",
    metadata: { store: HANDLE, product: "p_course" }, customer_details: { email, name: `Name of ${email}` }, ...extra,
  });
  const offer = (id: string, email: string) => ({ id, object: "payment_intent", created: PAID, amount: 1900, currency: "usd", receipt_email: email, metadata: { store: HANDLE, kind: "upsell", product: "p_offer" } });
  const ending = (id: string, customer: string) => ({ id, object: "subscription", created: PAID, start_date: PAID, customer, cancel_at_period_end: true, current_period_end: PAID + 86_400 * 30, metadata: { store: HANDLE, product: "p_member" } });
  customers.cus_MemberGone = "member-gone@example.com";
  customers.cus_MemberKept = "member-kept@example.com";
  timeline = [
    evt("evt_SaleGone", "checkout.session.completed", PAID + 60, session("cs_Gone01", "sale-gone@example.com")),
    evt("evt_SaleKept", "checkout.session.completed", PAID + 70, session("cs_Kept01", "sale-kept@example.com")),
    evt("evt_SubGone", "checkout.session.completed", PAID + 80, session("cs_SubGone01", "sub-gone@example.com", "subscription", { subscription: "sub_Gone01" })),
    evt("evt_OfferGone", "payment_intent.succeeded", PAID + 90, offer("pi_OfferGone", "offer-gone@example.com")),
    evt("evt_OfferKept", "payment_intent.succeeded", PAID + 95, offer("pi_OfferKept", "offer-kept@example.com")),
    evt("evt_EndGone", "customer.subscription.updated", PAID + 100, ending("sub_EndGone", "cus_MemberGone"), { cancel_at_period_end: false }),
    evt("evt_EndKept", "customer.subscription.updated", PAID + 110, ending("sub_EndKept", "cus_MemberKept"), { cancel_at_period_end: false }),
  ];
  await watchStripe(Date.now() + 10_000);
  is("a sale whose person was deleted after paying: no address and no name", await buyerOf("sale.completed", "checkout_session", "cs_Gone01"), { email: null, name: null });
  is("a sale nobody deleted: named as before", await buyerOf("sale.completed", "checkout_session", "cs_Kept01"), { email: "sale-kept@example.com", name: "Name of sale-kept@example.com" });
  is("a membership's sale and its start: no address and no name", [await buyerOf("sale.completed", "checkout_session", "cs_SubGone01"), await buyerOf("membership.started", "checkout_session", "cs_SubGone01")], [{ email: null, name: null }, { email: null, name: null }]);
  is("an offer's sale whose person was deleted: no address", await buyerOf("sale.completed", "payment_intent", "pi_OfferGone"), { email: null, name: null });
  is("an offer's sale nobody deleted: named as before", await buyerOf("sale.completed", "payment_intent", "pi_OfferKept"), { email: "offer-kept@example.com", name: null });
  is("a cancellation whose member was deleted: no address, the customer's id kept", await buyerOf("membership.canceled", "subscription", "sub_EndGone"), { email: null, customer: "cus_MemberGone" });
  is("a cancellation nobody deleted: named as before", await buyerOf("membership.canceled", "subscription", "sub_EndKept"), { email: "member-kept@example.com", customer: "cus_MemberKept" });

  part("One read of the print an event, on the store's own deletion hash");
  await setup(["refund.issued"]);
  const reads: unknown[][] = [];
  const counting = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const c of commands) if (String(c[1] ?? "").startsWith("nl:erased:")) reads.push(c);
    return counting(commands);
  }) as typeof redis.pipeline;
  timeline = [evt("evt_RfOne", "charge.refunded", PAID + 500, refund("ch_one", "one@example.com"))];
  await watchStripe(Date.now() + 10_000);
  redis.pipeline = counting;
  is("one HGET of this address's print, nothing written", reads, [["HGET", suppressedKey(listId), suppressionPrint(listId, "one@example.com")]]);
  is("as many as the webhook unit counts (tests/plan-cost-registry.ts)", reads.length, WEBHOOK_ERASED_READ_COMMANDS);

  part("No read when no endpoint hears the event (rule 26, review of #3491)");
  await setup(["refund.issued"]);
  reads.length = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const c of commands) if (String(c[1] ?? "").startsWith("nl:erased:")) reads.push(c);
    return counting(commands);
  }) as typeof redis.pipeline;
  timeline = [
    evt("evt_UnheardSale", "checkout.session.completed", PAID + 600, session("cs_Unheard01", "unheard@example.com")),
    evt("evt_UnheardSub", "checkout.session.completed", PAID + 610, session("cs_UnheardSub01", "unheard-sub@example.com", "subscription", { subscription: "sub_Unheard01" })),
    evt("evt_UnheardOffer", "payment_intent.succeeded", PAID + 620, offer("pi_UnheardOffer", "unheard-offer@example.com")),
    evt("evt_UnheardEnd", "customer.subscription.updated", PAID + 630, ending("sub_UnheardEnd", "cus_MemberKept"), { cancel_at_period_end: false }),
  ];
  await watchStripe(Date.now() + 10_000);
  redis.pipeline = counting;
  is("a store that hears only refunds: no read for a sale, a membership, an offer or a cancellation", reads, []);
  is("and nothing sent for them", (await recentMessages((await storeForEmail(OWNER))!, "sale.completed", 50)).length, 0);

  console.error = logged;
  done();
}

void main();
