/**
 * The real lib/affiliates.ts for tests/affiliate-idle-failed.test.ts, with only idleSweep replaced: a store named
 * "idlefail" throws, as an unknown reply in its sweep would; every other store warns two affiliates and removes one.
 */
import type { Store } from "@/lib/store";

export * from "../lib/affiliates";

/** The stores swept, in order. */
export const swept: string[] = [];

export async function idleSweep(store: Store): Promise<{ warned: number; removed: number }> {
  swept.push(store.handle);
  if (store.handle === "idlefail") throw new Error("an unknown reply while sweeping");
  return { warned: 2, removed: 1 };
}
