/**
 * The fifth part of the numbers, added on 11 October 2026: purchases sent to
 * Meta and TikTok from the server (lib/ad-events.ts), which ad sold
 * (utm_content), money by the buyer's country, refunds by channel, searches
 * that found nothing, what stops visitors and how far a video is watched
 * (lib/page-depth.ts), what changed in words (lib/insights.ts), and the
 * weekly email to the team. What is checked:
 *
 *   - a token is kept sealed and never as given, a purchase is sent once,
 *     only for a paid order of this store, only to a platform with both a
 *     pixel and a token, with the order's id as the event's and the email
 *     hashed, and what each platform answered is kept for the studio;
 *   - the ad a visitor came from is remembered beside the channel, and an old
 *     cookie without it still reads;
 *   - each sale's country and ad are read from Stripe, and a refund is put
 *     under the channel and product of the sale it gave back;
 *   - a search that found nothing is counted by its words;
 *   - an answer and a video's progress ride in the reading's one field;
 *   - a sentence is said only when its numbers are big enough;
 *   - a team member's stop link stops only their copy.
 */
import { adEventId, metaEvent, sendServerPurchase, serverSetup, setServerToken, sha256, tiktokEvent } from "@/lib/ad-events";
import { channelForSale, channelMetadata, nextChannelCookie, readChannelCookie } from "@/lib/visit-channel";
import { countSearchMiss, readSales, readStats, studioStats, type StatsData } from "@/lib/stats";
import { countDepth, depthField, readDepth } from "@/lib/page-depth";
import { insightsFrom } from "@/lib/insights";
import { leaveWeeklyTeam, setWeeklyTeam, weeklyMemberStopUrl, weeklyMemberToken, weeklyMemberTokenOk, weeklyStoreTokenOk, weeklyTeam, weeklyToken } from "@/lib/stats-report";
import { claimHandle, ensureStatsId, setAdsServer, setPixels, setStripeAccount, storeForEmail } from "@/lib/store";
import { NO_PIXELS } from "@/lib/pixels";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_numbers_five_stand_in";

const OWNER = "owner@example.com";
const NOW = Date.now();
const DAY = 86_400_000;
const META_TOKEN = "EAAB" + "x".repeat(60);
const TIKTOK_TOKEN = "tt" + "y".repeat(40);

