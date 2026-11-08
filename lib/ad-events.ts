/**
 * Conversions sent to the creator's ad platforms from our server (added 11
 * October 2026 for purchases to Meta and TikTok; made complete on 12 October
 * 2026): Meta's Conversions API, TikTok's Events API, Google Analytics' (GA4)
 * Measurement Protocol and Pinterest's Conversions API.
 *
 * Why. A pixel runs in the browser, and a good part of browsers never let it
 * report: content blockers, Safari's tracking prevention, an in-app browser
 * that closes before the script loads, a buyer who closes the tab on Stripe's
 * page before the thanks page. An ad the platform cannot see sell is an ad it
 * cannot learn from, so each sale costs the creator more. Triple Whale
 * (Sonar), Northbeam (Apex), Hyros, Cometly, Wicked Reports and Usermaven all
 * sell sending conversions from the server for this reason. Here it is part
 * of the pixels.
 *
 * What is sent, and when:
 *
 *   - a purchase, when Stripe says it is paid: from the five-minute pass over
 *     each store's checkouts (lib/checkout-sweep.ts), and sooner from the
 *     thanks page when the buyer reaches it. Either way once, with the
 *     order's id, so each platform counts the browser's event and this one as
 *     one purchase. Marked as a new customer or a returning one, read from
 *     the creator's own Stripe account by the buyer's address;
 *   - a membership's renewal, as a purchase of its own, from the same pass;
 *   - a sign-up for something free, a waitlist or the creator's list, as a
 *     lead (not to Google, which has no way to count a lead sent twice once).
 *
 * Only for a buyer who allowed ad measurement on the store: after a yes where
 * the law asks first, and never for a browser that sends Global Privacy
 * Control (components/store-pixels.tsx, lib/ad-consent.ts). That yes is now
 * carried by the checkout itself, so it no longer depends on the buyer coming
 * back. A buyer who said no, or was never asked where asking is the law, is
 * never sent from here.
 *
 * Only to a platform whose pixel is on the store and whose access token the
 * creator pasted, made in their own ad account; the token is sealed before it
 * is kept (lib/secret-box.ts) and never shown again.
 *
 * What goes with each: an id made from the order's (adEventId), never the
 * order's own; its time, amount, currency and products;
 * the buyer's email address hashed with SHA-256, as every platform requires;
 * the network address and browser of the request that opened the checkout;
 * the platforms' own first-party cookies when the browser had them (_fbp,
 * _fbc, _ttp, _epik, _ga) and the ad click that brought the buyer (fbclid,
 * ttclid, epik). Nothing else.
 *
 * Cost: nothing on a visit. One Redis write per checkout opened with the yes,
 * and per sale one Stripe read (new or returning) and one call per platform.
 *
 *   nl:adsrv:<statsId>          JSON { meta?, tiktok?, google?, pinterest?: sealed token, pinterestAccount?, testCode? }
 *   nl:adsrv:last:<statsId>     JSON { at, kind, meta?, tiktok?, google?, pinterest? }: the last answers, for the studio
 *   nl:adsrv:sent:<id>          an order, renewal or lead already sent (3 days; 40 for renewals)
 *   nl:adsrv:ctx:<token>        the request that opened a checkout (4 days)
 *   nl:adsrv:sub:<subscription> the cookies and clicks a membership's renewals are sent with (400 days), never an address
 */
import { keepFor } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { canSeal, deriveKey, seal, unseal } from "@/lib/secret-box";
import { onAccount } from "@/lib/stripe-account";
import { type Store, saleHandles } from "@/lib/store";
import { toMajor } from "@/lib/money";
import { bumpsFromMeta, bundleFromMeta } from "@/lib/bundle-rules";
import { ADS_SERVER_PLATFORMS, type AdsServerPlatform, LEAD_ID, adsCookieName, readAdsCookie } from "@/lib/ad-consent";

export const META_GRAPH_VERSION = "v25.0";
export type ServerPlatform = AdsServerPlatform;
export const SERVER_PLATFORMS: ServerPlatform[] = [...ADS_SERVER_PLATFORMS];

const configKey = (statsId: string) => `nl:adsrv:${statsId}`;
const lastKey = (statsId: string) => `nl:adsrv:last:${statsId}`;
const sentKey = (id: string) => `nl:adsrv:sent:${id}`;
/** What a renewal's sent mark takes in the store's data room for its forty days. */
export const RENEWAL_MARK_BYTES = 192;
const ctxKey = (token: string) => `nl:adsrv:ctx:${token}`;
export const subKey = (sub: string) => `nl:adsrv:sub:${sub}`;
const context = (statsId: string, platform: ServerPlatform) => `ads-server|${statsId}|${platform}`;
const SESSION = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const CTX_TOKEN = /^[0-9a-f]{24}$/;
const SUB = /^sub_[A-Za-z0-9]{6,80}$/;

