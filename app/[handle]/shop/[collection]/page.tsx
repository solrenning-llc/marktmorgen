import { assistReminderShown } from "@/lib/assistant-reminder";
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { type Listing, normaliseHandle, storeForPage } from "@/lib/store";
import { readListings } from "@/lib/catalog";
import { offerableTargets } from "@/lib/child-safety-holds";
import { canSell, canSellProduct } from "@/lib/store-checkout";
import { offersCart } from "@/lib/cart-checkout";
import { MAX_CART, cartable } from "@/lib/cart-rules";
import { bumpTargets } from "@/lib/product-extras";
import { bundleItemsToRead, offeredItems } from "@/lib/bundles";
import { preorderDay, soonState } from "@/lib/preorders";
import { stockLeft } from "@/lib/stock";
import { outOfKeys } from "@/lib/licence-keys";
import { canWrite } from "@/lib/mail";
import { canManage } from "@/lib/membership-manage";
import { canUseDomain } from "@/lib/domains";
import { summaries } from "@/lib/reviews";
import { forVisitor } from "@/lib/visitor";
import { isResting, takePublicRequest } from "@/lib/traffic";
import { bundleItemUnits, collectionUnits } from "@/lib/page-read-rules";
import { speech } from "@/lib/buyer-words";
import { lookStyle } from "@/lib/store-look";
import { photoUrl } from "@/lib/photo-limits";
import { SITE_URL } from "@/lib/site-url";
import { storeRoot } from "@/lib/store-sitemap";
import { collectionInSegment, collectionSegment, shownProducts } from "@/lib/store-collections";
import { ProductCard, productPath } from "@/components/store-product";
import { AddAllToCart, CartButton } from "@/components/store-cart";
import { StoreResting } from "@/components/store-resting";
import { StoreTracking } from "@/components/store-tracking";
import { JsonLd } from "@/components/structured-data";
import { collectionPath, listedItems } from "@/components/store-collections";
import { WhoAnswers } from "@/components/who-answers";
import { sellsThroughPayPal } from "@/lib/paypal-sales";

type Params = {
  params: Promise<{ handle: string; collection: string }>;
};

/** The store and the collection an address names, or null. */
async function load(rawHandle: string, rawSegment: string) {
  let decoded = "";
  let segment = "";
  try {
    decoded = decodeURIComponent(rawHandle);
    segment = decodeURIComponent(rawSegment).slice(0, 120);
  } catch {
    return null;
  }
  if (!decoded.startsWith("@")) return null;
  const asked = normaliseHandle(decoded);
  const store = await storeForPage(asked);
  if (!store) return null;
  const collection = collectionInSegment(segment, store.collections ?? []);
  return collection ? { store, asked, collection, segment } : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle, collection: segment } = await params;
  const found = await load(handle, segment);
  if (!found || found.store.suspended) return { title: "Not found — Marktmorgen" };
  const { store, collection } = found;
  const url = `${storeRoot(store)}/shop/${collectionSegment(collection)}`;
  const title = `${collection.title} — ${store.name}`;
  const description = collection.blurb || speech(store).w.storeDescription(store.name);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: "website" },
    robots: { index: shownProducts(collection, listedItems(store)).length > 0, follow: true },
  };
}

/**
 * One of a store's collections (lib/store-collections.ts): its title and the
 * creator's words about it, then its published products in the creator's
 * order, each drawn as on the store page with its own buy box. The ones that
 * can go in a cart can be added together, when they fit in one.
 */
