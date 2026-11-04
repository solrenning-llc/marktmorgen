import type { NextRequest } from "next/server";
import { cardVcard, readCreatorCard, vcardFileName } from "@/lib/creator-card";
import { SITE_URL } from "@/lib/site-url";
import { normaliseHandle, storeForPage } from "@/lib/store";

/**
 * The creator's business card as a file to save in a phone's or a
 * computer's contacts (vCard 4.0, lib/creator-card.ts; 639 [GL7](22)): only
 * what the creator typed for it, only while they have it on and the store
 * is not switched off. Made on
 * request from the kept card, never stored as a file.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  if (!decoded.startsWith("@")) return new Response("Not found", { status: 404 });
  const store = await storeForPage(normaliseHandle(decoded));
  // Switched off after notices about its content (lib/takedown.ts): its card is not given either.
  if (!store || store.suspended) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const card = await readCreatorCard(store.statsId);
  const file = cardVcard(card, store.name, `${SITE_URL}/@${store.handle}`);
  if (!file) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(file, {
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      "Content-Disposition": `attachment; filename="${vcardFileName(card)}"`,
      // A card turned off, changed or forgotten is never given again from a cache.
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
