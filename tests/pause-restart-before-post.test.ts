/**
 * #3671, Claude 3's LEVE 5 (6795099064, kept "fix here" in 7106585571): a legacy restart that failed provably
 * BEFORE its only POST (the price lookup, ensurePrice) kept the break held for good, posted nothing ever again and
 * told the creator to "check" a charge that cannot exist. Now the price is read before the attempt is written: a
 * failure there writes no attempt, posts nothing, tells nothing, and the next daily run tries again. A failure
 * after the attempt (the POST itself) is still held and told once, as before (tests/plan-pause.test.ts).
 *
 * Synthetic: the Redis stand-in and a Stripe/Resend stub; nothing real is charged or sent. The price cache of
 * lib/billing.ts is empty at the start of this file, so the first restart really reads /v1/prices.
 */
import { claimHandle, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { pauseOf, pausePlan, runBreaks } from "@/lib/plan-pause";
import { PLAN_PRICES } from "@/lib/plan";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_pause_before_post";
process.env.RESEND_API_KEY = "re_test_plan_pause_before_post";

const DAY = 86_400;
const NOW = 1_791_700_000;
const emails: string[] = [];
const subs: Record<string, Record<string, unknown>> = {};
let posts = 0;
let priceReadsToFail = 0;

function subscription(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, status: "active", customer: "cus_TestPause0001", default_payment_method: "pm_TestCard00001",
    cancel_at: null, cancel_at_period_end: false, start_date: NOW - 100 * DAY, trial_end: NOW - 86 * DAY,
    items: { data: [{ current_period_end: NOW + 10 * DAY, price: { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } } }] },
    ...over,
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com") {
    if (url.pathname === "/v1/prices" && method === "GET") {
      if (priceReadsToFail > 0) { priceReadsToFail -= 1; return new Response(JSON.stringify({ error: { type: "api_error", message: "down" } }), { status: 500 }); }
      return new Response(JSON.stringify({ data: [{ id: "price_creator_month", lookup_key: "nimbus_labs_creator_month", active: true, currency: "usd", unit_amount: PLAN_PRICES.creator.month, recurring: { interval: "month", interval_count: 1 } }], has_more: false }), { status: 200 });
    }
    if (url.pathname === "/v1/subscriptions" && method === "POST") {
      posts += 1;
      const body = new URLSearchParams(String(init?.body ?? ""));
      const observedNow = Math.floor(Date.now() / 1000);
      const price = { id: body.get("items[0][price]"), lookup_key: "nimbus_labs_creator_month", currency: "usd", unit_amount: PLAN_PRICES.creator.month, recurring: { interval: "month", interval_count: 1 } };
      const fresh = subscription("sub_Restarted00002", {
        start_date: NOW, trial_end: null, customer: { id: body.get("customer"), email: "x@example.com" },
        items: { data: [{ current_period_start: observedNow - 60, current_period_end: observedNow + 30 * DAY, price, quantity: 1 }] },
      });
      subs.sub_Restarted00002 = fresh;
      return new Response(JSON.stringify(fresh), { status: 200 });
    }
    const m = url.pathname.match(/^\/v1\/subscriptions\/(sub_[A-Za-z0-9]+)$/);
    if (m && subs[m[1]]) {
      if (method === "POST") {
        const body = new URLSearchParams(String(init?.body ?? ""));
        if (body.has("cancel_at_period_end")) subs[m[1]].cancel_at_period_end = body.get("cancel_at_period_end") === "true";
      }
      return new Response(JSON.stringify(subs[m[1]]), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: `no route ${method} ${url.pathname}` } }), { status: 404 });
  }
  if (url.hostname === "api.resend.com") {
    emails.push(String((JSON.parse(String(init?.body ?? "{}")) as { subject?: string }).subject ?? ""));
    return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  part("A price lookup that fails before the only POST writes no attempt and is tried again the next day");
  subs.sub_BeforePost0001 = subscription("sub_BeforePost0001");
  const email = "beforepost@example.com";
  await claimHandle(email, "beforepoststore", "A store", "");
  await setSubscription(email, { customerId: "cus_TestPause0001", subscriptionId: "sub_BeforePost0001", active: true, tier: "creator", cycle: "month" });
  const store = (await storeForEmail(email))!;
  const set = await pausePlan(store, 1, NOW);
  is("(setup) the break is taken", set.kind, "paused");
  const until = set.kind === "paused" ? set.record.until : 0;
  await setSubscription(email, { active: false });

  priceReadsToFail = 1;
  emails.length = 0;
  const first = await runBreaks(until + 60);
  is("nothing is posted to Stripe", posts, 0);
  is("the run counts it as not done", [first.restarted, first.failed], [0, 1]);
  const raw = String(redis.run(["GET", `nl:pause:${storeRef(store)}`]) ?? "");
  is("no restart attempt is written into the break", raw.includes('"attempt"'), false);
  is("the break is still due on its own date, not held past every batch", redis.run(["ZSCORE", "nl:pause:due", storeRef(store)]), String(until));
  is("the creator is not told to check a charge that cannot exist", emails.filter((s) => s.includes("needs a check")), []);

  const next = await runBreaks(until + DAY);
  is("the next day the plan starts again", next.restarted, 1);
  is("with exactly one POST", posts, 1);
  is("and the break is gone", await pauseOf((await storeForEmail(email))!), null);
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
