/**
 * An extra from the creator for buying through one affiliate's link
 * (630 [HN6](6), unit 1; owner's Hotmart audit, "bônus do afiliado").
 *
 * A creator may give one of their affiliates something to offer: buy through
 * that affiliate's link, and the store adds up to MAX_EXTRAS of its own
 * products to the order, delivered by the store exactly as a bundle's are
 * (lib/bundle-rules.ts). It is the creator's own product and the creator's
 * own choice, never the affiliate's, and it is said before the purchase, on
 * the product page and at checkout, never discovered after paying.
 *
 * Pure and browser-safe; nothing reads it yet. Unit 2 keeps the offers in the
 * affiliate setting and lets the creator choose them in the studio; unit 3
 * shows the line before the purchase to a visitor whose click names that
 * affiliate, writes the extras onto the checkout (extraMeta) and hands them
 * over with the order (extraFromMeta beside deliveredIds). Unit 3 needs
 * lib/store-checkout.ts, which another pull request holds today.
 *
 * What may be an extra is what may go in a bundle (canBeInBundle): a one-off
 * paid product with one price and something whole to hand over. Not one with
 * a limited number for sale (only its own checkout counts one), and never the
 * very product being bought, or one the order already hands over. A draft may
 * be one, as it may be in a bundle: it is handed over with the order like any
 * other (deliveredIds), so offering something only through affiliates is a
 * reason to keep it off the store.
 *
 * Never on an order that hands nothing over to whoever paid (a gift, a
 * purchase for several people, a pre-order: lib/bundle-rules.ts deliveredIds),
 * nor on a tip, a payment request or an order that charged nothing: the
 * extra goes with a purchase, and only one that paid (extrasAllowed).
 */
import type { Listing } from "@/lib/store";
import { MAX_AFFILIATE_EXTRAS, canBeInBundle, extraFromMeta } from "@/lib/bundle-rules";

export { extraFromMeta };

/** The most products one affiliate's offer may add to an order. */
export const MAX_EXTRAS = MAX_AFFILIATE_EXTRAS;
/** The most affiliates who may have an offer at once. */
export const MAX_EXTRA_OFFERS = 50;

const AFFILIATE_ID = /^[a-z0-9]{12}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** One affiliate's offer: which affiliate, and the creator's products the order gains. */
export type ExtraOffer = { aff: string; items: string[] };

/** The offers as kept, made safe: unreadable entries dropped, each affiliate once, each list deduplicated and capped. */
export function readExtraOffers(raw: unknown): ExtraOffer[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtraOffer[] = [];
  for (const entry of raw.slice(0, MAX_EXTRA_OFFERS * 2)) {
    if (!entry || typeof entry !== "object") continue;
    const { aff, items } = entry as { aff?: unknown; items?: unknown };
    if (typeof aff !== "string" || !AFFILIATE_ID.test(aff) || out.some((o) => o.aff === aff)) continue;
    const ids = Array.isArray(items) ? [...new Set(items.filter((id): id is string => typeof id === "string" && SAFE_ID.test(id)))].slice(0, MAX_EXTRAS) : [];
    if (ids.length > 0) out.push({ aff, items: ids });
    if (out.length === MAX_EXTRA_OFFERS) break;
  }
  return out;
}

export type ExtraProblem = "affiliate" | "count" | "unknown" | "kind" | "stock" | "too_many";

/** An affiliate as far as an offer cares: who, and whether the creator approves them today. */
export type ExtraAffiliate = { id: string; status: string };

/**
 * Why an offer sent from the studio is refused, or null. The affiliate must be
 * one the creator approves today (`approved`: their ids). Every item must be
 * one of the store's products that can be handed over whole (canBeInBundle)
 * and without a limited number; one to MAX_EXTRAS of them, none repeated.
 * `existing` is the offers kept now: changing an affiliate's own offer is not
 * one more, and a new one past MAX_EXTRA_OFFERS is refused.
 */
