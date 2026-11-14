/**
 * lib/store-checkout.ts as it is, except readOrder, which answers the order
 * the test sets (tests/i18n-thanks-bundle-heading.test.ts) instead of asking
 * Stripe. Test-only.
 */
import type { Order } from "../lib/store-checkout";
import type { Store } from "../lib/store";

export * from "../lib/store-checkout";

let answer: Order = { state: "invalid" };

export function answerOrder(order: Order): void {
  answer = order;
}

export async function readOrder(_store: Store, _sessionId: string | undefined): Promise<Order> {
  return answer;
}
