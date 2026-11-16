/**
 * Conversions sent from the server, complete (lib/ad-consent.ts,
 * lib/ad-events.ts; added 12 October 2026). Checked:
 *
 *   - the buyer's yes, readable by the server, with the ad click they came
 *     from, gone after thirty days;
 *   - a checkout keeps the request that opened it only with that yes, on a
 *     store that sends from the server;
 *   - a paid order goes to Meta, TikTok, Google Analytics and Pinterest when
 *     Stripe says it is paid, whether or not the buyer came back, marked new
 *     or returning, once, and never for another store's order or a gift of
 *     support;
 *   - a membership's renewal goes as a purchase of its own, with no address
 *     or browser, once;
 *   - a sign-up goes as a lead, not to Google, only with the yes.
 */
import { clicksFrom, leadIdOf, nextAdsCookie, readAdsCookie, adsCookieName, parseAdsServer } from "@/lib/ad-consent";
import {
  adEventId,
  adsCheckout,
  gaClientId,
  gaSessionId,
  googleEmail,
  newLeadId,
  sendPaidOrders,
  sendRenewals,
  sendServerLead,
  sendServerPurchase,
  serverSetup,
  setServerToken,
  sha256,
} from "@/lib/ad-events";
import { NO_PIXELS } from "@/lib/pixels";
import { claimHandle, ensureStatsId, setAdsServer, setPixels, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_server_conversions_stand_in";

const OWNER = "owner@example.com";
const NOW = Date.now();
const SEC = Math.floor(NOW / 1000);
const TOKENS = { meta: "EAAB" + "m".repeat(60), tiktok: "tt" + "t".repeat(40), google: "G00gleApiSecret_abcdefgh", pinterest: "pina_" + "p".repeat(50) };

/** An event as Meta, TikTok or Pinterest takes it, with the fields read here. */
type Ev = { event_id: string; event_name: string; action_source: string; event_source_url?: string; custom_data: Record<string, unknown>; user_data: Record<string, unknown> };
type Out = { host: string; url: string; body: Record<string, unknown>; headers: Record<string, string> };
const out: Out[] = [];
let sessions: Record<string, unknown>[] = [];
let invoices: Record<string, unknown>[] = [];
const stripeAsked: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (["graph.facebook.com", "business-api.tiktok.com", "www.google-analytics.com", "api.pinterest.com"].includes(url.hostname)) {
    out.push({ host: url.hostname, url: url.href, body: JSON.parse(String(init?.body)), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (url.hostname === "business-api.tiktok.com") return json({ code: 0, message: "OK" });
    if (url.hostname === "www.google-analytics.com") return new Response(null, { status: 204 });
    return json({ events_received: 1 });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  stripeAsked.push(path + url.search);
  const one = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (one) {
    const found = sessions.find((s) => s.id === one[1]);
    return found ? json(found) : json({ error: { message: "No such checkout session" } }, 404);
  }
  if (path === "/checkout/sessions") {
    const email = url.searchParams.get("customer_details[email]");
    const data = email ? sessions.filter((s) => (s.customer_details as { email: string }).email.toLowerCase() === email.toLowerCase()) : sessions;
    return json({ object: "list", data, has_more: false });
  }
  if (path === "/invoices") return json({ object: "list", data: invoices, has_more: false });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** A request as a route sees it: headers and cookies. */
function request(cookies: Record<string, string>, headers: Record<string, string> = {}) {
  return {
    headers: new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1", "user-agent": "Mozilla/5.0 (iPhone)", referer: "https://marktmorgen.com/@harbor/p/club?utm_source=x&order=secret", ...headers }),
    cookies: { get: (name: string) => (name in cookies ? { value: cookies[name] } : undefined) },
  };
}

const paid = (id: string, email: string, meta: Record<string, string>, created = SEC - 600, extra: Record<string, unknown> = {}) => ({
  id,
  status: "complete",
  payment_status: "paid",
  amount_total: 4900,
  currency: "usd",
  created,
  customer_details: { email },
  metadata: { store: "harbor", product: "club000001", ...meta },
  ...extra,
});

async function main(): Promise<void> {
  redis.clear();

  part("The buyer's yes, as the server reads it");
  const cookie = nextAdsCookie(undefined, "?ttclid=E.C.P.Cj0abc123&utm_source=tiktok&gclid=Cj0KCQabc123", SEC);
  is("kept with the ad click it came from, not Google's, which is never sent", readAdsCookie(cookie, SEC), { ttclid: "E.C.P.Cj0abc123", at: SEC });
  is("a later visit without a click keeps the click", readAdsCookie(nextAdsCookie(cookie, "", SEC + 60), SEC + 60), { ttclid: "E.C.P.Cj0abc123", at: SEC });
  is("a later ad's click takes its place", readAdsCookie(nextAdsCookie(cookie, "?epik=dj0yJnU9abc", SEC + 60), SEC + 60), { epik: "dj0yJnU9abc", at: SEC + 60 });
  is("after thirty days the yes stays and the click goes", readAdsCookie(cookie, SEC + 31 * 86400), {});
  is("no yes, nothing", [readAdsCookie(undefined, SEC), readAdsCookie("n", SEC)], [null, null]);
  is("only click ids that look like one", clicksFrom("?fbclid=<script>&ttclid=E.C.P.abc"), { ttclid: "E.C.P.abc" });
  is("a lead's id, or nothing", [leadIdOf(newLeadId())?.startsWith("ld_"), leadIdOf("ld_x"), leadIdOf(["ld_0123456789abcdef"])], [true, undefined, undefined]);
  is("only platforms it knows", parseAdsServer(["meta", "x", "google"]), ["meta", "google"]);

  part("Google's ids");
  is("the visitor's, from _ga", gaClientId("GA1.1.1234567890.1700000000"), "1234567890.1700000000");
  is("the visit's, in either shape", [gaSessionId("GS1.1.1700000500.3.1.1700000600.0.0.0"), gaSessionId("GS2.1.s1700000500$o3$g1$t1700000600$j0$l0$h0")], ["1700000500", "1700000500"]);
  is("Gmail's dots are not part of the address", googleEmail((" " + ("Jane.Doe" + "@" + "Gmail.com"))), ("janedoe" + "@" + "gmail.com"));

  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setPixels(OWNER, { ...NO_PIXELS, meta: "123456789012345", tiktok: "C4ABCDEFGH1234567890", google: "G-AB12CD34EF", pinterest: "2612345678901" });
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const yes = { [adsCookieName("harbor")]: nextAdsCookie(undefined, "?fbclid=IwAR0abc&epik=dj0yJnU9abc", SEC - 3600), _fbp: "fb.1.1.1", _ga: "GA1.1.111.222", _ga_AB12CD34EF: "GS1.1.1700000500.3.1.1700000600.0.0.0", _ttp: "ttp1" };

  part("A checkout keeps the request only with the yes");
  is("not on a store that sends nothing from the server", await adsCheckout(request(yes), store, NOW), {});
  is("Pinterest needs its ad account", await setServerToken(statsId, "pinterest", TOKENS.pinterest), "account");
  for (const p of ["meta", "tiktok", "google", "pinterest"] as const) await setServerToken(statsId, p, TOKENS[p], { account: "549755885175" });
  const setup = await serverSetup(statsId);
  is("all four on, the account shown, never a token", [setup.on, setup.pinterestAccount, JSON.stringify(setup).includes("pina_")], [{ meta: true, tiktok: true, google: true, pinterest: true }, "549755885175", false]);
  await setAdsServer(OWNER, ["meta", "tiktok", "google", "pinterest"]);
  store = (await storeForEmail(OWNER))!;
  is("without the yes, nothing kept", await adsCheckout(request({ _fbp: "fb.1.1.1" }), store, NOW), {});
  const meta = await adsCheckout(request(yes), store, NOW);
  is("with it, a pointer for the checkout's metadata", /^[0-9a-f]{24}$/.test(meta.ads ?? ""), true);
  const kept = JSON.parse(redis.run(["GET", `nl:adsrv:ctx:${meta.ads}`]) as string);
  is("the request kept: address, browser, page without its query, cookies and clicks", [kept.ip, kept.userAgent, kept.url, kept.cookies._gs, kept.cookies.fbclid, kept.cookies.epik], [
    "203.0.113.9",
    "Mozilla/5.0 (iPhone)",
    "https://marktmorgen.com/@harbor/p/club",
    "GS1.1.1700000500.3.1.1700000600.0.0.0",
    "IwAR0abc",
    "dj0yJnU9abc",
  ]);

  part("Paid orders, from the five-minute pass");
  sessions = [
    paid("cs_test_order000000001", "New@Example.com", { ads: meta.ads as string }, SEC - 600, { subscription: "sub_Club00000001" }),
    paid("cs_test_order000000002", "back@example.com", { ads: meta.ads as string }),
    paid("cs_test_order000000000", "back@example.com", {}, SEC - 90 * 86400),
    paid("cs_test_order000000003", "none@example.com", {}),
    { ...paid("cs_test_order000000004", "x@example.com", { ads: meta.ads as string }), metadata: { store: "another", product: "x", ads: meta.ads } },
    paid("cs_test_order000000005", "tip@example.com", { ads: meta.ads as string, kind: "tip" }),
  ];
  is("two sent: not without the yes, not another store's, not a gift of support", await sendPaidOrders(store, sessions, NOW), 2);
  is("each to all four platforms", out.map((o) => o.host).sort(), [
    "api.pinterest.com", "api.pinterest.com", "business-api.tiktok.com", "business-api.tiktok.com", "graph.facebook.com", "graph.facebook.com", "www.google-analytics.com", "www.google-analytics.com",
  ]);
  const metaOut = out.filter((o) => o.host === "graph.facebook.com").map((o) => (o.body.data as Ev[])[0]);
  const first = metaOut.find((e) => e.event_id === adEventId("cs_test_order000000001"))!;
  is("Meta: the id made from the order's, a website purchase, the money, new or returning", [
    first.event_name,
    first.action_source,
    first.event_source_url,
    first.custom_data.value,
    first.custom_data.customer_type,
    metaOut.find((e) => e.event_id === adEventId("cs_test_order000000002"))!.custom_data.customer_type,
  ], ["Purchase", "website", "https://marktmorgen.com/@harbor/p/club", 49, "new", "returning"]);
  is("matched with the hashed address, the browser, Meta's cookie and the click", [
    first.user_data.em,
    first.user_data.client_ip_address,
    first.user_data.fbp,
    String(first.user_data.fbc).endsWith(".IwAR0abc"),
  ], [[sha256("new@example.com")], "203.0.113.9", "fb.1.1.1", true]);
  const google = out.find((o) => o.host === "www.google-analytics.com" && JSON.stringify(o.body).includes(adEventId("cs_test_order000000001")))!;
  const gEvent = (google.body.events as { name: string; params: Record<string, unknown> }[])[0];
  is("Google: the visitor and the visit, the purchase with its transaction id", [
    new URL(google.url).searchParams.get("measurement_id"),
    new URL(google.url).searchParams.get("api_secret") === TOKENS.google,
    google.body.client_id,
    gEvent.name,
    gEvent.params.transaction_id,
    gEvent.params.session_id,
    gEvent.params.value,
    (google.body.consent as Record<string, string>).ad_user_data,
  ], ["G-AB12CD34EF", true, "111.222", "purchase", adEventId("cs_test_order000000001"), "1700000500", 49, "GRANTED"]);
  const pin = out.find((o) => o.host === "api.pinterest.com")!;
  const pEvent = (pin.body.data as Ev[])[0];
  is("Pinterest: to the ad account, with the click and the value as text", [
    new URL(pin.url).pathname,
    pin.headers.authorization === `Bearer ${TOKENS.pinterest}`,
    pEvent.event_name,
    pEvent.action_source,
    pEvent.user_data.click_id,
    pEvent.custom_data.value,
  ], ["/v5/ad_accounts/549755885175/events", true, "checkout", "web", "dj0yJnU9abc", "49"]);
  const tik = out.find((o) => o.host === "business-api.tiktok.com")!;
  is("TikTok: its token in its header, the pixel, the id", [tik.headers["access-token"] === TOKENS.tiktok, tik.body.event_source_id, (tik.body.data as { event: string }[])[0].event], [true, "C4ABCDEFGH1234567890", "CompletePayment"]);
  is("no token anywhere in what was sent", out.some((o) => JSON.stringify(o.body).includes(TOKENS.meta) || JSON.stringify(o.body).includes(TOKENS.pinterest)), false);
  out.length = 0;
  is("once: the next pass sends nothing", await sendPaidOrders(store, sessions, NOW), 0);
  is("nor the thanks page after it", await sendServerPurchase(store, "cs_test_order000000001", { ip: "", userAgent: "", url: "", cookies: {} }, NOW), "already");
  is("the studio sees the last answers", (await serverSetup(statsId)).last, { at: NOW, kind: "purchase", meta: "Received", tiktok: "Received", google: "Received", pinterest: "Received" });

  part("The thanks page, sooner");
  sessions.push(paid("cs_test_order000000006", "fast@example.com", { ads: meta.ads as string }));
  is("sent from the browser's request with what the checkout kept", await sendServerPurchase(store, "cs_test_order000000006", { ip: "198.51.100.1", userAgent: "UA", url: "u", cookies: { _fbp: "fb.1.9.9" } }, NOW), "sent");
  const fast = (out.find((o) => o.host === "graph.facebook.com")!.body.data as Ev[])[0];
  is("the checkout's address, the newer cookie", [fast.user_data.client_ip_address, fast.user_data.fbp], ["203.0.113.9", "fb.1.9.9"]);
  is("and the pass after it sends nothing more", await sendPaidOrders(store, sessions, NOW), 0);
  out.length = 0;

  part("A membership's renewals");
  const keptSub = JSON.parse(redis.run(["GET", "nl:adsrv:sub:sub_Club00000001"]) as string);
  is("what renewals go with: cookies and clicks, never an address or browser", [keptSub._fbp, keptSub.epik, "ip" in keptSub, JSON.stringify(keptSub).includes("203.0.113.9")], ["fb.1.1.1", "dj0yJnU9abc", false, false]);
  invoices = [
    { id: "in_Renew000001", status: "paid", billing_reason: "subscription_cycle", amount_paid: 4900, currency: "usd", customer_email: "new@example.com", created: SEC - 300, status_transitions: { paid_at: SEC - 300 }, parent: { subscription_details: { subscription: "sub_Club00000001", metadata: { store: "harbor", product: "club000001", ads: meta.ads } } } },
    { id: "in_First000001", status: "paid", billing_reason: "subscription_create", amount_paid: 4900, currency: "usd", customer_email: "new@example.com", created: SEC - 300, parent: { subscription_details: { subscription: "sub_Club00000001", metadata: { store: "harbor", ads: meta.ads } } } },
    { id: "in_NoYes000001", status: "paid", billing_reason: "subscription_cycle", amount_paid: 4900, currency: "usd", customer_email: "q@example.com", created: SEC - 300, parent: { subscription_details: { subscription: "sub_Other0000001", metadata: { store: "harbor" } } } },
  ];
  is("only the renewal of a membership bought with the yes", await sendRenewals(store, NOW), 1);
  const renewal = (out.find((o) => o.host === "graph.facebook.com")!.body.data as Ev[])[0];
  is("Meta: made by the subscription, a returning customer, no address or browser", [renewal.event_id, renewal.action_source, renewal.custom_data.customer_type, "client_ip_address" in renewal.user_data, "event_source_url" in renewal], [
    adEventId("in_Renew000001"),
    "system_generated",
    "returning",
    false,
    false,
  ]);
  is("Pinterest: offline", ((out.find((o) => o.host === "api.pinterest.com")!.body.data as Record<string, unknown>[])[0]).action_source, "offline");
  out.length = 0;
  is("once", await sendRenewals(store, NOW), 0);

  part("Sign-ups, as leads");
  const lead = newLeadId();
  is("not without the yes", await sendServerLead(store, request({}), { id: lead, email: "free@example.com", product: "guide00001" }, NOW), false);
  is("with it", await sendServerLead(store, request(yes), { id: lead, email: "free@example.com", product: "guide00001" }, NOW), true);
  is("to Meta, TikTok and Pinterest, not Google", out.map((o) => o.host).sort(), ["api.pinterest.com", "business-api.tiktok.com", "graph.facebook.com"]);
  const leadMeta = (out.find((o) => o.host === "graph.facebook.com")!.body.data as Record<string, unknown>[])[0];
  is("as a lead with the page's id, so the pixel's counts once", [leadMeta.event_name, leadMeta.event_id], ["Lead", lead]);
  is("once", await sendServerLead(store, request(yes), { id: lead, email: "free@example.com", product: "guide00001" }, NOW), false);

  part("Cost");
  is("one Stripe read per sale for new or returning, none per visit", stripeAsked.filter((p) => p.includes("customer_details")).length, 3);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
