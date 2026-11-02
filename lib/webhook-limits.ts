/**
 * The webhook figures a page may show without loading lib/webhooks.ts (which
 * reaches Stripe, Redis and the network): the studio's editor and the public
 * feature page's card read the same ones the server keeps to. Browser-safe.
 */

/** Endpoints one store may have. */
export const MAX_ENDPOINTS = 5;

/**
 * An endpoint's address as the studio shows it: the host and enough of the
 * path to tell two apart, never the whole of a secret-bearing path.
 */
export function shortAddress(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    const tail = path.length > 24 ? `${path.slice(0, 10)}…${path.slice(-6)}` : path;
    return `${parsed.host}${tail}`;
  } catch {
    return "an endpoint";
  }
}
