/**
 * A member price on a product's page (620 [SZ4], second unit; the rules are
 * lib/member-price-rules.ts, the proof and the checkout lib/member-price.ts).
 *
 * Shown only to a visitor the server proved holds what the creator's rule
 * asks (memberPriceFor), and only where the checkout takes it: the buyer's
 * own purchase of this product alone, at one price, paid in full by card,
 * nothing checked beside it and no bundle to build (lib/store-checkout.ts,
 * memberAlone). The page's buy box sends the percentage it showed and the
 * checkout proves it again before Stripe, so what the page says is what is
 * charged. Unknown is the normal price.
 *
 * The page that draws this reads the visitor's cookies, so it is drawn for
 * each request and never cached for everybody: one visitor's price never
 * reaches another.
 */
import { offNow } from "@/components/store-product";
import { speech } from "@/lib/buyer-words";
import { memberPriceWords } from "@/lib/buyer-words/member-price";
import { picks } from "@/lib/bundle-rules";
import type { MemberCheck } from "@/lib/member-price";
import { activeBumps, activePlan } from "@/lib/product-extras";
import { isFree, type Listing, type Store } from "@/lib/store";
import { canSellProduct } from "@/lib/store-checkout";
import { saleable, salePrice } from "@/lib/store-sale";

/** Where the product's buy box stands on the page, as the page already knows it. */
export type MemberPlace = {
  /** The store can take a payment now. */
  selling: boolean;
  /** Coming soon: a waitlist or a pre-order instead of the buy box. */
  soon: boolean;
  /** Units left of a limited product, or null when it is not limited. */
  remaining: number | null;
  /** For a bundle: whether it holds enough to hand over now. */
  ready: boolean;
  /** What its order bump offers, read by the page. */
  related: Listing[];
};

/**
 * Whether this product's buy box can carry a member price at all. Asked
 * before anything about the visitor is read, so nothing is counted or asked
 * of Stripe where it could never show.
 */
export function memberPriceCanShow(store: Store, product: Listing, place: MemberPlace): boolean {
  return (
    place.selling &&
    !place.soon &&
    place.remaining !== 0 &&
    place.ready &&
    !isFree(product) &&
    saleable(product) &&
    canSellProduct(store, product) &&
    // The checkout refuses a member price with a payment plan, a box checked or a bundle the buyer builds (its own form).
    !activePlan(product) &&
    activeBumps(place.related, product).length === 0 &&
    !picks(product)
  );
}

/**
 * The percentage the page shows and claims: a proved member's, only where it
 * takes off more than a sale or a fair price does (the checkout takes the
 * largest, never two). 0 otherwise: unknown is the normal price.
 */
export function memberShown(store: Store, product: Listing, check: MemberCheck): number {
  return check.state === "member" && check.percent > offNow(store, product) ? check.percent : 0;
}

/** The answer the checkout sent back in the address, or "" for anything else. */
export function readMemberBack(raw: unknown): "changed" | "alone" | "" {
  return raw === "changed" || raw === "alone" ? raw : "";
}

/** "Member price $21.60 (regular $27)", and who it is for, beside the buy box. */
export function MemberPriceNote({ store, product, percent, paypal }: { store: Store; product: Listing; percent: number; paypal: boolean }) {
  const { money } = speech(store);
  const words = memberPriceWords(store.language);
  return (
    <p className="mb-2 text-sm font-semibold" data-member-price="">
      {words.line(money(salePrice(product.priceCents, percent)), money(product.priceCents))}
      <span className="st-muted block text-xs font-normal">{paypal ? `${words.note} ${words.paypal}` : words.note}</span>
    </p>
  );
}

/** The price pill for a proved member: the regular price struck through and named, then the member price named. */
export function MemberPriceTag({ store, product, percent }: { store: Store; product: Listing; percent: number }) {
  const { w, money } = speech(store);
  return (
    <>
      <s className="st-muted mr-1.5 font-normal">
        <span className="sr-only">{w.was}</span>
        {money(product.priceCents)}
      </s>
      <span className="sr-only">{`${memberPriceWords(store.language).head} `}</span>
      {money(salePrice(product.priceCents, percent))}
    </>
  );
}

/** What the checkout sent back, said beside the buy box: nothing was charged. */
export function MemberPriceBack({ store, back }: { store: Store; back: "changed" | "alone" }) {
  const words = memberPriceWords(store.language);
  return <p className="st-note mb-3 text-sm">{back === "changed" ? words.changed : words.alone}</p>;
}
