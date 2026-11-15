/**
 * Issue #4659 (money, HIGH): a definitive cancel whose break deletion is not
 * confirmed must never let the old break restart the cancelled plan and
 * charge the creator. Reproduction transcribed from the issue (Claude 2 on
 * main @e4dbb5e9bf): dropPause under a Redis pipeline that throws, answers []
 * or [null] without applying the deletion, then runBreaks at the break's end.
 * RED on main: no veto exists. Dormant while PLAN_BREAKS_ENABLED is false.
 * The fix waits for lib/plan-pause.ts's reservation (Codex A3, codex/a3-restart-contract, #2435).
 */
import { claimHandle, setSubscription, storeForEmail } from "@/lib/store";
import { dropPause, pauseOf, pausePlan, runBreaks } from "@/lib/plan-pause";
import { done, is, part } from "./check";
import { PLAN_PRICES } from "@/lib/plan";
import { store as pauseRedis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_pause_only";
process.env.RESEND_API_KEY = "re_test_plan_pause_only";

const DAY = 86_400;
const NOW = 1_791_700_000;
const emails: { to: string; subject: string; text: string }[] = [];
const subs: Record<string, Record<string, unknown>> = {};
const created: URLSearchParams[] = [];
let providerCalls = 0;
const keepScheduledStop = false;
const refuseScheduledStop = false;
const loseScheduledStopAck = false;
let scheduledStopWrites = 0;
let beforeRestartAnswer: (() => Promise<void>) | null = null;
const createAnswer: "ok" | "declined" | "down" | "otherCustomer" | "otherTier" | "yearly" | "trial" | "pastDue" | "otherPrice" | "amount" | "currency" | "intervalCount" | "extraItem" | "intervalMismatch" | "quantity" | "missingQuantity" | "missingPeriod" | "expiredPeriod" | "futurePeriod" | "fractionPeriod" | "longPeriod" = "ok";

function subscription(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: "active",
    customer: "cus_TestPause0001",
    default_payment_method: "pm_TestCard00001",
    cancel_at: null,
    cancel_at_period_end: false,
    start_date: NOW - 100 * DAY,
    trial_end: NOW - 86 * DAY,
    items: {
      data: [
        {
          current_period_end: NOW + 10 * DAY,
          price: { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } },
        },
      ],
    },
    ...over,
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com") {
    providerCalls++;
    if (url.pathname === "/v1/prices" && method === "POST") {
      const body = new URLSearchParams(String(init?.body ?? ""));
      return new Response(JSON.stringify({
        id: "price_creator_month", unit_amount: Number(body.get("unit_amount")),
        currency: body.get("currency"),
        recurring: { interval: body.get("recurring[interval]"), interval_count: Number(body.get("recurring[interval_count]")) },
      }), { status: 200 });
    }
    if (url.pathname === "/v1/prices" || url.pathname.startsWith("/v1/prices/search") || url.pathname.startsWith("/v1/products")) {
      return new Response(JSON.stringify({ data: [{ id: "price_creator_month", lookup_key: "nimbus_labs_creator_month", active: true, unit_amount: 2900, recurring: { interval: "month" } }], has_more: false, id: "price_creator_month" }), { status: 200 });
    }
    if (url.pathname === "/v1/subscriptions" && method === "POST") {
      const body = new URLSearchParams(String(init?.body ?? ""));
      created.push(body);
      if (createAnswer === "declined") return new Response(JSON.stringify({ error: { code: "card_declined", message: "Your card was declined." } }), { status: 402 });
      if (createAnswer === "down") return new Response(JSON.stringify({ error: { type: "api_error", message: "down" } }), { status: 500 });
      const freshPrice = {
        id: body.get("items[0][price]"), lookup_key: "nimbus_labs_creator_month",
        currency: "usd", unit_amount: PLAN_PRICES.creator.month,
        recurring: { interval: "month", interval_count: 1 },
      };
      if (createAnswer === "otherPrice") freshPrice.id = "price_NotRequested01";
      if (createAnswer === "amount") freshPrice.unit_amount += 1;
      if (createAnswer === "currency") freshPrice.currency = "eur";
      if (createAnswer === "intervalCount") freshPrice.recurring.interval_count = 2;
      if (createAnswer === "intervalMismatch") freshPrice.recurring.interval = "year";
      const observedNow = Math.floor(Date.now() / 1000);
      const items: { current_period_start?: number; current_period_end: number; price: typeof freshPrice; quantity?: number }[] = [{ current_period_start: observedNow - 60, current_period_end: observedNow + 30 * DAY, price: freshPrice, quantity: 1 }];
      if (createAnswer === "missingPeriod") delete items[0].current_period_start;
      if (createAnswer === "expiredPeriod") { items[0].current_period_start = observedNow - 2 * DAY; items[0].current_period_end = observedNow; }
      if (createAnswer === "futurePeriod") { items[0].current_period_start = observedNow + DAY; items[0].current_period_end = observedNow + 2 * DAY; }
      if (createAnswer === "fractionPeriod") items[0].current_period_start = observedNow - 0.5;
      if (createAnswer === "longPeriod") items[0].current_period_end = observedNow + 32 * DAY;
      if (createAnswer === "quantity") items[0].quantity = 2;
      if (createAnswer === "missingQuantity") delete items[0].quantity;
      if (createAnswer === "extraItem") items.push({ ...items[0] });
      const fresh = subscription("sub_Restarted00001", {
        start_date: NOW, trial_end: null,
        customer: { id: body.get("customer"), email: "x@example.com" },
        items: { data: items },
      });
      if (createAnswer === "otherCustomer") fresh.customer = { id: "cus_OtherRestart01", email: "other@example.com" };
      if (createAnswer === "otherTier" || createAnswer === "yearly") {
        fresh.items = { data: [{ current_period_end: NOW + 10 * DAY, price: {
          lookup_key: createAnswer === "otherTier" ? "nimbus_labs_pro_month" : "nimbus_labs_creator_year",
          unit_amount: createAnswer === "otherTier" ? 44900 : 69000,
          recurring: { interval: createAnswer === "yearly" ? "year" : "month" },
        } }] };
      }
      if (createAnswer === "trial") { fresh.status = "trialing"; fresh.trial_end = NOW + DAY; }
      if (createAnswer === "pastDue") fresh.status = "past_due";
      subs.sub_Restarted00001 = fresh;
      const pendingStoreChange = beforeRestartAnswer;
      beforeRestartAnswer = null;
      if (pendingStoreChange) await pendingStoreChange();
      return new Response(JSON.stringify(fresh), { status: 200 });
    }
    const m = url.pathname.match(/^\/v1\/subscriptions\/(sub_[A-Za-z0-9]+)$/);
    if (m && subs[m[1]]) {
      if (method === "POST") {
        const body = new URLSearchParams(String(init?.body ?? ""));
        if (body.get("cancel_at_period_end") === "true") scheduledStopWrites++;
        if (body.has("cancel_at_period_end") && !(keepScheduledStop && body.get("cancel_at_period_end") === "false") && !(refuseScheduledStop && body.get("cancel_at_period_end") === "true")) subs[m[1]].cancel_at_period_end = body.get("cancel_at_period_end") === "true";
      }
      if (loseScheduledStopAck && method === "POST") throw new Error("synthetic lost scheduled-stop acknowledgement");
      return new Response(JSON.stringify(subs[m[1]]), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: `no route ${method} ${url.pathname}` } }), { status: 404 });
  }
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    emails.push({ to: Array.isArray(body.to) ? body.to[0] : body.to, subject: body.subject, text: body.text });
    return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function storeWith(email: string, handle: string, sub: string) {
  await claimHandle(email, handle, "A store", "");
  await setSubscription(email, { customerId: "cus_TestPause0001", subscriptionId: sub, active: true, tier: "creator", cycle: "month" });
  return (await storeForEmail(email))!;
}