/** Tokens are long strings of letters, digits and a few marks; anything else is not one. */
const TOKEN = /^[A-Za-z0-9._\-|]{20,600}$/;
const TEST_CODE = /^TEST[0-9]{3,10}$/;
const AD_ACCOUNT = /^\d{6,20}$/;
const CTX_SECONDS = 4 * 86_400;
/** How long a sale, renewal or lead is marked as sent, so it is sent once. */
const SENT_SECONDS = 3 * 86_400;
/** The platforms' addresses, or a stand-in on this computer for the end-to-end test (tests/e2e/services.mjs). */
const STAND_IN = /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.ADS_API_BASE ?? "") ? (process.env.ADS_API_BASE as string) : "";
const endpoint = (host: string, path: string) => (STAND_IN ? `${STAND_IN}/ads/${host}${path}` : `https://${host}${path}`);
const SUB_SECONDS = 400 * 86_400;
/** The cookies a conversion is matched with, as the browser had them at the checkout. */
const COOKIES = ["_fbp", "_fbc", "_ttp", "ttclid", "_epik", "_ga"] as const;

type Stored = Partial<Record<ServerPlatform, string>> & { pinterestAccount?: string; testCode?: string };
type Answers = Partial<Record<ServerPlatform, string>>;

export type ServerSetup = {
  /** Which platforms have a token kept, never the token. */
  on: Record<ServerPlatform, boolean>;
  /** Pinterest's ad account the events go to: not a secret. */
  pinterestAccount: string;
  /** Meta's test event code, while the creator is checking it in Events Manager. */
  testCode: string;
  /** The last answer each platform gave, for the studio to show. */
  last: ({ at: number; kind?: ConversionKind } & Answers) | null;
};

export const NO_SETUP: ServerSetup = { on: { meta: false, tiktok: false, google: false, pinterest: false }, pinterestAccount: "", testCode: "", last: null };

