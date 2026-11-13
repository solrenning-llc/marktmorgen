import type { Metadata } from "next";
import { cache } from "react";
import { type Store } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";
import { CARD_COPY_UNITS, readCardView, siteMaySell } from "@/lib/embed-card-view";
import { CardRefused, drawEmbedCard, loadCard } from "@/components/embed-card";

type Params = { params: Promise<{ handle: string; product: string; view: string }> };

/**
 * The copy the CDN keeps of the card pasted into a creator's own site
 * (lib/embed-card-view.ts, DONO-20261113-DEC-2). proxy.ts sends every display
 * of /embed/<store>/<product> without ?mm= here, with the place the code was
 * pasted and the site it is shown on in the last segment of the address.
 *
 * Built ahead of its displays: forced static, so nothing of the request is
 * read (Next hands it no headers), and made again at most once a
 * CARD_FRESH_SECONDS window for each address, the CDN serving the copy
 * between. The database is read only when a copy is made: the store's
 * record, then CARD_COPY_UNITS of its public requests of the month are taken
 * before the product is read; past them the copy is a plain link to the
 * product's page and reads nothing more. The database's commands are sent
 * with no-store, so each copy reads them afresh, never from a cache of data.
 *
 * Nothing on it decides a sale: the checkout reads stock, availability and
 * the price again on the click (app/api/store/checkout), and the copy never
 * says how many are left.
 */
export const dynamic = "force-static";
/** CARD_FRESH_SECONDS, as the literal Next needs (tests/embed-card-cached.test.ts holds the two together). */
export const revalidate = 300;
export const dynamicParams = true;

/** No copy is made when the site is built: each is made on its first display. */
export function generateStaticParams(): { handle: string; product: string; view: string }[] {
  return [];
}

/**
 * The store's public requests a copy takes, after its record is read and before its product is (CARD_COPY_UNITS,
 * shared by everyone the copy is shown to); once for the title and the body.
 */
const paid = cache((store: Store): Promise<boolean> => takePublicRequest(store, "public", undefined, CARD_COPY_UNITS, { shared: true }).catch(() => false));

const load = cache((raw: string, id: string) => loadCard(raw, id, paid));

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle, product: id } = await params;
  const loaded = await load(handle, id);
  const { store, product, unread } = loaded;
  return {
    title: loaded.resting ? "See this product" : store && product ? `${product.title} — ${store.name}` : unread ? "Not available just now" : "Not on sale",
    robots: { index: false, follow: false },
  };
}

export default async function CardCopy({ params }: Params) {
  const { handle, product: id, view } = await params;
  const { place, site } = readCardView(view);
  const loaded = await load(handle, id);
  // Past the store's public requests: the product was not read, and the copy is a plain link.
  if (loaded.resting) return <CardRefused handle={handle} id={id} place={place} page={false} />;
  // Drawn for no country: a copy is shared by every visitor of its address, so it shows no fair price (lib/fair-price.ts).
  const store = loaded.store ? { ...loaded.store, visitorCountry: "" } : null;
  // The site it is shown on came in the address (the proxy read it off the display's Referer).
  const pastedAllowed = async (shown: Store) => siteMaySell(shown.embedSites, site);
  return drawEmbedCard({ loaded, store, open: null, query: {}, place, pastedAllowed, cached: true });
}

