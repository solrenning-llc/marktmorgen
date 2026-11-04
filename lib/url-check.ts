/**
 * A web address checked when the person leaves its field (487 [IT4],
 * pattern 1; added 1 November 2026), by the server's own reading (readLink
 * in lib/product-link.ts), so the field never passes what the save refuses.
 *
 * The usual slip is the missing "https://": then the address is offered back
 * with it, but only when that makes it one the server keeps. An http://
 * address is offered back as https://. Anything else gets the server's own
 * words, and nothing is offered. An empty field is fine: these fields are
 * optional, and the save says so when one is not.
 *
 * Browser-safe: plain functions.
 */
import { LINK_PROBLEMS, readLink } from "@/lib/product-link";
import { MAX_ROOM_LENGTH, cleanRoom } from "@/lib/call-setup";

export const NEEDS_HTTPS = "This address needs https:// at the start.";

export function linkOnLeave(raw: string): { problem: string | null; fix: string | null } {
  const typed = (raw ?? "").trim();
  if (!typed) return { problem: null, fix: null };
  const read = readLink(typed);
  if (read.ok) return { problem: null, fix: null };
  // A scheme is a name and a colon not followed by a port number: "mailto:" is one, "example.com:8080" is not.
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(typed);
  // Only an address with no scheme, or with http://, is tried with https://.
  if (!hasScheme || /^http:\/\//i.test(typed)) {
    const withHttps = readLink(`https://${typed.replace(/^http:\/\//i, "")}`);
    if (withHttps.ok) return { problem: NEEDS_HTTPS, fix: withHttps.url };
    // With no scheme typed, why the address itself is refused, not that a scheme is missing.
    if (!hasScheme) return { problem: LINK_PROBLEMS[withHttps.reason], fix: null };
  }
  return { problem: LINK_PROBLEMS[read.reason], fix: null };
}

export type LinkCheck = (raw: string) => { problem: string | null; fix: string | null };

/**
 * The same check for a field whose server reads addresses its own way:
 * `accept` is that reading (the stored address, or null when refused), and
 * `refused` the words the editor already shows for it. https:// is offered
 * back only when the server's reading then keeps it.
 */
export function checkWith(accept: (raw: string) => string | null, refused: string, maxLength: number): LinkCheck {
  return (raw) => {
    const typed = (raw ?? "").trim();
    if (!typed) return { problem: null, fix: null };
    if (typed.length > maxLength) return { problem: LINK_PROBLEMS.long, fix: null };
    const kept = accept(typed);
    // Measured as it would be stored too: letters that are written out longer can take it past the length.
    if (kept !== null) return kept.length > maxLength ? { problem: LINK_PROBLEMS.long, fix: null } : { problem: null, fix: null };
    const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(typed);
    if (!hasScheme || /^http:\/\//i.test(typed)) {
      const tried = `https://${typed.replace(/^http:\/\//i, "")}`;
      const fixed = tried.length <= maxLength ? accept(tried) : null;
      if (fixed !== null && fixed.length <= maxLength) return { problem: NEEDS_HTTPS, fix: fixed };
    }
    return { problem: refused, fix: null };
  };
}

/**
 * A meeting link, as lib/call-setup.ts cleanRoom keeps it (calls and community
 * events). cleanRoom cuts what is longer than MAX_ROOM_LENGTH, which would
 * keep a broken link, so the field says it is too long before that happens;
 * the server's reading itself is left as it is, because it also reads the
 * links already stored.
 */
export function roomOnLeave(refused: string): LinkCheck {
  return checkWith((raw) => {
    const kept = cleanRoom(raw);
    return typeof kept === "string" && kept !== "bad" ? kept : null;
  }, refused, MAX_ROOM_LENGTH);
}