function parse<T>(raw: unknown, fallback: T): T {
  try {
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as T) : fallback;
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function readStored(statsId: string): Promise<Stored> {
  if (!isRedisConfigured()) return {};
  const [raw] = await redisPipeline([["GET", configKey(statsId)]]);
  return parse<Stored>(raw, {});
}

export async function serverSetup(statsId: string | null): Promise<ServerSetup> {
  if (!statsId || !isRedisConfigured()) return NO_SETUP;
  const [raw, lastRaw] = await redisPipeline([["GET", configKey(statsId)], ["GET", lastKey(statsId)]]);
  const stored = parse<Stored>(raw, {});
  const last = parse<ServerSetup["last"]>(lastRaw, null);
  return {
    on: { meta: Boolean(stored.meta), tiktok: Boolean(stored.tiktok), google: Boolean(stored.google), pinterest: Boolean(stored.pinterest && stored.pinterestAccount) },
    pinterestAccount: stored.pinterestAccount ?? "",
    testCode: stored.testCode ?? "",
    last,
  };
}

/** The platforms with a token kept, for the store's own record (lib/store.ts adsServer). */
export function platformsOn(setup: ServerSetup): ServerPlatform[] {
  return SERVER_PLATFORMS.filter((p) => setup.on[p]);
}

/**
 * Keeps a platform's token, sealed, or forgets it (`token` empty). A token
 * that does not look like one is refused, so a pasted pixel id or a sentence
 * is said to be wrong at once rather than failing at the first sale.
 * Pinterest also needs the ad account its events go to.
 */
export async function setServerToken(
  statsId: string,
  platform: ServerPlatform,
  token: unknown,
  extra: { account?: unknown } = {},
): Promise<"saved" | "removed" | "invalid" | "account"> {
  const text = typeof token === "string" ? token.trim() : "";
  const stored = await readStored(statsId);
  if (!text) {
    delete stored[platform];
    if (platform === "pinterest") delete stored.pinterestAccount;
    await redisPipeline([["SET", configKey(statsId), JSON.stringify(stored)]]);
    return "removed";
  }
  if (!TOKEN.test(text)) return "invalid";
  if (platform === "pinterest") {
    const account = typeof extra.account === "string" ? extra.account.trim() : "";
    if (!AD_ACCOUNT.test(account)) return "account";
    stored.pinterestAccount = account;
  }
  stored[platform] = seal(text, context(statsId, platform));
  await redisPipeline([["SET", configKey(statsId), JSON.stringify(stored)]]);
  return "saved";
}

/** Meta's test event code, while the creator checks the events arrive (Events Manager, Test events); empty to stop. */
export async function setTestCode(statsId: string, code: unknown): Promise<boolean> {
  const text = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (text && !TEST_CODE.test(text)) return false;
  const stored = await readStored(statsId);
  if (text) stored.testCode = text;
  else delete stored.testCode;
  await redisPipeline([["SET", configKey(statsId), JSON.stringify(stored)]]);
  return true;
}

/**
 * What a conversion is matched with: the request that opened the checkout or
 * sent the sign-up, and its cookies. Empty network address and browser for a
 * renewal, which no browser made.
 */
export type BuyerRequest = { ip: string; userAgent: string; url: string; cookies: Record<string, string> };

export type ConversionKind = "purchase" | "renewal" | "lead";

export type Conversion = {
  kind: ConversionKind;
  /**
   * The event's id, the same as the browser's: made from the order's checkout
   * id or the renewal's invoice id by adEventId, never either of them, or the
   * lead's own random id (never a key to anything).
   */
  id: string;
  /** When it happened, in seconds. */
  at: number;
  cents: number;
  currency: string;
  products: string[];
  email: string | null;
  /** Whether the buyer had paid this creator before; null when that could not be read. */
  customer: "new" | "returning" | null;
};

const AD_EVENT_LABEL = "marktmorgen/ad-event-id/v1";

/**
 * The id an order's ad event goes out with, to every pixel and from the
 * server alike (506 [SG1], finding E-2). A checkout's id (cs_…) or a PayPal
 * order's id is a key on this site: whoever has it opens the order's
 * downloads, the buyer's address, a verified review, Discord, a call's room
 * and, on PayPal, every purchase made with that address; a renewal's invoice
 * id is proof of purchase for a review. So the platforms are never given one,
 * only this: an HMAC-SHA256 of it under a key derived for this use alone from
 * the server's root secret (lib/secret-box.ts deriveKey), cut to 128 bits.
 *
 * The same id in, the same id out, on the thanks page (which computes it on
 * the server and hands it to the pixels) and in the conversions sent from
 * here, so each platform still counts the browser's event and the server's
 * as one purchase. A keyed hash rather than a plain one: a PayPal order id is
 * short and partly predictable, and a plain hash of it could be checked
 * against guesses; this cannot without the key, and cannot be turned back.
 *
 * Without a root secret it answers "" and nothing is sent with an id at all
 * (the browser's purchase event and the server's conversion are both
 * skipped), never the order's own id. That secret is what reads Stripe here
 * in the first place, so a deployment that sells always has it.
 */
export function adEventId(id: string): string {
  const key = id ? deriveKey(AD_EVENT_LABEL) : null;
  return key ? `ev_${createHmac("sha256", key).update(id).digest("hex").slice(0, 32)}` : "";
}

const RELAY_CONTEXT = "marktmorgen/ad-event-relay/v1";
/** How long a relay handle opens after the thanks page made it. */
export const AD_EVENT_RELAY_SECONDS = 3600;
/** The longest relay handle the route reads; a checkout's id at its longest seals to about 340 characters. */
export const AD_EVENT_RELAY_MAX = 420;

/**
 * What the thanks page hands the pixels so the buyer's browser can ask this
 * site's server to send the same purchase now (app/api/store/ads-event): an
 * opaque handle, never the checkout's id. Review of #2557 (Codex O): every
 * prop of a client component is serialized into the page, where the
 * platforms' scripts run, and the checkout's id is a key to the order
 * (adEventId above). This is sealed (lib/secret-box.ts, AES-256-GCM, a fresh
 * nonce each time) with the store and this one purpose bound in, and it
 * carries its own hour: it opens only in openAdEventRelay, for the same store,
 * while fresh, untouched. Nothing else reads it, and every route that takes a
 * checkout's id holds it to the cs_ shape (lib/store-checkout.ts readOrder),
 * which this never has. "" when there is nothing to seal with, or the id is
 * not a checkout's: the browser then asks nothing, and the five-minute pass
 * sends the purchase instead.
 */
export function adEventRelay(sessionId: string, storeHandle: string, now = Date.now()): string {
  if (!SESSION.test(sessionId) || !storeHandle || !canSeal()) return "";
  return seal(`${Math.floor(now / 1000) + AD_EVENT_RELAY_SECONDS}|${sessionId}`, `${RELAY_CONTEXT}|${storeHandle}`);
}

/** The checkout's id inside a relay handle made for this store within its hour, or null. */
export function openAdEventRelay(token: unknown, storeHandle: string, now = Date.now()): string | null {
  if (typeof token !== "string" || !token || token.length > AD_EVENT_RELAY_MAX || !storeHandle) return null;
  const opened = unseal(token, `${RELAY_CONTEXT}|${storeHandle}`);
  if (!opened.ok) return null;
  const cut = opened.value.indexOf("|");
  const until = opened.value.slice(0, cut);
  const sessionId = opened.value.slice(cut + 1);
  if (cut < 1 || !/^\d{1,12}$/.test(until) || Number(until) * 1000 < now || !SESSION.test(sessionId)) return null;
  return sessionId;
}

export const sha256 = (text: string) => createHash("sha256").update(text.trim().toLowerCase()).digest("hex");

/** Google's rule for an address before it is hashed: Gmail's dots are not part of it. */
export function googleEmail(email: string): string {
  const [name, domain] = email.trim().toLowerCase().split("@");
  if (!domain) return email.trim().toLowerCase();
  return domain === "gmail.com" || domain === "googlemail.com" ? `${name.replace(/\./g, "")}@${domain}` : `${name}@${domain}`;
}

const isSale = (c: Conversion) => c.kind !== "lead";

/** Meta's click cookie, from the cookie Meta's pixel wrote, or from the click itself. */
function metaClick(cookies: Record<string, string>): string {
  if (cookies._fbc) return cookies._fbc;
  if (cookies.fbclid && cookies.clickAt) return `fb.1.${Number(cookies.clickAt) * 1000}.${cookies.fbclid}`;
  return "";
}

/** Meta's event, as its Conversions API takes it. Pure, so the test reads exactly what is sent. */
export function metaEvent(c: Conversion, buyer: BuyerRequest) {
  const user: Record<string, unknown> = {};
  if (buyer.ip) user.client_ip_address = buyer.ip;
  if (buyer.userAgent) user.client_user_agent = buyer.userAgent;
  if (c.email) user.em = [sha256(c.email)];
  if (buyer.cookies._fbp) user.fbp = buyer.cookies._fbp;
  const fbc = metaClick(buyer.cookies);
  if (fbc) user.fbc = fbc;
  // A renewal is made by the subscription, not by anybody on a page: Meta's own
  // name for that is "system_generated".
  const website = c.kind !== "renewal";
  return {
    event_name: isSale(c) ? "Purchase" : "Lead",
    event_time: c.at,
    event_id: c.id,
    action_source: website ? "website" : "system_generated",
    ...(website && buyer.url ? { event_source_url: buyer.url } : {}),
    user_data: user,
    custom_data: isSale(c)
      ? {
          currency: c.currency.toUpperCase(),
          value: toMajor(c.cents, c.currency),
          content_ids: c.products,
          content_type: "product",
          ...(c.customer ? { customer_type: c.customer } : {}),
          ...(c.kind === "renewal" ? { renewal: true } : {}),
        }
      : { content_ids: c.products },
  };
}

/** TikTok's event, as its Events API takes it. Pure, like metaEvent. */
export function tiktokEvent(c: Conversion, buyer: BuyerRequest) {
  const user: Record<string, unknown> = {};
  if (buyer.ip) user.ip = buyer.ip;
  if (buyer.userAgent) user.user_agent = buyer.userAgent;
  if (c.email) user.email = sha256(c.email);
  if (buyer.cookies._ttp) user.ttp = buyer.cookies._ttp;
  const ttclid = buyer.cookies.ttclid;
  if (ttclid) user.ttclid = ttclid;
  return {
    event: isSale(c) ? "CompletePayment" : "SubmitForm",
    event_time: c.at,
    event_id: c.id,
    user,
    ...(buyer.url && c.kind !== "renewal" ? { page: { url: buyer.url } } : {}),
    ...(isSale(c)
      ? {
          properties: {
            currency: c.currency.toUpperCase(),
            value: toMajor(c.cents, c.currency),
            contents: c.products.map((id) => ({ content_id: id, content_type: "product", quantity: 1 })),
          },
        }
      : {}),
  };
}

/** Pinterest's event, as its Conversions API takes it. Pure, like metaEvent. */
export function pinterestEvent(c: Conversion, buyer: BuyerRequest) {
  const user: Record<string, unknown> = {};
  if (c.email) user.em = [sha256(c.email)];
  if (buyer.ip && buyer.userAgent) {
    user.client_ip_address = buyer.ip;
    user.client_user_agent = buyer.userAgent;
  }
  const click = buyer.cookies._epik || buyer.cookies.epik;
  if (click) user.click_id = click;
  const web = c.kind !== "renewal";
  return {
    event_name: isSale(c) ? "checkout" : "lead",
    action_source: web ? "web" : "offline",
    event_time: c.at,
    event_id: c.id,
    ...(web && buyer.url ? { event_source_url: buyer.url } : {}),
    user_data: user,
    ...(isSale(c)
      ? {
          custom_data: {
            currency: c.currency.toUpperCase(),
            value: String(toMajor(c.cents, c.currency)),
            content_ids: c.products,
            order_id: c.id,
            num_items: Math.max(1, c.products.length),
          },
        }
      : {}),
  };
}

/** Google Analytics' visitor id from its _ga cookie ("GA1.1.123.456" → "123.456"). */
export function gaClientId(cookie: string | undefined): string {
  const match = /^GA\d\.\d\.(\d+\.\d+)$/.exec(cookie ?? "");
  return match ? match[1] : "";
}

/** The visit's id from Google Analytics' own session cookie, in either of the shapes it has had. */
export function gaSessionId(cookie: string | undefined): string {
  const value = cookie ?? "";
  const older = /^GS\d\.\d\.(\d{6,12})\./.exec(value);
  if (older) return older[1];
  const newer = /^GS\d\.\d\.s(\d{6,12})\$/.exec(value);
  return newer ? newer[1] : "";
}

/**
 * Google Analytics' request body, as its Measurement Protocol takes it, for a
 * purchase or a renewal. With the visitor's own _ga id and visit, so Google
 * credits it to the visit — and to the Google ad, when Google Ads takes its
 * conversions from this Analytics property. A buyer whose browser never let
 * Google's tag run has no _ga id: the purchase still goes, so the revenue in
 * Analytics is the store's, under an id made from the order.
 */
export function googleBody(c: Conversion, buyer: BuyerRequest, nowSeconds: number) {
  const client = gaClientId(buyer.cookies._ga) || `${parseInt(createHash("sha256").update(c.id).digest("hex").slice(0, 8), 16)}.${c.at}`;
  const session = gaSessionId(buyer.cookies._gs);
  // Google takes events up to three days old with their own time; older ones go with now.
  const recent = nowSeconds - c.at < 72 * 3600 - 300;
  return {
    client_id: client,
    ...(recent ? { timestamp_micros: c.at * 1_000_000 } : {}),
    ...(c.email ? { user_data: { sha256_email_address: [sha256(googleEmail(c.email))] } } : {}),
    ...(buyer.ip ? { ip_override: buyer.ip } : {}),
    consent: { ad_user_data: "GRANTED", ad_personalization: "GRANTED" },
    events: [
      {
        name: "purchase",
        params: {
          transaction_id: c.id,
          currency: c.currency.toUpperCase(),
          value: toMajor(c.cents, c.currency),
          items: c.products.map((id) => ({ item_id: id, quantity: 1 })),
          ...(session && c.kind !== "renewal" ? { session_id: session } : {}),
          ...(c.customer ? { customer_type: c.customer } : {}),
          ...(c.kind === "renewal" ? { renewal: "yes" } : {}),
          engagement_time_msec: 1,
        },
      },
    ],
  };
}

/** Which of a store's platforms a conversion can go to: a pixel, a token, and Google only for a sale through its Analytics tag. */
function targets(store: Store, stored: Stored, c: Conversion): ServerPlatform[] {
  return SERVER_PLATFORMS.filter((p) => {
    if (!stored[p] || !store.pixels[p]) return false;
    if (p === "pinterest" && !stored.pinterestAccount) return false;
    if (p === "google") return isSale(c) && /^G-/.test(store.pixels.google ?? "");
    return true;
  });
}

async function post(platform: ServerPlatform, store: Store, stored: Stored, token: string, c: Conversion, buyer: BuyerRequest, nowSeconds: number): Promise<string> {
  const json = { "Content-Type": "application/json" };
  const signal = AbortSignal.timeout(8_000);
  let response: Response;
  if (platform === "meta") {
    // The token as the access_token query parameter, where Meta's guide to the Conversions API says it goes.
    response = await fetch(endpoint("graph.facebook.com", `/${META_GRAPH_VERSION}/${store.pixels.meta}/events?access_token=${encodeURIComponent(token)}`), {
      method: "POST",
      headers: json,
      body: JSON.stringify({ data: [metaEvent(c, buyer)], ...(stored.testCode ? { test_event_code: stored.testCode } : {}) }),
      signal,
    });
  } else if (platform === "tiktok") {
    response = await fetch(endpoint("business-api.tiktok.com", "/open_api/v1.3/event/track/"), {
      method: "POST",
      headers: { ...json, "Access-Token": token },
      body: JSON.stringify({ event_source: "web", event_source_id: store.pixels.tiktok, data: [tiktokEvent(c, buyer)] }),
      signal,
    });
  } else if (platform === "pinterest") {
    response = await fetch(endpoint("api.pinterest.com", `/v5/ad_accounts/${stored.pinterestAccount}/events`), {
      method: "POST",
      headers: { ...json, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ data: [pinterestEvent(c, buyer)] }),
      signal,
    });
  } else {
    // Google's Measurement Protocol answers every request it can read with an
    // empty 2xx, so "Received" here means delivered, as Google itself says.
    const query = new URLSearchParams({ measurement_id: store.pixels.google as string, api_secret: token });
    response = await fetch(endpoint("www.google-analytics.com", `/mp/collect?${query}`), {
      method: "POST",
      headers: json,
      body: JSON.stringify(googleBody(c, buyer, nowSeconds)),
      signal,
    });
  }
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } | string; code?: number; message?: string };
  const failed = !response.ok || (platform === "tiktok" && typeof body.code === "number" && body.code !== 0);
  const said = typeof body.error === "string" ? body.error : body.error?.message ?? body.message ?? response.status;
  return failed ? `Refused: ${String(said).slice(0, 160)}` : "Received";
}

