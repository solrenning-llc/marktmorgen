/**
 * Audit A4 follow-up (pre-review of the per-status reading): a store's running
 * members are now read in up to three readings of MAX_PAGES pages each, so the
 * daily come-back and yearly-offer runs (app/api/cron/plans, 45 s deadline in a
 * 60 s function) must stop reading Stripe at their deadline, as every other
 * step of those runs does, and say the reading did not finish: never thirty
 * Stripe pages after the time is up, which would let the function be cut off
 * before the jobs after it run and before the run's cursor is kept.
 */
import { runningMembers } from "@/lib/member-health";
import { nudgeStore } from "@/lib/member-nudge";
import { askStore } from "@/lib/yearly-ask";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setNudge, setStripeAccount, setYearlyAsk, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Math.floor(Date.now() / 1000);
let stripePages = 0;
let served = 0;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.pathname === "/v1/subscriptions") {
    stripePages += 1;
    // Stripe answers slowly, and always has more: another store's members on the same account.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const data = Array.from({ length: 100 }, () => {
      served += 1;
      return {
        id: `sub_Busy${String(served).padStart(8, "0")}`,
        status: url.searchParams.get("status"),
        customer: { id: `cus_Busy${served}`, email: `busy${served}@example.com` },
        metadata: { store: "busyneighbor", product: "p" },
        start_date: NOW - 100 * 86_400,
        items: { data: [{ quantity: 1, current_period_end: NOW + 86_400, price: { unit_amount: 1000, recurring: { interval: "month", interval_count: 1 } } }] },
      };
    });
    return new Response(JSON.stringify({ object: "list", data, has_more: true }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_health_deadline_stand_in";
  process.env.RESEND_API_KEY = "re_test_health_deadline_stand_in";
  redis.clear();
  const originalError = console.error;
  console.error = () => {};
  const OWNER = "deadline-owner@example.com";
  const made = await claimHandle(OWNER, "slowclub", "Slow Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSlowClub01", true);
  const club = await addProduct(OWNER, "Slow Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setNudge(OWNER, { on: true, address: "1 Main St, Portland, OR 97201" });
  await setYearlyAsk(OWNER, { on: true, address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;

  part("Without a deadline (the studio page): every status, MAX_PAGES pages each");
  stripePages = 0;
  is("thirty pages, not complete", [(await runningMembers(store)).complete, stripePages], [false, 30]);

  part("With a deadline: stops reading Stripe when the time is up, and says it did not finish");
  stripePages = 0;
  const cut = await runningMembers(store, Date.now() + 150);
  is("not complete, and at most the pages that fit before the deadline", [cut.complete, stripePages <= 5], [false, true]);

  stripePages = 0;
  const nudged = { complete: true };
  await nudgeStore(store, Date.now() + 150, Date.now(), nudged);
  is("the come-back run passes its deadline to the reading", [nudged.complete, stripePages <= 5], [false, true]);

  stripePages = 0;
  const asked = { complete: true };
  await askStore(store, Date.now() + 150, Date.now(), asked);
  is("the yearly-offer run passes its deadline to the reading", [asked.complete, stripePages <= 5], [false, true]);

  console.error = originalError;
  done();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