let sessions: Record<string, unknown>[] = [];
let refunds: Record<string, unknown>[] = [];
let disputes: Record<string, unknown>[] = [];
const sentOut: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "graph.facebook.com" || url.hostname === "business-api.tiktok.com") {
    sentOut.push({ url: url.href, body: JSON.parse(String(init?.body)), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return url.hostname === "graph.facebook.com" ? json({ events_received: 1 }) : json({ code: 0, message: "OK" });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const one = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (one) {
    const found = sessions.find((s) => s.id === one[1]);
    return found ? json(found) : json({ error: { message: "No such checkout session" } }, 404);
  }
  if (path === "/checkout/sessions") return json({ object: "list", data: sessions, has_more: false });
  if (path === "/refunds") return json({ object: "list", data: refunds, has_more: false });
  if (path === "/disputes") return json({ object: "list", data: disputes, has_more: false });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const paid = (id: string, daysAgo: number, amount: number, meta: Record<string, string> = {}, country = "US", pi = "") => ({
  id,
  status: "complete",
  payment_status: "paid",
  amount_total: amount,
  currency: "usd",
  created: Math.floor((NOW - daysAgo * DAY) / 1000),
  customer_details: { email: "Buyer@Example.com ", address: { country } },
  payment_intent: pi || `pi_${id}`,
  metadata: { store: "harbor", product: "prod000001", ...meta },
});

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;

  part("Purchases sent from the server");
  is("a pasted pixel id is not a token", await setServerToken(statsId, "meta", "1234567890"), "invalid");
  is("a token is kept", await setServerToken(statsId, "meta", META_TOKEN), "saved");
  await setServerToken(statsId, "tiktok", TIKTOK_TOKEN);
  const kept = JSON.stringify(redis.keys().map((k) => redis.run(["GET", k])));
  is("sealed, never as it was given", [kept.includes(META_TOKEN), kept.includes(TIKTOK_TOKEN)], [false, false]);
  is("the studio is told which are on, never the token", (await serverSetup(statsId)).on, { meta: true, tiktok: true, google: false, pinterest: false });
  await setAdsServer(OWNER, ["meta", "tiktok"]);
  const buyer = { ip: "203.0.113.9", userAgent: "Mozilla/5.0 (iPhone)", url: "https://marktmorgen.com/@harbor/thanks", cookies: { _fbp: "fb.1.1.1", _ttp: "ttp1" } };
  sessions = [paid("cs_test_server00000001", 0, 4900), { ...paid("cs_test_server00000002", 0, 900), metadata: { store: "another", product: "x" } }];
  is("nothing goes without a pixel on the store", await sendServerPurchase(store, "cs_test_server00000001", buyer, NOW), "off");
  await setPixels(OWNER, { ...NO_PIXELS, meta: "123456789012345" });
  store = (await storeForEmail(OWNER))!;
  is("never for another store's order", await sendServerPurchase(store, "cs_test_server00000002", buyer, NOW), "invalid");
  is("sent for a paid order of this store", await sendServerPurchase(store, "cs_test_server00000001", buyer, NOW), "sent");
  is("once", await sendServerPurchase(store, "cs_test_server00000001", buyer, NOW), "already");
  is("only to the platform with a pixel and a token", sentOut.map((s) => new URL(s.url).hostname), ["graph.facebook.com"]);
  const metaSent = sentOut[0].body as { data: { event_id: string; user_data: Record<string, unknown>; custom_data: { value: number } }[] };
  is("with the id made from the order's, the email hashed and the money in dollars", [
    metaSent.data[0].event_id,
    metaSent.data[0].user_data.em,
    metaSent.data[0].user_data.fbp,
    metaSent.data[0].custom_data.value,
    new URL(sentOut[0].url).searchParams.get("access_token") === META_TOKEN && !JSON.stringify(metaSent).includes(META_TOKEN),
  ], [adEventId("cs_test_server00000001"), [sha256("buyer@example.com")], "fb.1.1.1", 49, true]);
  is("and what it answered is kept for the studio", (await serverSetup(statsId)).last?.meta, "Received");
  const order = { kind: "purchase" as const, id: "cs_x", at: 1, cents: 1000, currency: "usd", products: ["p"], email: null, customer: null };
  is("an order with no email sends none", [("em" in metaEvent(order, buyer).user_data), ("email" in tiktokEvent(order, buyer).user)], [false, false]);
  is("TikTok's has the same id", tiktokEvent(order, buyer).event_id, "cs_x");

  part("Which ad sold");
  const cookie = nextChannelCookie(undefined, { source: "instagram", medium: "paid", campaign: "launch", content: "reel-b" }, NOW / 1000);
  const remembered = readChannelCookie(cookie, NOW / 1000);
  is("the ad is remembered beside the channel", remembered?.content, "reel-b");
  is("an old cookie, without it, still reads", readChannelCookie(["tiktok", "", "", Math.floor(NOW / 1000), "tiktok", Math.floor(NOW / 1000)].join("~"), NOW / 1000)?.last, "tiktok");
  is("and goes onto the sale", channelMetadata(channelForSale({ source: "", medium: "", campaign: "" }, remembered)).channel_content, "reel-b");

  part("Country, ad and refunds, from Stripe");
  sessions = [
    paid("cs_test_sale0000000001", 1, 5000, { channel: "instagram", channel_content: "reel-b", channel_campaign: "launch" }, "DE"),
    paid("cs_test_sale0000000002", 2, 3000, { channel: "tiktok", channel_campaign: "launch" }, "US", "pi_refunded"),
    paid("cs_test_sale0000000003", 3, 2000, { channel: "instagram" }, "DE"),
  ];
  refunds = [
    { id: "re_test_fixture1", status: "succeeded", amount: 3000, currency: "usd", created: Math.floor((NOW - DAY) / 1000), payment_intent: "pi_refunded" },
    { id: "re_test_fixture2", status: "succeeded", amount: 500, currency: "usd", created: Math.floor((NOW - DAY) / 1000), payment_intent: "pi_unknown" },
    { id: "re_test_fixture3", status: "failed", amount: 999, currency: "usd", created: Math.floor((NOW - DAY) / 1000), payment_intent: "pi_refunded" },
    // From before the store changed its currency (22 [E5], unit 2b): left out of every amount, and counted.
    { id: "re_test_fixture4", status: "succeeded", amount: 700, currency: "eur", created: Math.floor((NOW - DAY) / 1000), payment_intent: "pi_old_currency" },
  ];
  // Disputes in euros: one the bank holds (counted), one the creator won (in no figure).
  disputes = [
    { id: "dp_test_fixture1", status: "lost", amount: 900, currency: "eur", created: Math.floor((NOW - DAY) / 1000), payment_intent: "pi_old_currency" },
    { id: "dp_test_fixture2", status: "won", amount: 400, currency: "eur", created: Math.floor((NOW - DAY) / 1000), payment_intent: "pi_old_currency" },
  ];
  const sales = (await readSales(store, NOW))!;
  is("money by the buyer's country", sales.byCountryIn?.d7, [{ country: "DE", cents: 7000, sales: 2 }, { country: "US", cents: 3000, sales: 1 }]);
  is("a campaign shared across channels is not labeled as only one", sales.byCampaignIn?.d7, [{ campaign: "launch", source: "", sources: ["instagram", "tiktok"], cents: 8000, sales: 2 }]);
  is("and by the ad", sales.byContentIn?.d7, [{ content: "reel-b", source: "instagram", campaign: "launch", cents: 5000, sales: 1 }]);
  is("a refund under the channel of the sale it gave back, one that matches none apart", sales.refundsIn?.d7, [
    { source: "tiktok", refunds: 1, cents: 3000 },
    { source: "unrecorded", refunds: 1, cents: 500 },
  ]);
  is("and under its product", sales.refundsByProduct, { prod000001: { refunds: 1, cents: 3000 } });
  is("daily refunds stay on their recorded date", sales.refundDays, { [new Date(NOW - DAY).toISOString().slice(0, 10)]: 3500 });
  is("a refund and a dispute in another currency are in none of those, counted apart; a dispute the creator won is not", [sales.takenBackElsewhere, sales.disputesIn?.d7], [{ refunds: 1, disputes: 1 }, []]);
  disputes = [];

  part("Reused ad names stay separate in the payment reading");
  const originalSessions = sessions;
  sessions = [...sessions,
    paid("cs_test_variant0000004", 1, 1500, { channel: "google", channel_campaign: "launch", channel_content: "reel-b" }, "US"),
    paid("cs_test_variant0000005", 1, 1200, { channel: "instagram", channel_campaign: "winter", channel_content: "reel-b" }, "DE"),
  ];
  const variants = (await readSales(store, NOW))!;
  is("one content name in different channels or campaigns is not merged", variants.byContentIn?.d7.map(r=>[r.content,r.source,r.campaign,r.cents,r.sales]), [
    ["reel-b","instagram","launch",5000,1],
    ["reel-b","google","launch",1500,1],
    ["reel-b","instagram","winter",1200,1],
  ]);
  sessions = originalSessions;

  part("Searched for and not found");
  await countSearchMiss(statsId, ["notion", "template"], NOW);
  await countSearchMiss(statsId, ["notion", "template"], NOW);
  await countSearchMiss(statsId, [], NOW);
  const data = studioStats(store, (await readStats(store, NOW))!, sales, "ok", []);
  is("counted by its words", data.searchMisses.d7, [{ name: "notion template", visits: 2 }]);
  is("all campaign payment channels reach the studio", data.posts.d7[0].sources, ["instagram", "tiktok"]);

  part("What stops visitors, and the video");
  is("one field for all of it", [
    depthField("blok0002", "price", "blok0001.50"),
    depthField("blok0002", "nonsense", "blok0001.50"),
    depthField("blok0002", "", "blok0001.33"),
    depthField("<x>", "price"),
  ], ["blok0002?price!blok0001.50", "blok0002!blok0001.50", "blok0002", null]);
  await countDepth(statsId, "prod000001", "blok0002", "price", "blok0001.100");
  await countDepth(statsId, "prod000001", "blok0003", "price", "blok0001.p");
  await countDepth(statsId, "prod000001", "blok0001", "details");
  const depth = await readDepth(statsId, "prod000001");
  is("the blocks still add up to the visitors", [depth.visitors, depth.stopped], [3, { blok0002: 1, blok0003: 1, blok0001: 1 }]);
  is("what stopped them", depth.whyNot, { price: 2, details: 1 });
  is("and how far the video went", depth.videos.blok0001, { played: 2, quarter: 1, half: 1, threeQuarters: 1, end: 1 });

  part("What changed, in words");
  const quiet = insightsFrom(data, "d7");
  is("a quiet week says little", quiet.length <= 1, true);
  const busy: StatsData = {
    ...data,
    cashflowComplete: true,
    refunds: { d7: [], d30: [], d90: [] },
    channelDays: { instagram: { [data.days[data.days.length - 1].date]: 9000 } },
    totals: { ...data.totals, d7: { visitors: 400, views: 600, checkouts: 30, sales: 3, cents: 9000 } },
    previous: { ...data.previous, d7: { visitors: 200, views: 300, checkouts: 10, sales: 6, cents: 12000 } },
    channels: {
      ...data.channels,
      d7: [
        { source: "instagram", visits: 200, checkouts: 20, free: 0, sales: 3, cents: 9000 },
        { source: "tiktok", visits: 150, checkouts: 5, free: 0, sales: 0, cents: 0 },
      ],
    },
  };
  const said = insightsFrom(busy, "d7", [{ id: "aaaaaaaa", channel: "tiktok", campaign: "", cents: 5000, from: data.days[data.days.length - 3].date, to: data.days[data.days.length - 1].date }]).map((i) => i.text);
  is("a negative recorded result comes first, without a budget instruction", /^TikTok received \$0 in payments in the last 7 days, with \$0 in refunds and \$50 in recorded ads\. -\$50 remains/.test(said[0] ?? ""), true);
  is("then the visitors, the buying and the checkouts", [
    said.some((t) => /More people visited: 400 .* up 100%/.test(t)),
    said.some((t) => /Fewer of your visitors bought: 0\.8% .* 3\.0%/.test(t)),
    said.some((t) => /Of 30 checkouts started, 3 were paid/.test(t)),
  ], [true, true, true]);
  is("never more than asked for", insightsFrom(busy, "d7", [], 2).length, 2);

  part("The weekly email to the team");
  // Rule 23 (claude5/email-stop-by-sid-2): the list is kept by the store's id, so it is set and read for a store.
  const harbor = { sid: "0123456789abcdef0123456789abcdef", handle: "harbor", previousHandles: [] as string[] };
  await setWeeklyTeam(harbor, ["Ana@Example.com", "ben@example.com"]);
  is("kept as addresses", await weeklyTeam(harbor), ["ana@example.com", "ben@example.com"]);
  const anaToken = weeklyMemberToken("harbor", "ana@example.com");
  is("a member's link is theirs alone", [
    weeklyMemberTokenOk("harbor", "ana@example.com", anaToken),
    weeklyMemberTokenOk("harbor", "ben@example.com", anaToken),
    weeklyMemberTokenOk("harbor", "ana@example.com", weeklyToken("harbor")),
  ], [true, false, false]);
  const anaLink = new URL(weeklyMemberStopUrl(harbor, "ana@example.com")).searchParams;
  is("a member's link, signed for the store's id, is theirs alone", [
    weeklyStoreTokenOk(harbor.sid, "harbor", anaLink.get("t")!, "ana@example.com"),
    weeklyStoreTokenOk(harbor.sid, "harbor", anaLink.get("t")!, "ben@example.com"),
    weeklyStoreTokenOk(harbor.sid, "harbor", anaLink.get("t")!),
  ], [true, false, false]);
  await leaveWeeklyTeam(harbor, "ana@example.com");
  is("and stops only their copy", await weeklyTeam(harbor), ["ben@example.com"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