/** One conversion to each platform it can go to, and the answers kept for the studio. */
async function deliver(store: Store, stored: Stored, c: Conversion, buyer: BuyerRequest, now: number): Promise<number> {
  const platforms = targets(store, stored, c);
  // No id made for it (adEventId without a secret): nothing goes, rather than the order's own.
  if (!platforms.length || !store.statsId || !c.id) return 0;
  const answers: Answers = {};
  await Promise.all(
    platforms.map(async (platform) => {
      const opened = unseal(stored[platform] as string, context(store.statsId as string, platform));
      if (!opened.ok) {
        answers[platform] = "Your token could not be read; paste it again.";
        return;
      }
      try {
        answers[platform] = await post(platform, store, stored, opened.value, c, buyer, Math.floor(now / 1000));
      } catch {
        answers[platform] = "Did not answer";
      }
    }),
  );
  // In one order whatever answered first, so the studio reads them the same way each time.
  const ordered = Object.fromEntries(SERVER_PLATFORMS.filter((p) => answers[p]).map((p) => [p, answers[p]]));
  await redisPipeline([["SET", lastKey(store.statsId), JSON.stringify({ at: now, kind: c.kind, ...ordered }), "EX", 90 * 86400]]);
  return platforms.length;
}

/** Whether a store sends anything from the server: a token kept for a platform whose pixel it has. */
export function sendsFromServer(store: Store): boolean {
  return store.adsServer.some((p) => Boolean(store.pixels[p]));
}

