/**
 * Audit A7: Stripe's list of plan disputes is read newest first, at most
 * MAX_PAGES pages a run, with no cursor between runs. With more pages than
 * that, every run reads the same newest pages again, so the oldest dispute is
 * not reached by the next run either: the run is not complete, and its log
 * says so instead of saying the oldest wait for the next run.
 */
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { MAX_PAGES, syncPlanDisputes } from "@/lib/plan-disputes";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_dispute_log_only";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const owner = "plan-dispute-log@example.com";
const handle = "plan-dispute-log";
const SUB = "sub_PlanDisputeLog01";

function dispute(id: string): Record<string, unknown> {
  return {
    id, object: "dispute", status: "needs_response", created: NOW - DAY,
    charge: { id: `ch_${id.slice(3)}`, invoice: { id: `in_${id.slice(3)}`, subscription: SUB, lines: { data: [{ period: { start: NOW - 10 * DAY, end: NOW + 20 * DAY } }] } } },
  };
}
/** One dispute a page, newest first; the last page holds the oldest. */
const pages = Array.from({ length: MAX_PAGES + 1 }, (_, page) => ({
  object: "list", data: [dispute(page === MAX_PAGES ? "du_Oldest" : `du_Newer${page}`)], has_more: page < MAX_PAGES,
}));
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/disputes") {
    const after = url.searchParams.get("starting_after");
    const index = after ? pages.findIndex((page) => page.data.some((row) => row.id === after)) + 1 : 0;
    return Response.json(pages[index] ?? { object: "list", data: [], has_more: false });
  }
  if (url.hostname === "api.stripe.com" && url.pathname === `/v1/subscriptions/${SUB}`) return Response.json({ id: SUB, metadata: { store: handle }, customer: "cus_PlanDisputeLog01" });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(owner, handle, "Plan dispute log shop", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_PlanDisputeLog01", subscriptionId: SUB, active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

  part("More pages than one run reads (A7)");
  const first = await syncPlanDisputes(Date.now() + 10_000, NOW);
  const second = await syncPlanDisputes(Date.now() + 10_000, NOW);
  const kept = (await storeForEmail(owner))!.planDisputes ?? [];
  is("neither run is complete, and the next run does not reach the oldest either", [first.complete, second.complete, kept.some((d) => d.id === "du_Oldest")], [false, false, false]);
  is("the log never says the oldest wait for the next run", errors.some((line) => /wait for the next run/.test(line)), false);
  is("it says the oldest are not read", errors.filter((line) => /plan disputes/.test(line) && /not read/.test(line)).length, 2);

  console.error = originalError;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
