import { NextResponse, type NextRequest } from "next/server";
import { handleForDomain } from "@/lib/domains";
import { SITE_URL } from "@/lib/site-url";
import { AFFILIATE_CODE_PATTERN, VIA_COOKIE_SECONDS, viaCookieName, viaCookieValue } from "@/lib/affiliate-setting";
import { needsConsent } from "@/lib/pixels";
import { dynamicPolicy, isDynamicPage, isEmbedPage, isEventRoomPage, isStorePage, newNonce, roomPermissions } from "@/lib/csp";
import { fromAnotherSite } from "@/lib/request-guard";
import { isPlatformHost, requestHost } from "@/lib/request-origin";
import { ZOOM_ARRIVAL_COOKIE, ZOOM_ARRIVAL_SECONDS, arrivedForZoom } from "@/lib/zoom-arrival";
import { CODE_COOKIE_SECONDS, codeCookieName, readLinkCode } from "@/lib/code-link";
import { AB_COOKIE, AB_COOKIE_SECONDS, readBucket } from "@/lib/headline-test-rules";
import { CHANNEL_COOKIE_SECONDS, channelCookieName, nextChannelCookie, touchFrom } from "@/lib/visit-channel";
import { isOwnPagePath } from "@/lib/site-page-rules";

/**
 * A creator's own domain, served as their store.
 *
 * On marktmorgen.com (and the deployment's own addresses) nothing happens
 * here. On a creator's domain, the root is their store page, the store's own
 * pages keep their short paths (/thanks, /course/…, /p/<product>, /community,
 * /affiliates, /renew/<product>, /certificate/<id>, /review), and
 * anything that belongs to the site itself — signing in, the studio, the help
 * pages — is sent to marktmorgen.com, where the session lives.
 *
 * The store page is told which domain it was reached on, so it can send a
 * visitor back to marktmorgen.com if the store is no longer on Pro.
 *
 * Two more jobs happen here because this runs before everything else: every
 * page rendered for a visit gets its Content-Security-Policy with a fresh
 * nonce (lib/csp.ts), and every request to the API that changes something is
 * refused when it comes from another site or carries a body too large to
 * read (guardApi, below).
 */
const DOMAIN_HEADER = "x-nimbus-domain";
/** The path and query a visitor asked for on a creator's domain, before it was rewritten. */
const PATH_HEADER = "x-nimbus-path";
/** Which store an address belongs to, for the page that says it is not there (app/[handle]/not-found.tsx). */
const STORE_HEADER = "x-nimbus-store";
/** The two files a crawler asks a site for, which a creator's domain answers with the store's own (app/[handle]/store-sitemap, store-robots). */
const CRAWLER_FILES = /^\/(sitemap\.xml|robots\.txt)$/;
/** Where each is served from: a folder named like the file itself would be taken for one of Next's own. */
const CRAWLER_ROUTES: Record<string, string> = { "/sitemap.xml": "/store-sitemap", "/robots.txt": "/store-robots" };
/** A store's map under its address here: /@handle/sitemap.xml. */
const STORE_SITEMAP = /^\/(?:@|%40)([^/]+)\/sitemap\.xml$/i;
const STORE_PATHS = /^\/(media-kit|tip|thanks|free|manage|orders|course|book|community|p|affiliates|renew|certificate|review|waitlist|podcast|left|group|blog|join|contact|discord|go|form|shop|pay|sign|letters)(\/|$)/;

/**
 * A visitor who followed an affiliate's link (?via=<code>) keeps the code and
 * the time in a first-party cookie on the store's own address, so a purchase
 * made later, inside the store's window, is credited to whoever sent them
 * (lib/affiliates.ts). Set here so it works without JavaScript; whether the
 * code is real, and still inside the window, is decided at the checkout.
 *
 * Both ends of the journey are kept: the click just made, and the earliest one
 * the visitor still carries. Which of the two earns the sale is the store's
 * own setting, read at the checkout — nothing here needs to know it, so no
 * store's record is read on a page view to find out.
 *
 * Not set here where the law asks for consent before such a cookie (the same
 * places the ad pixels ask first, lib/pixels.ts): there the store page asks
 * the visitor (components/affiliate-click.tsx), and a yes sets this same
 * cookie through /api/store/via.
 */
