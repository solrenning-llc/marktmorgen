import type { NextRequest } from "next/server";
import { cardVcard, readCreatorCard, vcardFileName } from "@/lib/creator-card";
import { SITE_URL } from "@/lib/site-url";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";
import { speech } from "@/lib/buyer-words";
import { plain } from "@/lib/serve-file";

/**
 * The creator's business card as a file to save in a phone's or a
 * computer's contacts (vCard 4.0, lib/creator-card.ts; 639 [GL7](22)): only
 * what the creator typed for it, only while they have it on and the store
 * is not switched off. Made on
 * request from the kept card, never stored as a file.
 *
 * Paid for before the card is read (review of #1962): one of the store's
 * public requests (lib/traffic.ts), as a certificate's file is; the file is
 * one read of a few kilobytes at the most (MAX_STORED_CARD_BYTES), so one
 * request covers it. Past the window's requests, or with no window they can
 * be counted in, the store is resting and nothing is read.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  if (!decoded.startsWith("@")) return new Response("Not found", { status: 404 });
  const store = await storeForPage(normaliseHandle(decoded));
  // Switched off after notices about its content (lib/takedown.ts): its card is not given either.
  if (!store || store.suspended) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!(await takePublicRequest(store, "public"))) return plain(503, speech(store).w.restingTitle);
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
