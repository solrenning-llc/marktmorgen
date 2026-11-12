/**
 * Where the money came from, three ways side by side, and how long after a
 * visit a sale is credited to it (lib/attribution-rules.ts,
 * lib/visit-channel.ts; added 12 October 2026). Checked:
 *
 *   - the window a creator chooses, and only the four it can be;
 *   - the channel cookie kept 90 days and read with the store's window;
 *   - each channel's money by the last visit, the first and what buyers said,
 *     on one row, answers that name several channels beside them;
 *   - the sales with no channel, split by what their buyers said, counted
 *     when the answer is given;
 *   - the studio's numbers carry it for each window, with the store's window.
 */
import { mock } from "node:test";
import { ATTRIBUTION_DAYS, attributionTable, parseAttributionDays } from "@/lib/attribution-rules";
import { CHANNEL_COOKIE_SECONDS, channelCookieName, channelOfRequest, nextChannelCookie, readChannelCookie } from "@/lib/visit-channel";
import { recordHeard } from "@/lib/heard";
import { readSales, readStats, studioStats } from "@/lib/stats";
import { claimHandle, ensureStatsId, setAttributionDays, setStripeAccount, storeForEmail } from "@/lib/store";
import { numbersContext } from "@/lib/numbers-ask";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
// The sales below are dated from NOW, taken once at load, while the week is read again from the clock: a run crossing
// 00:00 UTC (any day) lost what the buyers said (the podcast answer and Instagram's said column). Only Date is stopped,
// for the whole run; timers and performance.now() run as usual.
mock.timers.enable({ apis: ["Date"], now: Date.now() });

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_attribution_stand_in";

const OWNER = "owner@example.com";
const NOW = Date.now();
const SEC = Math.floor(NOW / 1000);
const DAY = 86_400;

let sessions: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  const one = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (one) {
    const found = sessions.find((s) => s.id === one[1]);
    return found ? json(found) : json({ error: { message: "No such checkout session" } }, 404);
  }
  if (path === "/checkout/sessions") return json({ object: "list", data: sessions, has_more: false });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const request = (cookies: Record<string, string>) => ({
  headers: new Headers({ referer: "https://marktmorgen.com/@harbor/p/x" }),
  cookies: { get: (name: string) => (name in cookies ? { value: cookies[name] } : undefined) },
});

const paid = (id: string, daysAgo: number, cents: number, meta: Record<string, string> = {}) => ({
  id,
  status: "complete",
  payment_status: "paid",
  amount_total: cents,
  currency: "usd",
  created: SEC - daysAgo * DAY,
  metadata: { store: "harbor", product: "prod000001", ...meta },
});