function withAffiliateClick(request: NextRequest, handle: string, response: NextResponse): NextResponse {
  const code = request.nextUrl.searchParams.get("via")?.toLowerCase() ?? "";
  if (!handle || !AFFILIATE_CODE_PATTERN.test(code)) return response;
  if (needsConsent(request.headers.get("x-vercel-ip-country"))) return response;
  const name = viaCookieName(handle);
  response.cookies.set({
    name,
    value: viaCookieValue(request.cookies.get(name)?.value, code, Date.now() / 1000),
    path: "/",
    maxAge: VIA_COOKIE_SECONDS,
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
  });
  return response;
}

/**
 * A discount code in the address (?code=SPRING) is kept for this store, so it
 * applies at the checkout without being typed (lib/code-link.ts). Whether it
 * is real, live and for this sale is Stripe's to say, at the checkout.
 */
function withCodeLink(request: NextRequest, handle: string, response: NextResponse): NextResponse {
  const code = readLinkCode(request.nextUrl.searchParams.get("code"));
  if (!handle || !code) return response;
  response.cookies.set({
    name: codeCookieName(handle),
    value: code,
    path: "/",
    maxAge: CODE_COOKIE_SECONDS,
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
  });
  return response;
}

/**
 * A visitor to a product's page is given one random group number, 0 to 999,
 * for the headline tests creators run (lib/headline-test.ts), and keeps it.
 * Not where the law asks for consent before such a cookie: those visitors
 * see each page's first headline and are not counted.
 */
function withTestGroup(request: NextRequest, productPage: boolean, response: NextResponse): NextResponse {
  if (!productPage || readBucket(request.cookies.get(AB_COOKIE)?.value) !== null) return response;
  if (needsConsent(request.headers.get("x-vercel-ip-country"))) return response;
  const bytes = new Uint16Array(1);
  crypto.getRandomValues(bytes);
  response.cookies.set({
    name: AB_COOKIE,
    value: String(bytes[0] % 1000),
    path: "/",
    maxAge: AB_COOKIE_SECONDS,
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
  });
  return response;
}

/**
 * A visit to a store from somewhere nameable — a tagged link, a site that
 * sent the visitor, an app's built-in browser — is remembered for thirty
 * days in a cookie of the store's own, so a sale made on a later, typed-in
 * visit is still credited to where the buyer came from (lib/visit-channel.ts).
 * A visit from nowhere nameable changes nothing.
 *
 * Not where the law asks for consent before such a cookie (the places the ad
 * pixels ask first, lib/pixels.ts), and never for a browser sending Global
 * Privacy Control: those sales are credited by the page's own tags, as before.
 */
function withChannel(request: NextRequest, handle: string, ownHost: string, response: NextResponse): NextResponse {
  if (!handle || request.method !== "GET") return response;
  if (needsConsent(request.headers.get("x-vercel-ip-country")) || request.headers.get("sec-gpc") === "1") return response;
  const touch = touchFrom({
    url: request.nextUrl,
    referrer: request.headers.get("referer") ?? "",
    userAgent: request.headers.get("user-agent") ?? "",
    ownHost,
  });
  if (!touch) return response;
  const name = channelCookieName(handle);
  response.cookies.set({
    name,
    value: nextChannelCookie(request.cookies.get(name)?.value, touch, Date.now() / 1000),
    path: "/",
    maxAge: CHANNEL_COOKIE_SECONDS,
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
  });
  return response;
}

/**
 * Somebody who opens the Video calls page by the link in Zoom's Marketplace
 * listing (or the review link) came to connect Zoom, and is usually not
 * logged in yet. The word in the address does not survive logging in and
 * making a store, so it is kept in a cookie here (lib/meet-providers.ts).
 */
