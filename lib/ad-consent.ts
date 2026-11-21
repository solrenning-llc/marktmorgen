/**
 * The buyer's yes to ad measurement, as the server can read it (added 12
 * October 2026), and the ad clicks that brought them.
 *
 * The yes itself is given where it always was: the store's own question, or
 * no question where the law asks none and the browser does not send Global
 * Privacy Control (components/store-pixels.tsx). Until now it lived only in
 * the browser, so only the browser could say "send this purchase", and a buyer
 * who closed the tab on Stripe's page was never sent. Now the same yes is also
 * written in a cookie of this store's, which every checkout route reads
 * (lib/ad-events.ts adsCheckout): the checkout then carries it, and the
 * purchase is sent from the server when Stripe says it is paid, whether or
 * not the buyer comes back. A no, or Global Privacy Control, deletes the
 * cookie; with no cookie nothing is ever sent from here.
 *
 * With the yes, the cookie keeps the click id the visitor last arrived with
 * from an ad — Meta's fbclid, TikTok's ttclid, Pinterest's epik — for thirty
 * days, so a sale a few visits later can still be matched to the ad. Not
 * Google's gclid: Google takes conversions from the server through Google
 * Analytics, which ties them to the click itself, and keeping it here would
 * be keeping something never sent. Nothing else, and nobody's name or address.
 *
 * Pure, so the browser that writes it and the server that reads it share one
 * reading.
 */

export const ADS_COOKIE_DAYS = 30;
export const ADS_COOKIE_SECONDS = ADS_COOKIE_DAYS * 86_400;

export const CLICK_PARAMS = ["fbclid", "ttclid", "epik"] as const;
export type ClickParam = (typeof CLICK_PARAMS)[number];

/** The ad clicks kept, and when the latest arrived (seconds). */
export type Clicks = Partial<Record<ClickParam, string>> & { at?: number };

/** Click ids are letters, digits and a few marks; anything else is not one. */
const CLICK_ID = /^[A-Za-z0-9._\-~]{4,300}$/;

export function adsCookieName(handle: string): string {
  return `nl_ads_${handle.replace(/[^a-z0-9._-]/g, "")}`;
}

/** The click ids on a page's address, when it was opened from an ad. */
export function clicksFrom(search: string): Partial<Record<ClickParam, string>> {
  const params = new URLSearchParams(search);
  const found: Partial<Record<ClickParam, string>> = {};
  for (const name of CLICK_PARAMS) {
    const value = params.get(name)?.trim() ?? "";
    if (CLICK_ID.test(value)) found[name] = value;
  }
  return found;
}

/**
 * What the cookie holds: "y", the yes, then the clicks. Clicks older than the
 * window are dropped, so nothing is matched to an ad seen months ago.
 */
export function readAdsCookie(value: string | undefined | null, nowSeconds: number): Clicks | null {
  if (!value || !value.startsWith("y")) return null;
  const params = new URLSearchParams(value.slice(1));
  const at = Number(params.get("at") ?? "0");
  const fresh = Number.isFinite(at) && at > 0 && nowSeconds - at <= ADS_COOKIE_SECONDS && at <= nowSeconds + 300;
  const clicks: Clicks = {};
  if (!fresh) return clicks;
  for (const name of CLICK_PARAMS) {
    const id = params.get(name) ?? "";
    if (CLICK_ID.test(id)) clicks[name] = id;
  }
  if (Object.keys(clicks).length) clicks.at = Math.floor(at);
  return clicks;
}

/**
 * The cookie's next value: the yes, and the clicks kept, with any on this
 * page's address taking the place of the old ones, because the latest ad is
 * the one that brought them back.
 */
export function nextAdsCookie(existing: string | undefined | null, search: string, nowSeconds: number): string {
  const now = Math.floor(nowSeconds);
  const fresh = clicksFrom(search);
  const kept = Object.keys(fresh).length ? { ...fresh, at: now } : readAdsCookie(existing, now) ?? {};
  const params = new URLSearchParams();
  for (const name of CLICK_PARAMS) if (kept[name]) params.set(name, kept[name] as string);
  if (kept.at && params.toString()) params.set("at", String(kept.at));
  const rest = params.toString();
  return rest ? `y&${rest}` : "y";
}