async function main(): Promise<void> {
  redis.clear();

  part("The window a creator chooses");
  is("7, 30, 60 or 90, and 30 for anything else", [ATTRIBUTION_DAYS, parseAttributionDays(60), parseAttributionDays("90"), parseAttributionDays(45), parseAttributionDays(null)], [[7, 30, 60, 90], 60, 90, 30, 30]);

  part("The channel cookie, read with the store's window");
  is("kept 90 days, the longest a creator can choose", CHANNEL_COOKIE_SECONDS, 90 * DAY);
  const cookie = nextChannelCookie(undefined, { source: "youtube", medium: "", campaign: "" }, SEC - 40 * DAY);
  is("a visit 40 days ago: not with 30 days, yes with 60", [readChannelCookie(cookie, SEC), readChannelCookie(cookie, SEC, 60)?.last], [null, "youtube"]);
  const name = channelCookieName("harbor");
  is("a checkout reads it with the store's window", [
    channelOfRequest(request({ [name]: cookie }), "harbor", "marktmorgen.com", SEC).channel,
    channelOfRequest(request({ [name]: cookie }), "harbor", "marktmorgen.com", SEC, 60).channel,
  ], ["direct", "youtube"]);
  const later = nextChannelCookie(cookie, { source: "instagram", medium: "", campaign: "" }, SEC);
  is("a quiet month does not lose where they first came from", [readChannelCookie(later, SEC)?.last, readChannelCookie(later, SEC)?.first], ["instagram", "youtube"]);

  part("Three ways, one row each");
  const table = attributionTable(
    [
      { source: "instagram", sales: 2, cents: 6000 },
      { source: "google", sales: 1, cents: 2000 },
      { source: "bing", sales: 1, cents: 1000 },
      { source: "direct", sales: 3, cents: 9000 },
    ],
    [
      { source: "youtube", sales: 3, cents: 7000 },
      { source: "instagram", sales: 1, cents: 2000 },
      { source: "direct", sales: 3, cents: 9000 },
    ],
    [
      { answer: "podcast", buyers: 2, cents: 5000, unknownBuyers: 2, unknownCents: 5000 },
      { answer: "instagram", buyers: 1, cents: 3000 },
      { answer: "search", buyers: 1, cents: 1000 },
      { answer: "friend", buyers: 1, cents: 0, unknownBuyers: 1, unknownCents: 0 },
    ],
  );
  is("each channel with its last visit, first visit and what buyers said", table.rows.map((r) => [r.name, r.last.cents, r.first.cents, r.said.cents]), [
    ["YouTube", 0, 7000, 0],
    ["Instagram", 6000, 2000, 3000],
    ["Podcasts", 0, 0, 5000],
    ["Search engines", 3000, 0, 1000],
    ["A friend, or a message", 0, 0, 0],
  ]);
  is("Google and Bing on one row with the answer that names them", table.rows.find((r) => r.key === "search")?.last, { sales: 2, cents: 3000 });
  is("no channel is not a row: it is split by what its buyers said", [table.unknown, table.unknownSaid.map((r) => [r.name, r.buyers, r.cents])], [
    { sales: 3, cents: 9000 },
    [["A podcast", 2, 5000], ["A friend, or a message", 1, 0]],
  ]);
  is("and the last visit adds up to all the money", table.total, { sales: 7, cents: 18000 });

  is("first visits keep no-channel money", table.unknownFirst, { sales: 3, cents: 9000 });
  is("both visit columns conserve purchases", [table.rows.reduce((n,r) => n+r.last.cents,table.unknown.cents),table.rows.reduce((n,r) => n+r.first.cents,table.unknownFirst?.cents ?? 0)], [18000,18000]);

  part("In the studio's numbers");
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  is("only one of the four", (await setAttributionDays(OWNER, 45)).ok, false);
  is("saved", (await setAttributionDays(OWNER, 60)).ok, true);
  const store = (await storeForEmail(OWNER))!;
  sessions = [
    paid("cs_test_attr00000001", 1, 4900, { channel: "instagram", channel_first: "youtube" }),
    paid("cs_test_attr00000002", 2, 2000, { channel: "direct", channel_first: "direct" }),
    paid("cs_test_attr00000003", 20, 1000, { channel: "google", channel_first: "google" }),
  ];
  is("an answer for a sale with a channel", await recordHeard(store, "cs_test_attr00000001", "instagram"), "counted");
  is("and for one with none", await recordHeard(store, "cs_test_attr00000002", "podcast"), "counted");
  const data = studioStats(store, (await readStats(store, NOW))!, (await readSales(store, NOW))!, "ok", []);
  const week = data.attribution!.d7;
  is("the week: Instagram by its last visit and what its buyer said, YouTube by the first", week.rows.map((r) => [r.key, r.last.cents, r.first.cents, r.said.cents]), [
    ["instagram", 4900, 0, 4900],
    ["youtube", 0, 4900, 0],
    ["podcast", 0, 0, 2000],
  ]);
  is("the sale with no channel, put down to a podcast by its buyer", [week.unknown, week.unknownSaid.map((r) => r.answer)], [{ sales: 1, cents: 2000 }, ["podcast"]]);
  is("the month has Google's sale too", data.attribution!.d30.rows.some((r) => r.key === "search" && r.last.cents === 1000), true);
  is("with the store's window", data.attributionDays, 60);
  const context = numbersContext(data) as Record<string, Record<string, unknown>>;
  is("and Ask your numbers can read it", (context.last_7_days.channels_three_ways as { channel: string }[]).map((r) => r.channel), ["Instagram", "YouTube", "Podcasts"]);

  is("studio keeps first-visit no channel", week.unknownFirst, { sales: 1, cents: 2000 });
  is("assistant keeps first-visit no channel", context.last_7_days.sales_with_no_first_visit_channel, { sales: 1, revenue: "$20" });
  is("partial attribution withheld from assistant", JSON.stringify(numbersContext({ ...data, partial: true })).includes("channels_three_ways"), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
