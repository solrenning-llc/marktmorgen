/**
 * The third part of the numbers added on 11 October 2026: a link for one
 * post and what that post brought, who is on the store right now, free
 * sign-ups by channel, the busy-day email and the MCP server
 * (lib/share-links.ts, lib/stats.ts, lib/stats-report.ts, app/api/mcp). What
 * is checked:
 *
 *   - a post's link carries where it went and the post's own name, and an
 *     unknown place is "other", never a word somebody typed;
 *   - each post's row joins its visits to its sales, money first;
 *   - "right now" counts each person once, under where they last came from,
 *     forgets anybody older than five minutes and lets go of the stale;
 *   - an address left in a sign-up box is counted under its channel;
 *   - a busy day is busy against the store's own usual, never against a
 *     quiet fortnight's single visit, and the email goes once a day, only to
 *     a store with a plan running whose creator has not stopped the emails;
 *   - the MCP server tells a client what it is without a key, reads nothing
 *     without one, reads its own store's numbers with one, and lists no
 *     buyer's address among its tools.
 */
import { POST_PLACES, postLink, postName } from "@/lib/share-links";
import { postRows, readLive, readStats, recordHit } from "@/lib/stats";
import { BUSY_FLOOR, isBusy, maybeBusyAlert, setWeeklyOff } from "@/lib/stats-report";
import { makeKey } from "@/lib/api-keys";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { GET as mcpGet, POST as mcp } from "@/app/api/mcp/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const OWNER = "owner@example.com";

