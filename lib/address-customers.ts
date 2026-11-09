/**
 * The customers a creator's Stripe account holds under one address, read as
 * typed and in small letters (Claude 5, the residue of R43 F1 on #2985 and its
 * sibling in the studio's member tools). Not every spelling: see below.
 *
 * Stripe's hosted checkout keeps the address as the buyer typed it on the
 * customer it makes, and the `email` filter of Stripe's customer list is
 * case-sensitive, so "Ana@Example.com" and "ana@example.com" are two
 * customers no one exact read finds together. The address is read as typed
 * and in small letters (one read when they are the same), never by sweeping
 * the account's customers. A spelling neither read nor typed
 * ("ANA@example.com" behind "Ana@Example.com") is not found: Stripe has no
 * case-blind exact filter. So an empty answer is no proof that the address
 * has no customer: a page never says "no membership", it says none was found
 * and asks for the address as the member typed it (components/member-discount.tsx,
 * components/member-free-days.tsx).
 *
 * Identity: a customer counts only when its own address is the one typed,
 * ignoring capitals. Any other row (another address, none, not text) proves
 * nothing and makes the answer unknown, never "no customer".
 *
 * Both reads together, newest first and each customer once, stay within
 * `max` customers; past it, or when either list has more pages or an
 * unreadable row, the answer is unknown. A page that is not a Stripe list
 * throws StripeListUnreadable (lib/stripe-list.ts).
 */
import { normaliseEmail } from "@/lib/auth";
import { ownField, readStripePage, type StripeRow } from "@/lib/stripe-list";

export type AddressCustomers = {
  /** The address's customers, newest first, each once, at most `max`. */
  rows: StripeRow[];
  /** Whether customers may exist past those rows: then no "no customer" or "not a member" may be said. */
  unknown: boolean;
};

/** The spellings an address is read under: as typed (trimmed) and in small letters, once when they are the same. */
export function addressSpellings(typed: string): string[] {
  const trimmed = typed.trim();
  const lower = normaliseEmail(trimmed);
  return trimmed === lower ? [lower] : [trimmed, lower];
}

/**
 * Reads the customers of an address under each of its spellings, side by
 * side; `read` asks Stripe's customer list for one spelling (its `email`
 * filter, at most `max` rows) and returns the answer as Stripe gave it.
 */
export async function customersOfAddress(
  typed: string,
  max: number,
  read: (spelling: string) => Promise<unknown>,
  idPattern: RegExp,
): Promise<AddressCustomers> {
  const lower = normaliseEmail(typed);
  const sameAddress = (row: Record<string, unknown>) => {
    const own = ownField(row, "email");
    return typeof own === "string" && own.toLowerCase() === lower;
  };
  const pages = await Promise.all(addressSpellings(typed).map(async (spelling) => readStripePage(await read(spelling), sameAddress, idPattern)));
  let unknown = pages.some((page) => page.unreadable > 0 || page.hasMore);
  const createdOf = (row: Record<string, unknown>) => {
    const at = ownField(row, "created");
    return typeof at === "number" ? at : 0;
  };
  const seen = new Set<string>();
  const all = pages.flatMap((page) => page.rows).filter((row) => !seen.has(row.id) && Boolean(seen.add(row.id)));
  all.sort((x, y) => createdOf(y) - createdOf(x));
  if (all.length > max) unknown = true;
  return { rows: all.slice(0, max), unknown };
}
