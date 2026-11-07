import type { NextRequest } from "next/server";
import { CODE, linkCache, targetNow } from "@/lib/short-link-rules";
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
 * A link that was ended, or never was, opens the page that says so.
 *
 * A link set to change on a date (510 [CK2] unit 1) opens its own page before
 * it and the other one from it on, read from the same record at the same
 * moment, and the CDN keeps the answer only until the date (linkCache), so
 * nobody is sent to the old page after it.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { code: raw } = await params;
  const code = raw.toLowerCase();
  const now = Date.now();
  const ended = () => new Response(null, { status: 302, headers: { Location: `${SITE_URL}/l/ended`, "Cache-Control": linkCache(null, now) } });
  if (!CODE.test(code)) return ended();
  const link = await findLink(code).catch(() => null);
  const store = link ? await storeForId(link.sid).catch(() => null) : null;
  if (!link || !store || store.statsId !== link.statsId) return ended();
  const target = targetNow(link, now);
  return new Response(null, { status: 302, headers: { Location: landingUrl(storeBase(store), { ...link, target }), "Cache-Control": linkCache(link, now) } });
}
