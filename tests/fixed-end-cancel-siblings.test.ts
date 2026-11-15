/**
 * Once a member can cancel a membership sold as a number of payments
 * (tests/fixed-end-cancel.test.ts), what reads its end has to tell the end
 * that was sold from a cancellation (rule 30, the same misreading elsewhere):
 * the membership.canceled event and its reason ("completed" only at the sold
 * end), "Why members leave" (lib/membership-numbers.ts) and the member health
 * list's "set to end" (lib/member-health.ts). The end that was sold stays
 * what it was: no event, no leaving, not "ending".
 */
import { addPeriods } from "@/lib/plans";
import { readSub } from "@/lib/membership-numbers";
import { scoreMembers } from "@/lib/member-health";
import { addEndpoint, recentMessages, setSendHooksForTests, watchStripe } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_fixed_end_siblings_only";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const account = "acct_FixedEndSib01";
const HANDLE = "fixed-end-shop";
let events: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || init?.method !== "GET") throw new Error(`unexpected synthetic operation ${url}`);
  if (url.pathname === "/v1/events") return Response.json({ data: events, has_more: false });
  return Response.json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } }, { status: 404 });
}) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] } });
const logged = console.error;
console.error = (...args: unknown[]) => (String(args[0]).startsWith("a webhook delivery failed") ? undefined : logged(...args));

const ANCHOR = 1_790_000_000;
const SOLD = addPeriods(ANCHOR, "month", 12);
const PERIOD_END = addPeriods(ANCHOR, "month", 3);
const item = { data: [{ id: "si_1", quantity: 1, current_period_end: PERIOD_END, price: { id: "price_m", unit_amount: 900, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] };
const fixed = (id: string, extra: Record<string, unknown>) => ({
  id,
  object: "subscription",
  status: "active",
  currency: "usd",
  customer: "cus_Fixed0001",
  start_date: ANCHOR - 7 * 86_400,
  billing_cycle_anchor: ANCHOR,
  trial_end: ANCHOR,
  items: item,
  metadata: { store: HANDLE, product: "p_member", ends_after: "12", ends_interval: "month" },
  ...extra,
});

async function main() {
  redis.clear();
  await claimHandle("fixed-end@example.com", HANDLE, "Fixed End", "");
  await ensureStatsId("fixed-end@example.com");
  await setStripeAccount("fixed-end@example.com", account);
  await setSubscription("fixed-end@example.com", { customerId: "cus_FixedOwner1", subscriptionId: "sub_FixedOwner01", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail("fixed-end@example.com"))!;
  is("an endpoint listening", (await addEndpoint(store, "https://hooks.example.net/in", ["membership.canceled"])).ok, true);

  part("membership.canceled: the sold end is not one, moving it earlier is");
  events = [
    { id: "evt_Sold", type: "customer.subscription.updated", created: 1_790_000_100, data: { object: fixed("sub_Sold0001", { cancel_at: SOLD }), previous_attributes: { cancel_at: null } } },
    { id: "evt_Early", type: "customer.subscription.updated", created: 1_790_000_200, data: { object: fixed("sub_Early001", { cancel_at: PERIOD_END, canceled_at: 1_790_000_200 }), previous_attributes: { cancel_at: SOLD } } },
  ];
  await watchStripe(Date.now() + 10_000);
  let sent = (await recentMessages(store, "membership.canceled", 20)).map((m) => m.data as { subscription: string; status: string; reason: string });
  is("only the early stop is a cancellation", sent.map((d) => [d.subscription, d.status]), [["sub_Early001", "ending"]]);

  part("membership.canceled when it ends: completed only at the sold end");
  redis.clear();
  await claimHandle("fixed-end@example.com", HANDLE, "Fixed End", "");
  await ensureStatsId("fixed-end@example.com");
  await setStripeAccount("fixed-end@example.com", account);
  await setSubscription("fixed-end@example.com", { customerId: "cus_FixedOwner1", subscriptionId: "sub_FixedOwner01", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const again = (await storeForEmail("fixed-end@example.com"))!;
  await addEndpoint(again, "https://hooks.example.net/in", ["membership.canceled"]);
  events = [
    { id: "evt_EndSold", type: "customer.subscription.deleted", created: 1_790_000_300, data: { object: fixed("sub_EndSold1", { status: "canceled", cancel_at: SOLD, ended_at: SOLD, cancellation_details: { reason: "cancellation_requested" } }) } },
    { id: "evt_EndEarly", type: "customer.subscription.deleted", created: 1_790_000_400, data: { object: fixed("sub_EndEarly", { status: "canceled", cancel_at: PERIOD_END, ended_at: PERIOD_END, cancellation_details: { reason: "cancellation_requested" } }) } },
  ];
  await watchStripe(Date.now() + 10_000);
  sent = (await recentMessages(again, "membership.canceled", 20)).map((m) => m.data as { subscription: string; status: string; reason: string });
  const reasons = Object.fromEntries(sent.map((d) => [d.subscription, d.reason]));
  is("sold end: completed; stopped early: cancellation_requested", [reasons.sub_EndSold1, reasons.sub_EndEarly], ["completed", "cancellation_requested"]);

  part("Why members leave");
  const handles = new Set([HANDLE]);
  const soldRead = readSub(fixed("sub_Sold0001", { cancel_at: SOLD, canceled_at: ANCHOR - 7 * 86_400, cancellation_details: { reason: "cancellation_requested" } }) as never, handles)!;
  is("the sold end is not somebody leaving", [soldRead.canceledAt, soldRead.cancelCause], [0, ""]);
  const earlyRead = readSub(
    fixed("sub_Early001", { cancel_at: PERIOD_END, canceled_at: ANCHOR - 7 * 86_400, cancellation_details: { reason: "cancellation_requested" }, metadata: { store: HANDLE, product: "p_member", ends_after: "12", ends_interval: "month", cancel_requested_at: String(ANCHOR + 40 * 86_400) } }) as never,
    handles,
  )!;
  is("stopped early: leaving, counted from when the member asked", [earlyRead.canceledAt, earlyRead.cancelCause], [ANCHOR + 40 * 86_400, "cancellation_requested"]);
  const unread = readSub(fixed("sub_Unread01", { billing_cycle_anchor: undefined, trial_end: undefined, cancel_at: PERIOD_END, canceled_at: 5 }) as never, handles)!;
  is("a sold end that cannot be read: as before, not leaving", unread.canceledAt, 0);

  part("Member health: set to end");
  const rows = [
    fixed("sub_Sold0001", { cancel_at: SOLD, customer: { email: "sold@example.com" } }),
    fixed("sub_Early001", { cancel_at: PERIOD_END, customer: { email: "early@example.com" } }),
  ];
  const scored = await scoreMembers(again, rows as never, ANCHOR * 1000 + 30 * 86_400_000);
  const ending = Object.fromEntries(scored.map((r) => [r.email, r.factors.some((f) => f.reason === "ending")]));
  is("sold end: not ending; stopped early: ending", [ending["sold@example.com"], ending["early@example.com"]], [false, true]);
  done();
}

void main();
