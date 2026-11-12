/**
 * One page of a Stripe list, read in its exact shape (CX-123 rules 24 and 30;
 * Claude 4, C4-20261106-0105-C5-13; the Revisor 1's reading on #2464).
 *
 * A page is a plain object whose own `data` is an array and whose own
 * `has_more` is a boolean; anything else is not a page at all and throws
 * StripeListUnreadable, so a garbled answer is never read as an empty list.
 *
 * Each row counts only when it is a plain object with its own `id` in text
 * and the fields its caller needs, in values Stripe gives (`legible`). A row
 * that is not is counted in `unreadable` and proves nothing: it does not
 * throw the rest of the page away, and a "yes" found on another, readable
 * row still stands. What a caller may conclude:
 *
 *   - "yes" / "found" / "at least n": from readable rows, on any page;
 *   - "no" / "none" / "zero": only from a list read to its end (has_more
 *     false on the last page) with every row readable; otherwise the answer
 *     is not known, which the caller says as such, never as a no.
 */
import { types } from "node:util";

/** The version the callers in this lot pin their list reads to: the same as STRIPE_VERSION (lib/stripe-connect.ts). */
export const STRIPE_LIST_VERSION = "2026-08-26.dahlia";

export class StripeListUnreadable extends Error {
  constructor(what: string) {
    super(`Stripe answered a list in another shape: ${what}`);
    this.name = "StripeListUnreadable";
  }
}

export type StripeRow = Record<string, unknown> & { id: string };

export type StripePage = {
  /** The readable rows, in the order Stripe gave them. */
  rows: StripeRow[];
  /** Rows that are not readable: they prove nothing, and keep a "no" from being said. */
  unreadable: number;
  hasMore: boolean;
  /** The id to read the next page from: the last row's, only when that row is readable. */
  lastId: string | null;
};

/** A plain object Stripe's JSON would give: no array, no proxy, no class. */
export function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A field the object holds itself as plain data; undefined when it is missing, inherited or behind a getter. */
export function ownField(object: Record<string, unknown>, name: string): unknown {
  const slot = Object.getOwnPropertyDescriptor(object, name);
  return slot && Object.hasOwn(slot, "value") ? slot.value : undefined;
}

/** Whether the object holds this field itself as plain data (null included). */
export function hasOwnField(object: Record<string, unknown>, name: string): boolean {
  const slot = Object.getOwnPropertyDescriptor(object, name);
  return Boolean(slot && Object.hasOwn(slot, "value"));
}

const ANY_ID = /^[A-Za-z0-9_]{3,255}$/;

export function readStripePage(
  page: unknown,
  legible: (row: Record<string, unknown>) => boolean = () => true,
  idPattern: RegExp = ANY_ID,
): StripePage {
  if (!plainObject(page)) throw new StripeListUnreadable("not an object");
  const data = ownField(page, "data");
  const hasMore = ownField(page, "has_more");
  if (!Array.isArray(data) || types.isProxy(data)) throw new StripeListUnreadable("data is not a list");
  if (typeof hasMore !== "boolean") throw new StripeListUnreadable("has_more is not true or false");
  const rows: StripeRow[] = [];
  let unreadable = 0;
  let lastId: string | null = null;
  for (let i = 0; i < data.length; i += 1) {
    const slot = Object.getOwnPropertyDescriptor(data, String(i));
    const row = slot && Object.hasOwn(slot, "value") ? slot.value : undefined;
    const id = plainObject(row) ? ownField(row, "id") : undefined;
    const ok = plainObject(row) && typeof id === "string" && idPattern.test(id) && legible(row);
    if (ok) rows.push(row as StripeRow);
    else unreadable += 1;
    if (i === data.length - 1) lastId = ok ? (id as string) : null;
  }
  return { rows, unreadable, hasMore, lastId };
}
