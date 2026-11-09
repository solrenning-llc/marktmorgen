/**
 * The thanks page's relay (app/api/store/ads-event, lib/ad-events.ts
 * sendServerPurchase) and the buyer's no (C5 outbound audit, 9 November 2026,
 * LEVE 3; proof aud-ssrf-proof-ads-event-consent).
 *
 * lib/ad-events.ts promises that a buyer who said no, or whose browser sends
 * Global Privacy Control, is never sent from our server. The lead route
 * (sendServerLead) and the checkout (adsCheckout) read that no on the server
 * (allowedBy); the relay route did not, and the thanks page sealed its handle
 * whatever the buyer chose. So a POST with that handle from a browser that
 * said no sent the buyer's hashed address, network address and browser to
 * Meta, TikTok, Google and Pinterest.
 *
 * What the server can read, and what it does with it:
 *   - Sec-GPC: 1 on the request: nothing is sent, and the thanks page seals no handle;
 *   - this store's ads cookie holding the no (components/store-pixels.tsx now
 *     writes it, ADS_COOKIE_NO, where it used to delete the cookie), or anything
 *     else that is not the yes: the same;
 *   - neither (a browser that keeps no cookies): still sent, as before. A
 *     browser that keeps no cookies and said yes is sent only this way
 *     (components/store-pixels.tsx writeAdsCookie), and refusing it is the
 *     owner's decision, not this fix's.
 *
 * Harness and fetch stand-in from tests/ad-event-relay.test.ts; no request
 * leaves the machine.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import * as consent from "@/lib/ad-consent";
import * as ads from "@/lib/ad-events";
import { NO_PIXELS } from "@/lib/pixels";
import { claimHandle, ensureStatsId, setAdsServer, setPixels, setStripeAccount, storeForEmail } from "@/lib/store";
import { POST } from "@/app/api/store/ads-event/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_ad_event_consent_stand_in";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

type Asker = { cookies: { get(name: string): { value: string } | undefined }; headers?: Pick<Headers, "get"> };
// Read through the modules, so this file still runs, and fails, where they are missing.
const refusedBy = ((ads as unknown as Record<string, unknown>).refusedBy as ((request: Asker, store: { handle: string }) => boolean) | undefined) ?? (() => false);
const NO = ((consent as unknown as Record<string, unknown>).ADS_COOKIE_NO as string | undefined) ?? "n";

const OWNER = "owner@example.com";
const SEC = Math.floor(Date.now() / 1000);
const TOKENS = { meta: "EAAB" + "m".repeat(60), tiktok: "tt" + "t".repeat(40), google: "G00gleApiSecret_abcdefgh", pinterest: "pina_" + "p".repeat(50) };
const COOKIE = consent.adsCookieName("harbor");
const YES = consent.nextAdsCookie(undefined, "", SEC - 3600);
const sent: string[] = [];
const stripeReads: string[] = [];
const sessions: Record<string, unknown>[] = [];

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

let address = 0;
async function post(body: Record<string, unknown>, extra: Record<string, string>): Promise<number> {
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
        ...extra,
      },
      body: JSON.stringify(body),
    }),
  );
  return response.status;
}

const asker = (cookie: Record<string, string>, headers: Record<string, string> = {}): Asker => ({
  cookies: { get: (name: string) => (name in cookie ? { value: cookie[name] } : undefined) },
  headers: new Headers(headers),
});

let n = 0;
/** A paid checkout opened WITHOUT the yes (adsCheckout kept nothing: no `ads` metadata), and its thanks-page handle. */
function checkout(): { id: string; relay: string } {
  n += 1;
  const id = `cs_test_consentCase${String(n).padStart(16, "0")}`;
  sessions.push({
    id,
    status: "complete",
    payment_status: "paid",
    amount_total: 4900,
    currency: "usd",
    created: SEC - 600,
    customer_details: { email: `buyer${n}@example.com` },
    metadata: { store: "harbor", product: "club000001" },
  });
  return { id, relay: ads.adEventRelay(id, "harbor") };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0004", true);
  await setPixels(OWNER, { ...NO_PIXELS, meta: "123456789012345", tiktok: "C4ABCDEFGH1234567890", google: "G-AB12CD34EF", pinterest: "2612345678901" });
  let store = (await storeForEmail(OWNER))!;
  for (const p of ["meta", "tiktok", "google", "pinterest"] as const) await ads.setServerToken(store.statsId!, p, TOKENS[p], { account: "549755885175" });
  await setAdsServer(OWNER, ["meta", "tiktok", "google", "pinterest"]);
  store = (await storeForEmail(OWNER))!;

  part("The no the server can read");
  is("the no the browser writes is not a yes", consent.readAdsCookie(NO, SEC), null);
  is("Global Privacy Control: refused", refusedBy(asker({}, { "sec-gpc": "1" }), store), true);
  is("Global Privacy Control beside the yes: still refused", refusedBy(asker({ [COOKIE]: YES }, { "sec-gpc": "1" }), store), true);
  is("this store's cookie holding the no: refused", refusedBy(asker({ [COOKIE]: NO }), store), true);
  is("this store's cookie holding anything but the yes: refused", refusedBy(asker({ [COOKIE]: "garbled" }), store), true);
  is("the yes: not refused", refusedBy(asker({ [COOKIE]: YES }), store), false);
  is("another store's no is not this one's", refusedBy(asker({ [consent.adsCookieName("otherstore")]: NO }), store), false);
  is("no cookie and no signal (a browser that keeps no cookies): not refused here", refusedBy(asker({}), store), false);

  const refused: [string, Record<string, string>][] = [
    ["a browser that sends Global Privacy Control", { "sec-gpc": "1" }],
    ["a browser that said no (the store's cookie holds the no)", { cookie: `${COOKIE}=${NO}; _fbp=fb.1.1.1` }],
    ["Global Privacy Control beside a yes cookie", { "sec-gpc": "1", cookie: `${COOKIE}=${YES}` }],
  ];
  for (const [what, headers] of refused) {
    part(`The relay route: ${what}`);
    const { relay } = checkout();
    const [before, reads] = [sent.length, stripeReads.length];
    is("answers empty", await post({ h: "harbor", t: relay }, headers), 204);
    is("nothing about the buyer reaches an ad platform", sent.length - before, 0);
    is("not the buyer's hashed address in particular", sent.slice(before).filter((s) => s.includes(ads.sha256(`buyer${n}@example.com`))).length, 0);
    is("and the creator's Stripe account is not even asked", stripeReads.length - reads, 0);
  }

  part("The relay route: what still sends");
  {
    const { relay } = checkout();
    const before = sent.length;
    is("the yes: the purchase goes to the four platforms", [await post({ h: "harbor", t: relay }, { cookie: `${COOKIE}=${YES}; _fbp=fb.1.1.1` }), sent.length - before], [204, 4]);
  }
  {
    // Kept on purpose (owner's decision pending): the only way a cookieless browser's yes reaches the server.
    const { relay } = checkout();
    const before = sent.length;
    is("no cookie and no signal: still sent, as before", [await post({ h: "harbor", t: relay }, {}), sent.length - before], [204, 4]);
  }

  part("The thanks page seals no handle where the request says no");
  const page = readFileSync("app/[handle]/thanks/page.tsx", "utf8");
  is("no purchase event seals a handle without the check", (page.match(/relay: adEventRelay\(/g) ?? []).length, 0);
  is("each of the five Stripe purchases goes through it", (page.match(/relay: relayFor\(sessionId\),/g) ?? []).length, 5);
  is("which reads the request's own no", /const relayFor = \(id: string\) => \(refusedBy\(\{ cookies: [a-zA-Z]+, headers: [a-zA-Z]+ \}, store\) \? undefined : adEventRelay\(id, store\.handle\)\)/.test(page), true);

  part("The browser keeps the no where the server can read it");
  const pixels = readFileSync("components/store-pixels.tsx", "utf8");
  is("a no writes the no, for as long as a yes is kept", pixels.includes("document.cookie = `${name}=${ADS_COOKIE_NO}; Path=/; Max-Age=${ADS_COOKIE_SECONDS}; SameSite=Lax${secure}`;"), true);
  is("and no longer only deletes the cookie", pixels.includes("document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;"), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