function withZoomArrival(request: NextRequest, response: NextResponse): NextResponse {
  const { pathname, searchParams } = request.nextUrl;
  if (pathname !== "/studio/meetings" || !arrivedForZoom({ zoom: searchParams.get("zoom") ?? undefined, from: searchParams.get("from") ?? undefined })) {
    return response;
  }
  response.cookies.set({
    name: ZOOM_ARRIVAL_COOKIE,
    value: "1",
    path: "/",
    maxAge: ZOOM_ARRIVAL_SECONDS,
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
  });
  return response;
}

/**
 * The biggest body any API route takes: the store photo and a file of licence
 * keys are the largest, at under three megabytes. Each route caps its own
 * body lower; this is the ceiling nothing can pass, checked before a route
 * reads a byte.
 */
const MAX_API_BODY_BYTES = 4 * 1024 * 1024;

/**
 * The one address another site may post to: the one-click unsubscribe that
 * mail apps send (RFC 8058). Its token is the whole key, it only ever takes
 * somebody off a list, and a web mail app is entitled to press it from its
 * own page.
 */
const CROSS_SITE_POSTS = new Set(["/api/mail/unsubscribe"]);

/**
 * Every request under /api/ that changes something passes here first.
 *
 * A request from another site is refused whatever route it names, so no
 * route can be added without the check (lib/request-guard.ts). A declared
 * body over the ceiling is refused before it is read, and a body sent
 * without a declared length — which only a script, never a form or a fetch
 * of ours, does — is refused too, so a route's own ceiling always has a
 * number to check.
 */
/** A private podcast's feed (app/api/store/podcast/feed/[token]). */
const PODCAST_FEED_PATH = /^\/api\/store\/podcast\/feed\/[^/]+$/;

function guardApi(request: NextRequest): NextResponse {
  const method = request.method.toUpperCase();
  // A feed's address with a query is sent on, for good, to the feed's own (audit of private podcasts, L1): the CDN
  // keeps a feed under its exact address, and a query added to it would miss that copy every time and spend the
  // feed's few daily readings (lib/podcast-access.ts, feedReadAllowed) before the subscriber's own app asks.
  if ((method === "GET" || method === "HEAD") && request.nextUrl.search && PODCAST_FEED_PATH.test(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.search = "";
    return NextResponse.redirect(url, 308);
  }
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return NextResponse.next();
  if (fromAnotherSite(request) && !CROSS_SITE_POSTS.has(request.nextUrl.pathname)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const length = request.headers.get("content-length");
  if (length === null && request.headers.has("transfer-encoding")) {
    return NextResponse.json({ ok: false, error: "length_required" }, { status: 411 });
  }
  if (Number(length ?? "0") > MAX_API_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  }
  return NextResponse.next();
}

/**
 * The nonce policy for a page rendered for this visit (lib/csp.ts).
 *
 * Next reads the nonce from the policy on the request and puts it on every
 * script it writes into the page; the same policy goes back on the response
 * for the browser to enforce. A page built ahead of time is left to the
 * policy in next.config.ts, since its scripts were written without one.
 */
function withPolicy(path: string, headers: Headers): Policy | null {
  if (!isDynamicPage(path)) return null;
  // Ad platforms and video players only on a store's own pages, and a live
  // event's video room only on that event's own page (lib/csp.ts).
  // The card pasted into a creator's site may be framed by it, and needs
  // neither (lib/embed-rules.ts).
  const room = isEventRoomPage(path);
  const policy = dynamicPolicy(newNonce(), { store: isStorePage(path), room, embed: isEmbedPage(path) });
  headers.set("content-security-policy", policy);
  return { csp: policy, room };
}

type Policy = { csp: string; room: boolean };

function answer(response: NextResponse, policy: Policy | null): NextResponse {
  if (policy) response.headers.set("Content-Security-Policy", policy.csp);
  if (policy?.room) response.headers.set("Permissions-Policy", roomPermissions());
  return response;
}

/** The store a platform path belongs to: /@handle and everything under it. */
function handleInPath(pathname: string): string {
  const match = pathname.match(/^\/(?:@|%40)([^/]+)/i);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]).toLowerCase();
  } catch {
    return "";
  }
}

