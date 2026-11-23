/**
 * #5010 row 150 (coordinators f0cb, de89; held for the owner's YES; audit ea4f and 729c): a sales file
 * (app/api/store/export, what=sales) reads every sale again, and at the ten essential requests a day it could take, it
 * cost more than a Store plan carries. It now takes one of SALES_FILES_PER_MONTH files a month, a count of its own
 * (lib/sales-files.ts), never from the studio's requests or any other figure. Checked through the real route:
 *   - the owner's SALES_FILES_PER_MONTH files go, then the next is refused with how many and when it opens again,
 *     and a refusal takes no place (ea4f 7);
 *   - the team has as many of its own, and never uses up the owner's (ea4f 8);
 *   - the studio's requests are never touched;
 *   - a file whose sales were read keeps its place even when it fails (ea4f 9, 729c 11);
 *   - a store with no statsId is refused with nothing read (729c 13);
 *   - the button says what the files hold before the click (ea4f 6);
 *   - the cost is priced: the owner's and the team's files a month at the most a file costs, the file's bytes at
 *     their most, and twice that for a store that pays nothing (729c 14).
 * Synthetic: the in-memory Redis and a Stripe stand-in.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { GET as exportRoute } from "@/app/api/store/export/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { allowanceUsed } from "@/lib/store-allowance";
import { SALES_FILES_PER_MONTH, SALES_FILES_WORDS } from "@/lib/studio-allowance-rules";
import { SALES_FILE_MAX_BYTES } from "@/lib/stats";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { putMember } from "@/lib/team";
import { TIERS } from "@/lib/plan";
import { COST_LINES, SALES_FILES_A_MONTH, SALES_FILE_COST, exportCost } from "./plan-cost-registry";
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
const ADMIN = "sales-files-admin@example.com";

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
  if (!(await putMember(store, ADMIN, "admin"))) throw new Error("setup: admin");
  const owner = await openSession(OWNER);
  const admin = await openSession(ADMIN);
  const get = (session: string) => exportRoute(new NextRequest(`https://marktmorgen.com/api/store/export?what=sales&range=all&store=${store.sid}`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
  const ownerKey = () => redis.keys().find((key) => key.startsWith(`nl:rl:export:${store.statsId}:sales:`));

  part("A file whose sales were read keeps its place, even when it could not be made");
  const studioBefore = await allowanceUsed(store, "studio");
  stripeDown = true;
  const failed = await get(owner);
  stripeDown = false;
  is("Stripe did not answer: no file, and the answer says the try counted", [failed.status, (await failed.text()).includes("This try counted as one of your sales files")], [502, true]);

  part(`The owner's ${SALES_FILES_PER_MONTH} sales files a month, then a plain refusal that takes no place`);
  const statuses: number[] = [];
  for (let i = 1; i < SALES_FILES_PER_MONTH; i += 1) statuses.push((await get(owner)).status);
  is(`${SALES_FILES_PER_MONTH - 1} more files go, the failed one counted`, statuses, Array.from({ length: SALES_FILES_PER_MONTH - 1 }, () => 200));
  const refused = await get(owner);
  const words = await refused.text();
  is("the next is refused", refused.status, 429);
  is("saying how many, that they never use up the figures, and when it opens again", [words.includes(`You have downloaded ${SALES_FILES_PER_MONTH} sales files this month`), words.includes("never use up your monthly figures"), /opens again/.test(words)], [true, true, true]);
  await get(owner);
  is("a refusal takes no place: the count stays at the month's files", Number((await redis.pipeline([["GET", ownerKey()!]]))[0]), SALES_FILES_PER_MONTH);

  part("The team has as many of its own, and never uses up the owner's");
  const team: number[] = [];
  for (let i = 0; i <= SALES_FILES_PER_MONTH; i += 1) team.push((await get(admin)).status);
  is(`an Admin downloads ${SALES_FILES_PER_MONTH}, then is refused`, team, [...Array.from({ length: SALES_FILES_PER_MONTH }, () => 200), 429]);
  is("the owner's count did not move", Number((await redis.pipeline([["GET", ownerKey()!]]))[0]), SALES_FILES_PER_MONTH);
  is("the studio's requests were never touched", (await allowanceUsed(store, "studio")) - studioBefore, 0);

  part("A store with no statsId is refused with nothing read");
  {
    const { takeSalesFile } = await import("@/lib/sales-files");
    const answer = await takeSalesFile({ ...store, statsId: "" }, true);
    is("503, nothing counted", answer.ok ? 0 : answer.status, 503);
  }

  part("Said before the click, and in plain words");
  is("the button's note", SALES_FILES_WORDS, `You can download up to ${SALES_FILES_PER_MONTH} sales files a month (or in your trial), and your team up to ${SALES_FILES_PER_MONTH} more. They never use up your monthly figures.`);
  is("the button is described by it", /aria-describedby="sales-files-note"[\s\S]{0,200}id="sales-files-note"[^>]*>\{SALES_FILES_WORDS\}/.test(readFileSync("components/stats-panel.tsx", "utf8")), true);
  is("the public page says how many", readFileSync("lib/site-pages.ts", "utf8").includes("up to ${SALES_FILES_PER_MONTH} times a month"), true);

  part("Its cost is priced, for a store that pays and one that pays nothing");
  const line = COST_LINES.find((l) => l.id === "sales-files");
  is("its line is in the registry", Boolean(line), true);
  is("the owner's and the team's", SALES_FILES_A_MONTH, 2 * SALES_FILES_PER_MONTH);
  for (const tier of TIERS) is(`${tier}: ${SALES_FILES_A_MONTH} files a month at the most a file costs`, line ? Math.abs(line.monthlyUsd(tier) - SALES_FILES_A_MONTH * SALES_FILE_COST) < 1e-12 : false, true);
  is("a file's cost carries its bytes sent, at their most", SALES_FILE_COST > exportCost(1) && SALES_FILE_MAX_BYTES > 0, true);
  is("a store that pays nothing carries a trial's files and the month's after it", /\+ 2 \* SALES_FILES_A_MONTH \* SALES_FILE_COST/.test(readFileSync("tests/plan-cost-registry.ts", "utf8")), true);

  done();
}

void main().catch((error) => {
  console.log(error);
  process.exit(1);
});
