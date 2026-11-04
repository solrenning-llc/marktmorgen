/**
 * The other readers of the store's sales count what they read before they
 * read it (MR: a ceiling before every spend), each in its own figure:
 *
 *   - asked for in the studio (all-time sales, any stretch of days, the
 *     background reading of what buyers get next): the studio's requests,
 *     refused with the figure's own sentence (or NOT_COUNTED), nothing read;
 *   - automatic (the sold counts on store pages, the daily alerts, the weekly
 *     and monthly emails, a subject test's sales): the studio's requests,
 *     and when not counted nothing is read, nothing is marked done, and a
 *     later run tries again;
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
import { NOTE_ROOM, testNotCountedNote } from "@/lib/broadcasts";
import { claimWeek, releaseWeek } from "@/lib/stats-report";
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

  part("Automatic: counted before reading; not counted, nothing read or marked, tried again later");
  await spend(3);
  stripeCalls = 0;
  const sold = { ...store, look: { ...store.look, sold: true } } as Store;
  await redisPipeline([["SET", `nl:sold:${store.statsId}`, JSON.stringify({ at: 1, p: { kept: 4 }, t: {} })]]);
  const refreshed = await refreshSoldCounts(sold, (s) => readAllTimeSales(s));
  is("the sold counts on store pages: nothing read, the counts kept stay", [refreshed, stripeCalls, JSON.parse(String((await redisPipeline([["GET", `nl:sold:${store.statsId}`]]))[0])).p.kept], [null, 0, 4]);
  await redisPipeline([["DEL", `nl:sold:lock:${store.statsId}`]]);
  await spend(BUYER_LEDGER_UNITS + 1);
  const before = await used();
  const counts = await refreshSoldCounts(sold, (s) => readAllTimeSales(s));
  is("with room, counted first and then read", [counts !== null, (await used()) - before, stripeCalls > 0], [true, paidSalesReadUnits(store, 0), true]);
  await spend(3);
  stripeCalls = 0;
  const alerts = await checkAlerts(store, Date.parse("2026-11-04T12:00:00Z"));
  is("the daily alerts: nothing read or said, tomorrow's pass reads again", [alerts, stripeCalls], [{ said: 0, skipped: true }, 0]);
  await redisPipeline([["SET", studioKey, "0"]]);
  const week = Date.parse("2026-11-02T12:00:00Z");
  await claimWeek(store.handle, week);
  await releaseWeek(store.handle, week);
  is("a week let go can be claimed again by a later run", await claimWeek(store.handle, week), true);
  const weekly = flat("app/api/cron/weekly/route.ts");
  const monthly = flat("app/api/cron/monthly/route.ts");
  is("the weekly and monthly emails count before reading the numbers, and let the week or month go when not counted", [weekly.indexOf("countUnits(store, STUDIO_PAGE_UNITS)") > 0 && weekly.indexOf("countUnits(store, STUDIO_PAGE_UNITS)") < weekly.indexOf("readNumbers(store)"), weekly.includes("await releaseWeek(store.handle).catch(() => undefined); out.deferred += 1; continue;"), monthly.indexOf("countUnits(store, STUDIO_PAGE_UNITS)") > 0 && monthly.indexOf("countUnits(store, STUDIO_PAGE_UNITS)") < monthly.indexOf("readNumbers(store)"), monthly.includes("await releaseMonth(store.handle, month).catch(() => undefined); out.deferred += 1; continue;")], [true, true, true, true]);
  const sends = flat("lib/broadcasts.ts");
  is("a subject test's sales: counted first; not counted, it waits saying why, its winner not chosen", [sends.includes('if (!(await salesCount(store, counting.count).read())) return "not_counted";'), sends.includes('b = { ...b, status: "waiting", note: testNotCountedNote(testCounting.said.message) }; break;')], [true, true]);
  is("its note fits the record and says it is tried again", [testNotCountedNote("").endsWith("It is tried again automatically."), testNotCountedNote("x".repeat(NOTE_ROOM)).length <= NOTE_ROOM], [true, true]);

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
