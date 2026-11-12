/**
 * Audit R18, finding 1 (synthetic): a dispute of a plan payment that Stripe
 * closes as "prevented" (the money went back to the creator before a
 * chargeback, as lib/plan-refund-rules.ts RETURNED and lib/checkup-rules.ts
 * CLOSED already read it) or as the legacy "charge_refunded" (the charge was
 * refunded) was read by disputeStatusOf() as "open" for ever:
 *
 *   - the store stayed paused (checkout, list emails, AI, uploads, video)
 *     with no end, long after the period the payment covered;
 *   - the daily job kept it as "open:<store>" and re-read it every day, so
 *     MAX_REREADS stuck ones took every re-read slot and an older dispute
 *     really decided later was never read again.
 *
 * Expected: both read as "lost" (the money went back), so they pause to the
 * end of the period the payment covered and are remembered as final. Every
 * other status reads exactly as before; a status Stripe does not document
 * still reads as open (unknown is never "closed" or "won").
 */
import { isPaidUp } from "@/lib/billing";
import { claimHandle, ensureStatsId, recordPlanDispute, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { costPauseCode } from "@/lib/plan-standing";
import { disputeStatusOf } from "@/lib/plan-dispute-rules";
import { MAX_REREADS, SEEN_KEY, syncPlanDisputes } from "@/lib/plan-disputes";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_dispute_closed_only";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const owner = "plan-dispute-closed@example.com";
const handle = "plan-dispute-closed-shop";
const SUB = "sub_PlanDisputeClosed01";
let pages: { data: Record<string, unknown>[]; has_more: boolean }[] = [];
let byId: Record<string, Record<string, unknown>> = {};
const asked: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com") {
    asked.push(`${method} ${url.pathname}`);
    if (method !== "GET") return new Response("{}", { status: 400 });
    if (url.pathname === "/v1/disputes") return Response.json(pages[0] ?? { data: [], has_more: false });
    if (url.pathname.startsWith("/v1/disputes/")) {
      const id = url.pathname.split("/").pop() ?? "";
      return byId[id] ? Response.json(byId[id]) : new Response(JSON.stringify({ error: { message: "missing" } }), { status: 404 });
    }
    if (url.pathname === `/v1/subscriptions/${SUB}`) return Response.json({ id: SUB, metadata: { store: handle }, customer: "cus_PlanDisputeClosed01" });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

function dispute(id: string, status: string): Record<string, unknown> {
  return {
    id,
    object: "dispute",
    status,
    created: NOW - DAY,
    charge: { id: `ch_${id.slice(3)}`, invoice: { id: `in_${id.slice(3)}`, subscription: SUB, lines: { data: [{ period: { start: NOW - 10 * DAY, end: NOW + 20 * DAY } }] } } },
  };
}

async function setup() {
  redis.clear();
  asked.length = 0;
  byId = {};
  pages = [];
  await claimHandle(owner, handle, "Plan dispute closed shop", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_PlanDisputeClosed01", subscriptionId: SUB, active: true, tier: "pro", cycle: "month", period: paidPeriod() });
}

async function seen(): Promise<Map<string, string>> {
  const raw = await redis.run(["HGETALL", SEEN_KEY]);
  const out = new Map<string, string>();
  if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) out.set(String(raw[i]), String(raw[i + 1]));
  else if (raw && typeof raw === "object") for (const [key, value] of Object.entries(raw)) out.set(key, String(value));
  return out;
}

async function main() {
  part("Stripe's closed statuses are not read as still open");
  is("prevented reads as lost (the money went back)", disputeStatusOf("prevented"), "lost");
  is("charge_refunded reads as lost (the charge was refunded)", disputeStatusOf("charge_refunded"), "lost");
  is("won is unchanged", disputeStatusOf("won"), "won");
  is("warning_closed is unchanged", disputeStatusOf("warning_closed"), "won");
  is("lost is unchanged", disputeStatusOf("lost"), "lost");
  for (const status of ["needs_response", "under_review", "warning_needs_response", "warning_under_review"]) {
    is(`${status} is still open`, disputeStatusOf(status), "open");
  }
  for (const status of ["something_new", "Prevented", "PREVENTED", " prevented", "charge_refunded ", "", null, undefined, 0, ["prevented"], { status: "prevented" }]) {
    is(`${JSON.stringify(status) ?? "undefined"} is unknown, still open (never closed or won)`, disputeStatusOf(status), "open");
  }

  for (const status of ["prevented", "charge_refunded"]) {
    part(`A plan dispute listed as ${status}`);
    await setup();
    const id = `du_Closed${status.replace(/_/g, "")}`;
    pages = [{ data: [dispute(id, status)], has_more: false }];
    const read = await syncPlanDisputes(Date.now() + 10_000, NOW);
    is("recorded once, nothing failed", [read.recorded, read.failed, read.complete], [1, 0, true]);
    const after = (await storeForEmail(owner))!;
    is("written as lost, with the period it covered", after.planDisputes, [{ id, status: "lost", at: NOW - DAY, coversUntil: NOW + 20 * DAY }]);
    is("paused while the period it paid for runs", costPauseCode(after, NOW) !== null, true);
    is("checkout closed while the period it paid for runs", isPaidUp(after), false);
    for (const later of [NOW + 21 * DAY, NOW + 400 * DAY]) {
      is(`no pause ${Math.round((later - NOW) / DAY)} days later`, costPauseCode(after, later), null);
    }
    is("remembered as final, not open", (await seen()).get(id), "final");
    asked.length = 0;
    pages = [{ data: [], has_more: false }];
    await syncPlanDisputes(Date.now() + 10_000, NOW);
    is("not read again by id the next day", asked.filter((line) => line.startsWith("GET /v1/disputes/")), []);
  }

  for (const status of ["prevented", "charge_refunded"]) {
    part(`An open plan dispute past the list window, re-read as ${status}`);
    await setup();
    const id = `du_Stale${status.replace(/_/g, "")}`;
    const before = (await storeForEmail(owner))!;
    await recordPlanDispute(storeRef(before), { id, status: "open", at: NOW - 200 * DAY, coversUntil: NOW - 170 * DAY }, NOW);
    await redis.run(["HSET", SEEN_KEY, id, `open:${before.sid}`]);
    byId = { [id]: { id, object: "dispute", status, created: NOW - 200 * DAY } };
    const read = await syncPlanDisputes(Date.now() + 10_000, NOW);
    is("re-read and recorded", [read.reread, read.recorded, read.failed], [1, 1, 0]);
    const after = (await storeForEmail(owner))!;
    is("written as lost, keeping the period first read", after.planDisputes, [{ id, status: "lost", at: NOW - 200 * DAY, coversUntil: NOW - 170 * DAY }]);
    is("its period long over: nothing paused", costPauseCode(after, NOW), null);
    is("checkout open again", isPaidUp(after), true);
    is("its re-read slot is freed (final)", (await seen()).get(id), "final");
  }

  part("Stuck ones never hold every re-read slot");
  {
    await setup();
    const store = (await storeForEmail(owner))!;
    // MAX_REREADS old disputes closed as prevented, then one older dispute the bank decided for us.
    const stuck = Array.from({ length: MAX_REREADS }, (_, i) => `du_Stuck${String(i).padStart(3, "0")}`);
    const late = "du_StuckWonLater";
    for (const id of [...stuck, late]) {
      await redis.run(["HSET", SEEN_KEY, id, `open:${store.sid}`]);
      byId[id] = { id, object: "dispute", status: id === late ? "won" : "prevented", created: NOW - 200 * DAY };
    }
    await recordPlanDispute(storeRef(store), { id: late, status: "open", at: NOW - 200 * DAY, coversUntil: NOW - 170 * DAY }, NOW);
    for (let run = 0; run < 3; run += 1) await syncPlanDisputes(Date.now() + 10_000, NOW);
    const after = await seen();
    is("no stuck one is still open", stuck.filter((id) => after.get(id) !== "final"), []);
    is("the later win is read in a following run", after.get(late), "final");
    const lifted = (await storeForEmail(owner))!;
    // Written as won, it no longer pauses, so withPlanDispute may drop it first past PLAN_DISPUTES_KEPT: never kept as open.
    is("and no longer kept as open on the store", lifted.planDisputes?.some((kept) => kept.id === late && kept.status === "open"), false);
    asked.length = 0;
    const next = await syncPlanDisputes(Date.now() + 10_000, NOW);
    is("the run after asks Stripe no dispute by id and is complete", [asked.filter((line) => line.startsWith("GET /v1/disputes/")).length, next.complete], [0, true]);
  }

  part("Controls: an open dispute and an undocumented status stay open");
  for (const status of ["needs_response", "something_new"]) {
    await setup();
    const id = `du_Ctrl${status.replace(/_/g, "")}`;
    pages = [{ data: [dispute(id, status)], has_more: false }];
    await syncPlanDisputes(Date.now() + 10_000, NOW);
    const after = (await storeForEmail(owner))!;
    is(`${status}: written as open`, after.planDisputes?.[0]?.status, "open");
    is(`${status}: still paused past the period`, costPauseCode(after, NOW + 400 * DAY) !== null, true);
    is(`${status}: kept for a re-read`, (await seen()).get(id), `open:${after.sid}`);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
