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
 *     server's as one;
 *   - in a stand-in browser, the real StorePixels component: all six
 *     platforms (Meta, Google, TikTok, Pinterest, X, Reddit) get the derived
 *     id and never the order's own, in any call or on the page's address,
 *     which is cleared of every key (session_id, paypal, token, pkg, move)
 *     before any script starts; nothing starts when it cannot be cleared; a
 *     reload or a step back puts the key back from this tab's storage so the
 *     page still shows the order; a purchase sent under the old id is not
 *     sent again; the checkout's own id goes only to this site's server.
 */
import * as React from "react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { adsCookieName, nextAdsCookie } from "@/lib/ad-consent";
import * as ads from "@/lib/ad-events";
import { NO_PIXELS, type Pixels } from "@/lib/pixels";
import { StorePixels } from "@/components/store-pixels";
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

type Browser = {
  seen: { src: string; page: string }[];
  posted: { url: string; body: string }[];
  replaced: string[];
  local: Map<string, string>;
  /** The addresses Next's router was told of (a history write without Next's own state, once it listens). */
  router: string[];
  /** Lets Next's router start listening, as its own effect does after this component's on the first round. */
  listen(): void;
};

/**
 * A stand-in browser at `href` (the shape of tests/review-2557-page-url.test.ts):
 * the address, history, storage, the document the scripts are added to and
 * fetch. `session` null is a browser whose tab storage throws. History is
 * Next 16's: its state carries `__NA`, and once the router listens
 * (app-router.js wraps history.replaceState as an own property), a write
 * without `__NA` moves the router's address too. `routerLate` starts with
 * the router not yet listening.
 */
