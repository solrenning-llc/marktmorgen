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
import { claimHandle, ensureStatsId, ensureStoreId, moveAccount, ownerKey, setSubscription, storeForEmail, storeRef } from "@/lib/store";
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

  part("A legacy home store whose address has capitals: its mark moves with it (Codex X6's LOW on #3752)");
  const LEGACY = "owner-legacy@movepause.example";
  const LEGACY_SHOWN = "Owner-Legacy@MovePause.example";
  const LEGACY_NEW = "owner-legacy-new@movepause.example";
  await claimHandle(LEGACY, "movepauselegacy", "Move Pause Legacy", "");
  const ownerOf = await ownerKey(LEGACY);
  const record = JSON.parse(String((await pipeline([["GET", ownerOf]]))[0])) as Record<string, unknown>;
  await pipeline([["SET", ownerOf, JSON.stringify({ ...record, email: LEGACY_SHOWN })]]);
  const legacyRef = storeRef((await storeForEmail(LEGACY))!);
  is("(the record keeps the address with its capitals, so its ref has them)", legacyRef, LEGACY_SHOWN);
  await pipeline([["SET", `nl:pause:last:${legacyRef}`, String(NOW - 30 * DAY), "EX", 335 * DAY]]);
  const legacyMoved = await moveAccount(LEGACY, LEGACY_NEW);
  const legacyAfter = (await pipeline([["EXISTS", `nl:pause:last:${legacyRef}`], ["GET", `nl:pause:last:${LEGACY_NEW}`]])) as unknown[];
  is("the move went through", legacyMoved.ok, true);
  is("the mark is at the new address", legacyAfter[1], String(NOW - 30 * DAY));
  is("and none is left at the old ref", legacyAfter[0], 0);

  part("The mark keeps its own end across a slow move (Codex X6's LOW on #3752)");
  const SLOW = "owner-slow@movepause.example";
  const SLOW_NEW = "owner-slow-new@movepause.example";
  await claimHandle(SLOW, "movepauseslow", "Move Pause Slow", "");
  await pipeline([["SET", `nl:pause:last:${SLOW}`, String(NOW - 30 * DAY), "EX", 335 * DAY]]);
  const WAIT_MS = 1_200;
  let readLeft: number | null = null;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answer = await pipeline(commands);
    if (readLeft === null && commands.length === 2 && commands[0][0] === "GET" && commands[0][1] === `nl:pause:last:${SLOW}` && commands[1][0] === "PTTL") {
      readLeft = Number((answer as unknown[])[1]);
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    }
    return answer;
  }) as typeof redis.pipeline;
  const slowMoved = await moveAccount(SLOW, SLOW_NEW);
  redis.pipeline = pipeline;
  const leftNow = Number((await pipeline([["PTTL", `nl:pause:last:${SLOW_NEW}`]]))[0]);
  is("the move went through", slowMoved.ok, true);
  is(`(the mark was read with ${readLeft} ms left, then the move took ${WAIT_MS} ms)`, readLeft !== null && readLeft > 0, true);
  is("the mark at the new address ends no later than it did at the old one", readLeft !== null && leftNow <= readLeft - WAIT_MS, true);
  is("and it is still there, with almost all its time", leftNow > 335 * DAY * 1000 - 60_000, true);
  done();
}
void main();
