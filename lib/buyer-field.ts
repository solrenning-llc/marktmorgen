import { createHash } from "node:crypto";

/**
 * Who bought a gift or a purchase for several, as kept on its record (b) and as its buyer index is keyed (#5125): the
 * SHA-256 of the address, trimmed and in lower case. One helper for both lib/gifts.ts and lib/group-buy.ts, so the two
 * indexes can never normalize an address differently (Claude 1 and Claude 4 Z on #5148).
 */
export const buyerField = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

/** A paid record's buyer, as kept on it (b): from the checkout that paid for it; none when it names no address. */
export function buyerOf(session: { customer_details?: { email?: unknown } | null }): { b?: string } {
  const typed = typeof session.customer_details?.email === "string" ? session.customer_details.email.trim() : "";
  return typed ? { b: buyerField(typed) } : {};
}
