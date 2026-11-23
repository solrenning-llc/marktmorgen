/**
 * #5010 row 150 (coordinators f0cb, de89; held for the owner's YES): a sales file (app/api/store/export, what=sales)
 * reads every sale again, and at the ten essential requests a day it could take, it cost more than a Store plan
 * carries. It now takes one of SALES_FILES_PER_MONTH files a month, a count of its own (lib/sales-files.ts), never
 * from the studio's requests or any other figure. Checked through the real route:
 *   - SALES_FILES_PER_MONTH files go, then the next is refused with how many and when it opens again;
 *   - the studio's requests are never touched;
 *   - a file that could not be made gives its place back;
 *   - the cost is priced: SALES_FILES_PER_MONTH files a month at the most a file costs, for a store that pays and one
 *     that pays nothing.
 * Synthetic: the in-memory Redis and a Stripe stand-in.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { GET as exportRoute } from "@/app/api/store/export/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { allowanceUsed } from "@/lib/store-allowance";
import { SALES_FILES_PER_MONTH } from "@/lib/studio-allowance-rules";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { TIERS } from "@/lib/plan";
import { COST_LINES, SALES_FILE_COST } from "./plan-cost-registry";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let stripeDown = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.stripe.com") {
    if (stripeDown) return new Response(JSON.stringify({ error: { message: "synthetic outage" } }), { status: 500 });
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const OWNER = "sales-files-owner@example.com";

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.STRIPE_SECRET_KEY = "sk_test_sales_files_month_only";
  await claimHandle(OWNER, "salesfiles", "Sales Files", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1SalesFiles00001", true);
  await setSubscription(OWNER, { customerId: "cus_salesfiles", subscriptionId: "sub_salesfiles", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const session = await openSession(OWNER);
  const get = () => exportRoute(new NextRequest(`https://marktmorgen.com/api/store/export?what=sales&range=all&store=${store.sid}`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));

  part("A file that could not be made gives its place back");
  const studioBefore = await allowanceUsed(store, "studio");
  stripeDown = true;
  const failed = await get();
  stripeDown = false;
  is("Stripe did not answer: no file", failed.status, 502);

  part(`${SALES_FILES_PER_MONTH} sales files a month, then a plain refusal`);
  const statuses: number[] = [];
  for (let i = 0; i < SALES_FILES_PER_MONTH; i += 1) statuses.push((await get()).status);
  is(`${SALES_FILES_PER_MONTH} files go, the failed one not counted`, statuses, Array.from({ length: SALES_FILES_PER_MONTH }, () => 200));
  const refused = await get();
  const words = await refused.text();
  is("the next is refused", refused.status, 429);
  is("saying how many, that it is a count of its own, and when it opens again", [words.includes(`You have downloaded ${SALES_FILES_PER_MONTH} sales files this month`), words.includes("never counts against your studio's requests"), /opens again/.test(words)], [true, true, true]);
  is("the studio's requests were never touched", (await allowanceUsed(store, "studio")) - studioBefore, 0);

  part("Its cost is priced, for a store that pays and one that pays nothing");
  const line = COST_LINES.find((l) => l.id === "sales-files");
  is("its line is in the registry", Boolean(line), true);
  for (const tier of TIERS) is(`${tier}: ${SALES_FILES_PER_MONTH} files a month at the most a file costs`, line ? Math.abs(line.monthlyUsd(tier) - SALES_FILES_PER_MONTH * SALES_FILE_COST) < 1e-12 : false, true);
  is("a store that pays nothing carries the same files", /\+ SALES_FILES_PER_MONTH \* SALES_FILE_COST/.test(readFileSync("tests/plan-cost-registry.ts", "utf8")), true);

  done();
}

void main().catch((error) => {
  console.log(error);
  process.exit(1);
});
