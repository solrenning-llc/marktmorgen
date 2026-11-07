import { MAX_CART } from "@/lib/cart-rules";
import type { Pixels } from "@/lib/pixels";

/**
 * 601 [KB22] U9: the two steps between a page view and a started checkout,
 * told to the creator's own pixels (components/store-pixels.tsx): a product's
 * own page opened, and a product put in the cart.
 *
 * Only Meta, Google and Reddit are told, each with a name from its own list
 * of standard events (Reddit's: docs/x-reddit-pixels-official-check-2026-11-02.md,
 * item 2). Only the product's id goes with it: no amount, no identifier, no
 * new script. And only for a visitor who pressed "Allow" on the words that
 * name these two steps: a yes given before those words, or a country that
 * does not ask first, is not enough (stepsAllowed).
 */

export type StepKind = "meta" | "google" | "reddit";
export type Step = { type: "view" | "cart"; productId: string };

export const STEP_EVENT_NAMES: Record<StepKind, Record<Step["type"], string>> = {
  meta: { view: "ViewContent", cart: "AddToCart" },
  google: { view: "view_item", cart: "add_to_cart" },
  reddit: { view: "ViewContent", cart: "AddToCart" },
};

// A product's id as the store writes it; anything else is never sent.
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What each of the creator's pixels is told for one step, in order. */
export function stepCalls(pixels: Pixels, step: Step): [StepKind, unknown[]][] {
  if (!PRODUCT_ID.test(step.productId)) return [];
  const id = step.productId;
  const cart = step.type === "cart";
  const calls: [StepKind, unknown[]][] = [];
  if (pixels.meta) calls.push(["meta", ["track", STEP_EVENT_NAMES.meta[step.type], { content_ids: [id], content_type: "product" }]]);
  if (pixels.google) calls.push(["google", ["event", STEP_EVENT_NAMES.google[step.type], { items: [cart ? { item_id: id, quantity: 1 } : { item_id: id }] }]]);
  if (pixels.reddit) {
    calls.push(["reddit", ["track", STEP_EVENT_NAMES.reddit[step.type], cart ? { itemCount: 1, products: [{ id, quantity: 1 }] } : { products: [{ id }] }]]);
  }
  return calls;
}

/**
 * Kept beside the visitor's yes when they press "Allow" on the words that name
 * these steps. Change it whenever those words change, so an older yes does
 * not count for the new words.
 */
export const STEPS_MARK_VALUE = "1";

export const stepsMarkKey = (handle: string) => `nl_px_steps:${handle}`;

/** Told only when the pixels run, the visitor said yes themselves, and that yes was to these words. */
export function stepsAllowed(state: "unknown" | "ask" | "on" | "off", choice: "yes" | "no" | null, mark: string | null): boolean {
  return state === "on" && choice === "yes" && mark === STEPS_MARK_VALUE;
}

/** The cart's own storage key and change event (components/store-cart.tsx). */
export const CART_KEY_PREFIX = "mm-cart:";
export const CART_CHANGED_EVENT = "mm-cart-changed";

/** The cart's ids as the cart itself reads them; anything else is an empty cart. */
export function cartIdsOf(raw: string | null): string[] {
  try {
    const value = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(0, MAX_CART) : [];
  } catch {
    return [];
  }
}

/** The products that are in the cart now and were not before, each once. */
export function addedToCart(before: string[], now: string[]): string[] {
  const had = new Set(before);
  return [...new Set(now)].filter((id) => !had.has(id));
}
