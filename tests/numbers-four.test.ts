/**
 * The fourth part of the numbers, added on 11 October 2026: how a page is
 * read (lib/page-read.ts), each figure beside the stretch before it, the AI
 * assistants as channels, notes on the chart (lib/stats-notes.ts), what was
 * spent on ads (lib/ad-spend-rules.ts), "where did you hear about us?"
 * (lib/heard.ts), the email when sales stop (lib/quiet-sales.ts), and who
 * stays (lib/membership-numbers.ts). What is checked:
 *
 *   - a page's token opens its own store's numbers for its own page and no
 *     other, and the store page's items are read back in order, each with how
 *     many reached it and clicked it;
 *   - all-time views are the sum of all-time sources, a record from before
 *     keeps what it counted, and a view writes no all-time "v";
 *   - each window is set beside the same stretch before it, for visits and
 *     for money, and money read in part is said to be unknown, not zero;
 *   - ChatGPT, Perplexity, Gemini and Gmail are named for what they are, and
 *     ChatGPT's own tag is the same channel as a visit it sent;
 *   - a note and a line of ad spend take only what they should, and spend is
 *     spread over the days it ran;
 *   - an answer is counted once, for a paid order of this store, and only
 *     while the creator asks;
 *   - a quiet stretch is quiet against the store's own pace, and the email
 *     goes once, only where it may;
 *   - a cohort is read only at ages all its members have reached.
 */
import { STORE_SCOPE, reachField, reachRows, readSampled, readToken, readTokenStats } from "@/lib/page-read";
import { countDepth, readDepth } from "@/lib/page-depth";
import { readStats, recordHit, readSales, studioStats } from "@/lib/stats";
import { classifySource } from "@/lib/source-rules";
import { cameFrom } from "@/lib/came-from";
import { addNote, readNotes, removeNote, noteDay } from "@/lib/stats-notes";
import { readSpend, spendBy, spendWithin } from "@/lib/ad-spend-rules";
import { addSpend, readSpends } from "@/lib/ad-spend";
import { heardOff, recordHeard, setHeardOff } from "@/lib/heard";
import { checkQuiet, isQuiet } from "@/lib/quiet-sales";
import { setWeeklyOff, summaryOf, weeklyMessage } from "@/lib/stats-report";
import { channelsFrom, cohortsFrom, type Sub } from "@/lib/membership-numbers";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { POST as readRoute } from "@/app/api/store/read/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_numbers_four_stand_in";
process.env.RESEND_API_KEY = "re_test_numbers_four_only";

const OWNER = "owner@example.com";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const DAY = 86_400_000;

