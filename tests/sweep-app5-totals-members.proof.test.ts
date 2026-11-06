/**
 * Sweep app5 proof (CX-123 rules 24 and 30), synthetic only: the in-memory Redis double and a Stripe stand-in that
 * fails; no network.
 *
 * app/studio/totals/page.tsx:44 reads each store's members with `keptMembers(store).catch(() => null)` and hands
 * `members: null` to `sumStores` inside a read whose state is still "ok" (line 45). lib/account-totals.ts:92-97 adds a
 * store's members only when they are there, and names a store in "Not added in" only when its state is not "ok". So a
 * store whose Stripe read failed is silently left out of "Paying members", "On a free trial" and "Monthly recurring
 * revenue": with every store failing, the page says 0 paying members and $0.00 a month (moneyLines, line 25), with no
 * note; with one failing, a smaller number presented as the whole.
 *
 * Healthy control first; the checks named DEFECT pass while the defect is present.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { keptMembers } from "@/lib/store-readings";
import { type StoreFigures, sumStores } from "@/lib/account-totals";
import type { StatsData } from "@/lib/stats";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const t = { visitors: 10, views: 20, checkouts: 2, sales: 1, cents: 1_000 };
const data = { totals: { d7: t, d30: t, d90: t, all: t }, currency: "usd", sales: "ok", partial: false } as unknown as StatsData;
const figures = (name: string, read: StoreFigures["read"]): StoreFigures => ({ sid: name.toLowerCase(), name, handle: name.toLowerCase(), read });

async function main(): Promise<void> {
  part("What the page does with a members read that throws (app/studio/totals/page.tsx:44-45)");
  const page = readFileSync("app/studio/totals/page.tsx", "utf8");
  is("the throw becomes members: null inside state ok", page.includes("keptMembers(store).catch(() => null)") && page.includes('return { state: "ok", data, members: club ?'), true);

  part("keptMembers when Stripe cannot be reached");
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_sweep_app5_totals_only";
  let stripeCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (new URL(String(input)).hostname === "api.stripe.com") stripeCalls += 1;
    return new Response(JSON.stringify({ error: { message: "synthetic outage" } }), { status: 500 });
  }) as typeof fetch;
  const OWNER = "sweepapp5totals@example.com";
  await claimHandle(OWNER, "sweepapptotals", "Sweep Totals", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSweepTot01", true);
  const shop = (await storeForEmail(OWNER))!;
  const outcome = await keptMembers(shop).then(
    (v) => ({ threw: false, value: v }),
    () => ({ threw: true, value: null }),
  );
  console.log(`  (keptMembers ${outcome.threw ? "threw" : "answered null"})`);
  is("Stripe was asked", stripeCalls > 0, true);
  is("the read does not give numbers (it throws or answers null): the page then has members: null", outcome.value, null);

  part("Healthy control: two stores, both members read");
  const healthy = sumStores([
    figures("Bread", { state: "ok", data, members: { currency: "usd", paying: 3, trialing: 1, mrr: 2_700 } }),
    figures("Pasta", { state: "ok", data, members: { currency: "usd", paying: 40, trialing: 2, mrr: 36_000 } }),
  ]);
  is("43 paying, 3 on trial, $387.00 a month, nothing left out", [healthy.members.paying, healthy.members.trialing, healthy.members.mrr, healthy.left], [43, 3, [{ currency: "USD", cents: 38_700 }], []]);

  part("DEFECT: Pasta's members read failed (members: null, state ok)");
  const one = sumStores([
    figures("Bread", { state: "ok", data, members: { currency: "usd", paying: 3, trialing: 1, mrr: 2_700 } }),
    figures("Pasta", { state: "ok", data, members: null }),
  ]);
  is("DEFECT: 3 paying and $27.00 a month shown as the whole", [one.members.paying, one.members.mrr], [3, [{ currency: "USD", cents: 2_700 }]]);
  is("DEFECT: and nothing says Pasta's members were not added in", one.left, []);

  part("DEFECT: both members reads failed");
  const both = sumStores([figures("Bread", { state: "ok", data, members: null }), figures("Pasta", { state: "ok", data, members: null })]);
  is("DEFECT: 0 paying, 0 on trial, no money lines (the page prints $0.00), no note", [both.members.paying, both.members.trialing, both.members.mrr, both.left], [0, 0, [], []]);
  done();
}

void main();
