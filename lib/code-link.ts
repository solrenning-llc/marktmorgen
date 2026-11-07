/**
 * A discount code that arrives in a link: marktmorgen.com/@harbor?code=SPRING,
 * or the same on a product's page or the store's own domain.
 *
 * Measured before it was built (7 October 2026): Gumroad, Kajabi and Shopify
 * all take a code in the address and apply it at checkout; on Stan a buyer
 * types it into the box. A code someone has to retype from a post or an email
 * is a code some of them never use, and a creator who shares one wants it to
 * just work.
 *
 * What it is, and what it is not:
 *
 *   - The code is remembered for this store, in this browser, for seven days
 *     (the proxy sets it, proxy.ts), so it still applies when the buyer comes
 *     back from another page. Remembering what the visitor clicked to get is
 *     the service they asked for, so it does not wait for consent.
 *   - It decides nothing. At the checkout (one product's, lib/store-checkout.ts,
 *     or a cart's, lib/cart-checkout.ts, since 624 [SZ8](23)) the code is looked up on the
 *     creator's own Stripe account; only a live promotion code of theirs is
 *     applied, by Stripe, with Stripe's own rules (its end date, its limits,
 *     a first order only). A code that is unknown, used up or not for this
 *     sale leaves the checkout exactly as it would have been, with the box
 *     to type one in.
 *   - It never stacks: a store-wide sale or a come-back offer already
 *     applied wins, as it does when a code is typed (lib/store-checkout.ts).
 *
 * Pure, so the proxy can import it.
 */
/**
 * The shape of a code: the same as lib/discount.ts's CODE_PATTERN, written out
 * here because that module talks to Stripe and the proxy must not load it.
 * tests/code-link.test.ts holds the two to the same pattern.
 */
export const LINK_CODE_PATTERN = /^[A-Z0-9-]{3,24}$/;

/** How long the code is kept: a week, which outlasts any "this weekend" offer. */
export const CODE_COOKIE_SECONDS = 7 * 24 * 60 * 60;

/** One cookie per store, so a code for one store is never sent to another's checkout. */
export function codeCookieName(handle: string): string {
  return `nl_code_${handle.toLowerCase().replace(/[^a-z0-9_-]/g, "")}`;
}

/** A code as it arrives in an address, made the shape codes have here, or "" when it is not one. */
export function readLinkCode(raw: string | null | undefined): string {
  const code = (raw ?? "").trim().toUpperCase().slice(0, 40);
  return LINK_CODE_PATTERN.test(code) ? code : "";
}
