import { servedImageUrl } from "@/lib/picture-served";
import Link from "next/link";
import type { Listing, Store } from "@/lib/store";
import { KIND } from "@/lib/catalog";
import { PriceTag, productPath } from "@/components/store-product";
import { AddToCart } from "@/components/store-cart";
import { speech } from "@/lib/buyer-words";
import { type Collection, collectionSegment, collectionsOf, shownCollections } from "@/lib/store-collections";

/** A collection's address under the store's (lib/store-collections.ts). */
export function collectionPath(store: Pick<Store, "handle">, collection: Pick<Collection, "id" | "title">): string {
  return `/@${store.handle}/shop/${collectionSegment(collection)}`;
}

/** The store's index, as the collection rules read it: no product read. */
export function listedItems(store: Store): { id: string; hidden: boolean }[] {
  return store.catalog.items.map((item) => ({ id: item.id, hidden: (item.kind & KIND.hidden) !== 0 }));
}

/**
 * The store's collections, as links above its products (added 17 October
 * 2026): each with its name and how many published products it holds,
 * counted from the store's own index. Nothing is drawn for a store without
 * a collection worth opening.
 */
export function CollectionsNav({ store }: { store: Store }) {
  const shown = shownCollections(store.collections ?? [], listedItems(store));
  if (shown.length === 0) return null;
  const { w } = speech(store);
  return (
    <nav aria-label={w.collections} className="mb-6">
      <p className="st-muted mb-2 text-xs font-bold uppercase tracking-[0.08em]">{w.collections}</p>
      <ul className="flex flex-wrap gap-2">
        {shown.map(({ collection, count }) => (
          <li key={collection.id}>
            <Link prefetch={false} href={collectionPath(store, collection)} className="st-card st-link-card inline-flex min-h-11 items-center gap-2 px-4 py-2 text-sm font-semibold">
              {collection.title}
              <span className="st-muted font-normal">{w.productCount(count)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The collections a product is in, as links under its page: a visitor who
 * came for one guide finds the rest of the series. Only collections with
 * something published to open.
 */
export function InCollections({ store, productId }: { store: Store; productId: string }) {
  const items = listedItems(store);
  const mine = new Set(collectionsOf(store.collections ?? [], productId).map((c) => c.id));
  const shown = shownCollections(store.collections ?? [], items).filter(({ collection }) => mine.has(collection.id));
  if (shown.length === 0) return null;
  const { w } = speech(store);
  return (
    <nav aria-label={w.collections} className="sp-section">
      <p className="st-muted text-sm font-semibold">{w.inCollections}</p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {shown.map(({ collection, count }) => (
          <li key={collection.id}>
            <Link prefetch={false} href={collectionPath(store, collection)} className="st-card st-link-card inline-flex min-h-11 items-center gap-2 px-4 py-2 text-sm font-semibold">
              {collection.title}
              <span className="st-muted font-normal">{w.productCount(count)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * "Goes well with <product>" under a product's page (added 17 October 2026):
 * the creator's own picks of their other products, in their order, each with
 * its price as it is today and, where it can go in one, Add to cart. Said as
 * the creator's pick and nothing more: no count, no claim about other buyers
 * (that is AlsoBought's, from real sales, components/more-from.tsx).
 */
export function GoesWellWith({
  store,
  title,
  items,
  cartIds,
}: {
  store: Store;
  title: string;
  items: Listing[];
  /** The picks that can go in the store's cart right now; the others are a link to their page. */
  cartIds: Set<string>;
}) {
  if (items.length === 0) return null;
  const { w } = speech(store);
  return (
    <section className="sp-section" aria-labelledby="goes-well-title">
      <h2 id="goes-well-title" className="font-display text-2xl font-semibold leading-tight tracking-[-0.02em]">
        {w.pairedWith(title)}
      </h2>
      <p className="st-muted mt-1 text-sm">{w.pickedBy(store.name)}</p>
      <ul className="mt-5 space-y-3">
        {items.map((product) => (
          <li key={product.id} className="st-card p-4">
            <Link prefetch={false} href={productPath(store, product)} className="st-title-link flex min-h-11 items-center gap-4">
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
            {cartIds.has(product.id) ? <AddToCart handle={store.handle} productId={product.id} lang={store.language} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
