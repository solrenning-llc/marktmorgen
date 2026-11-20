/**
 * The email before the first charge after a free trial, and before a yearly
 * renewal (lib/billing-reminders.ts), when the plan is changed after it went
 * (synthetic).
 *
 * Each notice says the date and the amount that will be charged (Visa's rule
 * for the first charge after a trial; California's for a yearly renewal), and
 * is sent once per charge. "Once" was marked by the subscription and the
 * date alone. A switch inside a trial keeps the trial's end (lib/billing.ts
 * switchPlan, trial_end), and a switch between plans of the same interval
 * keeps the period's end, so after a switch the charge has the same date and
 * a different amount: the mark of the first notice stood for it, and the only
 * notice the creator had named the amount of the plan they left.
 *
 * Now the mark names the plan and the amount too, so a charge whose amount
 * changed is warned of again, with the amount it will be; the same charge is
 * still warned of once.
 */
import { sendReminders } from "@/lib/billing-reminders";
import { lookupKey } from "@/lib/billing";
import { PLAN_PRICES, type Cycle, type Tier } from "@/lib/plan";
import { store as redis } from "./redis-stub";
import { sent as emails } from "./reminder-after-switch-world";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_reminder_switch_only";

const NOW = 1_797_000_000;
const DAY = 86_400;
let trialing: Record<string, unknown>[] = [];
let active: Record<string, unknown>[] = [];

function sub(id: string, status: "trialing" | "active", tier: Tier, cycle: Cycle, endsAt: number): Record<string, unknown> {
  return {
    id, object: "subscription", status, created: NOW - 20 * DAY,
    ...(status === "trialing" ? { trial_start: endsAt - 14 * DAY, trial_end: endsAt } : {}),
    cancel_at: null, cancel_at_period_end: false,
    customer: { id: `cus_${id.slice(4)}`, email: `${id.toLowerCase()}@example.com` },
    metadata: { store: id.slice(4).toLowerCase(), tier },
    items: { data: [{ quantity: 1, current_period_start: endsAt - (cycle === "year" ? 365 : 30) * DAY, current_period_end: endsAt,
      price: { lookup_key: lookupKey(tier, cycle), unit_amount: PLAN_PRICES[tier][cycle], currency: "usd", recurring: { interval: cycle, interval_count: 1 } } }] },
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com" && method === "GET" && url.pathname === "/v1/subscriptions") {
    const data = url.searchParams.get("status") === "trialing" ? trialing : url.searchParams.get("status") === "active" ? active : [];
    return new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US")}`;

async function main() {

  part("A trial notice, then a switch to another plan inside the trial (same trial end)");
  {
    const trialEnd = NOW + 7 * DAY;
    trialing = [sub("sub_TrialSwitch01", "trialing", "creator", "month", trialEnd)];
    const first = await sendReminders(NOW);
    is("the first notice goes, naming the Store plan's monthly amount", [first.sent, emails.at(-1)?.text.includes(money(PLAN_PRICES.creator.month))], [1, true]);
    is("the same charge is not warned of twice", (await sendReminders(NOW + 3600)).sent, 0);
    trialing = [sub("sub_TrialSwitch01", "trialing", "scale", "year", trialEnd)];
    const after = await sendReminders(NOW + DAY);
    is("after the switch, the charge on the same day with a new amount is warned of", after.sent, 1);
    is("and the notice names the amount that will be charged", emails.at(-1)?.text.includes(money(PLAN_PRICES.scale.year)), true);
    is("still once", (await sendReminders(NOW + DAY + 3600)).sent, 0);
  }

  part("A yearly renewal notice, then a switch to another yearly plan (same period end)");
  {
    trialing = [];
    const renews = NOW + 20 * DAY;
    active = [sub("sub_YearSwitch001", "active", "creator", "year", renews)];
    is("the renewal notice goes", (await sendReminders(NOW)).sent, 1);
    active = [sub("sub_YearSwitch001", "active", "scale", "year", renews)];
    const after = await sendReminders(NOW + DAY);
    is("after the switch, the renewal at the new amount is warned of", [after.sent, emails.at(-1)?.text.includes(money(PLAN_PRICES.scale.year))], [1, true]);
  }
  part("A notice marked before the plan was in its mark still counts for its date");
  {
    active = [];
    const trialEnd = NOW + 6 * DAY;
    trialing = [sub("sub_LegacyMark0001", "trialing", "creator", "month", trialEnd)];
    await redis.pipeline([["SET", `nl:remind:trial:sub_LegacyMark0001:${trialEnd}`, "1", "EX", 60 * DAY]]);
    is("no second notice for a charge already warned of", (await sendReminders(NOW)).sent, 0);
  }
  done();
}

void main();