/** The cookies worth keeping from a request, under their own names, and Google's visit as `_gs`. */
function cookiesOf(request: { cookies: { get(name: string): { value: string } | undefined } }, store: Store, nowSeconds: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of COOKIES) {
    const value = request.cookies.get(name)?.value?.slice(0, 300);
    if (value) out[name] = value;
  }
  const google = store.pixels.google;
  if (google && /^G-/.test(google)) {
    const visit = request.cookies.get(`_ga_${google.slice(2)}`)?.value?.slice(0, 300);
    if (visit) out._gs = visit;
  }
  const clicks = readAdsCookie(request.cookies.get(adsCookieName(store.handle))?.value, nowSeconds) ?? {};
  for (const name of ["fbclid", "ttclid", "epik"] as const) {
    const value = clicks[name];
    if (value && !out[name === "epik" ? "_epik" : name]) out[name] = value;
  }
  if (clicks.at) out.clickAt = String(clicks.at);
  return out;
}

/** Whether this request carries the buyer's yes to ad measurement on this store (lib/ad-consent.ts). */
export function allowedBy(request: { cookies: { get(name: string): { value: string } | undefined }; headers?: Pick<Headers,"get"> }, store: Pick<Store,"handle">, nowSeconds = Date.now() / 1000): boolean {
  if (request.headers?.get("sec-gpc") === "1") return false;
  return readAdsCookie(request.cookies.get(adsCookieName(store.handle))?.value, nowSeconds) !== null;
}

