/**
 * Which channel a sale is credited to (lib/visit-channel.ts, added 11 October
 * 2026), and what it does to the studio's numbers. What is checked:
 *
 *   - a visit is named the way the visit counter names it — a tag, a site, an
 *     app's built-in browser — and a typed-in visit, a visit from the store's
 *     own pages or a robot is not a channel at all;
 *   - the cookie keeps the latest channel and the first, forgets the latest
 *     after 30 days and the first after 90, and a broken one is ignored;
 *   - a sale is credited to the page's own tags first, then to the
 *     remembered channel, then to direct;
 *   - the proxy sets the cookie only where it may: never where the law asks
 *     first, never for Global Privacy Control, never for a visit from nowhere;
 *   - the studio reads the channel off Stripe's records, counts renewals under
 *     the channel the subscription was sold through, and keeps subscriptions
 *     sold before any of this apart instead of calling them direct.
 */
import { NextRequest } from "next/server";
import {
  CHANNEL_COOKIE_SECONDS,
  channelCookieName,
  channelForSale,
  channelMetadata,
  channelOfRequest,
  nextChannelCookie,
  readChannelCookie,
  touchFrom,
} from "@/lib/visit-channel";
import { readSales, renewalsFrom, withRenewals, UNRECORDED } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { proxy } from "@/proxy";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const HOST = "marktmorgen.com";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const INSTAGRAM_APP = `${PHONE} Instagram 340.0.0.0`;
const NOW = Date.UTC(2026, 9, 11, 12);
const nowS = NOW / 1000;
const DAY = 86400;

const touch = (url: string, referrer = "", userAgent = PHONE) =>
  touchFrom({ url: new URL(url), referrer, userAgent, ownHost: HOST });

let sessions: Record<string, unknown>[] = [];
let invoices: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }));
  if (path === "/checkout/sessions") return list(sessions);
  if (path === "/invoices") return list(invoices);
  return list([]);
}) as typeof fetch;

