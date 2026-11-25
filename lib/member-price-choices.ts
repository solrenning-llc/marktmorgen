/**
 * What the studio's member-price editor can pick (620 [SZ4], unit 3), read
 * once from the store's catalog for the page and again for each save
 * (app/api/store/member-price), so a save is checked against what the store
 * sells at that moment:
 *
 *   - who can qualify: a paid product the store sells now, a membership or
 *     a product bought once; never a draft, a free product or a call;
 *   - what a rule can lower: what a sale could cover (lib/store-sale.ts,
 *     `saleable`), at its price.
 *
 * One read of the listings, bounded by the store's own catalog, as the
 * studio's sale and fair-price editors read them. A read that fails throws:
 * the caller refuses or shows nothing, never an empty list as if it were
 * the store's. So does a read that gives back fewer listings than the
 * catalog names (one could not be read): the editor would open without that
 * product, trim the saved rule, and a save would remove the member price
 * (Claude 4 team review of #3026, fixed on Claude 5's behalf).
 */
import { KIND, readListings } from "@/lib/catalog";
import type { MemberEditChoices } from "@/lib/member-price-edit";
import { saleable } from "@/lib/store-sale";
import type { Store } from "@/lib/store";

export async function memberEditChoices(store: Store): Promise<MemberEditChoices> {
  const ids = store.catalog.items.filter((item) => (item.kind & KIND.paid) !== 0 && (item.kind & (KIND.call | KIND.hidden)) === 0).map((item) => item.id);
  if (!ids.length) return { qualifying: [], discounted: [] };
  const listings = await readListings(store, ids);
  const read = new Set(listings.map((p) => p.id));
  if (listings.length !== ids.length || !ids.every((id) => read.has(id))) {
    throw new Error(`${ids.length - read.size} of the store's ${ids.length} listings could not be read`);
  }
  return {
    qualifying: listings.filter((p) => p.priceCents > 0 && !p.call).map((p) => ({ id: p.id, title: p.title, membership: Boolean(p.recurring) })),
    discounted: listings.filter(saleable).map((p) => ({ id: p.id, title: p.title, priceCents: p.priceCents })),
  };
}