type Requested = { headers: Headers; cookies: { get(name: string): { value: string } | undefined } };

/** The address a request came from, as the platform in front of us passed it on. */
function addressOf(request: Requested): string {
  return (request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "").slice(0, 60);
}

/** The page a request was sent from, without its query, which can name an order. */
function pageOf(request: Requested): string {
  try {
    const page = new URL(request.headers.get("referer") ?? "");
    return `${page.origin}${page.pathname}`;
  } catch {
    return "";
  }
}

/**
 * Called by every route that opens a checkout. With the buyer's yes, on a
 * store that sends from the server, keeps the request that opened it for a
 * few days and answers the metadata that points to it, which the checkout
 * route puts on the Stripe session (and its subscription, beside the
 * channel). Without the yes, nothing is kept and the checkout is as before.
 */
export async function adsCheckout(request: Requested, store: Store, now = Date.now()): Promise<Record<string, string>> {
  if (!sendsFromServer(store) || !isRedisConfigured() || !allowedBy(request, store, now / 1000)) return {};
  const token = randomBytes(12).toString("hex");
  const kept: BuyerRequest = {
    ip: addressOf(request),
    userAgent: (request.headers.get("user-agent") ?? "").slice(0, 500),
    url: pageOf(request),
    cookies: cookiesOf(request, store, now / 1000),
  };
  try {
    // Kept only while the store's data room has space for it (lib/store-data.ts):
    // without it the checkout opens as it would without the yes.
    const value = JSON.stringify(kept);
    if (!(await keepFor(store, dataBytes([ctxKey(token), value], 1), CTX_SECONDS, now))) return {};
    await redisPipeline([["SET", ctxKey(token), value, "EX", CTX_SECONDS]]);
  } catch {
    return {};
  }
  return { ads: token };
}

/** A checkout as Stripe lists or returns it, with only the fields read here. */
export type AdsSession = {
  id?: unknown;
  status?: unknown;
  payment_status?: unknown;
  created?: unknown;
  amount_total?: unknown;
  currency?: unknown;
  customer_email?: unknown;
  subscription?: unknown;
  metadata?: Record<string, string> | null;
  customer_details?: { email?: unknown } | null;
};

const emailOf = (s: AdsSession) =>
  typeof s.customer_details?.email === "string" ? s.customer_details.email : typeof s.customer_email === "string" ? s.customer_email : null;

/** The products a checkout delivers, by id, from its metadata. */
function productsOf(meta: Record<string, string>): string[] {
  const ids = [meta.product, ...bumpsFromMeta(meta).map((b) => b.id), ...bundleFromMeta(meta, "bundle")]
    .map((v) => (v ?? "").trim())
    .filter((v) => /^[A-Za-z0-9_-]{2,40}$/.test(v));
  return [...new Set(ids)].slice(0, 20);
}

/**
 * Whether the buyer had paid this creator before: their other paid checkouts
 * on the creator's own Stripe account, by address. One read per sale.
 */
export async function customerType(store: Store, email: string | null, sessionId: string, created: number): Promise<"new" | "returning" | null> {
  if (!email || !store.stripeAccountId) return null;
  try {
    const query = new URLSearchParams({ limit: "10", "customer_details[email]": email });
    const listed = (await onAccount("GET", store.stripeAccountId, `/checkout/sessions?${query}`)) as { data?: unknown };
    const rows = (Array.isArray(listed.data) ? listed.data : []) as AdsSession[];
    const before = rows.some((row) => row.id !== sessionId && row.payment_status === "paid" && typeof row.created === "number" && row.created < created);
    return before ? "returning" : "new";
  } catch {
    return null;
  }
}

function conversionOf(store: Store, session: AdsSession, customer: Conversion["customer"]): Conversion {
  const meta = session.metadata ?? {};
  return {
    kind: "purchase",
    id: adEventId(session.id as string),
    at: typeof session.created === "number" ? session.created : Math.floor(Date.now() / 1000),
    cents: typeof session.amount_total === "number" ? session.amount_total : 0,
    currency: typeof session.currency === "string" ? session.currency : store.currency,
    products: productsOf(meta),
    email: emailOf(session),
    customer,
  };
}

