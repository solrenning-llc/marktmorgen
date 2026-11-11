/**
 * The figure on a product's price pill, in the store's currency and language (moved unchanged from
 * components/store-product.tsx, which re-exports it). Kept apart so lib/purchase-email.ts reads it
 * without importing the store's buyer components into every page whose server code sends mail.
 */
import { speech } from "@/lib/buyer-words";
import { fromPrice, listedLengths } from "@/lib/call-lengths";
import { activePwyw } from "@/lib/pay-what-you-want";
import { isFree, type Listing, type Store } from "@/lib/store";
import { fromPriceCents, sellableOptions } from "@/lib/store-checkout";

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
