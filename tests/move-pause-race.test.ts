/**
 * A break taken while the store's address moves is never left at the old address (Codex X5's MEDIUM on #3752, confirmed
 * by Claude 2 cloud I). moveAccount (lib/store.ts) holds the store's lock and reads, once, whether a break is set
 * (closingUnderway) and the once-a-year mark (breakYearAt); pausePlan (lib/plan-pause.ts) took no lock, so a break
 * written between those reads and the move's last write stayed at the old ref: the daily run could not find the store
 * any more (the plan, already set to stop at the period's end, was never started again), and the new address had no
 * once-a-year mark. Now a break is taken, and taken back, under the same store lock, on the store read afresh under it.
 * Real code with the stand-in Redis; Stripe simulated; the break is asked for right after the move reads the mark.
 */
import { pausePlan } from "@/lib/plan-pause";
import { claimHandle, ensureStatsId, ensureStoreId, moveAccount, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const SUB = "sub_MovePauseRace01";
const subs: Record<string, Record<string, unknown>> = {
  [SUB]: {
    id: SUB, status: "active", customer: "cus_MovePauseRace1", default_payment_method: "pm_MovePauseRace1",
    cancel_at: null, cancel_at_period_end: false, start_date: NOW - 100 * DAY, trial_end: NOW - 86 * DAY,
    items: { data: [{ current_period_end: NOW + 10 * DAY, price: { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } } }] },
  },
};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const m = url.pathname.match(/^\/v1\/subscriptions\/(sub_[A-Za-z0-9]+)$/);
  if (url.hostname === "api.stripe.com" && m && subs[m[1]]) {
    if ((init?.method ?? "GET") === "POST") {
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (body.has("cancel_at_period_end")) subs[m[1]].cancel_at_period_end = body.get("cancel_at_period_end") === "true";
    }
    return new Response(JSON.stringify(subs[m[1]]), { status: 200 });
  }
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ error: { message: "no route" } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_move_pause_race_only";
  const OLD = "owner@movepause.example";
  const NEW = "owner-new@movepause.example";
  await claimHandle(OLD, "movepauserace", "Move Pause Race", "");
  await ensureStatsId(OLD);
  await ensureStoreId(OLD);
  await setSubscription(OLD, { customerId: "cus_MovePauseRace1", subscriptionId: SUB, active: true, tier: "creator", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(OLD))!;
  const oldRef = storeRef(store);

  part("A break asked for between the move's read of the mark and its last write");
  const pipeline = redis.pipeline.bind(redis);
  let asked: string = "not asked";
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answer = await pipeline(commands);
    if (asked === "not asked" && commands.length === 2 && commands[0][0] === "GET" && commands[0][1] === `nl:pause:last:${oldRef}` && commands[1][0] === "PTTL") {
      asked = "asking";
      asked = await pausePlan(store, 1, NOW).then((r) => r.kind === "paused" ? "paused" : `refused ${r.reason}`, (error: Error) => `threw ${error.name}`);
    }
    return answer;
  }) as typeof redis.pipeline;
  const moved = await moveAccount(OLD, NEW);
  redis.pipeline = pipeline;
  const left = (await pipeline([["EXISTS", `nl:pause:${oldRef}`], ["EXISTS", `nl:pause:last:${oldRef}`], ["ZSCORE", "nl:pause:due", oldRef]])) as unknown[];
  const atNew = (await pipeline([["EXISTS", `nl:pause:${NEW}`], ["EXISTS", `nl:pause:last:${NEW}`]])) as unknown[];
  const orphaned = moved.ok && (left[0] === 1 || left[1] === 1 || left[2] !== null);
  is(`(the break was asked for in the window: ${asked})`, asked !== "not asked", true);
  is("no break is left at the old address of a store that moved", orphaned, false);
  is("a store that moved with no break at its new address has no stop scheduled at the provider", moved.ok && atNew[0] !== 1 ? subs[SUB].cancel_at_period_end : false, false);
  done();
}
void main();