const ordinary = (store: Store, s: AdsSession) =>
  s.status === "complete" && s.payment_status === "paid" && saleHandles(store).has(s.metadata?.store ?? "") && s.metadata?.kind !== "tip";

/** Keeps what a membership's renewals are sent with: the cookies and clicks, never an address or a browser. */
async function keepForRenewals(session: AdsSession, buyer: BuyerRequest): Promise<void> {
  const sub = typeof session.subscription === "string" ? session.subscription : "";
  if (!SUB.test(sub)) return;
  const { _fbp, _fbc, _ttp, ttclid, _epik, _ga, fbclid, epik, clickAt } = buyer.cookies;
  const kept = Object.fromEntries(Object.entries({ _fbp, _fbc, _ttp, ttclid, _epik, _ga, fbclid, epik, clickAt }).filter(([, v]) => v));
  await redisPipeline([["SET", subKey(sub), JSON.stringify(kept), "EX", SUB_SECONDS]]);
}

export type SendResult = "sent" | "already" | "off" | "invalid";

/**
 * The thanks page's faster way: the buyer's own browser, after its pixels
 * fired a purchase, asks for the same purchase to be sent from the server
 * now rather than at the next pass. Sent with what the checkout kept when it
 * has it, and otherwise with this request's own.
 */
export async function sendServerPurchase(store: Store, sessionId: unknown, buyer: BuyerRequest, now = Date.now()): Promise<SendResult> {
  if (typeof sessionId !== "string" || !SESSION.test(sessionId)) return "invalid";
  // Not held to the store's own record of its platforms: a token saved before that record was kept still sends.
  if (!store.statsId || !store.stripeAccountId || !isRedisConfigured()) return "off";
  const stored = await readStored(store.statsId);
  if (!SERVER_PLATFORMS.some((p) => stored[p] && store.pixels[p])) return "off";
  let session: AdsSession;
  try {
    session = (await onAccount("GET", store.stripeAccountId, `/checkout/sessions/${encodeURIComponent(sessionId)}`)) as AdsSession;
  } catch {
    return "invalid";
  }
  const created = typeof session.created === "number" ? session.created : 0;
  if (!ordinary(store, session) || created < now / 1000 - 86400) return "invalid";
  const [claimed, keptRaw] = await redisPipeline([
    ["SET", sentKey(sessionId), "1", "NX", "EX", SENT_SECONDS],
    ["GET", ctxKey(CTX_TOKEN.test(session.metadata?.ads ?? "") ? (session.metadata?.ads as string) : "none")],
  ]);
  if (claimed === null) return "already";
  const kept = parse<BuyerRequest | null>(keptRaw, null);
  const used: BuyerRequest = kept ? { ...kept, cookies: { ...kept.cookies, ...buyer.cookies } } : buyer;
  const c = conversionOf(store, session, await customerType(store, emailOf(session), sessionId, created));
  await deliver(store, stored, c, used, now);
  await keepForRenewals(session, used).catch(() => {});
  return "sent";
}

/**
 * The five-minute pass's part (lib/checkout-sweep.ts): every paid order of the
 * last day whose checkout carried the buyer's yes and has not been sent yet.
 * Answers how many were sent.
 */
export async function sendPaidOrders(store: Store, rows: AdsSession[], now = Date.now(), deadline = Infinity): Promise<number> {
  if (!store.statsId || !sendsFromServer(store) || !isRedisConfigured()) return 0;
  const due = rows.filter((row) => typeof row.id === "string" && SESSION.test(row.id) && CTX_TOKEN.test(row.metadata?.ads ?? "") && ordinary(store, row));
  if (!due.length) return 0;
  const sent = await redisPipeline(due.map((row) => ["EXISTS", sentKey(row.id as string)]));
  const left = due.filter((_, i) => Number(sent[i]) !== 1);
  if (!left.length) return 0;
  const stored = await readStored(store.statsId);
  if (!SERVER_PLATFORMS.some((p) => stored[p] && store.pixels[p])) return 0;
  const kept = await redisPipeline(left.map((row) => ["GET", ctxKey(row.metadata?.ads as string)]));
  let count = 0;
  for (let i = 0; i < left.length && Date.now() < deadline; i += 1) {
    const row = left[i];
    const buyer = parse<BuyerRequest | null>(kept[i], null);
    // What the checkout kept is gone after four days, and an order that old is no longer worth an ad platform's while.
    if (!buyer) continue;
    const [claimed] = await redisPipeline([["SET", sentKey(row.id as string), "1", "NX", "EX", SENT_SECONDS]]);
    if (claimed === null) continue;
    const created = typeof row.created === "number" ? row.created : 0;
    const c = conversionOf(store, row, await customerType(store, emailOf(row), row.id as string, created));
    if (await deliver(store, stored, c, buyer, now)) count += 1;
    await keepForRenewals(row, buyer).catch(() => {});
  }
  return count;
}

