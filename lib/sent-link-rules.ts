/**
 * Where a link in a sent email goes, and changing it afterwards (124
 * [F2-EDIT-SENT-LINKS], unit 1: the rules only; nothing sends or answers one
 * yet).
 *
 * In an email whose creator chose to be able to change its links later, each
 * link of the creator's own words is written as our address,
 *
 *   /r/<store id>/<email id>/<n>?u=<the address as written>&s=<signature>
 *
 * the same for every reader: nothing in it names who got it, and nothing is
 * kept about who used it (opens are never counted; which links somebody uses
 * is seen only with their own consent, lib/mail-clicks.ts, and not here).
 * The store's fixed id lets a click find the store (lib/store.ts storeForId)
 * to count it, without reading the email. The signature is of the store, the
 * email, the link's number and the address as written, so the redirect can never be used to send someone to an address
 * the creator did not write (no open redirect). With no change kept it goes
 * where it was written to go, so a link never dies because a record expired;
 * only a change is kept, with a short history: each address and when it was
 * set, never a person.
 *
 * Pure: the signing is given (lib/secret-box.ts deriveKey in the next unit).
 */
import { SITE_URL } from "@/lib/site-url";

/** Links of one email that can be changed: a review ceiling on what one email keeps. */
export const MAX_SENT_LINKS = 20;
/** The longest address a link may go to. */
export const MAX_SENT_LINK_URL = 2048;
/** Changes kept for one link, newest first. */
export const MAX_LINK_CHANGES = 10;
/** Database commands one click makes at the most (lib/sent-links.ts): the store's id and record, and the link's changes. A review ceiling. */
export const SENT_LINK_COMMANDS = 3;
/**
 * Public requests of the store's month one click takes before its changes
 * are read: more than its reads cost (SENT_LINK_READ in
 * tests/plan-cost-registry.test.ts).
 */
export const SENT_LINK_REQUEST_UNITS = 2;

const EMAIL_ID = /^[0-9a-f]{24}$/;
/** A store's fixed id, as lib/store.ts STORE_ID_PATTERN (not imported, so these rules stay pure). */
const STORE_ID = /^[0-9a-f]{32}$/;
const SIGNATURE = /^[0-9a-f]{32}$/;
const NUMBER = /^(0|[1-9]\d?)$/;

export type LinkChange = { to: string; at: number };

/** A destination a creator may choose: a plain web address, never another scheme, credentials or our own redirect. */
export function readSentLinkTarget(raw: unknown): { ok: true; to: string } | { ok: false } {
  if (typeof raw !== "string") return { ok: false };
  const text = raw.trim();
  if (!text || text.length > MAX_SENT_LINK_URL) return { ok: false };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false };
  if (url.username || url.password) return { ok: false };
  if (!url.hostname.includes(".") || url.hostname.startsWith(".") || url.hostname.endsWith(".")) return { ok: false };
  let site: URL;
  try {
    site = new URL(SITE_URL);
  } catch {
    return { ok: false };
  }
  // One of these links itself would loop; www. is the same site (review of #3713).
  const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");
  if (bare(url.hostname) === bare(site.hostname) && url.pathname.startsWith("/r/")) return { ok: false };
  return { ok: true, to: text };
}

const signed = (storeId: string, emailId: string, n: number, original: string) => `${storeId}|${emailId}|${n}|${original}`;

/** The path a link is written as in the email: null without a signature, or past the most links of one email. */
export function sentLinkPath(storeId: string, emailId: string, n: number, original: string, sign: (text: string) => string | null): string | null {
  if (!STORE_ID.test(storeId) || !EMAIL_ID.test(emailId) || !Number.isInteger(n) || n < 0 || n >= MAX_SENT_LINKS) return null;
  const s = sign(signed(storeId, emailId, n, original));
  if (!s || !SIGNATURE.test(s)) return null;
  return `/r/${storeId}/${emailId}/${n}?u=${encodeURIComponent(original)}&s=${s}`;
}

/** A link as it comes back: its number and the address it was written to, only when the signature is that store's and email's own. */
export function readSentLinkPath(
  storeId: string,
  emailId: string,
  n: string,
  query: { u?: unknown; s?: unknown },
  verify: (text: string, signature: string) => boolean,
): { ok: true; n: number; original: string } | { ok: false } {
  if (!STORE_ID.test(storeId) || !EMAIL_ID.test(emailId) || !NUMBER.test(n)) return { ok: false };
  const number = Number(n);
  if (number >= MAX_SENT_LINKS) return { ok: false };
  if (typeof query.u !== "string" || typeof query.s !== "string" || !SIGNATURE.test(query.s)) return { ok: false };
  if (!verify(signed(storeId, emailId, number, query.u), query.s)) return { ok: false };
  return { ok: true, n: number, original: query.u };
}

/** Where a link goes: its newest kept change, else where it was written to go; null when that does not read as an address. */
export function sentLinkGoesTo(original: string, newest: LinkChange | null): string | null {
  // A change kept but no longer readable, or an original that is not an address, is unknown (null): never the old
  // address, which the creator may have changed because it was wrong (rule 24; review of #3713).
  const read = readSentLinkTarget(newest ? newest.to : original);
  return read.ok ? read.to : null;
}

/** A change to a link, kept newest first with at most MAX_LINK_CHANGES. Going back to the original is a change too. */
export function changeSentLink(history: readonly LinkChange[], original: string, raw: unknown, at: number): { ok: true; history: LinkChange[] } | { ok: false; problem: "address" | "same" } {
  const read = readSentLinkTarget(raw);
  if (!read.ok) return { ok: false, problem: "address" };
  if (read.to === sentLinkGoesTo(original, history[0] ?? null)) return { ok: false, problem: "same" };
  return { ok: true, history: [{ to: read.to, at }, ...history].slice(0, MAX_LINK_CHANGES) };
}
