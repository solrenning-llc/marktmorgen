import type { NextRequest } from "next/server";
import { cardVcard, readCreatorCard, vcardFileName, vcardFileNameStar } from "@/lib/creator-card";
import { SITE_URL } from "@/lib/site-url";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { isResting } from "@/lib/traffic";
import { canUseDomain } from "@/lib/domains";

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

/**
 * The creator's business card as a file to save in a phone's or a
 * computer's contacts (vCard 4.0, lib/creator-card.ts; 639 [GL7](22)): only
 * what the creator typed for it, only while they have it on and the store
 * is not switched off. Each file is one of the store's public requests,
 * taken before the card is read by the same check the card's page and the
 * store's page make (isResting, lib/traffic.ts): a store resting for its
 * visits or its requests gives no file. Switched off is checked first, so a
 * suspended store spends nothing. Made on request from the kept card, never stored as a file.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  let decoded = "";
  try {
    decoded = decodeURIComponent(handle);
  } catch {
    return NOT_FOUND();
  }
  if (!decoded.startsWith("@")) return NOT_FOUND();
  const store = await storeForPage(normaliseHandle(decoded));
  // Switched off after notices about its content (lib/takedown.ts): its card is not given either.
  if (!store || store.suspended) return NOT_FOUND();
  // On a custom domain the store may no longer use, as its pages: nothing here.
  const reachedOn = request.headers.get("x-nimbus-domain");
  if (reachedOn && (store.domain?.name !== reachedOn || !canUseDomain(store))) return NOT_FOUND();
  // Resting for its visits or its requests (one of them taken here), as the card's page.
  if (await isResting(store)) return new Response("Please try again later.", { status: 429, headers: { "Cache-Control": "no-store" } });
  const card = await readCreatorCard(store.statsId);
  const file = cardVcard(card, store.name, `${SITE_URL}/@${store.handle}`);
  if (!file) return NOT_FOUND();
  const star = vcardFileNameStar(card);
  return new Response(file, {
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      // The name in plain letters for every browser, and as written, for a name beyond ASCII, for those that read RFC 6266's filename*.
      "Content-Disposition": `attachment; filename="${vcardFileName(card)}"${star ? `; filename*=${star}` : ""}`,
      // A card turned off, changed or forgotten is never given again from a cache.
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
