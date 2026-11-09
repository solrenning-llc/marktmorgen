/**
 * A subscription status Stripe does not have is Stripe not read, never a
 * membership that ended or is gone (Claude 5, round 30 sibling of #2912's
 * readableSub: Stripe's eight subscription statuses, the list lib/billing.ts
 * and lib/member-health.ts read). Checked, each against its control with a
 * status Stripe has:
 *
 *   - the creator's buyer page (lib/buyer-profile.ts) says Stripe could not
 *     be read, and lists no membership as "Ended";
 *   - Stripe's own "paused" status is shown as paused, not as ended;
 *   - a member switching tier, moving to yearly or pausing
 *     (lib/tier-switch.ts, lib/yearly-switch.ts, lib/membership-pause.ts,
 *     all through subsOf in lib/membership-manage.ts) is told something went
 *     wrong, never that the membership is gone or cannot be changed.
 */
import { buyerProfile } from "@/lib/buyer-profile";
import { requestManageLink } from "@/lib/membership-manage";
import { previewSwitch } from "@/lib/tier-switch";
import { previewYearly } from "@/lib/yearly-switch";
import { pauseMembership } from "@/lib/membership-pause";
import * as stripeAccount from "@/lib/stripe-account";
import { addProduct, claimHandle, ensureStatsId, setPauseMonths, setProductLink, setStoreTiers, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const UNKNOWN = "upgraded_v2";
const emails: { text: string }[] = [];

// What the member's subscription says, and the buyer page's checkout's.
let memberStatus = "active";
let tierA = "";
let profileSub: Record<string, unknown> = {};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown) => new Response(JSON.stringify(v));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return json({ id: "e" });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(init?.body ? String(init.body) : "");
  if (method === "GET" && path === "/checkout/sessions") {
    return json({
      object: "list",
      has_more: false,
      data: [
        {
          id: "cs_test_club0000000001",
          mode: "subscription",
          status: "complete",
          payment_status: "paid",
          created: NOW - 40 * DAY,
          amount_total: 1500,
          currency: "usd",
          customer: "cus_club000001",
          customer_details: { email: "buyer@example.com" },
          payment_intent: null,
          subscription: profileSub,
          metadata: { store: "bakery", product: "club1", title: "Bakers' Club" },
        },
      ],
    });
  }
  if (method === "GET" && path === "/charges") return json({ object: "list", data: [], has_more: false });
  if (method === "GET" && path === "/customers") return json({ object: "list", data: [{ id: "cus_Member0001", created: 1 }], has_more: false });
  if (method === "GET" && path === "/customers/cus_Member0001") return json({ id: "cus_Member0001", email: "dana@example.com" });
  if (method === "GET" && path === "/subscriptions") {
    return json({
      object: "list",
      has_more: false,
      data: [
        {
          id: "sub_Member0001",
          status: memberStatus,
          customer: "cus_Member0001",
          created: NOW - 90 * DAY,
          start_date: NOW - 90 * DAY,
          trial_end: null,
          discount: null,
          discounts: [],
          pause_collection: null,
          metadata: { store: "harbor", product: tierA },
          items: { data: [{ id: "si_Member0001", quantity: 1, current_period_end: NOW + 10 * DAY, price: { unit_amount: 1000, currency: "usd", metadata: {}, recurring: { interval: "month", interval_count: 1 } } }] },
        },
      ],
    });
  }
  if (method === "POST" && path === "/prices") {
    return json({ id: "price_Made00000001", object: "price", active: true, currency: body.get("currency"), unit_amount: Number(body.get("unit_amount")), recurring: { interval: body.get("recurring[interval]"), interval_count: 1 }, metadata: {} });
  }
  if (method === "POST" && path === "/invoices/create_preview") {
    const at = Number(body.get("subscription_details[proration_date]"));
    return json({
      currency: "usd",
      starting_balance: 0,
      lines: { object: "list", has_more: false, data: [{ amount: 500, parent: { subscription_item_details: { proration: true } }, period: { start: at } }] },
    });
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

function bakery(): Store {
  const products = [{ id: "club1", title: "Bakers' Club", course: null, options: [] }];
  return {
    sid: "sidbake00001",
    handle: "bakery",
    name: "Oven Notes",
    email: "baker@example.com",
    previousHandles: [],
    releasedHandles: [],
    statsId: "b".repeat(32),
    listId: null,
    callsId: null,
    currency: "usd",
    language: "en",
    stripeAccountId: "acct_test_profile1",
    pastBuyers: false,
    catalog: { id: null, head: [], items: products.map((p) => ({ id: p.id, kind: 0, options: [] })), inline: products },
  } as unknown as Store;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_sub_status_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

  part("One list of Stripe's subscription statuses");
  is(
    "the eight Stripe has, read where every reader takes them from",
    [...(((stripeAccount as Record<string, unknown>).SUBSCRIPTION_STATUSES as Iterable<string> | undefined) ?? [])].sort(),
    ["active", "canceled", "incomplete", "incomplete_expired", "past_due", "paused", "trialing", "unpaid"],
  );

  part("The creator's buyer page");
  const shop = bakery();
  profileSub = { id: "sub_club1", status: "canceled", start_date: NOW - 40 * DAY, ended_at: NOW - DAY };
  const ended = await buyerProfile(shop, "buyer@example.com");
  is("control: Stripe's canceled is shown as ended, and Stripe was read", [ended.stripeError, ended.memberships.map((m) => m.status)], [false, ["ended"]]);
  profileSub = { id: "sub_club1", status: "paused", start_date: NOW - 40 * DAY };
  const paused = await buyerProfile(shop, "buyer@example.com");
  is("Stripe's own paused status is shown as paused, not ended", [paused.stripeError, paused.memberships.map((m) => m.status)], [false, ["paused"]]);
  profileSub = { id: "sub_club1", status: UNKNOWN, start_date: NOW - 40 * DAY };
  const unknown = await buyerProfile(shop, "buyer@example.com");
  is("a status Stripe does not have: Stripe not read, no membership said to have ended", [unknown.stripeError, unknown.memberships.map((m) => m.status)], [true, []]);
  profileSub = { id: "sub_club1", start_date: NOW - 40 * DAY };
  const missing = await buyerProfile(shop, "buyer@example.com");
  is("no status at all: the same", [missing.stripeError, missing.memberships.map((m) => m.status)], [true, []]);

  part("A member's own changes");
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const monthly = { interval: "month" as const, trialDays: 0, payments: 0 };
  const a = await addProduct(OWNER, "Basic", "", "10", monthly);
  const b = await addProduct(OWNER, "Pro", "", "20", monthly);
  if (!a.ok || !b.ok) throw new Error("no products");
  await setProductLink(OWNER, a.product.id, "https://example.com/basic");
  await setProductLink(OWNER, b.product.id, "https://example.com/pro");
  tierA = a.product.id;
  await setStoreTiers(OWNER, [a.product.id, b.product.id]);
  await setPauseMonths(OWNER, 2);
  const store = (await storeForEmail(OWNER))!;
  is("the member's link is emailed", await requestManageLink({ store, email: "dana@example.com", ip: "203.0.113.9", origin: "https://marktmorgen.com" }), "sent");
  const token = /token=([0-9a-f]{64})/.exec(emails.at(-1)!.text)![1];

  memberStatus = "active";
  const running = await previewSwitch(store, token, "sub_Member0001", b.product.id);
  is("control: a running membership can be switched", running.ok ? "ok" : running.reason, "ok");

  memberStatus = "canceled";
  const reasons = async () => {
    const tier = await previewSwitch(store, token, "sub_Member0001", b.product.id);
    const yearly = await previewYearly(store, token, "sub_Member0001");
    const pause = await pauseMembership(store, token, "sub_Member0001", 1, NOW);
    return [tier.ok ? "ok" : tier.reason, yearly.ok ? "ok" : yearly.reason, pause.ok ? "ok" : pause.reason];
  };
  is("control: Stripe's canceled is gone, gone and cannot be paused", await reasons(), ["gone", "gone", "cannot"]);

  memberStatus = UNKNOWN;
  is("a status Stripe does not have: something went wrong, never gone or cannot", await reasons(), ["error", "error", "error"]);

  memberStatus = "";
  is("an empty status: the same", await reasons(), ["error", "error", "error"]);

  done();
}

void main();
