import type { NextRequest } from "next/server";
import { CACHE_SECONDS, CODE } from "@/lib/short-link-rules";
import { findLink, landingUrl } from "@/lib/short-links";
import { storeForId } from "@/lib/store";
import { storeBase } from "@/lib/purchase-email";
import { SITE_URL } from "@/lib/site-url";

type Params = { params: Promise<{ code: string }> };

/**
 * A short link for a post (lib/short-links.ts): sends the person to the page
 * it was made for, tagged with where it was posted and the post's name, so
 * the visit is counted by that page, like any other, and its results are
 * the post's row in the numbers. Kept by the CDN for five minutes, so a link
 * opened a great many times is mostly answered without reaching the server.
 * A link that was ended, or never was, opens the page that says so; one that
 * could not be read just now answers 503, never "ended".
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { code: raw } = await params;
  const code = raw.toLowerCase();
  const cache = `public, max-age=0, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=60`;
  const ended = () => new Response(null, { status: 302, headers: { Location: `${SITE_URL}/l/ended`, "Cache-Control": cache } });
  if (!CODE.test(code)) return ended();
  // A link or a store that could not be read just now is not "ended" (rule 24; Codex U on #2878): saying so, and
  // letting the CDN keep that for five minutes, would turn a live link away. It answers 503, kept by nobody.
  let link: Awaited<ReturnType<typeof findLink>>;
  let store: Awaited<ReturnType<typeof storeForId>>;
  try {
    link = await findLink(code);
    store = link ? await storeForId(link.sid) : null;
  } catch (error) {
    console.error("opening a short link failed", error);
    return new Response("This link could not be opened just now. Please try again in a minute.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store", "Retry-After": "60" },
    });
  }
  if (!link || !store || store.statsId !== link.statsId) return ended();
  return new Response(null, { status: 302, headers: { Location: landingUrl(storeBase(store), link), "Cache-Control": cache } });
}
