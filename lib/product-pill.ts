import { speech } from "@/lib/buyer-words";
import { fromPrice, listedLengths } from "@/lib/call-lengths";
import { activePwyw } from "@/lib/pay-what-you-want";
import { isFree, type Listing, type Store } from "@/lib/store";
import { fromPriceCents, sellableOptions } from "@/lib/store-checkout";

/*
 * The figure on a product's price pill, kept out of
 * components/store-product.tsx so a server module that only needs it (an
 * order's confirmation email, lib/purchase-email.ts) does not reach the store
 * page's client components. A server module that imports a file
 * holding client components makes them client references of every page that
 * reaches it: the home page, through lib/demo-seed.ts, shipped the cart, the
 * checkout consent box and their words in several languages to every visitor.
 * components/store-product.tsx re-exports it, so nothing else changes.
 */

/** The figure on the price pill: "$27", "from €9 a month", "¥500+", "Free", in the store's currency and language. */
export function pricePill(store: Store, product: Listing): string {
  const { w, money } = speech(store);
  if (isFree(product)) return w.free;
  if (activePwyw(product)) return `${money(product.priceCents)}+`;
  const options = sellableOptions(product);
  const every = product.recurring ? ` ${w.every(product.recurring.interval)}` : "";
  // A call with several lengths (lib/call-lengths.ts): from the lowest of their prices.
  const lengths = product.call ? listedLengths(product.call, product.priceCents) : [];
  if (lengths.length) return w.fromPrice(money(fromPrice(lengths) as number));
  const price = `${money(fromPriceCents(product))}${every}`;
  return options.length > 1 ? w.fromPrice(price) : price;
}
