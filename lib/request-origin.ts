import type { NextRequest } from "next/server";
import { SITE_URL } from "@/lib/site-url";

/**
 * The address the visitor actually used.
 *
 * Links we email and redirects we issue have to point back at the host the
 * person typed — the custom domain, not whatever name the server answers to
 * inside the platform. Reading it from the request URL is not enough: behind a
 * proxy that is the internal name, which produces links that work for nobody
 * and cookies that are set on the wrong host.
 */
export function originFrom(request: NextRequest): string {
  // Each header is taken only as one plain value: the first of a list, a
  // host name with an optional port, a protocol of http or https. Anything
  // else (a protocol carrying a URL, a host with a path, a user part or a
  // space) is never pasted into a link; the request's own URL is used.
  const host = firstValue(request.headers.get("x-forwarded-host") ?? request.headers.get("host"));
  if (!host || !isPlainHost(host)) return new URL(request.url).origin;

  const forwardedProto = firstValue(request.headers.get("x-forwarded-proto")).toLowerCase();
  const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const proto = forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : isLocal ? "http" : "https";
  return `${proto}://${host}`;
}

/** One host name (or bracketed IPv6 address) with an optional port, and nothing else. */
const PLAIN_HOST = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/** PLAIN_HOST's shape, and an authority the URL parser itself accepts (a real IPv6 address, a port up to 65535). */
function isPlainHost(host: string): boolean {
  if (!PLAIN_HOST.test(host)) return false;
  try {
    new URL(`http://${host}`);
    return true;
  } catch {
    return false;
  }
}

/** The first value of a header that may hold a comma-separated list, trimmed. */
const firstValue = (value: string | null): string => (value ?? "").split(",")[0].trim();

/** The host a request was made to, lower case, without a port. */
export function requestHost(request: { headers: Headers }): string {
  return (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
}

/** Whether a host is this site itself rather than a creator's own domain. */
export function isPlatformHost(host: string): boolean {
  const platform = new URL(SITE_URL).hostname;
  return (
    host === "" ||
    host === platform ||
    host === `www.${platform}` ||
    host.endsWith(".vercel.app") ||
    host === "localhost" ||
    host === "127.0.0.1"
  );
}

/**
 * The address to put in a link we email, or hand to Stripe to send a buyer
 * back to.
 *
 * The host a request names is chosen by whoever sends it. Every domain a
 * creator connects is served by this same app, so a request sent to one
 * store's domain can name a different store; if the link in the email that
 * follows used that host, the one-time token in it would land on a domain
 * the sender controls the moment they point it somewhere else. So the
 * request's own address is used only when it is this site, or the domain
 * of the very store the link is for; anything else gets this site's own
 * address, where the link works just the same.
 */
export function linkOrigin(
  request: NextRequest,
  store?: { domain: { name: string } | null } | null,
): string {
  const host = requestHost(request);
  if (isPlatformHost(host)) return originFrom(request);
  if (store?.domain && store.domain.name.toLowerCase() === host) return originFrom(request);
  return SITE_URL;
}
