import type { Store } from "@/lib/store";
import { speech } from "@/lib/buyer-words";
import { isHouseStore } from "@/lib/house-store";
import { canSell } from "@/lib/store-checkout";
import { sellsInTestMode } from "@/lib/stripe-connect";

/**
 * Who answers for what, said to the buyer before paying (Directive
 * 2011/83/EU art. 6a(1)(d)): the creator is the seller and is responsible
 * for the product, refunds and any right to cancel; Marktmorgen hosts the
 * store's pages and is not a party to the sale (the Terms, section 3).
 * Drawn by the page where a buyer starts paying, and only where a real sale
 * can happen there: never in Stripe's test mode or on the demo store, where
 * nothing is sold. Whether the page can take a payment at all is the page's
 * own condition, as it already is for its buy button.
 */
export function WhoAnswers({ store, className = "st-muted mt-2 text-center text-sm" }: { store: Store; className?: string }) {
  if (!saysWhoAnswers(store)) return null;
  return <p className={className}>{speech(store).w.whoAnswers(store.name)}</p>;
}

/** Whether a real sale can happen in this store, so who answers for it is said: never in Stripe's test mode or on the demo store. */
export function saysWhoAnswers(store: Store): boolean {
  return !isHouseStore(store) && !(canSell(store) && sellsInTestMode(store));
}