export async function proxy(request: NextRequest) {
  const host = requestHost(request);

  if (request.nextUrl.pathname.startsWith("/api/")) return guardApi(request);

  if (isPlatformHost(host)) {
    // The site's own map and rules: nothing of a store's to add to them.
    if (CRAWLER_FILES.test(request.nextUrl.pathname)) return NextResponse.next();
    // A store's own map, under its address here.
    if (STORE_SITEMAP.test(request.nextUrl.pathname)) {
      const url = request.nextUrl.clone();
      url.pathname = request.nextUrl.pathname.replace(/\/sitemap\.xml$/i, "/store-sitemap");
      return NextResponse.rewrite(url);
    }
    const params = request.nextUrl.searchParams;
    const store = params.has("via") || params.has("code") ? handleInPath(request.nextUrl.pathname) : "";
    // The header is ours to set; one sent by a visitor is dropped.
    const headers = new Headers(request.headers);
    headers.delete(DOMAIN_HEADER);
    headers.delete(PATH_HEADER);
    headers.delete(STORE_HEADER);
    const policy = withPolicy(request.nextUrl.pathname, headers);
    const productPage = /^\/(?:@|%40)[^/]+\/p\/[^/]+\/?$/i.test(request.nextUrl.pathname);
    const visited = handleInPath(request.nextUrl.pathname);
    if (visited) headers.set(STORE_HEADER, visited);
    return answer(withChannel(request, visited, host, withTestGroup(request, productPage, withZoomArrival(request, withCodeLink(request, store, withAffiliateClick(request, store, NextResponse.next({ request: { headers } })))))), policy);
  }

  const { pathname, search } = request.nextUrl;
  const handle = await handleForDomain(host).catch(() => null);
  if (!handle) return NextResponse.redirect(`${SITE_URL}${pathname}${search}`, 307);

  const headers = new Headers(request.headers);
  headers.set(DOMAIN_HEADER, host);
  headers.set(PATH_HEADER, `${pathname}${search}`.slice(0, 2_000));
  headers.set(STORE_HEADER, handle);
  const rewrite = (path: string) => {
    const url = request.nextUrl.clone();
    url.pathname = path;
    const policy = withPolicy(path, headers);
    return answer(withChannel(request, handle, host, withTestGroup(request, /^\/@[^/]+\/p\/[^/]+\/?$/i.test(path), withCodeLink(request, handle, withAffiliateClick(request, handle, NextResponse.rewrite(url, { request: { headers } }))))), policy);
  };

  if (pathname === "/") return rewrite(`/@${handle}`);
  // A creator's domain is their site: its map and its rules are the store's.
  if (CRAWLER_FILES.test(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = `/@${handle}${CRAWLER_ROUTES[pathname]}`;
    return NextResponse.rewrite(url, { request: { headers } });
  }
  if (STORE_PATHS.test(pathname)) return rewrite(`/@${handle}${pathname}`);
  if (pathname === "/unsubscribe") {
    const policy = withPolicy(pathname, headers);
    return answer(NextResponse.next({ request: { headers } }), policy);
  }
  // One of the store's own pages, chef.com/about (lib/site-page-rules.ts).
  if (isOwnPagePath(pathname)) return rewrite(`/@${handle}${pathname}`);
  // The store's own long address works here too; another store's does not.
  const own = pathname.match(/^\/@([^/]+)(\/.*)?$/);
  if (own && decodeURIComponent(own[1]).toLowerCase() === handle) {
    const policy = withPolicy(pathname, headers);
    return answer(withChannel(request, handle, host, withCodeLink(request, handle, withAffiliateClick(request, handle, NextResponse.next({ request: { headers } })))), policy);
  }
  return NextResponse.redirect(`${SITE_URL}${pathname}${search}`, 308);
}

export const config = {
  // Pages (not Next's own files, not files with an extension), and the API,
  // where only the request guard above runs.
  matcher: ["/((?!api/|_next/|.*\\.[a-z0-9]+$).*)", "/api/:path*", "/sitemap.xml", "/robots.txt", "/:handle/sitemap.xml"],
};