const emails: { to: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    emails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return new Response(JSON.stringify({ id: `email_${emails.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

async function main(): Promise<void> {
  part("A link for one post");
  is("a name made fit for a link", [postName("  Outubro Reel #2 — Café! "), postName("---"), postName("a".repeat(60)).length], ["outubro-reel-2-cafe", "", 40]);
  is("where it went and which post", postLink("https://marktmorgen.com/@jenny", "tiktok", "October reel"), "https://marktmorgen.com/@jenny?utm_source=tiktok&utm_medium=post&utm_campaign=october-reel");
  is("an address with a query keeps it", postLink("https://marktmorgen.com/@jenny?x=1", "newsletter", "Issue 12"), "https://marktmorgen.com/@jenny?x=1&utm_source=newsletter&utm_medium=post&utm_campaign=issue-12");
  is("a place not on the list is 'other'", postLink("https://m.com/@j", "<script>", "a"), "https://m.com/@j?utm_source=other&utm_medium=post&utm_campaign=a");
  is("every place offered is a plain word", POST_PLACES.every((p) => /^[a-z]+$/.test(p.place)), true);

  part("What each post brought");
  const window = { campaigns: [{ name: "october-reel", visits: 40 }, { name: "story-1", visits: 90 }] } as Parameters<typeof postRows>[0];
  is("visits and money on one row, money first", postRows(window, [
    { campaign: "october-reel", source: "tiktok", cents: 9800, sales: 2 },
    { campaign: "issue-12", source: "newsletter", cents: 4900, sales: 1 },
  ]), [
    { campaign: "october-reel", source: "tiktok", visits: 40, sales: 2, cents: 9800 },
    { campaign: "issue-12", source: "newsletter", visits: 0, sales: 1, cents: 4900 },
    { campaign: "story-1", source: "", visits: 90, sales: 0, cents: 0 },
  ]);
  is("without sales, the visits alone", postRows(window, undefined).map((r) => [r.campaign, r.visits]), [["story-1", 90], ["october-reel", 40]]);

  part("Who is here now");
  redis.clear();
  process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  let store = (await storeForEmail(OWNER))!;
  const NOW = Date.UTC(2026, 9, 12, 12);
  const MIN = 60_000;
  const view = (ip: string, source: string, at: number) => recordHit(store, { kind: "view", source, ip, userAgent: PHONE, country: "US", device: "mobile" }, at);
  await view("192.0.2.1", "instagram", NOW - 40 * MIN);
  await view("192.0.2.2", "tiktok", NOW - 10 * MIN);
  await view("192.0.2.3", "instagram", NOW - 2 * MIN);
  await view("192.0.2.4", "instagram", NOW - 1 * MIN);
  await view("192.0.2.3", "", NOW - 30_000);
  const today = await view("192.0.2.5", "tiktok", NOW);
  is("a view says how many views the day has", today, 6);
  const live = await readLive(store, NOW);
  is("each person once, under where they last came from", live, {
    visitors: 3,
    sources: [{ source: "direct", visitors: 1 }, { source: "instagram", visitors: 1 }, { source: "tiktok", visitors: 1 }],
  });
  const left = redis.run(["ZCARD", `nl:stats:${store.statsId}:live`]);
  is("anybody older than half an hour is let go", left, 5);

  part("An address left in a sign-up box");
  await recordHit(store, { kind: "signup", ip: "192.0.2.3", userAgent: PHONE, channel: "instagram" }, NOW);
  await recordHit(store, { kind: "signup", ip: "192.0.2.4", userAgent: PHONE }, NOW);
  await recordHit(store, { kind: "signup", ip: "192.0.2.4", userAgent: "Googlebot/2.1" }, NOW);
  const stats = (await readStats(store, NOW))!;
  is("counted under its channel, untagged as direct, never a robot", stats.windows.d7.freeBySource, [{ name: "instagram", visits: 1 }, { name: "direct", visits: 1 }]);
  is("and it is not a checkout", stats.windows.d7.checkoutsBySource, []);

  part("A busy day");
  const fortnight = Array(14).fill(20);
  is("three times a usual day, past the floor and past the best day", isBusy(64, fortnight), { busy: true, times: 3 });
  is("under the floor is never busy", isBusy(BUSY_FLOOR - 1, Array(14).fill(1)).busy, false);
  is("a store that is always this busy is not", isBusy(200, Array(14).fill(150)).busy, false);
  is("not past the best day of the fortnight", isBusy(100, [...Array(13).fill(5), 120]).busy, false);
  is("a new store's first busy day", isBusy(64, []), { busy: true, times: 0 });

  // Today as the clock says, so the MCP server below reads the same views.
  const TODAY = Date.now();
  process.env.RESEND_API_KEY = "re_test_numbers_three_only";
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  store = (await storeForEmail(OWNER))!;
  for (let i = 0; i < 64; i += 1) await recordHit(store, { kind: "view", source: "tiktok", ip: `198.51.100.${i}`, userAgent: PHONE }, TODAY);
  is("a store with no plan is not written to", await maybeBusyAlert(store, 64, TODAY), false);
  await setSubscription(OWNER, { customerId: "cus_Busy00001", subscriptionId: "sub_Busy00001", active: true, period: paidPeriod() });
  store = (await storeForEmail(OWNER))!;
  is("only at 64, 128, 256…", await maybeBusyAlert(store, 65, TODAY), false);
  await setWeeklyOff("harbor", true);
  is("never after the creator stopped the emails", await maybeBusyAlert(store, 64, TODAY), false);
  await setWeeklyOff("harbor", false);
  is("written to once the day is busy", await maybeBusyAlert(store, 64, TODAY), true);
  is("to the creator, saying where they came from and how to stop it", [
    emails.length,
    emails[0]?.to,
    /Most of them came from TikTok\./.test(emails[0]?.text ?? ""),
    /To stop these emails/.test(emails[0]?.text ?? ""),
  ], [1, OWNER, true, true]);
  is("and once a day, however busy it gets", [await maybeBusyAlert(store, 128, TODAY), emails.length], [false, 1]);

  part("The MCP server");
  const rpc = (body: unknown, key?: string) =>
    mcp(new Request("https://marktmorgen.com/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }));
  const answer = async (body: unknown, key?: string) => (await (await rpc(body, key)).json()) as { result?: Record<string, unknown>; error?: { code: number } };
  const hello = await answer({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  is("it says what it is without a key", (hello.result?.serverInfo as { name: string })?.name, "marktmorgen");
  is("and nothing more without one", (await answer({ jsonrpc: "2.0", id: 2, method: "tools/list" })).error?.code, -32001);
  is("a wrong key reads nothing either", (await answer({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_store" } }, "nl_live_" + "0".repeat(40))).error?.code, -32001);
  is("a notification is taken without an answer", (await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  is("a batch is refused", (await answer([{ jsonrpc: "2.0", id: 4, method: "ping" }])).error?.code, -32600);
  is("broken JSON is a parse error", (await answer("{")).error?.code, -32700);
  is("GET is not offered", (await mcpGet()).status, 405);

  const made = await makeKey((await ensureStoreId(OWNER))!.sid, "Claude");
  if (!made.ok) throw new Error("no key made");
  const tools = (await answer({ jsonrpc: "2.0", id: 5, method: "tools/list" }, made.key)).result?.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
  is("with the key: twenty-two tools, all reading but the one that prepares a change", tools.map((t) => [t.name, t.annotations.readOnlyHint]), [
    ["get_numbers", true],
    ["list_products", true],
    ["get_revenue_by_channel", true],
    ["get_funnel", true],
    ["get_product_numbers", true],
    ["get_buyers", true],
    ["get_worth_knowing", true],
    ["get_memberships", true],
    ["get_emails", true],
    ["get_affiliates", true],
    ["get_live", true],
    ["get_numbers_for_days", true],
    ["get_product_description", true],
    ["get_sales_page", true],
    ["get_course_outline", true],
    ["get_lesson", true],
    ["get_page_test", true],
    ["get_page_reading", true],
    ["get_page_versions", true],
    ["list_saved_blocks", true],
    ["propose_product_description", false],
    ["get_store", true],
  ]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const got = (await answer({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name, arguments: args } }, made.key)).result as { content: { text: string }[]; isError: boolean };
    return { error: got.isError, data: JSON.parse(got.content[0].text) as Record<string, unknown>, text: got.content[0].text };
  };
  // Every tool, read: none answers with an address, the store owner's included.
  // A stretch of days needs its two ends (631 [AA1] unit 8); every other tool answers with no arguments.
  const ends = { from: new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) };
  // The tool that prepares a change needs a key allowed to (tests/agent-propose.test.ts); this read key is refused there.
  const readers = tools.filter((t) => t.annotations.readOnlyHint);
  const everything = await Promise.all(readers.map((t) => call(t.name, t.name === "get_numbers_for_days" ? ends : {})));
  // Tools about one product, page or lesson (631 [AA1] units 9 to 14) need it named: with nothing, they say so as an error.
  const needs = new Set(["get_product_description", "get_sales_page", "get_course_outline", "get_lesson", "get_page_test", "get_page_reading", "get_page_versions"]);
  is("each answers, and none of them hands out anybody's address", [everything.every((r, i) => !r.error || needs.has(readers[i].name)), everything.some((r) => /@/.test(r.text))], [true, false]);
  const channels = await call("get_revenue_by_channel", { days: 7 });
  is("revenue by channel for the days asked for", [channels.data.window, (channels.data.channels as { channel: string }[])[0]?.channel], ["last_7_days", "tiktok"]);
  const funnel = await call("get_funnel", { days: 90 });
  is("the funnel, with the days before", [funnel.data.window, typeof funnel.data.visitors, "the_same_days_before" in funnel.data], ["last_90_days", "number", true]);
  const own = await call("get_store");
  is("it reads its own store", [own.error, own.data.handle], [false, "harbor"]);
  const numbers = await call("get_numbers");
  const week = (numbers.data.days as Record<string, { visitors: number; channels: { channel: string }[] }>).last_7_days;
  is("and its numbers, as the API answers them", [numbers.error, week.visitors, week.channels[0]?.channel], [false, 64, "tiktok"]);
  is("a tool that is not there says so", (await call("list_leads")).error, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