let sessions: Record<string, unknown>[] = [];
let sessionsHaveMore = false;
let cappedPage = 0;
const emails: { to: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    emails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return json({ id: `email_${emails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const one = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (one) {
    const found = sessions.find((s) => s.id === one[1]);
    return found ? json(found) : json({ error: { message: "No such checkout session" } }, 404);
  }
  if (path === "/checkout/sessions") {
    const since = Number(url.searchParams.get("created[gte]") ?? 0);
    if (!url.searchParams.has("starting_after")) cappedPage = 0;
    const page = ++cappedPage;
    const rows = sessions.filter((s) => Number(s.created) >= since);
    return json({ object: "list", data: sessionsHaveMore ? rows.map(row=>({...row,id:String(row.id)+"_page"+page})) : rows, has_more: sessionsHaveMore });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function fresh(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
}

async function main(): Promise<void> {
  part("A page's token");
  await fresh();
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  // A visit's nonce the server's draw measures (lib/page-read.ts, readSampled), a fresh one each time.
  let seed = 0;
  const drawn = () => {
    for (;;) {
      const nonce = `visit${String((seed += 1)).padStart(11, "0")}`;
      if (readSampled(nonce)) return nonce;
    }
  };
  const tokenFor = (scope: string) => readToken(statsId, scope, Date.now(), drawn());
  const productToken = tokenFor("prod000001");
  is("opens its own store's numbers for its own page", readTokenStats(productToken, "prod000001"), statsId);
  is("and no other page", readTokenStats(productToken, "prod000002"), null);
  is("not the store page either", readTokenStats(productToken, STORE_SCOPE), null);
  const forged = `${"a".repeat(32)}.${productToken.split(".").slice(1).join(".")}`;
  is("nor another store's numbers with the same signature", readTokenStats(forged, "prod000001"), null);
  is("nothing opens nothing", [readTokenStats("", "prod000001"), readTokenStats("x.y", "prod000001")], [null, null]);

  part("The store page, item by item");
  is("a field is what a page sends, and nothing else", [
    reachField(3, "p:prod000001", "l:link01"),
    reachField(3, "p:prod000001", ""),
    reachField(-1, "p:x", ""),
    reachField(2, "<script>", ""),
    reachField(2, "p:prod000001", "javascript:"),
  ], ["sr:3.p:prod000001>l:link01", "sr:3.p:prod000001>", null, null, null]);
  const { visitors, rows } = reachRows({
    "0.p:aaa>": 10,
    "2.l:bbb>l:bbb": 6,
    "2.l:bbb>": 4,
    "4.s:faq>p:aaa": 5,
    "1.p:ccc>": 3,
    nonsense: 9,
  });
  is("each measured visit once", visitors, 28);
  is("in the order of the page, each with how many reached it and clicked it", rows.map((r) => [r.item, r.position, r.reached, r.clicks]), [
    ["p:aaa", 0, 28, 5],
    ["p:ccc", 1, 18, 0],
    ["l:bbb", 2, 15, 6],
    ["s:faq", 4, 5, 0],
  ]);

  part("Measured through the route, once a visit");
  const send = (body: Record<string, unknown>, userAgent = PHONE) =>
    readRoute(new Request("https://marktmorgen.com/api/store/read", { method: "POST", headers: { "user-agent": userAgent }, body: JSON.stringify({ h: "harbor", ...body }) }) as never);
  await send({ t: tokenFor("prod000001"), k: "d", p: "prod000001", b: "blok0001" });
  await send({ t: tokenFor("prod000001"), k: "d", p: "prod000001", b: "blok0002" });
  await send({ t: tokenFor("prod000001"), k: "d", p: "prod000002", b: "blok0001" });
  await send({ t: tokenFor("prod000001"), k: "d", p: "prod000001", b: "blok0001" }, "Googlebot/2.1");
  is("a sales page's furthest block, for its own page, never a robot's", await readDepth(statsId, "prod000001"), { visitors: 2, stopped: { blok0001: 1, blok0002: 1 }, whyNot: {}, videos: {}, time: {} });
  is("and none for a page the token is not for", (await readDepth(statsId, "prod000002")).visitors, 0);
  await countDepth(statsId, "prod000001", "blok0002");
  is("the visitors are the blocks added up", (await readDepth(statsId, "prod000001")).visitors, 3);
  await send({ t: tokenFor(STORE_SCOPE), k: "s", n: 2, b: "l:link01", c: "l:link01" });
  await send({ t: tokenFor(STORE_SCOPE), k: "s", n: 0, b: "p:prod000001", c: "" });
  await send({ t: tokenFor("prod000001"), k: "s", n: 0, b: "p:prod000001", c: "" });
  const reachStats = (await readStats(store))!;
  is("the store page's, on the day's record", reachStats.windows.d7.reach, { "2.l:link01>l:link01": 1, "0.p:prod000001>": 1 });

  part("All-time views");
  await fresh();
  store = (await storeForEmail(OWNER))!;
  const NOW = Date.now();
  for (const [ip, source] of [["192.0.2.1", "instagram"], ["192.0.2.2", "instagram"], ["192.0.2.3", "tiktok"]]) {
    await recordHit(store, { kind: "view", source, ip, userAgent: PHONE }, NOW);
  }
  const lifeKey = `nl:stats:${store.statsId}:life`;
  is("a view writes no all-time count of its own", redis.run(["HGET", lifeKey, "v"]), null);
  let life = (await readStats(store, NOW))!.life!;
  is("all-time views are the sources added up", [life.views, life.sources], [3, [{ name: "instagram", visits: 2 }, { name: "tiktok", visits: 1 }]]);
  // A record from before: it counted 50 views in "v" that its sources no longer hold.
  redis.run(["HSET", lifeKey, "v", 53]);
  redis.run(["HDEL", lifeKey, "vgap"]);
  life = (await readStats(store, NOW))!.life!;
  is("a record from before keeps what it counted", life.views, 53);
  await recordHit(store, { kind: "view", source: "x", ip: "192.0.2.4", userAgent: PHONE }, NOW);
  is("and goes on counting from there", (await readStats(store, NOW))!.life!.views, 54);

  part("Each window beside the stretch before it");
  await fresh();
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  store = (await storeForEmail(OWNER))!;
  const at = (daysAgo: number) => NOW - daysAgo * DAY;
  for (let i = 0; i < 4; i += 1) await recordHit(store, { kind: "view", source: "instagram", ip: `198.51.100.${i}`, userAgent: PHONE }, at(1));
  for (let i = 0; i < 2; i += 1) await recordHit(store, { kind: "view", source: "instagram", ip: `198.51.100.${i}`, userAgent: PHONE }, at(9));
  await recordHit(store, { kind: "view", source: "tiktok", ip: "198.51.100.9", userAgent: PHONE }, at(120));
  const visits = (await readStats(store, NOW))!;
  is("the 7 days before the last 7", visits.previous.d7, { visitors: 2, views: 2, checkouts: 0 });
  is("and the 90 before the last 90", [visits.previous.d90.views, visits.previous.d90.visitors], [1, 1]);
  const paid = (id: string, daysAgo: number, amount: number) => ({
    id,
    status: "complete",
    payment_status: "paid",
    amount_total: amount,
    currency: "usd",
    created: Math.floor(at(daysAgo) / 1000),
    metadata: { store: "harbor", product: "prod000001" },
  });
  sessions = [paid("cs_test_aaaaaaaaaa01", 2, 4900), paid("cs_test_aaaaaaaaaa02", 10, 2000), paid("cs_test_aaaaaaaaaa03", 100, 1000)];
  const sales = (await readSales(store, NOW))!;
  is("money in the stretch before, read from Stripe", [sales.previous?.d7, sales.previous?.d90], [{ sales: 1, cents: 2000 }, { sales: 1, cents: 1000 }]);
  is("and the 90 days themselves are as before", sales.totals.d90, { sales: 2, cents: 6900 });
  sessionsHaveMore = true;
  const partly = (await readSales(store, NOW))!;
  is("a stretch the reading did not reach all of is unknown, not zero", partly.previous?.d90, null);
  sessionsHaveMore = false;
  const data = studioStats(store, visits, sales, "ok", []);
  is("the studio has both", [data.previous.d7.visitors, data.previous.d7.cents], [2, 2000]);
  const summary = summaryOf(data);
  is("so does the API", summary.days.last_7_days.previous, { available: true, visitors: 2, page_views: 2, checkouts: 0, sales: 1, revenue: 2000 });
  part("Source traffic coverage survives legacy previous-period placeholders");
  is("confirmed source history available in all windows",data.previousTrafficAvailable,{d7:true,d30:true,d90:true});
  const previousCoverageMissing=studioStats(store,{...visits,previous:undefined} as unknown as typeof visits,sales,"ok",[]);
  is("missing source history is marked unavailable",previousCoverageMissing.previousTrafficAvailable,{d7:false,d30:false,d90:false});
  is("API does not expose legacy placeholders as real zeros",summaryOf(previousCoverageMissing).days.last_7_days.previous,{available:false,visitors:null,page_views:null,checkouts:null,sales:null,revenue:null});
  is("current results survive missing previous traffic",[previousCoverageMissing.totals.d7.visitors,previousCoverageMissing.totals.d7.cents],[4,4900]);
  const previousCoverageOneMissing=studioStats(store,{...visits,previous:{...visits.previous,d7:undefined}} as unknown as typeof visits,sales,"ok",[]);
  is("source windows have independent availability",[summaryOf(previousCoverageOneMissing).days.last_7_days.previous.available,summaryOf(previousCoverageOneMissing).days.last_30_days.previous.available],[false,true]);
  const previousCoverageZero=studioStats(store,{...visits,previous:{...visits.previous,d7:{visitors:0,views:0,checkouts:0}}},sales,"ok",[]);
  is("confirmed source zero traffic remains zero",[previousCoverageZero.previousTrafficAvailable?.d7,summaryOf(previousCoverageZero).days.last_7_days.previous.available,summaryOf(previousCoverageZero).days.last_7_days.previous.visitors],[true,true,0]);
  is("legacy stats data without the new flag retains reported history",summaryOf({...data,previousTrafficAvailable:undefined}).days.last_7_days.previous.visitors,2);
  const previousCoverageNoPayments=summaryOf(studioStats(store,visits,null,"error",[])).days.last_7_days.previous;
  is("payment failure does not hide complete prior traffic",[previousCoverageNoPayments.available,previousCoverageNoPayments.visitors,previousCoverageNoPayments.revenue],[true,2,null]);
  const weekly = weeklyMessage(store, data, "https://marktmorgen.com/x");
  is("and the weekly email says it in words", [/Visitors: 4 \(up 100% on the week before\)/.test(weekly?.text ?? ""), /\(up 145% on the week before\)/.test(weekly?.text ?? "")], [true, true]);

  part("The AI assistants, and where Gmail goes");
  const from = (referrer: string, utm = "") => classifySource({ referrer, utm, userAgent: PHONE, ownHost: "marktmorgen.com" });
  is("each by its name", [
    from("https://chatgpt.com/"),
    from("https://www.perplexity.ai/search/x"),
    from("https://claude.ai/chat/1"),
    from("https://gemini.google.com/app"),
    from("https://copilot.microsoft.com/"),
    from("https://www.google.com/"),
    from("https://mail.google.com/mail/u/0/"),
  ], ["chatgpt", "perplexity", "claude", "gemini", "copilot", "google", "email"]);
  is("ChatGPT's own tag is the same channel", [from("", "chatgpt.com"), cameFrom("https://marktmorgen.com/@harbor?utm_source=chatgpt.com", "marktmorgen.com").source], ["chatgpt", "chatgpt"]);

  part("Notes on the chart");
  const notesStats = store.statsId!;
  const today = new Date(NOW).toISOString().slice(0, 10);
  is("a day that is real and not ahead", [noteDay(today, NOW), noteDay("2026-02-30", NOW), noteDay("2999-01-01", NOW), noteDay("1999-01-01", NOW)], [today, "", "", ""]);
  await addNote(notesStats, today, "  Posted   the October reel ");
  is("words are not a note's without a day", await addNote(notesStats, "", "x"), null);
  let notes = await readNotes(notesStats);
  is("kept as one line", notes.map((n) => [n.day, n.text]), [[today, "Posted the October reel"]]);
  notes = await removeNote(notesStats, notes[0].id);
  is("and taken away", notes.length, 0);

  part("What was spent on ads");
  is("only what a line can be", [
    readSpend({ channel: "Instagram", cents: 12000, from: "2026-10-01", to: "2026-10-07" }, NOW).ok,
    readSpend({ channel: "direct", cents: 100, from: "2026-10-01", to: "2026-10-01" }, NOW),
    readSpend({ channel: "tiktok", cents: -5, from: "2026-10-01", to: "2026-10-01" }, NOW),
    readSpend({ channel: "tiktok", cents: 100.5, from: "2026-10-01", to: "2026-10-01" }, NOW),
    readSpend({ channel: "tiktok", cents: 100, from: "2026-10-07", to: "2026-10-01" }, NOW),
  ], [true, { ok: false, reason: "channel" }, { ok: false, reason: "amount" }, { ok: false, reason: "amount" }, { ok: false, reason: "days" }]);
  const line = { cents: 7000, from: "2026-10-01", to: "2026-10-07" };
  is("spread over the days it ran", [spendWithin(line, "2026-10-05", "2026-10-31"), spendWithin(line, "2026-09-01", "2026-09-30"), spendWithin(line, "2026-09-01", "2026-12-31")], [3000, 0, 7000]);
  const added = await addSpend(notesStats, { channel: "Instagram", campaign: "October Reel", cents: 7000, from: "2026-10-01", to: "2026-10-07" }, NOW);
  is("kept, the words as the numbers count them", added.ok ? added.spends.map((s) => [s.channel, s.campaign]) : null, [["instagram", "octoberreel"]]);
  const by = spendBy(await readSpends(notesStats), "2026-10-05", "2026-10-11");
  is("by channel and by post", [by.channels.get("instagram"), by.campaigns.get("octoberreel"), by.total], [3000, 3000, 3000]);

  part("Where did you hear about us?");
  await fresh();
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  store = (await storeForEmail(OWNER))!;
  sessions = [paid("cs_test_heard0000001", 0, 4900), { ...paid("cs_test_heard0000002", 0, 900), metadata: { store: "another", product: "x" } }];
  is("an answer that is not one is refused", await recordHeard(store, "cs_test_heard0000001", "everywhere"), "invalid");
  is("counted for a paid order of this store", await recordHeard(store, "cs_test_heard0000001", "friend"), "counted");
  is("once", await recordHeard(store, "cs_test_heard0000001", "friend"), "already");
  is("never for another store's order", await recordHeard(store, "cs_test_heard0000002", "friend"), "invalid");
  is("nor for one that does not exist", await recordHeard(store, "cs_test_heard0000009", "friend"), "invalid");
  const heardData = studioStats(store, (await readStats(store))!, null, "none", []);
  is("the studio shows the answer and the money of its sale", heardData.heard.d7, [{ answer: "friend", buyers: 1, cents: 4900, unknownBuyers: 1, unknownCents: 4900 }]);
  await setHeardOff("harbor", true);
  is("a creator who stops asking is not counted for", [await heardOff("harbor"), await recordHeard(store, "cs_test_heard0000001", "tiktok")], [true, "off"]);
  await setHeardOff("harbor", false);
  const kept = JSON.stringify(redis.keys().map((k) => redis.run(["HGETALL", k]) ?? redis.run(["GET", k])));
  is("nothing about the buyer is kept", /owner|example|cs_test_heard0000001"?\W*,\W*"?friend/.test(kept), false);

  part("When sales stop");
  const pace = (n: number, everyDays: number, lastDaysAgo: number) => Array.from({ length: n }, (_, i) => NOW - (lastDaysAgo + i * everyDays) * DAY);
  is("six a week, a week without one: quiet", isQuiet(pace(60, 7 / 6, 7), NOW).quiet, true);
  is("six a week, three days without one: not yet", isQuiet(pace(60, 7 / 6, 3), NOW).quiet, false);
  is("ten a day, two days without one: quiet", isQuiet(pace(500, 0.1, 2), NOW).quiet, true);
  is("twice a month, three weeks without one: its usual", isQuiet(pace(4, 15, 21), NOW).quiet, false);
  is("too few sales to know a pace", isQuiet(pace(5, 1, 9), NOW).quiet, false);

  await fresh();
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  store = (await storeForEmail(OWNER))!;
  sessions = pace(50, 1, 9).map((created, i) => ({ ...paid(`cs_test_quiet00000${String(i).padStart(2, "0")}`, 0, 2900), created: Math.floor(created / 1000) }));
  emails.length = 0;
  is("a store with no plan is not written to", await checkQuiet(store, NOW), "skipped");
  await setSubscription(OWNER, { customerId: "cus_Quiet00001", subscriptionId: "sub_Quiet00001", active: true, period: paidPeriod() });
  store = (await storeForEmail(OWNER))!;
  await setWeeklyOff("harbor", true);
  is("nor one whose creator stopped the emails", await checkQuiet(store, NOW), "skipped");
  await setWeeklyOff("harbor", false);
  is("written to once its sales have stopped", await checkQuiet(store, NOW + 3_600_000), "sent");
  is("saying so, and what to look at", [emails.length, emails[0]?.to, /no sales in 9 days/.test(emails[0]?.subject ?? ""), /Stripe dashboard/.test(emails[0]?.text ?? "")], [1, OWNER, true, true]);
  is("looked at once a day", await checkQuiet(store, NOW + 3_600_000), "seen");
  is("and written to once for the stretch", [await checkQuiet(store, NOW + 2 * DAY), emails.length], ["fine", 1]);

  part("Who stays");
  const s = Math.floor(NOW / 1000);
  const month = 30.4375 * 86400;
  const sub = (over: Partial<Sub>): Sub => ({ id: "sub", status: "active", product: "club", amount: 900, currency: "usd", interval: "month", count: 1, start: s - 200 * 86400, ended: 0, trialEnd: 0, channel: "instagram", canceledAt: 0, cancelCause: "", feedback: "", comment: "", ...over });
  const startOfMonth = (back: number) => {
    const d = new Date(NOW);
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 2) / 1000);
  };
  const four = startOfMonth(4);
  const subs = [
    sub({ start: four }),
    sub({ start: four + 3600, ended: four + 1.5 * month, status: "canceled", channel: "tiktok" }),
    sub({ start: startOfMonth(0), channel: "tiktok" }),
  ];
  const cohorts = cohortsFrom(subs, s);
  const old = cohorts.find((c) => c.month === new Date(four * 1000).toISOString().slice(0, 7));
  is("a cohort read at the ages its members have reached", old?.stayed, [1, 0.5, 0.5, null, null]);
  is("this month's cohort has no age yet", cohorts[0].stayed.every((x) => x === null), true);
  const channels = channelsFrom(subs, s);
  is("by channel: joined, still members, after three months", channels.map((c) => [c.channel, c.started, c.running, c.stayed3]), [
    ["tiktok", 2, 1, 0],
    ["instagram", 1, 1, 1],
  ]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
