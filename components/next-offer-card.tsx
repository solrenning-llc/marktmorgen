import { NextOfferBox } from "@/components/next-offer-box";
import { pricePill, productPath } from "@/components/store-product";
import { nextOfferWords } from "@/lib/buyer-words/next-offer";
import { imageUrl } from "@/lib/product-image";
import { type NextOffer, nextOfferFor } from "@/lib/next-offer";
import type { Listing, Store } from "@/lib/store";

/**
 * The one next product the Store assistant suggests on the page after paying
 * (lib/next-offer.ts), streamed in after the rest of the page so the buyer
 * never waits on it. Its title, its published price and the creator's own
 * summary; "AI suggestion" and a line saying so when the model chose it,
 * with its one sentence of why when that sentence held to the creator's
 * words. Nothing else: no discount, no countdown, no count of buyers.
 */
export async function NextOfferCard(input: {
  store: Store;
  session: string;
  email: string | null;
  bought: Listing[];
  alsoOwned: string[];
  declined: string[];
}) {
  const offer = await nextOfferFor(input).catch((error) => {
    console.error("choosing the next product failed", error);
    return null;
  });
  return offer ? <NextOfferView store={input.store} session={input.session} offer={offer} /> : null;
}

export function NextOfferView({ store, session, offer }: { store: Store; session: string; offer: NextOffer }) {
  const w = nextOfferWords(store.language);
  const { product } = offer;
  const text = offer.why || product.summary;
  return (
    <NextOfferBox
      handle={store.handle}
      session={session}
      href={productPath(store, product)}
      see={w.see}
      dismiss={w.dismiss}
      dismissed={w.dismissed}
      failed={w.dismissFailed}
      note={offer.ai ? w.aiNote(store.name) : ""}
    >
      {product.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl(product.image)} alt={product.image.alt} width={product.image.width} height={product.image.height} className="aspect-[16/9] w-full object-cover" />
      ) : null}
      <div className="px-5 pt-5 pb-4 sm:px-6">
        <p className="st-label">{offer.ai ? w.aiLabel : w.label(store.name)}</p>
        <h2 id="next-offer-title" className="mt-1 text-xl font-semibold leading-snug tracking-[-0.01em]">
          {product.title}
        </h2>
        <p className="mt-1 text-sm font-semibold">{pricePill(store, product)}</p>
        {text ? <p className="mt-2 text-sm leading-relaxed">{text}</p> : null}
      </div>
    </NextOfferBox>
  );
}