async function main(): Promise<void> {
  part("A visit, named");
  is("a tagged link", touch(`https://${HOST}/@jenny?utm_source=Newsletter&utm_medium=email&utm_campaign=spring&utm_content=Reel-B`), {
    source: "newsletter",
    medium: "email",
    campaign: "spring",
    content: "reel-b",
  });
  is("a site that sent the visitor", touch(`https://${HOST}/@jenny`, "https://www.youtube.com/watch?v=1"), { source: "youtube", medium: "", campaign: "", content: "" });
  is("Instagram's own browser, which sends no referrer", touch(`https://${HOST}/@jenny`, "", INSTAGRAM_APP), { source: "instagram", medium: "", campaign: "", content: "" });
  is("typed in, or a bookmark: no channel", touch(`https://${HOST}/@jenny`), null);
  is("from the store's own pages: no channel", touch(`https://${HOST}/@jenny/p/x`, `https://${HOST}/@jenny`), null);
  is("a robot: no channel", touch(`https://${HOST}/@jenny?utm_source=x`, "", "Googlebot/2.1"), null);

  part("What the cookie keeps");
  const first = nextChannelCookie(undefined, { source: "tiktok", medium: "", campaign: "" }, nowS - 20 * DAY);
  const second = nextChannelCookie(first, { source: "newsletter", medium: "email", campaign: "spring" }, nowS - 2 * DAY);
  const read = readChannelCookie(second, nowS);
  is("the latest channel, and the first kept", read && [read.last, read.medium, read.campaign, read.first], ["newsletter", "email", "spring", "tiktok"]);
  is("the latest forgotten after 30 days", readChannelCookie(second, nowS - 2 * DAY + CHANNEL_COOKIE_SECONDS + 60), null);
  const old = nextChannelCookie(undefined, { source: "tiktok", medium: "", campaign: "" }, nowS - 100 * DAY);
  const later = [ "google", "", "", Math.floor(nowS - DAY), "tiktok", Math.floor(nowS - 100 * DAY) ].join("~");
  is("a first channel older than 90 days gives way to the latest", readChannelCookie(later, nowS)?.first, "google");
  is("a cookie that was written long ago is not read at all", readChannelCookie(old, nowS), null);
  is("a broken one is ignored", [readChannelCookie("x", nowS), readChannelCookie("a~b~c~nope~d~1", nowS), readChannelCookie("<s>~~~1~a~1", nowS)], [null, null, null]);
  is("one cookie per store", channelCookieName("jenny"), "nl_ch_jenny");

  part("What a sale is credited to");
  const remembered = readChannelCookie(second, nowS);
  is("the page's own tags win", channelForSale({ source: "qr", medium: "print", campaign: "" }, remembered), { channel: "qr", first: "tiktok", medium: "print", campaign: "", content: "" });
  is("then the remembered channel", channelForSale({ source: "", medium: "", campaign: "" }, remembered), { channel: "newsletter", first: "tiktok", medium: "email", campaign: "spring", content: "" });
  is("then direct", channelForSale({ source: "", medium: "", campaign: "" }, null), { channel: "direct", first: "direct", medium: "", campaign: "", content: "" });
  is("written to Stripe without empty fields", channelMetadata(channelForSale({ source: "", medium: "", campaign: "" }, null)), { channel: "direct", channel_first: "direct" });
  const checkoutRequest = new NextRequest(`https://${HOST}/api/store/checkout`, {
    method: "POST",
    headers: { referer: `https://${HOST}/@jenny/p/abc`, cookie: `${channelCookieName("jenny")}=${second}` },
  });
  is("a checkout reads its cookie and its page", channelOfRequest(checkoutRequest, "jenny", HOST, nowS), {
    channel: "newsletter",
    channel_first: "tiktok",
    channel_medium: "email",
    channel_campaign: "spring",
  });

  part("Where the proxy sets it");
  const visit = async (url: string, headers: Record<string, string>) => {
    const response = await proxy(new NextRequest(url, { headers: { host: HOST, "user-agent": PHONE, ...headers } }));
    return response.cookies.get(channelCookieName("jenny"))?.value ?? null;
  };
  const set = await visit(`https://${HOST}/@jenny?utm_source=newsletter`, { "x-vercel-ip-country": "US" });
  is("a tagged visit from the US is remembered", set ? set.split("~").slice(0, 3) : null, ["newsletter", "", ""]);
  is("from Germany: not set", await visit(`https://${HOST}/@jenny?utm_source=newsletter`, { "x-vercel-ip-country": "DE" }), null);
  is("from a country we cannot tell: not set", await visit(`https://${HOST}/@jenny?utm_source=newsletter`, {}), null);
  is("with Global Privacy Control: not set", await visit(`https://${HOST}/@jenny?utm_source=newsletter`, { "x-vercel-ip-country": "US", "sec-gpc": "1" }), null);
  is("a typed-in visit: not set", await visit(`https://${HOST}/@jenny`, { "x-vercel-ip-country": "US" }), null);
  is("a page that is no store's: not set", (await proxy(new NextRequest(`https://${HOST}/pricing?utm_source=x`, { headers: { host: HOST, "user-agent": PHONE, "x-vercel-ip-country": "US" } }))).headers.get("set-cookie")?.includes("nl_ch_") ?? false, false);

  part("In the studio's numbers");
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_channels_only_a_stand_in";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  const store = (await storeForEmail("owner@example.com"))!;
  const at = (daysAgo: number) => Math.floor((NOW - daysAgo * 86_400_000) / 1000);
  const session = (amount: number, metadata: Record<string, string>) => ({
    id: `cs_${amount}`,
    status: "complete",
    payment_status: "paid",
    amount_total: amount,
    currency: "usd",
    created: at(1),
    metadata: { store: "harbor", product: "p1", ...metadata },
  });
  sessions = [
    session(5000, { channel: "instagram", channel_first: "tiktok" }),
    session(3000, { utm_source: "newsletter", channel: "newsletter", channel_first: "instagram" }),
    session(2000, { channel: "direct", channel_first: "direct" }),
    session(1000, {}),
  ];
  let invoiceNumber = 0;
  const invoice = (meta: Record<string, string>, amount: number) => ({
    id: `in_channel_${++invoiceNumber}`,
    status: "paid",
    billing_reason: "subscription_cycle",
    amount_paid: amount,
    currency: "usd",
    created: at(3),
    status_transitions: { paid_at: at(3) },
    subscription_details: { metadata: { store: "harbor", product: "club", ...meta } },
  });
  invoices = [invoice({ channel: "instagram" }, 900), invoice({ channel: "direct" }, 700), invoice({}, 500)];
  const renewals = renewalsFrom(store, invoices, NOW, "usd");
  is("renewals by the channel their membership was sold through", renewals.bySource, [
    { source: "instagram", payments: 1, cents: 900 },
    { source: "", payments: 1, cents: 700 },
    { source: UNRECORDED, payments: 1, cents: 500 },
  ]);
  const sales = await readSales(store, NOW);
  is("sales by channel, untagged and unremembered as direct (a tie goes by name)", sales?.bySource.map((r) => [r.source, r.cents]), [
    ["instagram", 5000],
    ["direct", 3000],
    ["newsletter", 3000],
  ]);
  is("sales by the first channel", sales?.firstBySource?.map((r) => [r.source, r.cents]), [
    ["tiktok", 5000],
    ["direct", 3000],
    ["instagram", 3000],
  ]);
  is("each channel with what it went on to bring", withRenewals(sales!.bySource, sales!.renewals!.bySource!).map((r) => [r.source, r.cents, r.renewalCents]), [
    ["instagram", 5000, 900],
    ["direct", 3000, 700],
    ["newsletter", 3000, 0],
    [UNRECORDED, 0, 500],
  ]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