async function main() {
  for (const mode of ["throws", "lost-ack", "null-ack"] as const) {
    part(`A definite cancel whose pause deletion is unconfirmed (${mode}) never lets the old break restart the plan`);
    const id = `sub_CancelVeto${mode.replace(/\W/g, "").slice(0, 8)}`;
    subs[id] = subscription(id);
    const store = await storeWith(`cancel-${mode}@example.com`, `cancelveto${mode.replace(/\W/g, "")}`, id);
    const set = await pausePlan(store, 1, NOW);
    if (set.kind !== "paused") throw new Error("fixture: no break was set");
    const until = set.record.until;
    // The route's sequence for intent=cancel: the provider confirms cancel_at_period_end, then dropPause, whose error the route only logs.
    const pipeline = pauseRedis.pipeline;
    pauseRedis.pipeline = (async () => {
      if (mode === "throws") throw new Error("synthetic Redis failure");
      return mode === "lost-ack" ? [] : [null];
    }) as typeof pauseRedis.pipeline;
    try {
      await dropPause(store).catch(() => undefined);
    } finally {
      pauseRedis.pipeline = pipeline;
    }
    is("the break record is still there (deletion not applied)", (await pauseOf(store)) !== null, true);
    // The paid period ends: the plan has stopped, as cancelling leaves it.
    await setSubscription(`cancel-${mode}@example.com`, { active: false });
    created.length = 0;
    const counts = await runBreaks(until + 60);
    is("the worker does not start the cancelled plan again", [counts.restarted, created.length], [0, 0]);
  }
  done();
}

void main();
