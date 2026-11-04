import { servedImageUrl } from "@/lib/picture-served";
import Link from "next/link";
import type { Listing, Store } from "@/lib/store";
import { PriceTag, productPath } from "@/components/store-product";
import { speech } from "@/lib/buyer-words";

/** How many other products a product's page points to. */
export const MORE_FROM_COUNT = 3;

/**
 * The other products a visitor may want, from the products already read
 * with the store record (lib/catalog.ts, head): no extra read on any page.
 *
 * Ordered by how often each has been bought, when the creator shows those
 * counts (lib/sold-count.ts), and otherwise in the creator's own order.
 * Drafts and things sold out are left off.
 */
export function moreFrom(store: Store, current: string, sold: Record<string, number> | null, shown: string[] = []): Listing[] {
  const others = store.catalog.head.filter((p) => p.id !== current && !p.hidden && !shown.includes(p.id));
  const ranked = sold ? [...others].sort((a, b) => (sold[b.id] ?? 0) - (sold[a.id] ?? 0)) : others;
  return ranked.slice(0, MORE_FROM_COUNT);
}

/**
 * "More from <store>" under a product's page (added 7 October 2026).
 *
 * Measured before it was built: Gumroad shows "More from <creator>" on a
 * product page and Kajabi's product pages link the creator's other offers;
 * a Stan product page leads nowhere but back. A visitor for whom this one is
 * not quite right is shown the creator's others rather than lost.
 *
 * Named for what it is: the creator's other products. Never "customers also
 * bought", which would be a claim about other buyers this does not measure;
 * that claim is made only by AlsoBought below, from what was measured.
 */
export function MoreFrom({ store, products }: { store: Store; products: Listing[] }) {
  if (products.length === 0) return null;
  return (
    <section className="sp-section" aria-labelledby="more-from-title">
      <h2 id="more-from-title" className="font-display text-2xl font-semibold leading-tight tracking-[-0.02em]">
        {speech(store).w.moreFrom(store.name)}
      </h2>
      <ul className="mt-5 space-y-3">
        {products.map((product) => (
          <li key={product.id}>
            <Link prefetch={false} href={productPath(store, product)} className="st-card st-link-card flex min-h-11 items-center gap-4 p-4">
              {product.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={servedImageUrl(product.image)} alt="" width={56} height={56} loading="lazy" decoding="async" className="st-thumb shrink-0" />
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{product.title}</span>
                {product.summary ? <span className="st-muted mt-0.5 block truncate text-sm">{product.summary}</span> : null}
              </span>
              <span className="st-price shrink-0 text-sm">
                <PriceTag store={store} product={product} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** How many products "also bought" shows. */
export const ALSO_BOUGHT_COUNT = 3;

/**
 * "Buyers of <product> also bought" (added 10 October 2026, lib/also-bought.ts):
 * the products the same buyers paid for, most first, each with how many
 * buyers bought both — counted from the store's own sales, never typed.
 */
export function AlsoBought({ store, title, items }: { store: Store; title: string; items: { product: Listing; count: number }[] }) {
  if (items.length === 0) return null;
  const { w } = speech(store);
  return (
    <section className="sp-section" aria-labelledby="also-bought-title">
      <h2 id="also-bought-title" className="font-display text-2xl font-semibold leading-tight tracking-[-0.02em]">
        {w.alsoBought(title)}
      </h2>
      <ul className="mt-5 space-y-3">
        {items.map(({ product, count }) => (
          <li key={product.id}>
            <Link prefetch={false} href={productPath(store, product)} className="st-card st-link-card flex min-h-11 items-center gap-4 p-4">
              {product.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={servedImageUrl(product.image)} alt="" width={56} height={56} loading="lazy" decoding="async" className="st-thumb shrink-0" />
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{product.title}</span>
                <span className="st-muted mt-0.5 block text-sm">{w.boughtBoth(count)}</span>
              </span>
              <span className="st-price shrink-0 text-sm">
                <PriceTag store={store} product={product} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
