/**
 * Emails published on the store (Kajabi's "newsletters, by email and on the
 * web"; docs/zero-cost-value-2026-10-18.md, item 1; added 18 October 2026):
 * the rules, browser-safe.
 *
 * A creator may publish an email they already sent to their list as a page
 * of their store, at /@handle/letters/<id>, with a page listing every one
 * published. Only on purpose, one email at a time, and never by itself:
 * an email sent to some buyers only may hold what those buyers paid for, so
 * nothing is published that the creator did not choose, and the studio says
 * that anyone can read it once it is.
 *
 * What is published is a copy of the email's subject and words as they were
 * sent, written once when it is published: its links as the creator typed
 * them (not the tagged ones each reader's email carried), and nothing about
 * who received it. Taking it off deletes the copy.
 *
 * No new cost: the copy and its place in the list are counted in the store's
 * data room before they are written, and each page view is one of the
 * store's public requests, as every store page is.
 *
 * For members only (queue items 28 [E11] and 100 [E2-MEMBER-PUBLICATIONS],
 * added 4 November 2026): the creator may check, when publishing, the
 * products that open it. Then its subject and who it is for are shown to
 * everyone, and its words only to somebody who proved their address and
 * holds one of those products now (lib/letter-access.ts, the same answer a
 * community's door gives). Nothing checked: everyone can read it, as before.
 */

/** Emails a store keeps published at once. */
export const MAX_PUBLISHED_LETTERS = 200;
/** How long a published copy stays, from the day it was published; publishing again starts the days afresh. */
export const LETTER_KEEP_DAYS = 400;
/** A published email's id in its address: 20 hex characters, made from the email's own id and the store's, never the email's id itself. */
export const LETTER_ID = /^[0-9a-f]{20}$/;
/** Products that may open one email for members, at most. */
export const MAX_LETTER_PRODUCTS = 20;
/** A product id as a store keeps it (lib/community.ts takes the same). */
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,40}$/;

export type Letter = {
  id: string;
  sid: string;
  subject: string;
  /** The email's words as sent (lib/mail-body.ts reads them). */
  body: string;
  /** When it went out, in milliseconds. */
  sentAt: number;
  publishedAt: number;
  /** The products that open its words; absent for an email everyone can read. */
  products?: string[];
};

/** The product ids given, as a published email may keep them: each once, each well formed, at most MAX_LETTER_PRODUCTS. */
export function letterProducts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((id): id is string => typeof id === "string" && PRODUCT_ID.test(id));
  return [...new Set(ids)].slice(0, MAX_LETTER_PRODUCTS);
}

/** Whether only the holders of some products may read this email's (or blog post's, lib/store-blog.ts) words. */
export function membersOnly(letter: Pick<Letter, "products">): boolean {
  return Boolean(letter.products && letter.products.length > 0);
}

/**
 * What the studio sent as the products that open a publication kept for
 * members (an email, or a blog post, lib/store-blog.ts), read the one way
 * both read it: left out (undefined or null), it keeps what it had, so
 * saving again never opens it by itself; an array is the choice, an empty
 * one for everyone, and only of products `has` knows, at most
 * MAX_LETTER_PRODUCTS; anything else is refused (null), never read as
 * "everyone".
 */
export function productChoice(raw: unknown, has: (id: string) => boolean): { keep: true } | { keep: false; ids: string[] } | null {
  if (raw === undefined || raw === null) return { keep: true };
  if (!Array.isArray(raw)) return null;
  const ids = letterProducts(raw);
  if (ids.length !== raw.length || ids.some((id) => !has(id))) return null;
  return { keep: false, ids };
}

/** Whatever came back from storage, made safe to use; null when it is not a published email. */
export function parseLetter(raw: unknown): Letter | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== "string" || !LETTER_ID.test(v.id) || typeof v.sid !== "string" || !v.sid) return null;
  if (typeof v.subject !== "string" || !v.subject.trim() || typeof v.body !== "string" || !v.body.trim()) return null;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const products = letterProducts(v.products);
  const letter: Letter = { id: v.id, sid: v.sid.slice(0, 64), subject: v.subject.slice(0, 300), body: v.body, sentAt: num(v.sentAt), publishedAt: num(v.publishedAt) };
  // A copy that names products but none readable is kept closed, never opened to everyone.
  if (v.products !== undefined && (!Array.isArray(v.products) || (v.products.length > 0 && products.length === 0))) return null;
  return products.length ? { ...letter, products } : letter;
}

/** What the studio says before an email is published. */
export const PUBLISH_WARNING =
  "Anyone can read it once it is published, including people who are not on your list. Publish only an email whose words you would put on your store: an email sent to buyers of one product may hold what they paid for.";

/** What the studio says before an email is published for members only. */
export const MEMBERS_PUBLISH_WARNING =
  "Everyone can see its subject and which products open it. Its words show only to somebody who proves their email address and holds one of the products you checked: paid and not refunded, a membership still running, given for free, brought over or given as a gift.";
