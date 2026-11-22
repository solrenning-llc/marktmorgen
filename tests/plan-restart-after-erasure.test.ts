/**
 * Codex L-20261120-1741 (HIGH, money and erasure; #5010 row 58): the end of a break (lib/plan-pause.ts runBreaks)
 * reads the store, then, after awaits, starts its plan again with a POST /subscriptions charged at once (lib/billing.ts
 * restartPlan). A store whose erasure began in between (its erasing mark, lib/store.ts ERASING_KEY, written by
 * prepareStore before anything is deleted) still got that POST: a new paid subscription and its charge on a store being
 * erased, while setSubscription then refused to write it down, so nothing kept its id to reconcile it.
 *
 * Now restartPlan asks `beforePost` right before each POST (lib/inbox.ts contactStoreLive: the erasing mark absent, the
 * id key still the store's own, read in one step without writing). A store not read live gets no POST: its break and
 * its due entry are kept untouched, the creator is not told anything, and the erasure deletes them with the store.
 * Synthetic store, Stripe and Redis stand-in only.
 */
import { ERASING_KEY, claimHandle, ensureStatsId, ensureStoreId, erasingField, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { pauseOf, pausePlan, runBreaks } from "@/lib/plan-pause";
import { PLAN_PRICES } from "@/lib/plan";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_restart_erasure_only";
process.env.RESEND_API_KEY = "re_test_plan_pause_only";

const DAY = 86_400;
const NOW = 1_791_700_000;
const emails: string[] = [];
const subs: Record<string, Record<string, unknown>> = {};
let created = 0;
/** Run once, on the price lookup that comes after the store was read and before the POST. */
let onPriceRead: (() => Promise<void>) | null = null;

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
    if (url.pathname.startsWith("/v1/prices") || url.pathname.startsWith("/v1/products")) {
      const run = onPriceRead;
      onPriceRead = null;
      if (run) await run();
      if (url.pathname === "/v1/prices" && method === "POST") {
        const body = new URLSearchParams(String(init?.body ?? ""));
        return new Response(JSON.stringify({ id: "price_creator_month", unit_amount: Number(body.get("unit_amount")), currency: body.get("currency"), recurring: { interval: body.get("recurring[interval]"), interval_count: Number(body.get("recurring[interval_count]")) } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: "price_creator_month", lookup_key: "nimbus_labs_creator_month", active: true, unit_amount: 2900, recurring: { interval: "month" } }], has_more: false, id: "price_creator_month" }), { status: 200 });
    }
    if (url.pathname === "/v1/subscriptions" && method === "POST") {
      created += 1;
      const body = new URLSearchParams(String(init?.body ?? ""));
      const now = Math.floor(Date.now() / 1000);
      const fresh = subscription("sub_Restarted00001", {
        start_date: NOW, trial_end: null, customer: { id: body.get("customer"), email: "x@example.com" },
        items: { data: [{ current_period_start: now - 60, current_period_end: now + 30 * DAY, quantity: 1, price: { id: body.get("items[0][price]"), lookup_key: "nimbus_labs_creator_month", currency: "usd", unit_amount: PLAN_PRICES.creator.month, recurring: { interval: "month", interval_count: 1 } } }] },
      });
      subs.sub_Restarted00001 = fresh;
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
    emails.push(String(JSON.parse(String(init?.body ?? "{}")).subject ?? ""));
    return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

/** A store on a monthly plan, on a break that has ended: its paid period over, as cancelling leaves it. */
async function onBreakDue(email: string, handle: string, sub: string) {
  subs[sub] = subscription(sub);
  await claimHandle(email, handle, "A store", "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  await setSubscription(email, { customerId: "cus_TestPause0001", subscriptionId: sub, active: true, tier: "creator", cycle: "month" });
  const store = (await storeForEmail(email))!;
  const set = await pausePlan(store, 1, NOW);
  if (set.kind !== "paused") throw new Error(`no break: ${JSON.stringify(set)}`);
  await setSubscription(email, { active: false });
  return { store: (await storeForEmail(email))!, until: set.record.until };
}

async function main() {
  part("A store whose erasure begins after the store was read and before the POST gets no new plan and no charge");
  {
    const { store, until } = await onBreakDue("restart-erasing@example.com", "restarterasing", "sub_RestartErase1");
    created = 0;
    emails.length = 0;
    // The erasure marks the store (prepareStore) while the worker looks up the plan's price (first here: the price is
    // then kept in the process, lib/billing.ts ensurePrice, so the control below does not look it up again).
    onPriceRead = async () => { await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]]); };
    const counts = await runBreaks(until + 60);
    is("no POST /subscriptions: nothing is started or charged", created, 0);
    is("nothing restarted", counts.restarted, 0);
    is("the break is kept for the erasure to delete with the store", (await pauseOf(store)) !== null, true);
    is("and the creator of a store being erased is told nothing", emails, []);
  }
  part("Control: a live store's plan starts again on the day");
  {
    const { until } = await onBreakDue("restart-live@example.com", "restartlive", "sub_RestartLive01");
    created = 0;
    const counts = await runBreaks(until + 60);
    is("started again, one POST", [counts.restarted, created], [1, 1]);
  }

  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
