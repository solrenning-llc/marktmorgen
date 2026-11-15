/**
 * The age a creator confirms when making a store (568 [GD2] (i), unit 1).
 *
 * The Terms (app/terms/page.tsx, "1. Eligibility and accounts") say a person
 * must be at least 18, or the age of majority where they live if that is
 * higher, to use the Services. Until now nothing asked: a store was made with
 * an address and a name. Now the form that makes a store shows an unchecked
 * box with ADULT_SENTENCE, and the server makes no store without it.
 *
 * The yes is kept on the store record (Store.adultConfirmed) with the version
 * of the words the person checked and the time, so it can be shown which
 * sentence was agreed to and when. ADULT_VERSION goes up whenever the words
 * change; a page still showing older words sends an older version, which is
 * refused (unknown is never a yes), and the person reloads and checks again.
 *
 * Pure: no request, nothing written. It does not check a person's real age,
 * which nothing on this site can do without asking for an identity document
 * (568 [GD2] (c) forbids forms that ask for one); Stripe checks the identity
 * of whoever takes payments, on its own pages.
 */

/** The words beside the box. Change ADULT_VERSION with them. */
export const ADULT_SENTENCE = "I am at least 18 years old, or the age of majority where I live if that is higher.";

/** The version of ADULT_SENTENCE; up by one whenever its words change. */
export const ADULT_VERSION = 1;

/** A yes kept on a store: the version of the words checked, and when (ISO 8601). */
export type AdultConfirmation = { version: number; at: string };

/**
 * The yes in a request to make a store, or null when there is none: the box
 * must be sent as exactly `true`, with exactly the current version. Anything
 * else (missing, "on", "true", 1, an older or a later version) is no yes.
 */
export function adultFrom(body: Record<string, unknown>, now: Date = new Date()): AdultConfirmation | null {
  if (body.adult !== true) return null;
  if (body.adultVersion !== ADULT_VERSION) return null;
  return { version: ADULT_VERSION, at: now.toISOString() };
}

/**
 * A kept yes read back from a stored record, or null when it is not one: a
 * whole positive version and a real ISO time. A record with something else in
 * the field is read as having no yes, never as having one.
 */
export function readAdult(value: unknown): AdultConfirmation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { version, at } = value as Record<string, unknown>;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > 1_000) return null;
  if (typeof at !== "string" || at.length > 30 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(at)) return null;
  if (!Number.isFinite(Date.parse(at))) return null;
  return { version, at };
}
