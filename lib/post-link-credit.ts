/**
 * How a sale is counted for the link of each short video or post
 * (278 [H3-3], unit 1, added 7 November 2026).
 *
 * Short links (lib/short-links.ts) already give each video its own line of
 * visits, sales and revenue. What the studio did not say is which link a sale
 * goes to when a buyer watched two videos, or came back later. The rule is
 * the checkout's own (lib/visit-channel.ts channelForSale): the tags on the
 * page the buyer paid on win; otherwise the last place they came from within
 * the store's window (Store.attributionDays: 7, 30, 60 or 90 days); a typed
 * return visit never erases it. Where the visit cookie is never set (proxy.ts
 * withChannel: a country where the law asks visitors first, an unknown
 * country, or Global Privacy Control), only the page paid on counts.
 *
 * Pure words from a value the studio already has: no read, no write, no cost.
 * A window that is not one of the four is never shown as a number.
 */
import { ATTRIBUTION_DAYS } from "@/lib/attribution-rules";

/** The sentence for the store's window, said under its short links and in help. */
export function postLinkCredit(days: unknown): string {
  const known = typeof days === "number" && (ATTRIBUTION_DAYS as readonly number[]).includes(days);
  const window = known ? `in the ${days} days before buying` : "in the days before buying that your store counts";
  return (
    "A sale counts for one link at most. If the buyer pays on the page a link opened, it counts for that link. " +
    `If not, it counts for the last place they came from ${window}: a link, if that was the last one they used.`
  );
}

/** Where visits are not remembered (proxy.ts withChannel, lib/pixels.ts needsConsent). */
export const POST_LINK_UNREMEMBERED =
  "Where the law asks visitors first (the EU, Iceland, Liechtenstein, Norway, the UK, Switzerland and Brazil), where the visitor's country is not known, " +
  "or when their browser sends Global Privacy Control, visits are not remembered, so a sale counts for a link only if the " +
  "buyer pays on the page that link opened.";
