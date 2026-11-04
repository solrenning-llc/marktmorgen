/**
 * The server side of a product card in an email (546 [EB1], unit 1; added
 * 4 November 2026): which products a buyer can get from the store right now,
 * and the facts its price is written from. The rules and the drawing are in
 * lib/mail-product-block.ts and lib/mail-product-price.ts.
 *
 * An email points a reader at a product, so it names only one the reader
 * could get on its page today, by the same checks the store uses there:
 *
 *   - published: a draft is out;
 *   - not coming soon, pre-orders included (lib/preorders.ts, one read for
 *     the whole email): an email is no place to take a pre-order, and a
 *     failed read leaves every product out rather than guessing;
 *   - not sold out: a limited product with 0 left is out, and so is one
 *     whose stock cannot be read (lib/stock.ts);
 *   - free: only while the store can give it (canGiveProduct, lib/free.ts);
 *   - paid: only while the store can sell it (canSellProduct, which needs
 *     canSell, lib/store-checkout.ts);
 *   - a bundle: only while it holds enough to hand over, counted as its own
 *     page counts it (offeredItems in lib/bundles.ts and bundleReady in
 *     lib/bundle-rules.ts); a failed read leaves it out.
 */
import type { Listing, Store } from "@/lib/store";
import { offeredItems } from "@/lib/bundles";
import { bundleReady } from "@/lib/bundle-rules";
import { canGiveProduct } from "@/lib/free";
import { activePwyw } from "@/lib/pay-what-you-want";
import { soonState } from "@/lib/preorders";
import { stockLeft } from "@/lib/stock";
import { canSellProduct, fromPriceCents, sellableOptions } from "@/lib/store-checkout";
import { saleOff } from "@/lib/store-sale";
import { isFree } from "@/lib/store-field-rules";
import type { PriceFacts } from "@/lib/mail-product-price";

/** The ids of `products` a buyer can get from `store` now. `now` is in milliseconds. */
export async function productsBuyableNow(store: Store, products: readonly Listing[], now = Date.now()): Promise<Set<string>> {
  // What the store itself refuses, before anything is read.
  const open = products.filter((p) => !p.hidden && (isFree(p) ? canGiveProduct(store, p) : canSellProduct(store, p)));
  if (open.length === 0) return new Set();
  let soon: Set<string>;
  try {
    soon = (await soonState(store)).soon;
  } catch {
    return new Set();
  }
  const ready = open.filter((p) => !soon.has(p.id));
  const bundles = ready.filter((p) => p.bundle);
  const inside = bundles.length ? await offeredItems(store, bundles).catch(() => new Map<string, Listing[]>()) : new Map<string, Listing[]>();
  const kept = await Promise.all(
    ready.map(async (p) => {
      if (p.bundle && !bundleReady(p, inside.get(p.id)?.length ?? 0)) return null;
      try {
        if ((await stockLeft(store, p, now)) === 0) return null;
      } catch {
        return null;
      }
      return p.id;
    }),
  );
  return new Set(kept.filter((id): id is string => id !== null));
}

/**
 * What a product's card says about its price, read from the store now
 * (`nowSeconds`). Never its introductory or yearly price, and never the
 * price for a visitor's country.
 */
export function mailPriceFacts(store: Store, product: Listing, nowSeconds: number): PriceFacts {
  const percent = store.sale ? saleOff(store.sale, product, nowSeconds) : 0;
  return {
    free: isFree(product),
    priceCents: product.priceCents,
    fromCents: fromPriceCents(product),
    optionCount: sellableOptions(product).length,
    interval: product.recurring?.interval ?? null,
    pwyw: activePwyw(product) !== null,
    sale: percent > 0 ? { percent, ends: store.sale.ends } : null,
    taxOnTop: store.tax.enabled && !store.tax.included,
  };
}
