/**
 * Member prices in the cart (620 [SZ4], unit 4; the rules and the proof are
 * lib/member-price-rules.ts and lib/member-price.ts).
 *
 * The open cart (app/api/store/cart, GET) shows each line at its member price
 * when this browser's address is proved now, and keeps in this browser, as a
 * cookie, the percentage it showed for each line. Paying (POST) proves it
 * again and charges a member price only when every line's proof equals what
 * the cart showed; anything else goes back to the cart, which reads it again,
 * so Stripe never charges a price the cart did not show. The cookie is only
 * what was shown: it is never trusted to give a price, only compared.
 *
 * The cart's form sends nothing but the products (components/store-cart.tsx),
 * so the claim rides on the answer the cart already reads.
 */
import { isMemberPercent } from "@/lib/member-price-rules";
import type { Store } from "@/lib/store";

/** How long the browser keeps what the cart showed: past it, a member price shown is proved and shown again before it is charged. */
export const CART_MEMBER_SECONDS = 2 * 60 * 60;

const LINE = /^([A-Za-z0-9_-]{1,64}):(\d{1,2})$/;
/** Lines a cart holds at most (lib/cart-rules.ts, MAX_CART), with room for the products a cart was shown before it changed. */
const MAX_LINES = 8;

/** The cookie, one per store, so two stores on one domain never read each other's. */
export function cartMemberCookie(store: Pick<Store, "handle">): string {
  return `nl_cartm_${store.handle.replace(/[^a-z0-9_-]/g, "")}`;
}

/** What the cart showed, as the cookie keeps it: "id:percent" for each line with a member price, in the cart's order. */
export function cartMemberValue(lines: Iterable<readonly [string, number]>): string {
  const out: string[] = [];
  for (const [id, percent] of lines) if (percent > 0 && isMemberPercent(percent) && LINE.test(`${id}:${percent}`)) out.push(`${id}:${percent}`);
  return out.slice(0, MAX_LINES).join(".");
}

/** What the cart showed, read back; anything not in that shape reads as nothing shown. */
export function readCartMember(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw) return out;
  const parts = raw.split(".");
  if (parts.length > MAX_LINES) return out;
  for (const part of parts) {
    const match = LINE.exec(part);
    if (!match || !isMemberPercent(Number(match[2]))) return new Map();
    out.set(match[1], Number(match[2]));
  }
  return out;
}

/** The header that keeps what the cart showed, or clears it when it showed none. */
export function cartMemberHeader(store: Pick<Store, "handle">, value: string, secure: boolean): string {
  const tail = `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  return value ? `${cartMemberCookie(store)}=${value}; Max-Age=${CART_MEMBER_SECONDS}; ${tail}` : `${cartMemberCookie(store)}=; Max-Age=0; ${tail}`;
}

/** Whether every line's member price proved now equals what the cart showed (0 for none). */
export function cartClaimHolds(ids: readonly string[], shown: ReadonlyMap<string, number>, proved: ReadonlyMap<string, number>): boolean {
  return ids.every((id) => (shown.get(id) ?? 0) === (proved.get(id) ?? 0));
}
