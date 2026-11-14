/**
 * What the server sends the creator's ad platforms stays inside the yes the
 * buyer gave (tracking-consent hunt, November 2026):
 *
 * - Google is told the yes covers measuring the purchase (ad_user_data), never
 *   personalized advertising: the question the buyer answered names only which
 *   ads bring people here, and outside the countries that ask first no yes was
 *   given at all (lib/ad-events.ts googleBody).
 * - The thanks page's relay (app/api/store/ads-event) sends nothing for a
 *   browser that sends Global Privacy Control, whatever the page's script did.
 * - A sign-up for something free or for a waitlist goes as a lead without the
 *   typed address: it is not confirmed yet, so it may be another person's, who
 *   never said yes (the list's own confirm route still sends it, once used).
 *
 * Synthetic data; every platform is a stand-in fetch.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterTasks } from "./next-server-after-world";
import { adsCookieName, nextAdsCookie } from "@/lib/ad-consent";
import * as ads from "@/lib/ad-events";
import { NO_PIXELS } from "@/lib/pixels";
import { setSoon } from "@/lib/waitlist";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setAdsServer, setPixels, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { POST as adsEvent } from "@/app/api/store/ads-event/route";
import { POST as joinRoute } from "@/app/api/store/waitlist/join/route";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

// NIMBUS_DATA_KEY: the tests' own (tests/test-config.mjs testEnvironment).
process.env.STRIPE_SECRET_KEY = "sk_test_ads_consent_scope_stand_in";
process.env.RESEND_API_KEY = "re_test_waitlist_only"; // a synthetic credential the Resend fixture knows
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const NOW = Date.now();
const SEC = Math.floor(NOW / 1000);
const SESSION = "cs_test_s1C2o3P4e5F6g7H8i9J0kLmNoPqRsTuV";
const PLATFORMS = ["graph.facebook.com", "business-api.tiktok.com", "www.google-analytics.com", "api.pinterest.com"];
const TOKENS = { meta: "EAAB" + "m".repeat(60), tiktok: "tt" + "t".repeat(40), google: "G00gleApiSecret_abcdefgh", pinterest: "pina_" + "p".repeat(50) };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const sent: { host: string; body: string }[] = [];
let sessions: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (PLATFORMS.includes(url.hostname)) {
    sent.push({ host: url.hostname, body: String(init?.body) });
    if (url.hostname === "business-api.tiktok.com") return json({ code: 0, message: "OK" });
    if (url.hostname === "www.google-analytics.com") return new Response(null, { status: 204 });
    return json({ events_received: 1 });
  }
  if (url.hostname === "api.resend.com") return json({ id: "email_1" });
  const one = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
  if (one) {
    const found = sessions.find((s) => s.id === decodeURIComponent(one[1]));
    return found ? json(found) : json({ error: { message: "No such checkout session" } }, 404);
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const yes = () => `${adsCookieName("harbor")}=${nextAdsCookie(undefined, "", SEC - 3600)}; _fbp=fb.1.1.1`;

async function runAfter(): Promise<void> {
  while (afterTasks.length) {
    const task = afterTasks.shift();
    if (typeof task === "function") await (task as () => Promise<unknown>)();
  }
}

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "owner@example.com";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_harbor", subscriptionId: "sub_harbor", active: true, tier: "pro", period: paidPeriod() });
  await setStripeAccount(OWNER, "acct_1TestHarbor0003", true);
  await setPixels(OWNER, { ...NO_PIXELS, meta: "123456789012345", tiktok: "C4ABCDEFGH1234567890", google: "G-AB12CD34EF", pinterest: "2612345678901" });
  let store = (await storeForEmail(OWNER))!;
  for (const p of ["meta", "tiktok", "google", "pinterest"] as const) await ads.setServerToken(store.statsId!, p, TOKENS[p], { account: "549755885175" });
  await setAdsServer(OWNER, ["meta", "tiktok", "google", "pinterest"]);
  store = (await storeForEmail(OWNER))!;

  part("Google: the purchase is measured, never personalized advertising");
  const body = ads.googleBody(
    { kind: "purchase", id: "evt_1", at: SEC, cents: 4900, currency: "usd", products: ["p1"], email: "buyer@example.com", customer: null },
    { ip: "203.0.113.9", userAgent: "UA", url: "https://marktmorgen.com/@harbor", cookies: {} },
    SEC,
  ) as { consent: Record<string, string> };
  is("ad_user_data granted with the yes, ad_personalization denied", [body.consent.ad_user_data, body.consent.ad_personalization], ["GRANTED", "DENIED"]);

  part("The thanks page's relay with Global Privacy Control");
  const meta = await ads.adsCheckout({ headers: new Headers({ "x-forwarded-for": "203.0.113.200" }), cookies: { get: (name: string) => (name === adsCookieName("harbor") ? { value: nextAdsCookie(undefined, "", SEC - 3600) } : undefined) } }, store, NOW);
  sessions = [{ id: SESSION, status: "complete", payment_status: "paid", amount_total: 4900, currency: "usd", created: SEC - 600, customer_details: { email: "buyer@example.com" }, metadata: { store: "harbor", product: "club000001", ads: meta.ads as string } }];
  const relay = (headers: Record<string, string>) =>
    adsEvent(
      new NextRequest("https://marktmorgen.com/api/store/ads-event", {
        method: "POST",
        headers: { "content-type": "application/json", host: "marktmorgen.com", origin: "https://marktmorgen.com", referer: "https://marktmorgen.com/@harbor/thanks", "x-forwarded-for": "203.0.113.7", cookie: yes(), ...headers },
        body: JSON.stringify({ h: "harbor", t: ads.adEventRelay(SESSION, "harbor") }),
      }),
    );
  is("sec-gpc: 1 sends nothing to any platform", [(await relay({ "sec-gpc": "1" })).status, sent.length], [204, 0]);
  is("control: without it, the same relay is sent to the four platforms", [(await relay({})).status, sent.length], [204, 4]);

  part("A waitlist sign-up as a lead, without the typed address");
  sent.length = 0;
  // Its own store, with the same pixels and tokens, as tests/waitlist-join-suspended.test.ts sets one up.
  const LIST = "lister@example.com";
  await claimHandle(LIST, "harborlist", "Harbor List", "");
  await ensureStoreId(LIST);
  await ensureStatsId(LIST);
  await ensureListId(LIST);
  await setSubscription(LIST, { customerId: "cus_harborlist", subscriptionId: "sub_harborlist", active: true, tier: "pro", period: paidPeriod() });
  await setPixels(LIST, { ...NO_PIXELS, meta: "123456789012345", tiktok: "C4ABCDEFGH1234567890", google: "G-AB12CD34EF", pinterest: "2612345678901" });
  const lister = (await storeForEmail(LIST))!;
  for (const p of ["meta", "tiktok", "google", "pinterest"] as const) await ads.setServerToken(lister.statsId!, p, TOKENS[p], { account: "549755885175" });
  await setAdsServer(LIST, ["meta", "tiktok", "google", "pinterest"]);
  const made = await addProduct(LIST, "The Bread Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  await setSoon((await storeForEmail(LIST))!, made.product.id, true);
  const joined = await joinRoute(
    new NextRequest("https://marktmorgen.com/api/store/waitlist/join", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", host: "marktmorgen.com", origin: "https://marktmorgen.com", "x-forwarded-for": "7.7.7.7", cookie: `${adsCookieName("harborlist")}=${nextAdsCookie(undefined, "", SEC - 3600)}; _fbp=fb.1.1.1` },
      body: new URLSearchParams({ handle: "harborlist", product: made.product.id, email: "Someone.Else@Example.com" }).toString(),
    }),
  );
  is("the sign-up is taken, with a lead id", [joined.status, /[?&]status=sent&e=ld_[0-9a-f]{16}$/.test(joined.headers.get("location") ?? "")], [303, true]);
  await runAfter();
  is("the lead goes to the platforms that take sign-ups", sent.length > 0, true);
  const typed = sha256("someone.else@example.com");
  is("and none of them carries the typed address, hashed or not", sent.filter((s) => s.body.includes(typed) || s.body.toLowerCase().includes("someone.else")).length, 0);
  is("the free copy's route sends its lead the same way, without the address", readFileSync("app/api/store/free/route.ts", "utf8").includes('sendServerLead(store, request, { id: lead, email: "", product: product.id })'), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
