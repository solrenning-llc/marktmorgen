/**
 * The id an order's ad event goes out with (506 [SG1], finding E-2; added 5
 * November 2026). A Stripe checkout id (cs_…) and a PayPal order id open the
 * order they name on this site: its downloads, the buyer's address, a
 * verified review, Discord, a call's room or a new time, a package's token
 * and, on PayPal, every purchase made with that address. A renewal's invoice
 * id (in_…) is proof of purchase for a review. None of them may reach an ad
 * platform. What is checked:
 *
 *   - adEventId turns an id into one that is the same every time, is never
 *     the id or a plain hash of it, cannot be turned back, and is nothing at
 *     all when the server has no secret to derive it with (never the raw id);
 *   - the conversions sent from the server (Meta, TikTok, Pinterest, Google
 *     Analytics) carry that id for a purchase and a renewal, never the
 *     checkout's or the invoice's own, in their bodies or their addresses;
 *   - the thanks page gives the pixels that same id, for Stripe and PayPal
 *     alike, so each platform still counts the browser's event and the
 *     server's as one, and the pixels' component sends the checkout's own id
 *     only to this site's own server.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { adsCookieName, nextAdsCookie } from "@/lib/ad-consent";
import * as ads from "@/lib/ad-events";
import { NO_PIXELS } from "@/lib/pixels";
import { claimHandle, ensureStatsId, setAdsServer, setPixels, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_ad_event_ids_stand_in";

// Read through the module, so this file still runs, and fails, where the function is missing.
const adEventId: (id: string) => string =
  ((ads as unknown as Record<string, unknown>).adEventId as ((id: string) => string) | undefined) ?? (() => "missing");

const OWNER = "owner@example.com";
const NOW = Date.now();
const SEC = Math.floor(NOW / 1000);
const SESSION = "cs_test_a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuV";
const INVOICE = "in_Renew0000000001";
const PAYPAL = "5O190127TN364715T";
const TOKENS = { meta: "EAAB" + "m".repeat(60), tiktok: "tt" + "t".repeat(40), google: "G00gleApiSecret_abcdefgh", pinterest: "pina_" + "p".repeat(50) };

const out: { host: string; url: string; body: string }[] = [];
let sessions: Record<string, unknown>[] = [];
let invoices: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (["graph.facebook.com", "business-api.tiktok.com", "www.google-analytics.com", "api.pinterest.com"].includes(url.hostname)) {
    out.push({ host: url.hostname, url: url.href, body: String(init?.body) });
    if (url.hostname === "business-api.tiktok.com") return json({ code: 0, message: "OK" });
    if (url.hostname === "www.google-analytics.com") return new Response(null, { status: 204 });
    return json({ events_received: 1 });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const one = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (one) {
    const found = sessions.find((s) => s.id === one[1]);
    return found ? json(found) : json({ error: { message: "No such checkout session" } }, 404);
  }
  if (path === "/checkout/sessions") return json({ object: "list", data: sessions, has_more: false });
  if (path === "/invoices") return json({ object: "list", data: invoices, has_more: false });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

function request(cookies: Record<string, string>) {
  return {
    headers: new Headers({ "x-forwarded-for": "203.0.113.9", "user-agent": "Mozilla/5.0 (iPhone)", referer: "https://marktmorgen.com/@harbor/p/club" }),
    cookies: { get: (name: string) => (name in cookies ? { value: cookies[name] } : undefined) },
  };
}

/** Every field of a sent event named like an id, wherever it sits. */
function idsIn(body: string): string[] {
  const found: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        if (["event_id", "order_id", "transaction_id"].includes(k) && typeof x === "string") found.push(x);
        walk(x);
      }
  };
  walk(JSON.parse(body));
  return found;
}

