/**
 * A link that opens a product with one of its price options already chosen
 * (630 [HN6](27), part (a); owner's Hotmart audit). The creator copies the
 * link of one option from the studio, say "Gold", and puts it on a sales page
 * or in an email; whoever opens it lands on the product's page with Gold
 * chosen, is told so, and can still choose another.
 *
 * Pure and browser-safe. What it holds to:
 *
 *   - only an option the page offers right now (sellableOptions in
 *     lib/product-option.ts) is chosen; an id it does not offer, a removed
 *     option or anything malformed chooses nothing, and the page asks for a
 *     choice as it always has (487 [IT4]: nothing is chosen for the buyer
 *     without their own click);
 *   - the link carries only the option's id, never a price, a discount or
 *     anything about a person: the price is still read from the creator's own
 *     record at checkout;
 *   - choosing is all it does: the buyer still presses the buy button.
 *
 * Cost: none. The page already reads the product; reading one query value
 * adds no read, write, request or supplier.
 */
import { OPTION_ID } from "@/lib/product-option";

/** The query parameter a product page reads the option from. */
export const OPTION_PARAM = "option";

/** The option the link names, when the page offers it now; null otherwise. */
export function linkedOption(raw: unknown, offered: readonly { id: string }[]): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !OPTION_ID.test(value)) return null;
  return offered.some((option) => option.id === value) ? value : null;
}

/** A product page's own path with one option chosen: `/@shop/p/guide-abc123?option=gold`. */
export function optionLinkPath(productPath: string, optionId: string): string {
  if (!OPTION_ID.test(optionId)) throw new Error("not an option id");
  return `${productPath}?${OPTION_PARAM}=${encodeURIComponent(optionId)}`;
}
