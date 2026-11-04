import type { NextRequest } from "next/server";
import { cardVcard, readCreatorCard, vcardFileName, vcardFileNameStar } from "@/lib/creator-card";
import { SITE_URL } from "@/lib/site-url";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

/**
 * The creator's business card as a file to save in a phone's or a
 * computer's contacts (vCard 4.0, lib/creator-card.ts; 639 [GL7](22)): only
 * what the creator typed for it, only while they have it on and the store
 * is not switched off. Each file is one of the store's public requests
 * (lib/traffic.ts), taken before the card is read; past the window's, none
 * is made. Made on request from the kept card, never stored as a file.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ handle: string }> }) {
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
  // One of the store's public requests for its window, as the store's other public answers.
  if (!(await takePublicRequest(store))) return new Response("Please try again later.", { status: 429, headers: { "Cache-Control": "no-store" } });
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