/** The platforms a store can send conversions to from the server (lib/ad-events.ts). */
export const ADS_SERVER_PLATFORMS = ["meta", "tiktok", "google", "pinterest"] as const;
export type AdsServerPlatform = (typeof ADS_SERVER_PLATFORMS)[number];

export function parseAdsServer(raw: unknown): AdsServerPlatform[] {
  const list = Array.isArray(raw) ? raw : [];
  return ADS_SERVER_PLATFORMS.filter((p) => list.includes(p));
}

/** A lead's own id, as the route that took the sign-up made it (lib/ad-events.ts newLeadId). */
export const LEAD_ID = /^ld_[0-9a-f]{16}$/;

/** The lead id on the page a sign-up landed on, when it is one. */
export function leadIdOf(raw: unknown): string | undefined {
  return typeof raw === "string" && LEAD_ID.test(raw) ? raw : undefined;
}

/**
 * The cookies the ad platforms' own scripts set on a store's site once they
 * were allowed to run: Meta, Google, TikTok, Pinterest, Reddit and X. They
 * were set under the yes, so they go with it (tracking-consent hunt, November
 * 2026): a no, or Global Privacy Control, expires them on this site too.
 */
/*
 * TikTok's ttcsid and ttcsid_<pixel code> are its own first-party session cookies (TikTok Ads help, "About using
 * cookies with TikTok Pixel", read through a search on 14 November 2026; LOW on #4241).
 */
export const PLATFORM_COOKIE = /^(_fbp|_fbc|_ga|_ga_[A-Za-z0-9]{1,40}|_gid|_gat(_[A-Za-z0-9]{1,40})?|_gcl_[a-z]{1,10}|_ttp|_tt_enable_cookie|ttclid|ttcsid|ttcsid_[A-Za-z0-9]{1,40}|_pin_unauth|_epik|_derived_epik|_pinterest_ct_ua|_rdt_uuid|_rdt_cid|_twclid|muc_ads)$/;

/**
 * The cookie strings that expire every platform cookie in a `document.cookie`
 * value, on this host and on every parent domain a script may have set it on
 * (Meta's and Google's set theirs on the site's registrable domain). A domain
 * the browser will not take, like a public suffix, is simply ignored by it.
 */
export function platformCookieExpiries(cookieHeader: string, hostname: string, secure: boolean): string[] {
  const names = new Set<string>();
  for (const part of cookieHeader.split(";")) {
    const name = part.split("=")[0]?.trim() ?? "";
    if (PLATFORM_COOKIE.test(name)) names.add(name);
  }
  if (!names.size) return [];
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  const domains = [""];
  if (labels.length >= 2 && !/^[0-9.]+$/.test(hostname)) {
    for (let i = 0; i <= labels.length - 2; i++) domains.push(`; Domain=.${labels.slice(i).join(".")}`);
  }
  const tail = `; Path=/; Max-Age=0; SameSite=Lax${secure ? "; Secure" : ""}`;
  return [...names].flatMap((name) => domains.map((domain) => `${name}=${domain}${tail}`));
}

/**
 * What the platforms' scripts keep in the browser's storage rather than in a
 * cookie: Google's conversion linker keeps ad clicks in Local Storage under
 * _gcl_ls (Google Tag Manager help, "Conversion linker"). ePrivacy art. 5(3)
 * covers any storage, so they go with the cookies (LOW on #4241). Only names
 * a platform documents: an unknown key is the site's own, never removed.
 */
export const PLATFORM_STORAGE = /^_gcl_ls$/;

/** The keys of a storage that are the platforms', as PLATFORM_STORAGE names them. */
export function platformStorageKeys(keys: readonly string[]): string[] {
  return keys.filter((k) => PLATFORM_STORAGE.test(k));
}

/**
 * Whether a no on one store may expire the platforms' cookies: not while
 * another store on the same site (marktmorgen.com/@another) has a stored yes
 * in this browser. Only a stored yes counts: a store whose pixels run with no
 * stored choice (outside the countries that ask first) does not keep them,
 * so a no here may expire cookies its pixels set too, and on a custom
 * subdomain the parent-domain expiry reaches the parent site's own. Both err
 * toward less tracking. `choices` are the stored choices of every store in
 * this browser, by handle.
 */
export function mayClearPlatformCookies(handle: string, choices: Record<string, string>, gpc: boolean): boolean {
  if (gpc) return true;
  return !Object.entries(choices).some(([other, value]) => other !== handle && value === "yes");
}
