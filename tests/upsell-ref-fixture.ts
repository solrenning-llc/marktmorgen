/**
 * The step reference the thanks page's form posts (lib/upsell.ts, offerRef) for a step as the store holds it now,
 * for tests that answer an offer without drawing the page first. A step no funnel of the store has is named by
 * its id alone, as before. Synthetic data only.
 */
import { readListing, readProducts } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { offerRef } from "@/lib/upsell";

export async function shownRef(store: Store, stepId: string): Promise<string> {
  for (const product of await readProducts(store)) {
    const step = product.funnel?.steps.find((s) => s.id === stepId);
    if (!step) continue;
    const target = await readListing(store, step.productId);
    return target ? offerRef(store, step, target) : stepId;
  }
  return stepId;
}