export function extraProblem(offer: { aff?: unknown; items?: unknown }, listings: Listing[], existing: ExtraOffer[], approved: string[]): ExtraProblem | null {
  if (typeof offer.aff !== "string" || !AFFILIATE_ID.test(offer.aff) || !approved.includes(offer.aff)) return "affiliate";
  if (!Array.isArray(offer.items) || offer.items.length < 1 || offer.items.length > MAX_EXTRAS) return "count";
  if (new Set(offer.items).size !== offer.items.length) return "count";
  for (const id of offer.items) {
    const product = typeof id === "string" ? listings.find((l) => l.id === id) : undefined;
    if (!product) return "unknown";
    if (!canBeInBundle(product)) return "kind";
    if (product.stock !== null) return "stock";
  }
  const aff = offer.aff;
  if (!existing.some((o) => o.aff === aff) && existing.length >= MAX_EXTRA_OFFERS) return "too_many";
  return null;
}

/** The order an extra would go with: its checkout metadata and what it charged, in the smallest unit. */
export type ExtraOrder = { meta: Record<string, string | undefined> | null | undefined; amountCents: number };

/** Whether an order may carry extras at all: one that paid, and hands what it bought to whoever paid. */
export function extrasAllowed(order: ExtraOrder): boolean {
  const meta = order.meta ?? {};
  if (meta.gift || meta.group || meta.preorder) return false;
  if (meta.kind === "tip" || meta.kind === "request") return false;
  return Number.isFinite(order.amountCents) && order.amountCents > 0;
}

/**
 * What an order through this affiliate's link gains now: the offer's products
 * that still can be handed over whole, without a limited number, and that the
 * order does not already hand over (`delivered`: the product bought, what was
 * ticked at checkout and every bundle's contents). [] for anybody else, and
 * for a credit that is not a click: the line was shown to whoever followed
 * the link, so a code or a bond earns the affiliate their share and adds
 * nothing to the order. `affiliate` is the one the click names as read by
 * attributedAffiliate (lib/affiliates.ts), never their own browser; somebody
 * the creator declined or removed since adds nothing, and nor does an order
 * that may not carry extras (extrasAllowed).
 */
export function extrasFor(offers: ExtraOffer[], affiliate: ExtraAffiliate | null, how: string, order: ExtraOrder, delivered: string[], listings: Listing[]): Listing[] {
  if (how !== "click" || !affiliate || affiliate.status !== "approved" || !AFFILIATE_ID.test(affiliate.id)) return [];
  if (!extrasAllowed(order)) return [];
  const offer = offers.find((o) => o.aff === affiliate.id);
  if (!offer) return [];
  const out: Listing[] = [];
  for (const id of offer.items) {
    if (delivered.includes(id) || out.some((l) => l.id === id)) continue;
    const product = listings.find((l) => l.id === id);
    if (product && canBeInBundle(product) && product.stock === null) out.push(product);
  }
  return out;
}

/** The checkout metadata that carries the extras: one key, ids joined, within Stripe's 500 characters. */
export function extraMeta(items: Pick<Listing, "id">[]): Record<string, string> {
  const ids = [...new Set(items.map((l) => l.id).filter((id) => SAFE_ID.test(id)))].slice(0, MAX_EXTRAS);
  return ids.length ? { aff_extra: ids.join(",") } : {};
}

/**
 * The line shown before the purchase, on the product page and at checkout:
 * who the extra is from (the store, never the affiliate), and exactly what it
 * is. No price put on it, no "free", no time limit: what it is worth is not
 * the promise. Nothing when there is no store name or nothing to name.
 */
export function extraWords(store: string, titles: string[]): string {
  const name = store.trim();
  const names = titles.map((t) => t.trim()).filter(Boolean);
  if (!name || names.length === 0) return "";
  const list =
    names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  return `With this order, ${name} also includes: ${list}.`;
}
