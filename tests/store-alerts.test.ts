/**
 * Alerts on a store's numbers, and each sale in the team's chat
 * (lib/store-alerts.ts, lib/sale-events.ts; added 12 October 2026). Checked:
 *
 *   - each rule, from the store's own usual level: visits that fell away,
 *     sales from visits that fell while visits held, refunds piling up, the
 *     month's goal off pace or reached; and none from a small store's
 *     ordinary quiet days;
 *   - said once a day at most, each kind once a week (the goal once a month),
 *     by email, in the chat where asked for, and never by email once the
 *     numbers emails are stopped;
 *   - each sale posted to the chat where asked for: the amount, what and from
 *     where, never who.
 */
import { type AlertInput, alertPaymentFigures, alertsFrom, checkAlerts, poissonAtLeast, poissonAtMost } from "@/lib/store-alerts";
import { setChatAddress } from "@/lib/chat-summary";
import { setSalesGoal } from "@/lib/sales-goal";
import { setWeeklyOff } from "@/lib/stats-report";
import { noteSales } from "@/lib/sale-events";
import { claimHandle, ensureStatsId, setChatSales, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_store_alerts_stand_in";
process.env.RESEND_API_KEY = "re_test_store_alerts_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "owner@example.com";
const SLACK = "https://hooks.slack.com/services/T000/B000/abcdefghijklmnop";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 12);
const posted: string[] = [];
const emails: { to: string; subject: string; text: string }[] = [];
let sessions: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.hostname === "hooks.slack.com") {
    posted.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return new Response("ok", { status: 200 });
  }
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    emails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return json({ id: `email_${emails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return json({ object: "list", data: sessions, has_more: false });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** `n` days ending today (today last), each with `visitors(i)` people; i = 0 is the oldest. */
function daysOf(n: number, visitors: (i: number) => number): AlertInput["days"] {
  return Array.from({ length: n }, (_, i) => {
    const date = new Date(NOW - (n - 1 - i) * DAY).toISOString().slice(0, 10);
    const v = visitors(i);
    return { date, views: v, visitors: v, checkouts: 0 };
  });
}

const base = (over: Partial<AlertInput>): AlertInput => ({
  name: "Harbor",
  currency: "usd",
  days: [],
  salesByDay: {},
  refunds7: 0,
  refunds90: 0,
  goal: 0,
  moneyByDay: {},
  today: new Date(NOW).toISOString().slice(0, 10),
  ...over,
});

async function main(): Promise<void> {
  redis.clear();

  part("Chance, as counts have it");
  is("none when about one is usual is ordinary", poissonAtMost(0, 1) > 0.3, true);
  is("3 when 30 are usual is not", poissonAtMost(3, 30) < 0.001, true);
  is("6 refunds when half of one is usual is not", poissonAtLeast(6, 0.5) < 0.01, true);

  part("Visits that fell away");
  // 40 days: 50 a day, then the last 3 full days (before today) at 10.
  const fell = daysOf(40, (i) => (i >= 36 && i <= 38 ? 10 : 50));
  is("said, with the numbers", alertsFrom(base({ days: fell })).map((a) => [a.kind, a.title]), [["traffic", "Harbor: visits fell to 30 in 3 days"]]);
  is("not for a store with a handful a day", alertsFrom(base({ days: daysOf(40, (i) => (i >= 36 && i <= 38 ? 0 : 5)) })).length, 0);
  is("today, still going, does not count", alertsFrom(base({ days: daysOf(40, (i) => (i === 39 ? 0 : 50)) })).length, 0);

  part("Sales from visits that fell, while visits held");
  const steady = daysOf(40, () => 100);
  const sold = (perDay: (i: number) => number) => Object.fromEntries(steady.map((d, i) => [d.date, { sales: perDay(i), cents: perDay(i) * 2000 }]));
  const dropped = alertsFrom(base({ days: steady, salesByDay: sold((i) => (i >= 32 && i <= 38 ? 0 : 3)) }));
  is("said when the last 7 days sold none at a rate of 3 a day", dropped.map((a) => a.kind), ["conversion"]);
  is("with the rate before and after", dropped[0].lines[0].includes("700 visitors and 0 sales (0.0%)") && dropped[0].lines[0].includes("(3.0%)"), true);
  is("not when sales dipped by chance", alertsFrom(base({ days: steady, salesByDay: sold((i) => (i >= 32 && i <= 38 ? 2 : 3)) })).length, 0);

  part("Refunds piling up");
  is("6 in a week, where 2 in a season is usual", alertsFrom(base({ refunds7: 6, refunds90: 8 })).map((a) => a.title), ["Harbor: 6 refunds in 7 days"]);
  is("not 3 where 3 a week is usual", alertsFrom(base({ refunds7: 3, refunds90: 40 })).length, 0);

  part("Unavailable payment readings");
  is("missing sales do not imply a conversion drop", alertsFrom(base({ days: steady, salesByDay: null })).length, 0);
  is("traffic remains available without money readings", alertsFrom(base({ days: fell, salesByDay: null, refunds7: null, refunds90: null, moneyByDay: null })).map(a => a.kind), ["traffic"]);
  is("unknown historical refunds do not imply a spike", alertsFrom(base({ refunds7: 6, refunds90: null })).length, 0);
  is("unknown recent refunds do not imply zero", alertsFrom(base({ refunds7: null, refunds90: 8 })).length, 0);
  const fixture = { partial: false, byDay: {}, channelDays: {}, paymentsComplete: true, cashflowComplete: true, refundsIn: { d7: [], d30: [], d90: [] } } as Parameters<typeof alertPaymentFigures>[0];
  is("confirmed empty readings stay zero", alertPaymentFigures(fixture), { salesByDay: {}, refunds7: 0, refunds90: 0 });
  is("capped purchase reading blocks conversion and refunds", alertPaymentFigures({ ...fixture, partial: true }), { salesByDay: null, refunds7: null, refunds90: null });
  is("failed refunds preserve complete purchase figures", alertPaymentFigures({ ...fixture, cashflowComplete: false }), { salesByDay: {}, refunds7: null, refunds90: null });
  is("missing refund records stay unavailable", alertPaymentFigures({ ...fixture, refundsIn: undefined }), { salesByDay: {}, refunds7: null, refunds90: null });
  is("incomplete renewals block refund comparison", alertPaymentFigures({ ...fixture, paymentsComplete: false }), { salesByDay: {}, refunds7: null, refunds90: null });
  is("legacy unconfirmed coverage blocks refunds", alertPaymentFigures({ ...fixture, paymentsComplete: undefined, cashflowComplete: undefined }), { salesByDay: {}, refunds7: null, refunds90: null });

  part("The month's goal");
  const money = (perDay: number, upTo: number) => Object.fromEntries(Array.from({ length: upTo }, (_, i) => [`2026-10-${String(i + 1).padStart(2, "0")}`, perDay]));
  is("off pace on the 20th", alertsFrom(base({ goal: 300_000, moneyByDay: money(5_000, 20) })).map((a) => [a.kind, a.title]), [["goal-pace", "Harbor: October 2026 is on pace for $1,550 of $3,000"]]);
  is("reached", alertsFrom(base({ goal: 50_000, moneyByDay: money(5_000, 20) })).map((a) => a.kind), ["goal-reached"]);
  is("nothing before the 10th", alertsFrom(base({ goal: 300_000, moneyByDay: money(1_000, 5), today: "2026-10-05" })).length, 0);

  part("Said once, where the creator asked for it");
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  let store = (await storeForEmail(OWNER))!;
  await setChatAddress(store.statsId!, "Harbor Kitchen", SLACK);
  await setChatSales(OWNER, true);
  store = (await storeForEmail(OWNER))!;
  posted.length = 0;
  const paid = (id: string, daysAgo: number, cents: number, meta: Record<string, string> = {}) => ({
    id,
    status: "complete",
    payment_status: "paid",
    amount_total: cents,
    currency: "usd",
    created: Math.floor((Date.now() - daysAgo * DAY) / 1000),
    customer_details: { email: "buyer@example.com", name: "Pat Buyer" },
    metadata: { store: "harbor", product: "nope", title: "Weeknight Club", channel: "instagram", ...meta },
  });
  sessions = [paid("cs_test_goal0000000001", 0, 60_000)];
  await setSalesGoal(store.statsId!, 50_000, "usd");
  const first = await checkAlerts(store);
  is("the goal reached, said once", first.said, 1);
  is("by email", emails.map((e) => [e.to, e.subject.startsWith("Harbor Kitchen reached its $500 goal")]), [[OWNER, true]]);
  is("and in the chat", posted.some((p) => p.startsWith("Harbor Kitchen reached its $500 goal")), true);
  is("once a day", (await checkAlerts(store)).skipped, true);
  is("and once a month", (await checkAlerts(store, Date.now() + DAY)).said, 0);
  await redis.pipeline([["DEL", `nl:alert:${store.statsId}:goal-reached:${new Date().toISOString().slice(0, 7)}`]]);
  await setWeeklyOff(store, true);
  emails.length = 0;
  await checkAlerts(store, Date.now() + 2 * DAY);
  is("never by email once the numbers emails are stopped", emails.length, 0);
  await setWeeklyOff(store, false);

  part("Each sale in the chat");
  posted.length = 0;
  await noteSales(store, [paid("cs_test_sale0000000001", 0, 2900)]);
  is("the amount, what and from where, never who", posted, ["New sale on Harbor Kitchen: $29, Weeknight Club (from Instagram)"]);
  await noteSales(store, [paid("cs_test_sale0000000001", 0, 2900)]);
  is("once", posted.length, 1);
  await setChatSales(OWNER, false);
  store = (await storeForEmail(OWNER))!;
  await noteSales(store, [paid("cs_test_sale0000000002", 0, 2900)]);
  is("not when switched off", posted.length, 1);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
