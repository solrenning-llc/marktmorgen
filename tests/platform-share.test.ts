/**
 * The share of each sale (lib/platform-share.ts) and the daily job that keeps
 * what was taken to what is owed (lib/share-settle.ts), built on October 12,
 * 2026 ahead of the switch that turns it on. Run with the switch passed in as
 * on, against a stand-in for Stripe. What is checked:
 *
 *   - who owes a share, and how much: by plan, never in the free trial, never
 *     for a store that subscribed before the share, never once a plan ends;
 *   - the fee set on a checkout is the share of the least the buyer can pay,
 *     so it can never be more than the payment, and a membership carries the
 *     plan's percentage;
 *   - the job gives back the part of a fee above the share of what was paid
 *     after a discount and the tax, the share of a refund, all of it after a
 *     lost dispute and all of it on a payment made inside the trial; it never
 *     raises a fee, and running it twice gives back nothing twice;
 *   - a store's memberships are moved to its plan's percentage when it changes.
 */
import {
  SHARING_INDEX,
  applyShare,
  applyShareToPayment,
  leastPaid,
  linesTotal,
  owedOn,
  planShareBps,
  shareBps,
  toGiveBack,
} from "@/lib/platform-share";
import { settleShares } from "@/lib/share-settle";
import { claimHandle, setStripeAccount, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { COUNTRIES } from "@/lib/stripe-connect";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const NOW = 1_800_000_000;
const ON = true;

type Fee = { id: string; account: string; charge: string; amount: number; amount_refunded: number; currency: string; created: number };
const fees = new Map<string, Fee>();
const charges = new Map<string, Record<string, unknown>>();
const sessions = new Map<string, Record<string, unknown>>();
const events: Record<string, unknown>[] = [];
const subscriptions: Record<string, unknown>[] = [];
const gaveBack: { fee: string; amount: number }[] = [];
const updated: { id: string; percent: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  const account = headers.get("Stripe-Account");
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (!account) {
    if (method === "GET" && path === "/application_fees") {
      const since = Number(url.searchParams.get("created[gte]")) || 0;
      return json({ object: "list", data: [...fees.values()].filter((f) => f.created >= since), has_more: false });
    }
    const one = path.match(/^\/application_fees\/([^/]+)$/);
    if (one && method === "GET") return fees.has(one[1]) ? json(fees.get(one[1])) : json({ error: { message: "No such fee" } }, 404);
    const back = path.match(/^\/application_fees\/([^/]+)\/refunds$/);
    if (back && method === "POST") {
      const fee = fees.get(back[1])!;
      const amount = Number(new URLSearchParams(String(init?.body)).get("amount"));
      fee.amount_refunded += amount;
      gaveBack.push({ fee: fee.id, amount });
      return json({ id: `fr_Refund${fee.id.replace(/^fee_/, "")}0001`, object: "fee_refund", amount, fee: fee.id, currency: fee.currency });
    }
  } else {
    const charge = path.match(/^\/charges\/([^/]+)$/);
    if (charge && method === "GET") return json(charges.get(charge[1]) ?? {});
    if (path === "/disputes" && method === "GET") {
      const chargeId=url.searchParams.get("charge");
      return json({ object: "list", has_more: false, data: chargeId === "ch_E" ? [{ id: "du_ShareLost01", object: "dispute", charge: chargeId, currency: "usd", status: "lost" }] : [] });
    }
    if (path === "/checkout/sessions" && method === "GET") {
      const found = sessions.get(url.searchParams.get("payment_intent") ?? "");
      return json({ object: "list", data: found ? [found] : [], has_more: false });
    }
    if (path === "/events" && method === "GET") return json({ object: "list", data: events, has_more: false });
    if (path === "/subscriptions/search" && method === "GET") return json({ object: "search_result", data: subscriptions, has_more: false });
    const sub = path.match(/^\/subscriptions\/([^/]+)$/);
    if (sub && method === "POST") {
      const percent = new URLSearchParams(String(init?.body)).get("application_fee_percent") ?? "";
      updated.push({ id: sub[1], percent });
      const row = subscriptions.find((s) => s.id === sub[1]);
      if (row) row.application_fee_percent = Number(percent);
      return json(row ?? {});
    }
  }
  return json({ error: { message: `not stood in for: ${method} ${path}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_share_only_a_stand_in";

  part("Who owes a share, and how much");
  const paying = { shared: true, subscriptionActive: true, trialEnds: 0, tier: "creator" as const };
  is("off, nobody owes anything", shareBps(paying, NOW, false), 0);
  is("Store, Studio and Scale", [shareBps(paying, NOW, ON), shareBps({ ...paying, tier: "pro" }, NOW, ON), shareBps({ ...paying, tier: "scale" }, NOW, ON)], [625, 275, 0]);
  is("nothing in the free trial, nothing before the share, nothing once a plan ends", [
    shareBps({ ...paying, trialEnds: NOW + 60 }, NOW, ON),
    shareBps({ ...paying, shared: false }, NOW, ON),
    shareBps({ ...paying, subscriptionActive: false }, NOW, ON),
  ], [0, 0, 0]);
  is("a membership sold in the trial still carries the plan's rate, settled per payment", planShareBps({ ...paying, trialEnds: NOW + 60 }, ON), 625);

  part("Where a store can be");
  // Stripe: "platforms based outside of Brazil with Brazilian connected
  // accounts can't collect application fees through Stripe" (Collect
  // application fees, read October 12, 2026). No such store can be opened.
  is("no creator can open an account in Brazil, where no share could be taken", COUNTRIES.some((c) => c.code === "br"), false);

  part("The fee set on a checkout");
  const body = new URLSearchParams({
    "line_items[0][quantity]": "2",
    "line_items[0][price_data][unit_amount]": "4900",
    "line_items[1][quantity]": "1",
    "line_items[1][price_data][unit_amount]": "1900",
  });
  is("the lines, before any discount", linesTotal(body), { cents: 11_700, unpriced: [] });
  is("the least the buyer can pay: the largest discount that may come off", [
    leastPaid(10_000, []),
    leastPaid(10_000, [{ kind: "percent", percent: 20 }]),
    leastPaid(10_000, [{ kind: "percent", percent: 20 }, { kind: "cents", cents: 3_000 }]),
    leastPaid(10_000, [{ kind: "percent", percent: 100 }]),
    leastPaid(10_000, [{ kind: "unknown" }]),
  ], [10_000, 8_000, 7_000, 0, 0]);
  const once = new URLSearchParams();
  is("a payment: the share of the least, as a fixed fee, and the rate written on it", [
    applyShare(once, paying, { recurring: false, least: 8_000 }, NOW, ON),
    once.get("payment_intent_data[application_fee_amount]"),
    once.get("payment_intent_data[metadata][share_bps]"),
  ], [500, "500", "625"]);
  const member = new URLSearchParams();
  is("a membership: the plan's percentage, which Stripe works out on each payment", [
    applyShare(member, { ...paying, tier: "pro" }, { recurring: true, least: 0 }, NOW, ON),
    member.get("subscription_data[application_fee_percent]"),
  ], [275, "2.75"]);
  const none = new URLSearchParams();
  is("off, nothing is written at all", [applyShare(none, paying, { recurring: false, least: 8_000 }, NOW, false), [...none.keys()]], [0, []]);
  const offer = new URLSearchParams();
  is("an offer after checkout: its exact amount", [applyShareToPayment(offer, paying, 2_900, NOW, ON), offer.get("application_fee_amount"), offer.get("metadata[share_base]")], [181, "181", "2900"]);

  part("What is owed on a payment");
  is("half refunded, half the share", owedOn({ bps: 625, base: 8_000, amount: 8_400, refunded: 4_200, lostDispute: false }), 250);
  is("a dispute lost, nothing", owedOn({ bps: 625, base: 8_000, amount: 8_400, refunded: 0, lostDispute: true }), 0);
  is("given back is only ever what was taken above it", [toGiveBack({ amount: 625, refunded: 0 }, 500), toGiveBack({ amount: 500, refunded: 0 }, 625)], [125, 0]);

  part("The daily job");
  const OWNER = "maker@example.com";
  await claimHandle(OWNER, "maker", "Maker", "");
  await setStripeAccount(OWNER, "acct_1TestShare00001", true);
  await setSubscription(OWNER, { customerId: "cus_Share000001", subscriptionId: "sub_Share000001", active: true, tier: "creator", cycle: "month", trialEnds: NOW - 10 * 86_400, shared: true, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const ref = storeRef(store);
  is("a store that pays a share is in the list the job reads", (await redisPipeline([["SISMEMBER", SHARING_INDEX, ref]]))[0], 1);
  const A = "acct_1TestShare00001";
  // A: $100 listed, a 20% code typed, $4 of tax: the fee was set on the least ($80, 500) — exact.
  fees.set("fee_A", { id: "fee_A", account: A, charge: "ch_A", amount: 500, amount_refunded: 0, currency: "usd", created: NOW - 3600 });
  charges.set("ch_A", { id: "ch_A", currency: "usd", amount: 8_400, amount_refunded: 0, disputed: false, payment_intent: { id: "pi_A", metadata: { share_bps: "625" } } });
  sessions.set("pi_A", { currency: "usd", amount_total: 8_400, total_details: { amount_tax: 400, amount_shipping: 0 } });
  // B: the box could have taken 50%, nobody typed a code; tax included in the price: the fee was set on $50, paid $100 of which $10 tax.
  fees.set("fee_B", { id: "fee_B", account: A, charge: "ch_B", amount: 312, amount_refunded: 0, currency: "usd", created: NOW - 3600 });
  charges.set("ch_B", { id: "ch_B", currency: "usd", amount: 10_000, amount_refunded: 0, disputed: false, payment_intent: { id: "pi_B", metadata: { share_bps: "625" } } });
  sessions.set("pi_B", { currency: "usd", amount_total: 10_000, total_details: { amount_tax: 1_000, amount_shipping: 0 } });
  // C: a $40 offer after checkout, refunded in full.
  fees.set("fee_C", { id: "fee_C", account: A, charge: "ch_C", amount: 250, amount_refunded: 0, currency: "usd", created: NOW - 3600 });
  charges.set("ch_C", { id: "ch_C", currency: "usd", amount: 4_000, amount_refunded: 4_000, disputed: false, payment_intent: { id: "pi_C", metadata: { share_bps: "625", share_base: "4000" } } });
  // D: a membership's payment made while the store was still in its trial.
  fees.set("fee_D", { id: "fee_D", account: A, charge: "ch_D", amount: 125, amount_refunded: 0, currency: "usd", created: NOW - 3600 });
  charges.set("ch_D", { id: "ch_D", currency: "usd", amount: 2_000, amount_refunded: 0, disputed: false, invoice: { currency: "usd", created: NOW - 20 * 86_400, total_excluding_tax: 2_000, subscription_details: { metadata: { store: "maker", share_bps: "625" } } } });
  // E: a $60 sale whose dispute was lost.
  fees.set("fee_E", { id: "fee_E", account: A, charge: "ch_E", amount: 375, amount_refunded: 0, currency: "usd", created: NOW - 3600 });
  charges.set("ch_E", { id: "ch_E", amount: 6_000, amount_refunded: 0, currency: "usd", disputed: true, payment_intent: { id: "pi_E", metadata: { share_bps: "625", share_base: "6000" } } });
  // F: an old sale, refunded in half yesterday, found through the refund itself.
  fees.set("fee_F", { id: "fee_F", account: A, charge: "ch_F", amount: 625, amount_refunded: 0, currency: "usd", created: NOW - 40 * 86_400 });
  charges.set("ch_F", { id: "ch_F", currency: "usd", amount: 10_000, amount_refunded: 5_000, disputed: false, payment_intent: { id: "pi_F", metadata: { share_bps: "625", share_base: "10000" } } });
  events.push({ id: "evt_F", type: "charge.refunded", data: { object: { id: "ch_F", application_fee: "fee_F" } } });
  // The store's plan was Studio when its memberships were sold; it is Store now.
  await redisPipeline([["HSET", "nl:share:applied", ref, "275"]]);
  subscriptions.push({ id: "sub_M1", status: "active", application_fee_percent: 2.75 }, { id: "sub_M2", status: "canceled", application_fee_percent: 2.75 });

  const first = await settleShares(Date.now() + 60_000, NOW, ON);
  const backOf = (id: string) => gaveBack.filter((g) => g.fee === id).reduce((sum, g) => sum + g.amount, 0);
  is("A: the fee was exactly the share of what was paid, so nothing comes back", backOf("fee_A"), 0);
  is("B: the share of $90 of goods is 562; the fee was 312 on the least, so nothing comes back and nothing is raised", backOf("fee_B"), 0);
  is("C: refunded in full, the whole fee back", backOf("fee_C"), 250);
  is("D: paid inside the trial, the whole fee back", backOf("fee_D"), 125);
  is("E: a dispute lost, the whole fee back", backOf("fee_E"), 375);
  is("F: half refunded, half the share back", backOf("fee_F"), 313);
  is("the live membership moved to the plan's percentage, the canceled one left alone", updated, [{ id: "sub_M1", percent: "6.25" }]);
  is("counted", [first.failed, first.complete, first.memberships], [0, true, 1]);

  const before = gaveBack.length;
  const second = await settleShares(Date.now() + 60_000, NOW, ON);
  is("run again: nothing is given back twice, nothing is moved twice", [gaveBack.length - before, updated.length, second.failed], [0, 1, 0]);

  part("A plan that ends");
  await setSubscription(OWNER, { active: false });
  is("the store leaves the list", (await redisPipeline([["SISMEMBER", SHARING_INDEX, ref]]))[0], 0);
  await settleShares(Date.now() + 60_000, NOW, ON);
  is("and its memberships stop paying a share: no plan, no share", updated.at(-1), { id: "sub_M1", percent: "0.00" });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