async function main(): Promise<void> {
  redis.clear();

  part("The id an ad event goes out with");
  const derived = adEventId(SESSION);
  is("the same every time", adEventId(SESSION), derived);
  is("its own shape: a prefix and 32 hex digits", /^ev_[0-9a-f]{32}$/.test(derived), true);
  is("never the id, nor any part of it", [derived.includes(SESSION), derived.includes(SESSION.slice(8, 24))], [false, false]);
  const plain = createHash("sha256").update(SESSION).digest("hex");
  is("never a plain hash of the id, which a guess could be checked against", [derived.includes(plain.slice(0, 32)), derived.includes(ads.sha256(SESSION).slice(0, 32))], [false, false]);
  is("another order, another id", adEventId("cs_test_a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuW") === derived, false);
  is("a PayPal order and an invoice too", [/^ev_[0-9a-f]{32}$/.test(adEventId(PAYPAL)), /^ev_[0-9a-f]{32}$/.test(adEventId(INVOICE))], [true, true]);
  const nimbus = process.env.NIMBUS_DATA_KEY;
  const stripe = process.env.STRIPE_SECRET_KEY;
  delete process.env.NIMBUS_DATA_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  is("without a secret to derive it with: nothing, never the id", adEventId(SESSION), "");
  process.env.NIMBUS_DATA_KEY = nimbus;
  process.env.STRIPE_SECRET_KEY = stripe;
  is("with another secret, another id", (() => {
    process.env.NIMBUS_DATA_KEY = "another-local-key-for-tests-only-0123456789";
    const other = adEventId(SESSION);
    process.env.NIMBUS_DATA_KEY = nimbus;
    return other === derived || other === "";
  })(), false);

  part("Conversions sent from the server");
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setPixels(OWNER, { ...NO_PIXELS, meta: "123456789012345", tiktok: "C4ABCDEFGH1234567890", google: "G-AB12CD34EF", pinterest: "2612345678901" });
  let store = (await storeForEmail(OWNER))!;
  for (const p of ["meta", "tiktok", "google", "pinterest"] as const) await ads.setServerToken(store.statsId!, p, TOKENS[p], { account: "549755885175" });
  await setAdsServer(OWNER, ["meta", "tiktok", "google", "pinterest"]);
  store = (await storeForEmail(OWNER))!;
  const cookies = { [adsCookieName("harbor")]: nextAdsCookie(undefined, "", SEC - 3600), _fbp: "fb.1.1.1", _ga: "GA1.1.111.222" };
  const meta = await ads.adsCheckout(request(cookies), store, NOW);
  sessions = [
    {
      id: SESSION,
      status: "complete",
      payment_status: "paid",
      amount_total: 4900,
      currency: "usd",
      created: SEC - 600,
      customer_details: { email: "buyer@example.com" },
      subscription: "sub_Club00000001",
      metadata: { store: "harbor", product: "club000001", ads: meta.ads as string },
    },
  ];
  is("a purchase is sent", await ads.sendServerPurchase(store, SESSION, { ip: "", userAgent: "", url: "", cookies: {} }, NOW), "sent");
  is("to all four platforms", out.map((o) => o.host).sort(), ["api.pinterest.com", "business-api.tiktok.com", "graph.facebook.com", "www.google-analytics.com"]);
  is("the checkout's id is in no body and no address", out.filter((o) => o.body.includes(SESSION) || o.url.includes(SESSION)).map((o) => o.host), []);
  is(
    "each id field carries the derived id, the browser's own",
    out.map((o) => [o.host, idsIn(o.body)]).sort(),
    [
      ["api.pinterest.com", [derived, derived]],
      ["business-api.tiktok.com", [derived]],
      ["graph.facebook.com", [derived]],
      ["www.google-analytics.com", [derived]],
    ],
  );

  out.length = 0;
  invoices = [
    {
      id: INVOICE,
      status: "paid",
      billing_reason: "subscription_cycle",
      amount_paid: 4900,
      currency: "usd",
      customer_email: "buyer@example.com",
      created: SEC - 300,
      status_transitions: { paid_at: SEC - 300 },
      parent: { subscription_details: { subscription: "sub_Club00000001", metadata: { store: "harbor", product: "club000001", ads: meta.ads } } },
    },
  ];
  is("a renewal is sent", await ads.sendRenewals(store, NOW), 1);
  is("the invoice's id is in no body and no address", out.filter((o) => o.body.includes(INVOICE) || o.url.includes(INVOICE)).map((o) => o.host), []);
  is("its id fields carry the invoice's derived id", [...new Set(out.flatMap((o) => idsIn(o.body)))], [adEventId(INVOICE)]);

  part("The thanks page and the pixels");
  const thanks = readFileSync("app/[handle]/thanks/page.tsx", "utf8");
  const pixels = readFileSync("components/store-pixels.tsx", "utf8");
  const purchases = thanks.match(/type: "purchase",[\s\S]{0,40}?id: [^,]+,/g) ?? [];
  is("six purchase events on the thanks page", purchases.length, 6);
  is(
    "each gives the pixels the derived id, never the checkout's or the order's own",
    purchases.map((p) => /id: adEventId\((sessionId|order)\),$/.test(p)),
    [true, true, true, true, true, true],
  );
  is("and the checkout's own id only as the order for this site's own server", (thanks.match(/order: sessionId,/g) ?? []).length, 5);
  is("which is the only thing the component sends there", /body: JSON\.stringify\(\{ h: handle, s: event\.order \}\)/.test(pixels), true);
  is("and only when the page gave it one", /if \(event\.order\)\s*\{?\s*fetch\("\/api\/store\/ads-event"/.test(pixels), true);
  is("no purchase reaches a pixel without its derived id", /event\?\.type === "purchase" && event\.id && once\(/.test(pixels), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
