/**
 * The name shown as an email's sender, made safe to show (Claude 7's outgoing-email audit, 15 November 2026). A
 * creator types their sender name and their store's name, and a name is what a reader trusts first: a name that holds
 * an address ("support@paypal.com"), a domain ("paypal.com", "www.apple.com") or claims to be Marktmorgen or its support
 * would make a creator's email pass for somebody else's, the display-name spoof. Such a name is never shown: the caller's
 * fallback is (the store's name when that is safe, else its address, "@handle"), so the email still says whose it is.
 *
 * Also what every From name needs: no quote, backslash, angle bracket or line break, at most 60 characters.
 * Pure. The settings page keeps what the creator typed; only what is shown is decided here.
 */

/**
 * Something shaped like a domain: a letter or digit, a dot and two or more letters with no space between (paypal.com,
 * help.co.uk). An abbreviation followed by a space ("St. Louis", "Dr. Ana") is a name, not a domain.
 */
const DOMAIN_LIKE = /[a-z0-9-]\.[a-z]{2,}\b/i;
/** A name that claims to be the platform, or a support desk speaking for one. */
const CLAIMS = /\b(marktmorgen|support|helpdesk|help\s*desk|security\s*team|billing\s*team|customer\s*service|no-?reply)\b/i;

/** The name cleaned for a From line, or "" when nothing is left. */
function cleaned(name: string): string {
  return name.replace(/["\\<>\r\n\u0000-\u001f\u007f\u2028\u2029]/g, "").replace(/\s{2,}/g, " ").trim().slice(0, 60).trim();
}

/** Whether a cleaned name may be shown as a sender. */
export function senderNameOk(name: string): boolean {
  const text = cleaned(name);
  return text !== "" && !text.includes("@") && !DOMAIN_LIKE.test(text) && !CLAIMS.test(text);
}

/** The name to show as the sender: `name` when it may be shown, else `fallback` (itself cleaned). */
export function safeSenderName(name: string, fallback: string): string {
  return senderNameOk(name) ? cleaned(name) : cleaned(fallback);
}
