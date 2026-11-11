import type { NextRequest } from "next/server";
import { CACHE_SECONDS, CODE } from "@/lib/short-link-rules";
import { findLink, landingUrl } from "@/lib/short-links";
import { storeForIdExactly } from "@/lib/store-exact";
import { storeBase } from "@/lib/purchase-email";
import { SITE_URL } from "@/lib/site-url";

type Params = { params: Promise<{ code: string }> };

/**
 * A short link for a post (lib/short-links.ts): sends the person to the page
 * it was made for, tagged with where it was posted and the post's name, so
 * the visit is counted by that page, like any other, and its results are
 * the post's row in the numbers. Kept by the CDN for five minutes, so a link
 * opened a great many times is mostly answered without reaching the server.
 * A link that was ended, or never was, opens the page that says so.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { code: raw } = await params;
  const code = raw.toLowerCase();
  const cache = `public, max-age=0, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=60`;
  const ended = () => new Response(null, { status: 302, headers: { Location: `${SITE_URL}/l/ended`, "Cache-Control": cache } });
  if (!CODE.test(code)) return ended();
  const unavailable = () => new Response("This link is unavailable right now. Please try again.", { status: 503, headers: { "Cache-Control": "no-store" } });
  let link, store;
  try {
    link = await findLink(code);
    // Read exactly (Codex J on #2527): only a store confirmed gone ends the link; a partial read is "try again",
    // never an ended page the CDN would keep for five minutes.
    store = link ? await storeForIdExactly(link.sid) : "none";
  } catch {
    return unavailable();
  }
  if (store === "unknown") return unavailable();
  if (!link || store === "none" || store.statsId !== link.statsId) return ended();
  return new Response(null, { status: 302, headers: { Location: landingUrl(storeBase(store), link), "Cache-Control": cache } });
}
