import type { NextRequest } from "next/server";
import { CACHE_SECONDS, CODE } from "@/lib/short-link-rules";
import { findLink, landingUrl } from "@/lib/short-links";
import { storeForId } from "@/lib/store";
import { storeBase } from "@/lib/purchase-email";
import { SITE_URL } from "@/lib/site-url";
import { clientAddress } from "@/lib/request-guard";
import { paceAddress } from "@/lib/picture-pace";
import { admitShortLinkOpen, payShortLinkOpen, shortLinkRefusal } from "@/lib/short-link-open";

type Params = { params: Promise<{ code: string }> };

/**
 * A short link for a post (lib/short-links.ts): sends the person to the page
 * it was made for, tagged with where it was posted and the post's name, so
 * the visit is counted by that page, like any other, and its results are
 * the post's row in the numbers. Kept by the CDN for five minutes, so a link
 * opened a great many times is mostly answered without reaching the server.
 * A link that was ended, or never was, opens the page that says so.
 * What reaches the function has a ceiling (lib/short-link-open.ts): a pace
 * per address and an hour's count, before anything is read; the store pays
 * for its link's open, after it is found. A refusal sends nobody anywhere.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { code: raw } = await params;
  const code = raw.toLowerCase();
  const cache = `public, max-age=0, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=60`;
  const ended = () => new Response(null, { status: 302, headers: { Location: `${SITE_URL}/l/ended`, "Cache-Control": cache } });
  if (!CODE.test(code)) return ended();
  const admission = await admitShortLinkOpen(code, { address: paceAddress(clientAddress(request)) });
  if (admission.state !== "open") return shortLinkRefusal(admission);
  const link = await findLink(code).catch(() => null);
  const store = link ? await storeForId(link.sid).catch(() => null) : null;
  if (!link || !store || store.statsId !== link.statsId) return ended();
  if (!(await payShortLinkOpen(store, code, admission))) return shortLinkRefusal({ state: "tired", now: Date.now() });
  return new Response(null, { status: 302, headers: { Location: landingUrl(storeBase(store), link), "Cache-Control": cache } });
}