function browserAt(
  href: string,
  opts: { session?: Map<string, string> | null; navigation?: string; replaceThrows?: boolean; referrer?: string; routerLate?: boolean } = {},
): Browser {
  const location = new URL(href) as unknown as URL & { replace(u: string): void };
  const proto = {
    state: { __NA: true } as unknown,
    replaceState(this: { state: unknown }, data: unknown, _t: string, url: string) {
      if (opts.replaceThrows) throw new Error("SecurityError");
      this.state = data;
      location.href = new URL(url, location.href).href;
    },
  };
  const history = Object.create(proto) as typeof proto;
  history.state = { __NA: true };
  const listen = () => {
    (history as unknown as Record<string, unknown>).replaceState = (data: unknown, t: string, url: string) => {
      if (!(data as { __NA?: unknown } | null)?.__NA && url) b.router.push(new URL(url, location.href).href);
      proto.replaceState.call(history, (data as object | null) ?? { __NA: true }, t, url);
    };
  };
  const b: Browser = { seen: [], posted: [], replaced: [], local: new Map(), router: [], listen };
  if (!opts.routerLate) listen();
  location.replace = (u: string) => void b.replaced.push(u);
  const g = globalThis as unknown as Record<string, unknown>;
  for (const name of ["fbq", "_fbq", "gtag", "dataLayer", "ttq", "TiktokAnalyticsObject", "pintrk", "twq", "rdt"]) delete g[name];
  g.location = location;
  g.history = history;
  const storage = (m: Map<string, string>) => ({
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
  g.localStorage = storage(b.local);
  const session = opts.session === undefined ? new Map<string, string>() : opts.session;
  Object.defineProperty(g, "sessionStorage", {
    configurable: true,
    get: () => {
      if (!session) throw new Error("SecurityError");
      return storage(session);
    },
  });
  Object.defineProperty(g, "performance", {
    configurable: true,
    writable: true,
    value: { getEntriesByType: (t: string) => (t === "navigation" && opts.navigation ? [{ type: opts.navigation }] : []), now: () => 0 },
  });
  Object.defineProperty(g, "navigator", { value: { globalPrivacyControl: false }, configurable: true, writable: true });
  g.document = {
    cookie: "",
    referrer: opts.referrer ?? "",
    readyState: "complete",
    createElement: () => ({}),
    head: { appendChild: (tag: { src?: string }) => b.seen.push({ src: String(tag.src), page: location.href }) },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  g.window = g;
  g.addEventListener = () => {};
  g.removeEventListener = () => {};
  g.fetch = (async (url: string, init?: RequestInit) => {
    b.posted.push({ url: String(url), body: String(init?.body) });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return b;
}

/** The real component, once, with its effects run in place and the pixels allowed (or the choice given). */
function runPixels(props: Parameters<typeof StorePixels>[0], state: "on" | "ask" | "unknown" | "off" = "on") {
  const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const before = internals.H;
  internals.H = {
    useState: () => [state, () => {}],
    useEffect: (effect: () => unknown) => void effect(),
    useLayoutEffect: (effect: () => unknown) => void effect(),
    useRef: (v: unknown) => ({ current: v }),
    useCallback: (f: unknown) => f,
    useMemo: (f: () => unknown) => f(),
    useContext: () => null,
  };
  try {
    StorePixels(props);
  } finally {
    internals.H = before;
  }
}

/** Every call each platform's queue holds, as text, by platform. */
function queued(): Record<string, string[]> {
  const g = globalThis as unknown as Record<string, ({ queue?: unknown[]; callQueue?: unknown[] } & unknown[]) | undefined>;
  const text = (calls: unknown) => (Array.isArray(calls) ? calls.map((c) => JSON.stringify(Array.isArray(c) ? c : Object.values(c as object))) : []);
  return {
    meta: text(g.fbq?.queue),
    google: text(g.dataLayer),
    tiktok: text(g.ttq ? [...g.ttq] : []),
    pinterest: text(g.pintrk?.queue),
    x: text(g.twq?.queue),
    reddit: text(g.rdt?.callQueue),
  };
}

let pixelSeq = 0;
/** All six pixels, with ids no other run of the component used (each pixel starts once per page). */
function sixPixels(): Pixels {
  pixelSeq += 1;
  const n = String(pixelSeq);
  return {
    ...NO_PIXELS,
    meta: `12345678901234${n}`.slice(-15),
    google: `G-AB12CD34E${n}`,
    tiktok: `C4ABCDEFGH123456789${n}`.slice(-20),
    pinterest: `261234567890${n}`.slice(-13),
    x: `a1b2${n}`,
    xEvents: { purchase: "p9q8r", lead: "l7m6n" },
    reddit: `a2_abc12${n}`,
    redditMatchingOff: true,
  };
}

/** The relay handle the thanks page seals for a checkout (lib/ad-events.ts adEventRelay), read through the module as adEventId is. */
const relayOf = (id: string) =>
  (((ads as unknown as Record<string, unknown>).adEventRelay as ((id: string, handle: string) => string) | undefined) ?? (() => ""))(id, "harbor");
const purchase = (id: string, relay?: string) => ({ type: "purchase" as const, id: adEventId(id), ...(relay ? { relay } : {}), value: 49, currency: "usd", productId: "club000001", title: "Club" });
const props = (pixels: Pixels, event: ReturnType<typeof purchase> | null) => ({ handle: "harbor", storeName: "Harbor Kitchen", pixels, names: "Meta and Google", askFirst: false, event });
const here = () => (globalThis as unknown as { location: URL }).location;

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
  const purchases = thanks.match(/type: "purchase",[\s\S]{0,40}?id: [^,]+,/g) ?? [];
  is("six purchase events on the thanks page", purchases.length, 6);
  is(
    "each gives the pixels the derived id, never the checkout's or the order's own",
    purchases.map((p) => /id: adEventId\((sessionId|order)\),$/.test(p)),
    [true, true, true, true, true, true],
  );
  // Altered 9 Nov 2026 (C5 audit LEVE 3, rule 23): the handle is sealed through relayFor, which gives none where the
  // request says no (tests/ads-event-consent.test.ts); was the literal adEventRelay(sessionId, store.handle) five times.
  is("and the checkout's own id never, only a relay handle sealed for this site's own server", [(thanks.match(/order: sessionId,/g) ?? []).length, (thanks.match(/relay: relayFor\(sessionId\),/g) ?? []).length], [0, 5]);

  part("The pixels in a browser: a Stripe thanks page");
  const onStripe = browserAt(`https://marktmorgen.com/@harbor/thanks?session_id=${SESSION}&upsell=no#top`);
  runPixels(props(sixPixels(), purchase(SESSION, relayOf(SESSION))));
  const calls = queued();
  is("the six platforms' scripts started", onStripe.seen.length, 6);
  is("none on an address naming the checkout", onStripe.seen.filter((s) => s.page.includes(SESSION)).length, 0);
  is("the address keeps everything else", here().href, "https://marktmorgen.com/@harbor/thanks?upsell=no#top");
  is(
    "each platform queued the purchase with the derived id",
    Object.fromEntries(Object.entries(calls).map(([p, list]) => [p, list.some((c) => c.includes(adEventId(SESSION)))])),
    { meta: true, google: true, tiktok: true, pinterest: true, x: true, reddit: true },
  );
  is("no call to any platform names the checkout", Object.entries(calls).filter(([, list]) => list.some((c) => c.includes(SESSION))).map(([p]) => p), []);
  is("only the relay handle goes, and only to this site's server", onStripe.posted.map((p) => [p.url, Object.keys(JSON.parse(p.body)), p.body.includes(SESSION), ads.openAdEventRelay(JSON.parse(p.body).t, "harbor")]), [["/api/store/ads-event", ["h", "t"], false, SESSION]]);
  is(
    "kept for this tab, under this page: the address it became and the one it was",
    JSON.parse((globalThis as unknown as { sessionStorage: Storage }).sessionStorage.getItem("nl_px_keys:/@harbor/thanks") ?? "null"),
    { clean: "https://marktmorgen.com/@harbor/thanks?upsell=no#top", was: `https://marktmorgen.com/@harbor/thanks?session_id=${SESSION}&upsell=no#top` },
  );
  is("Next's router is told the cleared address, so it never writes the key back", onStripe.router, ["https://marktmorgen.com/@harbor/thanks?upsell=no#top"]);
  is(
    "Meta's automatic configuration (clicked buttons with where they lead) is off before its init",
    calls.meta.slice(0, 2).map((c) => JSON.parse(c).slice(0, 3)),
    [["set", "autoConfig", false], ["init", JSON.parse(calls.meta[1])[1]]],
  );

  part("Before the visitor's choice, and when Next's router listens late");
  const asked = browserAt(`https://marktmorgen.com/@harbor/thanks?session_id=${SESSION}&upsell=no`, { routerLate: true });
  runPixels(props(sixPixels(), purchase(SESSION, relayOf(SESSION))), "ask");
  is("the address is cleared at once, whatever the choice, and no script starts", [here().href, asked.seen.length], ["https://marktmorgen.com/@harbor/thanks?upsell=no", 0]);
  is("keeping Next's own state on the entry while its router does not listen", (globalThis as unknown as { history: { state: unknown } }).history.state, { __NA: true });
  asked.listen();
  await new Promise((resolve) => setTimeout(resolve, 5));
  is("and telling its router the cleared address as soon as it does", asked.router, ["https://marktmorgen.com/@harbor/thanks?upsell=no"]);
  const early = browserAt(`https://marktmorgen.com/@harbor/free?token=${"f".repeat(48)}`);
  runPixels(props(sixPixels(), null), "unknown");
  is("the same before the choice is read", [here().search, early.seen.length], ["", 0]);

  part("A page opened from one whose address named a key");
  const fromThanks = browserAt("https://marktmorgen.com/@harbor", { referrer: `https://marktmorgen.com/@harbor/thanks?session_id=${SESSION}` });
  runPixels(props(sixPixels(), null));
  is("starts no script, which would send that address as where the visitor came from", fromThanks.seen.length, 0);
  const fromElsewhere = browserAt("https://marktmorgen.com/@harbor", { referrer: "https://example.com/?token=abc" });
  runPixels(props(sixPixels(), null));
  is("another site's address is not this site's key", fromElsewhere.seen.length, 6);
  const fromStore = browserAt("https://marktmorgen.com/@harbor/p/club", { referrer: "https://marktmorgen.com/@harbor?q=knives" });
  runPixels(props(sixPixels(), null));
  is("and a page of the store without a key changes nothing", fromStore.seen.length, 6);

  part("Links from a page with pixels to another page of this site");
  for (const page of ["app/[handle]/thanks/page.tsx", "app/[handle]/free/page.tsx", "app/[handle]/tip/page.tsx", "app/[handle]/book/[product]/page.tsx"]) {
    const text = readFileSync(page, "utf8");
    const links = [...text.matchAll(/<Link\s+href=\{([^}]*\}?[^}]*)\}/g)].map((m) => m[1]);
    is(
      `${page}: no Next <Link> carries a key (its client move is a history change the scripts count as a view)`,
      links.filter((h) => /sessionId|session_id|order=|token|pkg|move=|paypal|\bbook\b/.test(h)),
      [],
    );
  }

  part("The pixels in a browser: a PayPal thanks page");
  const paypal = browserAt(`https://marktmorgen.com/@harbor/thanks?paypal=${PAYPAL}`);
  runPixels(props(sixPixels(), purchase(PAYPAL)));
  is("none on an address naming the order", [paypal.seen.length, paypal.seen.filter((s) => s.page.includes(PAYPAL)).length], [6, 0]);
  is("no call to any platform names it", Object.entries(queued()).filter(([, list]) => list.some((c) => c.includes(PAYPAL))).map(([p]) => p), []);
  is("and nothing is asked of this site's server for it", paypal.posted, []);

  part("The other keys on a store's pages");
  for (const [name, value] of [["token", "f".repeat(48)], ["pkg", "pk_" + "a".repeat(30)], ["move", SESSION]] as const) {
    const page = browserAt(`https://marktmorgen.com/@harbor/free?${name}=${value}&status=sent`);
    runPixels(props(sixPixels(), null));
    is(`?${name}= is cleared before any script starts`, [page.seen.length, page.seen.filter((s) => s.page.includes(value)).length, here().search], [6, 0, "?status=sent"]);
  }

  part("When the address cannot be cleared");
  const stuck = browserAt(`https://marktmorgen.com/@harbor/thanks?session_id=${SESSION}`, { replaceThrows: true });
  runPixels(props(sixPixels(), purchase(SESSION, relayOf(SESSION))));
  is("no script starts and nothing is sent", [stuck.seen.length, stuck.posted.length], [0, 0]);

  part("Without this tab's storage");
  const bare = browserAt(`https://marktmorgen.com/@harbor/thanks?session_id=${SESSION}`, { session: null });
  runPixels(props(sixPixels(), purchase(SESSION, relayOf(SESSION))));
  is("the address is still cleared and the scripts start", [bare.seen.length, bare.seen.filter((s) => s.page.includes(SESSION)).length], [6, 0]);

  part("A reload, or a step back, after the address was cleared");
  const wasAt = `https://marktmorgen.com/@harbor/thanks?session_id=${SESSION}&upsell=no`;
  const kept = new Map([["nl_px_keys:/@harbor/thanks", JSON.stringify({ clean: "https://marktmorgen.com/@harbor/thanks?upsell=no", was: wasAt })]]);
  const reload = browserAt("https://marktmorgen.com/@harbor/thanks?upsell=no", { session: kept, navigation: "reload" });
  runPixels(props(sixPixels(), null));
  is("goes back to the address as it was, so the page shows the order again", reload.replaced, [wasAt]);
  is("and starts no script on the way", reload.seen.length, 0);
  const back = browserAt("https://marktmorgen.com/@harbor/thanks?upsell=no", { session: new Map(kept), navigation: "back_forward" });
  runPixels(props(sixPixels(), null));
  is("the same after a step back", back.replaced, [wasAt]);
  const fresh = browserAt("https://marktmorgen.com/@harbor/thanks?upsell=no", { session: new Map(kept), navigation: "navigate" });
  runPixels(props(sixPixels(), null));
  is("but a page opened afresh stays as it is", [fresh.replaced, fresh.seen.length], [[], 6]);
  const elsewhere = browserAt("https://marktmorgen.com/@harbor/thanks?product=guide00002", { session: new Map(kept), navigation: "reload" });
  runPixels(props(sixPixels(), null));
  is("and another address on the same path is never given that key", elsewhere.replaced, []);
  const other = browserAt("https://marktmorgen.com/@harbor/tip", { session: new Map(kept), navigation: "reload" });
  runPixels(props(sixPixels(), null));
  is("nor another page", other.replaced, []);
  const forged = browserAt("https://marktmorgen.com/@harbor/thanks", {
    session: new Map([["nl_px_keys:/@harbor/thanks", JSON.stringify({ clean: "https://marktmorgen.com/@harbor/thanks", was: "https://evil.example/@harbor/thanks?session_id=x" })]]),
    navigation: "reload",
  });
  runPixels(props(sixPixels(), null));
  is("and only ever an address of this page on this site", forged.replaced, []);

  part("A purchase sent before ids were derived");
  const before = browserAt(`https://marktmorgen.com/@harbor/thanks?session_id=${SESSION}`);
  before.local.set(`nl_px_sent:${SESSION}`, "1");
  runPixels(props(sixPixels(), purchase(SESSION, relayOf(SESSION))));
  is("a Stripe one is not sent again under the new id", [Object.values(queued()).flat().filter((c) => c.includes(adEventId(SESSION))).length, before.posted.length], [0, 0]);
  const beforePp = browserAt(`https://marktmorgen.com/@harbor/thanks?paypal=${PAYPAL}`);
  beforePp.local.set(`nl_px_sent:${PAYPAL}`, "1");
  runPixels(props(sixPixels(), purchase(PAYPAL)));
  is("nor a PayPal one", Object.values(queued()).flat().filter((c) => c.includes(adEventId(PAYPAL))).length, 0);
  const twice = browserAt(`https://marktmorgen.com/@harbor/thanks?session_id=${SESSION}x`);
  twice.local.set(`nl_px_sent:${adEventId(SESSION + "x")}`, "1");
  runPixels(props(sixPixels(), purchase(SESSION + "x", relayOf(SESSION + "x"))));
  is("nor one already sent under the new id", Object.values(queued()).flat().filter((c) => c.includes(adEventId(SESSION + "x"))).length, 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
