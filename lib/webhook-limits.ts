/**
 * The webhook figures a page may show without loading lib/webhooks.ts (which
 * reaches Stripe, Redis and the network): the studio's editor and the public
 * feature page's card read the same ones the server keeps to. Browser-safe.
 */

/** Endpoints one store may have. */
export const MAX_ENDPOINTS = 5;

/**
 * The longest any text in a message may be, in UTF-16 code units, once it is
 * cleaned where the message is made (lib/webhooks.ts, cleanText): every text
 * in it, a title, a buyer's name or address, an option, a tag the checkout
 * wrote. Past it the text is cut. 256 holds the longest address an email can
 * have (254).
 */
export const MESSAGE_TEXT_MAX = 256;
/**
 * The most bytes one delivery is ever kept at (nl:hooks:d:<id>, a week): its
 * message, escaped once more inside the record, and how it went. The store's
 * data registry prices a delivery at this (tests/store-data-registry.ts) and
 * the recent events read up to LOG_SIZE of them (lib/api-read-rules.ts,
 * eventsWork). The largest message the code makes is a sale of a bundle of
 * MAX_BUNDLE_ITEMS with three products ticked at checkout, each a bundle of
 * as many: with every text at its longest in the character that escapes
 * worst once cleaned (a quotation mark, four bytes kept), about 45 KB kept;
 * with titles in a three-byte script, about 30 KB
 * (tests/api-events-measured.test.ts).
 */
export const DELIVERY_MAX_BYTES = 64 * 1024;
/**
 * Room left under DELIVERY_MAX_BYTES when a delivery is first written, for
 * what its tries write on it later: its state, its count of tries, the
 * endpoint's answer in a sentence, the resend that names it.
 */
export const DELIVERY_UPDATE_ROOM_BYTES = 2 * 1024;
/** The most a delivery may be kept at when it is written, and so the most a message may take: DELIVERY_MAX_BYTES less the room its tries write later. */
export const DELIVERY_WRITE_MAX_BYTES = DELIVERY_MAX_BYTES - DELIVERY_UPDATE_ROOM_BYTES;

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
