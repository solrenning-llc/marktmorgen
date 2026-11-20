/**
 * What a creator may do with a link in a one-off email already sent (124
 * [F2-EDIT-SENT-LINKS], 6 November 2026), with nothing that needs the
 * server: the studio's form and the server read the same rules.
 *
 * A link in an email made from 6 November 2026 goes through one redirect of
 * ours (lib/sent-links.ts, app/go), the same for everybody who got the
 * email, so the creator can send a wrong or ended link somewhere else after
 * it went out. Where it may go is held tight, because a redirect on our
 * address that leads anywhere is what phishing looks for:
 *
 *   - https only, a full address, no name or password in it, no port;
 *   - a link that went to the store goes only to another page of the store;
 *   - any other link goes to another page on the host it first went to, or
 *     to a page of the store;
 *   - never to another page of ours that is not the store (another store,
 *     another redirect).
 *
 * The original is always where it can go back to.
 */
import { bodyHtml } from "@/lib/mail-body";
import { isOwnLink } from "@/lib/mail-links";
import { SITE_URL } from "@/lib/site-url";
import type { Store } from "@/lib/store";

/** Links an email can have changed: the first ones, in the order they are written. The rest go straight where written. */
export const SENT_LINKS_MAX = 20;
/** Changes kept for one email, all its links together: past them, it says so. */
export const SENT_LINK_CHANGES_MAX = 20;
/** The longest address a link can be changed to. */
export const SENT_LINK_MAX_LENGTH = 1_000;
/** How long the changes are kept after the first one, in days; then the links go where the email first sent them. */
export const SENT_LINK_KEEP_DAYS = 400;
/**
 * The longest change kept, in UTF-8 bytes, as written in the history with its
 * comma: {"n":19,"to":"…","at":…}, the address at SENT_LINK_MAX_LENGTH
 * characters of three bytes each (a well-formed character outside ASCII is
 * two or three bytes; one of four bytes is two characters), its number and
 * time with room.
 */
export const SENT_LINK_ENTRY_MAX_BYTES = 64 + SENT_LINK_MAX_LENGTH * 3;
/**
 * The longest history kept for one email, in UTF-8 bytes: its list and
 * expiry, and SENT_LINK_CHANGES_MAX changes at their longest. The server
 * never writes one past it (lib/sent-links.ts, changeLink), so what the
 * redirect reads and what a change sends are bounded by it in bytes, not
 * only in characters.
 */
export const SENT_LINK_RECORD_MAX_BYTES = 256 + SENT_LINK_CHANGES_MAX * SENT_LINK_ENTRY_MAX_BYTES;
/** One redirect is this many of the store's public requests (lib/traffic.ts), counted before the change is read. */
export const SENT_LINK_REQUEST_UNITS = 1;

/** Which subject line's share of the email a link was sent in (lib/mail-test.ts): "x" for the email's own. */
export type SentVariant = "x" | "a" | "b";
export const SENT_VARIANTS: readonly SentVariant[] = ["x", "a", "b"];

/** One change: link number `n` goes to `to` from `at` (seconds). */
export type LinkChange = { n: number; to: string; at: number };

/**
 * The links of an email that can be changed: distinct, in the order the
 * email draws them, read by drawing it (lib/mail-body.ts), so they are
 * exactly the ones a reader's email has.
 */
export function linksOf(body: string): string[] {
  const seen: string[] = [];
  bodyHtml(body, (href) => {
    if (/^https:\/\//.test(href) && !seen.includes(href)) seen.push(href);
    return href;
  });
  return seen.slice(0, SENT_LINKS_MAX);
}

/** Where link `n` goes now: its last change, or null when it was never changed. */
export function currentOf(changes: LinkChange[], n: number): string | null {
  for (let i = changes.length - 1; i >= 0; i -= 1) if (changes[i].n === n) return changes[i].to;
  return null;
}

/**
 * Why a link first sent to `original` may not go to `raw`, in words for the
 * studio; null when it may.
 */
export function destinationProblem(raw: string, original: string, store: Pick<Store, "handle" | "domain">): string | null {
  const to = typeof raw === "string" ? raw.trim() : "";
  if (!to) return "Type the address the link should go to.";
  if (to.length > SENT_LINK_MAX_LENGTH) return `An address can be up to ${SENT_LINK_MAX_LENGTH.toLocaleString("en-US")} characters long.`;
  if (/[\s<>"'`\\\u0000-\u001f\u007f]/.test(to)) return "An address cannot have spaces, quotes or angle brackets in it.";
  // Half of a character (a lone surrogate) is no text: kept, it would be written as six bytes.
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(to)) return "The address has a character in it that cannot be used. Type it again, or copy it again from the page.";
  let url: URL;
  try {
    url = new URL(to);
  } catch {
    return "That is not a full web address. Start it with https://";
  }
  if (url.protocol !== "https:") return "The address has to start with https:// so it opens securely.";
  if (url.username || url.password) return "The address cannot have a name or a password in it.";
  if (url.port) return "The address cannot name a port.";
  if (to === original) return null;
  if (isOwnLink(url, store)) return null;
  let first: URL;
  try {
    first = new URL(original);
  } catch {
    return "This link can only go to a page of your store.";
  }
  if (isOwnLink(first, store)) return "This link went to your store, so it can only go to another page of your store.";
  let site = "";
  try {
    site = new URL(SITE_URL).host.toLowerCase();
  } catch {
    site = "";
  }
  if (url.host.toLowerCase() === site) return "On Marktmorgen, a link can only go to a page of your own store.";
  if (url.host.toLowerCase() !== first.host.toLowerCase()) return `This link can go to another page on ${first.host}, or to a page of your store.`;
  return null;
}
