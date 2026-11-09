/**
 * The thanks page asks this site's own server to send a purchase to the
 * creator's ad platforms (app/api/store/ads-event, lib/ad-events.ts), from
 * the buyer's browser, where the platforms' scripts run. Review of #2557
 * (Codex O, tests/review-o2557-client-capability.test.ts): what the page
 * hands the pixels' client component is serialized into the page, so the
 * checkout's own id (cs_…), which opens the order's downloads, review and
 * the rest, must never be one of its props.
 *
 * What it gets instead (adEventRelay): an opaque, sealed handle, good for one
 * thing (that request), one store and one hour, that only the ads-event route
 * opens. Checked here: its shape; that it opens only for its store, only
 * while fresh and only untouched; that the route sends with it and refuses the
 * checkout's own id; that it is no key to an order anywhere the checkout's
 * id is one (readOrder, which the download, review, course, call, Discord and
 * podcast routes all go through); and that the page and the pixels carry it
 * and nothing else.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { adsCookieName, nextAdsCookie } from "@/lib/ad-consent";
import * as ads from "@/lib/ad-events";
import { NO_PIXELS } from "@/lib/pixels";
import { readOrder } from "@/lib/store-checkout";
import { claimHandle, ensureStatsId, setAdsServer, setPixels, setStripeAccount, storeForEmail } from "@/lib/store";
import { POST } from "@/app/api/store/ads-event/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_ad_event_relay_stand_in";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

type Relay = (sessionId: string, handle: string, now?: number) => string;
type Open = (token: unknown, handle: string, now?: number) => string | null;
// Read through the module, so this file still runs, and fails, where the functions are missing.
const mod = ads as unknown as Record<string, unknown>;
const relayOf: Relay = (mod.adEventRelay as Relay | undefined) ?? (() => "");
const openRelay: Open = (mod.openAdEventRelay as Open | undefined) ?? (() => null);

const OWNER = "owner@example.com";
const NOW = Date.now();
const SEC = Math.floor(NOW / 1000);
const SESSION = "cs_test_r1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuV";
const TOKENS = { meta: "EAAB" + "m".repeat(60), tiktok: "tt" + "t".repeat(40), google: "G00gleApiSecret_abcdefgh", pinterest: "pina_" + "p".repeat(50) };

const sent: string[] = [];
const stripeReads: string[] = [];
let sessions: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (["graph.facebook.com", "business-api.tiktok.com", "www.google-analytics.com", "api.pinterest.com"].includes(url.hostname)) {
    sent.push(`${url.hostname} ${String(init?.body)}`);
    if (url.hostname === "business-api.tiktok.com") return json({ code: 0, message: "OK" });
    if (url.hostname === "www.google-analytics.com") return new Response(null, { status: 204 });
    return json({ events_received: 1 });
  }
  stripeReads.push(url.pathname);
  const path = url.pathname.replace(/^\/v1/, "");
  const one = /^\/checkout\/sessions\/([^/]+)$/.exec(path);
  if (one) {
    const found = sessions.find((s) => s.id === decodeURIComponent(one[1]));
    return found ? json(found) : json({ error: { message: "No such checkout session" } }, 404);
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const cookies = (): Record<string, string> => ({ [adsCookieName("harbor")]: nextAdsCookie(undefined, "", SEC - 3600), _fbp: "fb.1.1.1" });

let address = 0;
async function post(body: Record<string, unknown>): Promise<number> {
  address += 1;
  const response = await POST(
    new NextRequest("https://marktmorgen.com/api/store/ads-event", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "marktmorgen.com",
        origin: "https://marktmorgen.com",
        referer: "https://marktmorgen.com/@harbor/thanks",
        "x-forwarded-for": `203.0.113.${address}`,
        cookie: Object.entries(cookies()).map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: JSON.stringify(body),
    }),
  );
  return response.status;
}

async function main(): Promise<void> {
  redis.clear();

  part("The handle the page gives the pixels");
  const relay = relayOf(SESSION, "harbor", NOW);
  is("there is one", relay.length > 0, true);
  is("short enough for the route's body", relay.length <= 400, true);
  is("never the checkout's id, nor any part of it", [relay.includes(SESSION), relay.includes(SESSION.slice(8, 24)), /cs_(test|live)_/.test(relay)], [false, false, false]);
  is("sealed afresh every time, so two pages never share one", relayOf(SESSION, "harbor", NOW) === relay, false);
  is("opens to the checkout's id, for its store, while fresh", openRelay(relay, "harbor", NOW + 1000), SESSION);
  is("not for another store", openRelay(relay, "otherstore", NOW), null);
  is("not after its hour", openRelay(relay, "harbor", NOW + 3601 * 1000), null);
  const parts = relay.split(".");
  const last = parts[parts.length - 1];
  const flipped = [...parts.slice(0, -1), (last[0] === "A" ? "B" : "A") + last.slice(1)].join(".");
  is("not altered", [openRelay(flipped, "harbor", NOW), openRelay(relay.slice(0, -2), "harbor", NOW), openRelay(`${relay}x`, "harbor", NOW)], [null, null, null]);
  is("never the checkout's own id given in its place", openRelay(SESSION, "harbor", NOW), null);
  is("nothing that is not text", [openRelay(undefined, "harbor", NOW), openRelay(42, "harbor", NOW), openRelay({ s: SESSION }, "harbor", NOW), openRelay("", "harbor", NOW)], [null, null, null, null]);
  is("none for something that is not a checkout's id", [relayOf("in_Renew0000000001", "harbor", NOW), relayOf("", "harbor", NOW)], ["", ""]);
  const nimbus = process.env.NIMBUS_DATA_KEY;
  const stripe = process.env.STRIPE_SECRET_KEY;
  delete process.env.NIMBUS_DATA_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  is("without a secret to seal with: none, never the id", relayOf(SESSION, "harbor", NOW), "");
  process.env.NIMBUS_DATA_KEY = nimbus;
  process.env.STRIPE_SECRET_KEY = stripe;
  process.env.NIMBUS_DATA_KEY = "another-local-key-for-tests-only-0123456789";
  is("and one sealed under another secret does not open", openRelay(relay, "harbor", NOW), null);
  process.env.NIMBUS_DATA_KEY = nimbus;

  part("The route");
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0002", true);
  await setPixels(OWNER, { ...NO_PIXELS, meta: "123456789012345", tiktok: "C4ABCDEFGH1234567890", google: "G-AB12CD34EF", pinterest: "2612345678901" });
  let store = (await storeForEmail(OWNER))!;
  for (const p of ["meta", "tiktok", "google", "pinterest"] as const) await ads.setServerToken(store.statsId!, p, TOKENS[p], { account: "549755885175" });
  await setAdsServer(OWNER, ["meta", "tiktok", "google", "pinterest"]);
  store = (await storeForEmail(OWNER))!;
  const meta = await ads.adsCheckout({ headers: new Headers({ "x-forwarded-for": "203.0.113.200" }), cookies: { get: (name: string) => (name in cookies() ? { value: cookies()[name] } : undefined) } }, store, NOW);
  sessions = [
    {
      id: SESSION,
      status: "complete",
      payment_status: "paid",
      amount_total: 4900,
      currency: "usd",
      created: Math.floor(Date.now() / 1000) - 600,
      customer_details: { email: "buyer@example.com" },
      metadata: { store: "harbor", product: "club000001", ads: meta.ads as string },
    },
  ];
  const fresh = relayOf(SESSION, "harbor");
  is("the checkout's own id: refused, nothing sent, Stripe not asked", [await post({ h: "harbor", s: SESSION }), sent.length, stripeReads.length], [204, 0, 0]);
  is("nor in the handle's place", [await post({ h: "harbor", t: SESSION }), sent.length, stripeReads.length], [204, 0, 0]);
  is("a handle past its hour: nothing", [await post({ h: "harbor", t: relayOf(SESSION, "harbor", Date.now() - 3601 * 1000) }), sent.length], [204, 0]);
  is("another store's handle: nothing", [await post({ h: "harbor", t: relayOf(SESSION, "otherstore") }), sent.length], [204, 0]);
  is("an altered handle: nothing", [await post({ h: "harbor", t: fresh.slice(0, -3) + "AAA" }), sent.length, stripeReads.length], [204, 0, 0]);
  is("its own fresh handle: the purchase goes to the four platforms", [await post({ h: "harbor", t: fresh }), sent.length], [204, 4]);
  is("and the checkout's id is in none of them", sent.filter((s) => s.includes(SESSION)).length, 0);
  is("the same handle again: sent once", [await post({ h: "harbor", t: fresh }), sent.length], [204, 4]);

  part("No key to the order anywhere else");
  const before = stripeReads.length;
  is("readOrder (downloads, reviews, courses, calls, Discord, podcasts) takes it for no order", (await readOrder(store, fresh)).state, "invalid");
  is("and does not even ask Stripe", stripeReads.length, before);
  is("its shape is none of a checkout's", /^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(fresh), false);

  part("The page and the pixels carry the handle, never the checkout's id");
  const page = readFileSync("app/[handle]/thanks/page.tsx", "utf8");
  const pixels = readFileSync("components/store-pixels.tsx", "utf8");
  is("no event on the thanks page names the checkout's own id", (page.match(/\border:\s*sessionId\b/g) ?? []).length, 0);
  // Altered 9 Nov 2026 (C5 audit LEVE 3, rule 23): the handle is sealed through relayFor, which gives none where the
  // request says no (tests/ads-event-consent.test.ts); was the literal adEventRelay(sessionId, store.handle) five times.
  is("each Stripe purchase gives the pixels the sealed handle", (page.match(/relay: relayFor\(sessionId\),/g) ?? []).length, 5);
  is("the pixels' event has no order field", /\border\?:\s*string/.test(pixels), false);
  is("and post only the handle", [pixels.includes("JSON.stringify({ h: handle, t: event.relay })"), /\bs: event\./.test(pixels)], [true, false]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
