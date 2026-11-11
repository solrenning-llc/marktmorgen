import type { Store } from "@/lib/store";

/**
 * 567 [GD1] (f), unit 3: whether the person of an inbox conversation asked
 * this store for a refund, or opened a dispute here, before. Read at the
 * creator's request from the creator's own Stripe account; nothing is kept.
 */
export type RefundHistory =
  | { state: "known"; checked: number; refunded: number; partly: number; disputed: number; more: boolean; unchecked: number }
  | { state: "none" }
  | { state: "unknown" };

/** How many checks a store may ask for in a day. */
export const REFUND_HISTORY_PER_DAY = 0;

/** The newest checkouts one check reads for each spelling of the address. */
export const REFUND_HISTORY_LIST = 0;

export function historyFrom(_listings: unknown[], _email: string): RefundHistory {
  return { state: "unknown" };
}

export async function refundHistory(_store: Store, _email: string): Promise<RefundHistory> {
  return { state: "unknown" };
}
