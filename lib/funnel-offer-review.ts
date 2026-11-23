import type { Listing, Store } from "@/lib/store";
import { canSell, canSellProduct } from "@/lib/store-checkout";
import { canGiveProduct } from "@/lib/free";
import { paypalOffered, paypalReady } from "@/lib/paypal-sales";
import { bundleReady, deliverableItems } from "@/lib/bundle-rules";
import { bumpPauseWords, bumpStates, limitedStock, planPauseWords, planState } from "@/lib/product-extras";

/** Existing in-memory records only. Never fetch a target or change a sale rule.
 * Fresh explicitly loaded records win over cached head/legacy records. */
export function cachedOfferListings(store: Store, loaded: readonly Listing[] = []): Listing[] {
  const ids = new Set(store.catalog.items.map(item => item.id));
  const records = new Map<string,Listing>();
  for (const product of [...(store.catalog.inline ?? []), ...store.catalog.head, ...loaded]) {
    if (ids.has(product.id)) records.set(product.id,product);
  }
  return [...records.values()];
}

/** Saved eligibility diagnostics; live stock, licences, provider health,
 * consent, email arrival and actual delivery are deliberately not certified. */
export function savedOfferIssues(store: Store, product: Listing, known: readonly Listing[]): string[] {
  if (product.hidden || product.call) return [];
  const issues: string[] = [];
  if (product.priceCents === 0) {
    if (!canGiveProduct(store,product)) issues.push("Free sign-up is unavailable with this saved configuration. Review delivery, the mailing list, store plan and email configuration.");
  } else {
    if (!canSell(store) && !paypalOffered(store)) issues.push("Store payments are unavailable. Review the store plan and payment connection.");
    else if (!canSellProduct(store,product) && !paypalReady(store,product)) issues.push("This paid offer is unavailable with its saved delivery or price options. Review the product.");
    if (limitedStock(product) === 0) issues.push("The configured quantity is zero. Live stock reservations have not been checked.");
    if (product.bundle) {
      const indexed = new Set(store.catalog.items.map(item => item.id));
      const loaded = new Set(known.map(item => item.id));
      if (product.bundle.some(id => indexed.has(id) && !loaded.has(id))) issues.push("Bundle delivery could not be fully checked from the records already loaded. Review its included products before sharing.");
      else if (!bundleReady(product,deliverableItems(product,[...known]).length)) issues.push("This bundle does not have enough deliverable products for the buyer's selection.");
    }
  }
  const plan = planState(product);
  if (plan && "paused" in plan) issues.push("The configured payment plan is not offered. " + planPauseWords(plan.paused,plan.plan,product,store.currency));
  else if (plan && !canSell(store)) issues.push("The configured payment plan requires an available Stripe connection and store plan. Review it separately from the up-front purchase.");
  const indexed = new Set(store.catalog.items.map(item => item.id));
  const byId = new Map(known.map(item => [item.id,item]));
  for (const bump of product.bumps) {
    if (indexed.has(bump.productId) && !byId.has(bump.productId)) {
      issues.push("A checkout add-on could not be checked from the records already loaded. Review the add-on product before sharing.");
      continue;
    }
    for (const state of bumpStates([...known],{...product,bumps:[bump]})) {
      if ("paused" in state) issues.push("A configured checkout add-on is not offered. " + bumpPauseWords(state.paused,byId.get(bump.productId)?.title ?? ""));
    }
  }
  return issues;
}
