/**
 * The other readers of the store's sales count what they read before they
 * read it (MR: a ceiling before every spend), each in its own figure:
 *
 *   - asked for in the studio (all-time sales, any stretch of days, the
 *     background reading of what buyers get next): the studio's requests,
 *     refused with the figure's own sentence (or NOT_COUNTED), nothing read;
 *   - automatic (the sold counts on store pages, the daily alerts, the weekly
 *     and monthly emails, a subject test's sales): the plan's, never the
 *     studio's requests, priced at their worst month in
 *     tests/plan-cost-registry.ts (SCHEDULED_READS), each bounded by its
 *     schedule and its own claim: the sold counts once each SOLD_LOCK_SECONDS
 *     whatever came of the last, the monthly email at most MONTHLY_TRIES
 *     readings with a doubling wait;
 *   - with an API key (GET /api/v1/stats and the MCP tools that read sales):
 *     API_NUMBERS_UNITS of the API requests, refused as the API refuses
 *     (429 monthly_limit), and documented.
 */
import { readFileSync } from "node:fs";
import { SalesNotCounted, readAllTimeSales, readRange } from "@/lib/stats";
import { paidSalesReadUnits, salesCount } from "@/lib/segments";
import { refreshSoldCounts } from "@/lib/sold-count";
import { checkAlerts } from "@/lib/store-alerts";
import { takeMoreApi } from "@/lib/api-guard";
import { MONTHLY_TRIES, claimMonth, letMonthGo, monthWaitOver } from "@/lib/stats-report";
import { SOLD_LOCK_SECONDS } from "@/lib/sold-count";
import { MCP_INSTRUCTIONS } from "@/lib/mcp-catalog";
import { API_NUMBERS_UNITS } from "@/lib/store-allowance-rules";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { countStudio } from "@/lib/studio-route";
import { redisPipeline } from "@/lib/redis";
import { BUYER_LEDGER_UNITS } from "@/lib/segments";
import { type Store, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "readers-owner@example.com";
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") stripeCalls += 1;
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const flat = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");
const notCounted = (error: unknown) => (error instanceof SalesNotCounted ? "not counted" : String(error));

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_readers_only_a_stand_in";
  await claimHandle(OWNER, "readershop", "Readers Shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestReaders001", true);
  await setSubscription(OWNER, { customerId: "cus_readers", subscriptionId: "sub_readers", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  await countStudio(store, null, 1);
  const studioKey = redis.keys().find((key) => key.startsWith("nl:allow:studio:"))!;
  const spend = (left: number) => redisPipeline([["SET", studioKey, String(allowanceFor(store, "studio") - left)]]);
  const used = async () => Number((await redisPipeline([["GET", studioKey]]))[0]);
  const asked: number[] = [];
  const refusing = salesCount(store, async (units) => { asked.push(units); return false; });

  part("Asked for in the studio: counted before reading, nothing read when not");
  stripeCalls = 0;
  const all = await readAllTimeSales(store, refusing).then(() => "read", notCounted);
  is("all-time sales: a reading of every sale's worth asked first, Stripe not read", [all, asked, stripeCalls], ["not counted", [paidSalesReadUnits(store, 0)], 0]);
  is("which is a reading of the buyers' worth with Stripe on", paidSalesReadUnits(store, 0), BUYER_LEDGER_UNITS);
  asked.length = 0;
  await redisPipeline([["SET", `nl:stats:${store.statsId}:allsales`, JSON.stringify({ totals: { sales: 1, cents: 100 }, byProduct: {}, since: "", partial: false, currency: store.currency, elsewhere: 0 })]]);
  const copy = await readAllTimeSales(store, salesCount(store, async (units) => { asked.push(units); return true; }));
  is("its ten-minute copy, small, counts nothing more and is read", [copy?.totals.sales, asked, stripeCalls], [1, [], 0]);
  await redisPipeline([["SET", `nl:stats:${store.statsId}:allsales`, "x".repeat(2_000_000)]]);
  const bigCopy = await readAllTimeSales(store, refusing).then(() => "read", notCounted);
  is("a copy past what a request covers is counted by its size first", [bigCopy, asked.at(-1)], ["not counted", 2]);
  await redisPipeline([["DEL", `nl:stats:${store.statsId}:allsales`]]);
  stripeCalls = 0;
  const range = await readRange(store, "2026-10-01", "2026-10-07", Date.parse("2026-11-04T12:00:00Z"), { count: refusing }).then(() => "read", notCounted);
  is("any stretch of days: counted before Stripe is read", [range, stripeCalls], ["not counted", 0]);
  const statsRoute = flat("app/api/store/stats/route.ts");
  const rangeRoute = flat("app/api/store/stats/range/route.ts");
  is("both routes count with the studio's figure and say its sentence, or the shared one", [statsRoute.includes("readAllTimeSales(store, salesCount(store, counting.count))"), statsRoute.includes('error: "studio_used", message: counting.said.message || NOT_COUNTED'), rangeRoute.includes("count: salesCount(store, counting.count)"), rangeRoute.includes('error: "studio_used", message: counting.said.message || NOT_COUNTED')], [true, true, true, true]);
  is("and the studio shows it", [flat("components/stats-panel.tsx").includes('? all.message ?? "Stripe did not answer"'), flat("components/custom-range.tsx").includes('else if (data.error === "studio_used" && typeof data.message === "string" && data.message) setError(data.message);')], [true, true]);
  is("the studio's background reading of what buyers get next is counted too", flat("app/studio/page.tsx").includes("after(() => readAllTimeSales(store, salesCount(store, countLedger(store).count))"), true);

  part("Automatic: the plan's, never the studio's requests; each bounded by its schedule and its claim");
  await spend(0);
  stripeCalls = 0;
  const sold = { ...store, look: { ...store.look, sold: true } } as Store;
  const before = await used();
  const counts = await refreshSoldCounts(sold, async () => null);
  const lockTtl = Number((await redisPipeline([["TTL", `nl:sold:lock:${store.statsId}`]]))[0]);
  is("the sold counts take nothing from the studio's requests, even with none left", (await used()) - before, 0);
  is("and a reading that failed holds the next one off as long as fresh counts would (six hours), not five minutes", [counts, lockTtl > 300, lockTtl <= SOLD_LOCK_SECONDS, SOLD_LOCK_SECONDS], [null, true, true, 6 * 3600]);
  is("so a second visit right after reads nothing", [await refreshSoldCounts(sold, async () => { throw new Error("read again"); })], [null]);
  const alerted = await checkAlerts(store, Date.parse("2026-11-04T12:00:00Z"));
  is("the daily alerts read without counting in the studio's requests", [alerted.skipped, (await used()) - before], [false, 0]);
  await redisPipeline([["SET", studioKey, "0"]]);
  const month = "2026-10";
  const tries: boolean[] = [];
  const waits: number[] = [];
  for (let i = 0; i < MONTHLY_TRIES; i += 1) {
    await claimMonth(store.handle, month);
    tries.push(await letMonthGo(store.handle, month));
    const ttl = Number((await redisPipeline([["TTL", `nl:monthly:wait:${month}:${store.handle}`]]))[0]);
    waits.push(ttl);
    if (i < MONTHLY_TRIES - 1) is(`after a failed reading the month waits (try ${i + 1})`, await monthWaitOver(store.handle, month), false);
    await redisPipeline([["DEL", `nl:monthly:wait:${month}:${store.handle}`]]);
  }
  is("the monthly email lets its month go five times, each after a wait that doubles, and keeps it after the sixth reading", [tries, waits.slice(0, MONTHLY_TRIES - 1)], [[true, true, true, true, true, false], [3600, 7200, 14_400, 28_800, 57_600]]);
  is("so no later run can claim it: at most MONTHLY_TRIES readings a month", [MONTHLY_TRIES, await claimMonth(store.handle, month)], [6, false]);
  const monthly = flat("app/api/cron/monthly/route.ts");
  is("the monthly job waits, claims, and lets go only through the cap", [monthly.indexOf("monthWaitOver(store.handle, month)") < monthly.indexOf("claimMonth(store.handle, month)"), monthly.includes("await letMonthGo(store.handle, month).catch(() => false);"), monthly.includes("releaseMonth")], [true, true, false]);
  is("no scheduled reading counts in the studio's requests", ["app/api/cron/weekly/route.ts", "app/api/cron/monthly/route.ts", "lib/store-alerts.ts", "lib/sold-count.ts", "lib/broadcasts.ts"].map((f) => flat(f).includes("countUnits(") || flat(f).includes("countStudio(store, null, paidSalesReadUnits")), [false, false, false, false, false]);

  part("With an API key: API_NUMBERS_UNITS of the API requests, refused as the API refuses");
  await countStudio(store, null, 0);
  const { takeAllowance } = await import("@/lib/store-allowance");
  await takeAllowance(store, "api", 1);
  const apiKey = redis.keys().find((key) => key.startsWith("nl:allow:api:"))!;
  await redisPipeline([["SET", apiKey, String(allowanceFor(store, "api") - 2)]]);
  const refused = await takeMoreApi(store, API_NUMBERS_UNITS - 1);
  is("too few left: 429 monthly_limit with the figure's sentence", [refused?.status, ((await refused?.json()) as { error?: string } | undefined)?.error], [429, "monthly_limit"]);
  await redisPipeline([["SET", apiKey, "0"]]);
  is("with room: taken, and nothing refused", [await takeMoreApi(store, API_NUMBERS_UNITS - 1), Number((await redisPipeline([["GET", apiKey]]))[0])], [null, API_NUMBERS_UNITS - 1]);
  const v1 = flat("app/api/v1/stats/route.ts");
  const mcp = flat("app/api/mcp/route.ts");
  is("v1 stats takes them before reading", v1.indexOf("takeMoreApi(store, API_NUMBERS_UNITS - 1)") > 0 && v1.indexOf("takeMoreApi(store, API_NUMBERS_UNITS - 1)") < v1.indexOf("readNumbers(store)"), true);
  is("MCP takes them before any tool that reads sales", [mcp.indexOf("takeMoreApi(store, API_NUMBERS_UNITS - 1)") > 0 && mcp.indexOf("takeMoreApi(store, API_NUMBERS_UNITS - 1)") < mcp.indexOf('if (params.name === "get_numbers")'), mcp.includes('const SALES_TOOLS = new Set(["get_numbers", "get_revenue_by_channel", "get_funnel", "get_product_numbers", "get_buyers", "get_worth_knowing", "get_emails"]);')], [true, true]);
  is("documented for developers and in the MCP instructions", [flat("app/developers/page.tsx").includes("Reading your numbers counts as ${API_NUMBERS_UNITS}, because your sales are read again from Stripe each time"), MCP_INSTRUCTIONS.includes(`counts as ${API_NUMBERS_UNITS} of the store's API requests`)], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
