import type { Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { canGiveProduct } from "@/lib/free";
import { canWrite } from "@/lib/mail";
import { ExitOffer } from "@/components/exit-offer";
import { BuyBox } from "@/components/store-product";
import { speech } from "@/lib/buyer-words";

/**
 * The store's offer for leaving visitors, when it has one that can be given
 * right now, on any page but the free product's own. One read, and only for
 * a store that chose an offer (lib/store.ts, exitOffer).
 */
export async function ExitOfferSlot({ store, except }: { store: Store; except?: string }) {
  if (!store.exitOffer || store.exitOffer === except) return null;
  const product = await readListing(store, store.exitOffer).catch(() => null);
  if (!product || !canGiveProduct(store, product)) return null;
  return (
    <ExitOffer store={store.handle} title={product.title} words={{ close: speech(store).w.close, beforeYouGo: speech(store).w.beforeYouGo, noMore: speech(store).w.noMoreOffers }}>
      {product.summary ? <p className="st-muted mt-2">{product.summary}</p> : null}
      <BuyBox store={store} product={product} related={[]} remaining={null} writes={canWrite(store)} selling place="x-" />
    </ExitOffer>
  );
}