export default async function CollectionPage({ params }: Params) {
  const { handle, collection: rawSegment } = await params;
  const found = await load(handle, rawSegment);
  if (!found) {
    // A collection taken away leaves its link leading to the store, not to nothing.
    let decoded = "";
    try {
      decoded = decodeURIComponent(handle);
    } catch {
      notFound();
    }
    const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
    if (store && !store.suspended) redirect(`/@${store.handle}`);
    notFound();
  }
  const { asked, collection, segment } = found;
  // With the visitor's country, for a fair price for it (lib/fair-price.ts).
  const store = await forVisitor(found.store);
  const path = collectionPath(store, collection);

  // The same rules the store page follows for the creator's own domain and an old address.
  const reachedOn = (await headers()).get("x-nimbus-domain");
  if (reachedOn && (store.domain?.name !== reachedOn || !canUseDomain(store))) redirect(`${SITE_URL}${path}`);
  if ((asked !== store.handle && !reachedOn) || segment !== collectionSegment(collection)) permanentRedirect(path);

  // As the store page does: a store with no plan a visit can be charged to
  // rests once it has had its month's visits (lib/traffic.ts).
  if (await isResting(store)) return <StoreResting store={store} />;
  if (store.suspended) return <StoreResting store={store} suspended />;

  const ids = shownProducts(collection, listedItems(store));
  if (ids.length === 0) redirect(`/@${store.handle}`);
  // Its products, paid for before they are read (lib/page-read-rules.ts, 4 November 2026):
  // past the window, the resting page, and nothing of them read.
  if (!(await takePublicRequest(store, "public", undefined, collectionUnits(ids.length)))) return <StoreResting store={store} />;
  // At most one page of products (MAX_COLLECTION_PRODUCTS), and the ones their checkout boxes offer.
  const listed = (await readListings(store, ids)).filter((p) => !p.hidden);
  const products = ids.flatMap((id) => listed.find((p) => p.id === id) ?? []);
  const targets = [...new Set(products.flatMap((p) => bumpTargets(p)))].filter((id) => !ids.includes(id));
  const related: Listing[] = [...products, ...(targets.length ? await readListings(store, targets).then((found) => offerableTargets(store, found)).catch(() => []) : [])];
  // The items their bundles hold, up to MAX_BUNDLE_ITEMS each, paid for once known and before they are read (Codex G2 on #2583).
  const items = bundleItemsToRead(related);
  if (items.length > 0 && !(await takePublicRequest(store, "public", undefined, bundleItemUnits(items.length)))) return <StoreResting store={store} />;

  const selling = canSell(store);
  const cartOn = selling && offersCart(store);
  const writes = canWrite(store);
  const manageable = canManage(store);
  const [soonRead, inBundles, rated, counts] = await Promise.all([
    // A reading that failed or came back out of shape is unknown, never "none coming soon" (CX-123 rule 24).
    soonState(store).catch(() => null),
    offeredItems(store, related).catch(() => new Map<string, Listing[]>()),
    store.reviewed ? summaries(store.statsId).catch(() => new Map()) : Promise.resolve(new Map()),
    Promise.all(
      products.map(async (product) => {
        // Keys left that could not be read are unknown, never "keys left" (CX-123 rule 24): no way to buy, no count.
        const [stock, out] = await Promise.all([stockLeft(store, product).catch(() => null), outOfKeys(store, product).catch(() => null)]);
        return out === null ? ("unread" as const) : out ? 0 : stock;
      }),
    ),
  ]);
  const coming = soonRead ?? { soon: new Set<string>(), days: new Map<string, string>() };
  const soon = coming.soon;
  const left = new Map<string, number>();
  const unread = new Set<string>();
  products.forEach((product, i) => {
    const count = counts[i];
    if (count === "unread") unread.add(product.id);
    else if (count !== null) left.set(product.id, count);
  });
  const inCart = cartOn ? products.filter((p) => cartable(p) && canSellProduct(store, p) && !soon.has(p.id) && left.get(p.id) !== 0 && !unread.has(p.id)).map((p) => p.id) : [];

  // With coming soon unknown, any product may not be out yet: each card draws no way to buy it and nothing for the
  // cart, and says buying is not available just now, as the card on the creator's own site does (#2910). With only
  // part of it read, a product read as coming soon keeps its waitlist; each other one is unknown.
  if (!soonRead || soonRead.partial) for (const product of products) if (!soon.has(product.id)) unread.add(product.id);

  const say = speech(store);
  const { w } = say;
  return (
    <div lang={say.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          name: collection.title,
          ...(collection.blurb ? { description: collection.blurb } : {}),
          url: `${SITE_URL}${path}`,
          mainEntity: {
            "@type": "ItemList",
            itemListElement: products.map((product, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE_URL}${productPath(store, product)}`, name: product.title })),
          },
        }}
      />
      <main id="content" className="relative mx-auto max-w-xl px-4 pb-16 pt-10 sm:pt-14">
        <Link href={`/@${store.handle}`} className="st-title-link mx-auto flex w-fit items-center gap-3 rounded-full py-1 pr-2">
          {store.photoId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl(store.photoId)} alt="" width={40} height={40} className="st-avatar !mx-0" style={{ width: 40, height: 40 }} />
          ) : (
            <span aria-hidden="true" className="st-avatar st-avatar-initial !mx-0" style={{ width: 40, height: 40, fontSize: "1rem" }}>
              {store.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="font-semibold">{store.name}</span>
        </Link>
        <h1 className="font-display mt-8 text-center text-3xl font-semibold leading-tight tracking-[-0.02em] sm:text-4xl">{collection.title}</h1>
        <p className="st-muted mt-2 text-center text-sm font-semibold">{w.productCount(products.length)}</p>
        {collection.blurb ? <p className="st-muted mx-auto mt-3 max-w-md text-center text-lg leading-relaxed">{collection.blurb}</p> : null}
        {soonRead && !soonRead.partial && inCart.length >= 2 && inCart.length <= MAX_CART ? <AddAllToCart handle={store.handle} productIds={inCart} lang={store.language} /> : null}
        <ul className="mt-8 space-y-4">
          {products.map((product, i) => (
            <ProductCard
              key={product.id}
              eager={i < 1}
              first={i === 0}
              store={store}
              product={product}
              related={related}
              remaining={left.has(product.id) && canSellProduct(store, product) ? left.get(product.id)! : null}
              writes={writes}
              selling={selling}
              manageable={manageable}
              rating={rated.get(product.id) ?? null}
              bundleItems={inBundles.get(product.id) ?? null}
              soon={soon.has(product.id)}
              preorder={preorderDay(store, product, soon.has(product.id), coming.days.get(product.id) ?? null)}
              cart={inCart.includes(product.id)}
              unread={unread.has(product.id)}
            />
          ))}
        </ul>
        {/* Before paying for any of them, as the store page says it (components/who-answers.tsx). */}
        {selling || sellsThroughPayPal(store) ? <WhoAnswers store={store} className="st-muted mt-6 text-center text-sm" /> : null}
        <div className="mt-12 text-center">
          <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
            {w.everythingFrom(store.name)}
          </Link>
        </div>
        <StoreTracking store={store} presence />
        {cartOn ? <CartButton handle={store.handle} lang={store.language} remind={assistReminderShown(store) ? store.name : ""} notice={null} /> : null}
      </main>
    </div>
  );
}