type InvoiceRow = {
  id?: unknown;
  status?: unknown;
  billing_reason?: unknown;
  amount_paid?: unknown;
  currency?: unknown;
  customer_email?: unknown;
  created?: unknown;
  status_transitions?: { paid_at?: unknown } | null;
  subscription?: unknown;
  subscription_details?: { metadata?: Record<string, string> | null } | null;
  parent?: { subscription_details?: { subscription?: unknown; metadata?: Record<string, string> | null } | null } | null;
  lines?: { data?: { price?: { product?: unknown } | null; metadata?: Record<string, string> | null }[] } | null;
};

/**
 * Each membership renewal paid in the last day, as a purchase of its own, for
 * a membership whose first checkout carried the buyer's yes: one read of the
 * creator's invoices per pass, only on a store that sends from the server.
 */
export async function sendRenewals(store: Store, now = Date.now(), deadline = Infinity): Promise<number> {
  if (!store.statsId || !store.stripeAccountId || !sendsFromServer(store) || !isRedisConfigured()) return 0;
  const since = Math.floor(now / 1000) - 86400;
  const listed = (await onAccount("GET", store.stripeAccountId, `/invoices?limit=100&status=paid&created[gte]=${since}`)) as { data?: unknown };
  const handles = saleHandles(store);
  const rows = ((Array.isArray(listed.data) ? listed.data : []) as InvoiceRow[]).filter((row) => {
    if (typeof row.id !== "string" || row.billing_reason !== "subscription_cycle" || row.status !== "paid") return false;
    const meta = row.parent?.subscription_details?.metadata ?? row.subscription_details?.metadata ?? {};
    return Boolean(meta.ads) && handles.has(meta.store ?? "") && typeof row.amount_paid === "number" && row.amount_paid > 0;
  });
  if (!rows.length) return 0;
  const subOf = (row: InvoiceRow) => {
    const raw = row.parent?.subscription_details?.subscription ?? row.subscription;
    return typeof raw === "string" ? raw : raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : "";
  };
  const marks = await redisPipeline(rows.map((row) => ["EXISTS", sentKey(row.id as string)]));
  const left = rows.filter((_, i) => Number(marks[i]) !== 1);
  if (!left.length) return 0;
  const stored = await readStored(store.statsId);
  if (!SERVER_PLATFORMS.some((p) => stored[p] && store.pixels[p])) return 0;
  const kept = await redisPipeline(left.map((row) => ["GET", subKey(SUB.test(subOf(row)) ? subOf(row) : "none")]));
  let count = 0;
  for (let i = 0; i < left.length && Date.now() < deadline; i += 1) {
    const row = left[i];
    const cookies = parse<Record<string, string> | null>(kept[i], null);
    // Only a membership whose first payment was sent from here, with the buyer's yes.
    if (!cookies) continue;
    // A renewal's mark is kept forty days: only while the store's data room
    // has space for it (lib/store-data.ts), else renewals wait for room.
    if (!(await keepFor(store, RENEWAL_MARK_BYTES, 40 * 86400, now))) break;
    const [claimed] = await redisPipeline([["SET", sentKey(row.id as string), "1", "NX", "EX", 40 * 86400]]);
    if (claimed === null) continue;
    const meta = row.parent?.subscription_details?.metadata ?? row.subscription_details?.metadata ?? {};
    const paidAt = Number(row.status_transitions?.paid_at) || Number(row.created) || Math.floor(now / 1000);
    const c: Conversion = {
      kind: "renewal",
      id: adEventId(row.id as string),
      at: paidAt,
      cents: row.amount_paid as number,
      currency: typeof row.currency === "string" ? row.currency : store.currency,
      products: productsOf(meta),
      email: typeof row.customer_email === "string" ? row.customer_email : null,
      customer: "returning",
    };
    if (await deliver(store, stored, c, { ip: "", userAgent: "", url: "", cookies }, now)) count += 1;
  }
  return count;
}

/** A new lead's own id, put on the page the sign-up lands on so the browser's event and this one are counted once. */
export function newLeadId(): string {
  return `ld_${randomBytes(8).toString("hex")}`;
}

/**
 * A sign-up for something free, a waitlist or the list, as a lead, from the
 * route that took it — only with the yes, and once. Answers whether it went.
 */
export async function sendServerLead(store: Store, request: Requested, lead: { id: string; email: string; product: string }, now = Date.now()): Promise<boolean> {
  if (!LEAD_ID.test(lead.id) || !store.statsId || !sendsFromServer(store) || !isRedisConfigured()) return false;
  if (!allowedBy(request, store, now / 1000)) return false;
  const stored = await readStored(store.statsId);
  const c: Conversion = {
    kind: "lead",
    id: lead.id,
    at: Math.floor(now / 1000),
    cents: 0,
    currency: store.currency,
    products: lead.product ? [lead.product] : [],
    email: lead.email || null,
    customer: null,
  };
  if (!targets(store, stored, c).length) return false;
  const [claimed] = await redisPipeline([["SET", sentKey(lead.id), "1", "NX", "EX", SENT_SECONDS]]);
  if (claimed === null) return false;
  const buyer: BuyerRequest = {
    ip: addressOf(request),
    userAgent: (request.headers.get("user-agent") ?? "").slice(0, 500),
    url: pageOf(request),
    cookies: cookiesOf(request, store, now / 1000),
  };
  return (await deliver(store, stored, c, buyer, now)) > 0;
}
