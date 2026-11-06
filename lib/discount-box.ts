import { setHasDiscounts, type Store } from "@/lib/store";

/**
 * The checkout's code box (lib/store.ts, hasDiscounts), read exactly: a code
 * live on the creator's Stripe account can be entered by a buyer only while
 * the box is on, so nothing is said as done on a box that was not confirmed.
 */

/** Whether the store setHasDiscounts answered with has the box exactly as wanted: null or anything else is not. */
export const boxIs = (store: Pick<Store, "hasDiscounts"> | null | undefined, wanted: boolean): boolean =>
  store?.hasDiscounts === wanted;

/** Whether the store setHasDiscounts answered with has the box on: null or anything but `true` is not. */
export const boxSwitchedOn = (store: Pick<Store, "hasDiscounts"> | null | undefined): boolean => boxIs(store, true);

/**
 * Writes the box and says whether the store read back has it as wanted. A
 * write that throws (a busy or failed store write) is "not confirmed", never
 * an error that hides what Stripe already did.
 */
export async function setDiscountBox(ref: string, wanted: boolean): Promise<boolean> {
  try {
    return boxIs(await setHasDiscounts(ref, wanted), wanted);
  } catch (error) {
    console.error("writing the checkout's code box failed", error);
    return false;
  }
}
