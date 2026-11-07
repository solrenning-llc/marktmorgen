import { MAX_CART } from "@/lib/cart-rules";
import { NO_PIXELS, pixelNames, type Pixels } from "@/lib/pixels";

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
 * does not ask first, is not enough (stepsAllowed), and the yes counts only
 * for the platforms those words named (stepsMarkValue).
 */

export type StepKind = "meta" | "google" | "reddit";
const STEP_KINDS: StepKind[] = ["meta", "google", "reddit"];
export type Step = { type: "view" | "cart"; productId: string };

export const STEP_EVENT_NAMES: Record<StepKind, Record<Step["type"], string>> = {
  meta: { view: "ViewContent", cart: "AddToCart" },
  google: { view: "view_item", cart: "add_to_cart" },
  reddit: { view: "ViewContent", cart: "AddToCart" },
};

// A product's id as the store writes it; anything else is never sent.
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The page a step happened on, as Google is given it: the address without its
 * query or fragment, so a sign-in code, a site or a return address in the
 * query (?code=, ?site=, ?return=) never goes with it. Only a web page's.
 */
export function pageLocationOf(href: string): string | undefined {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? `${url.origin}${url.pathname}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What each of the creator's pixels is told for one step, in order. Google's
 * own tag would add the page's full address; `pageLocation` (pageLocationOf)
 * is given in its place.
 */
export function stepCalls(pixels: Pixels, step: Step, pageLocation?: string): [StepKind, unknown[]][] {
  if (!PRODUCT_ID.test(step.productId)) return [];
  const id = step.productId;
  const cart = step.type === "cart";
  const calls: [StepKind, unknown[]][] = [];
  if (pixels.meta) calls.push(["meta", ["track", STEP_EVENT_NAMES.meta[step.type], { content_ids: [id], content_type: "product" }]]);
  if (pixels.google) {
    const items = [cart ? { item_id: id, quantity: 1 } : { item_id: id }];
    calls.push(["google", ["event", STEP_EVENT_NAMES.google[step.type], pageLocation ? { items, page_location: pageLocation } : { items }]]);
  }
  if (pixels.reddit) {
    calls.push(["reddit", ["track", STEP_EVENT_NAMES.reddit[step.type], cart ? { itemCount: 1, products: [{ id, quantity: 1 }] } : { products: [{ id }] }]]);
  }
  return calls;
}

/** The creator's pixels these steps go to, in the banner's order. */
export function stepKinds(pixels: Pixels): StepKind[] {
  return STEP_KINDS.filter((kind) => pixels[kind]);
}

/**
 * The banner's sentence for these steps, naming only the platforms they go
 * to (TikTok, Pinterest and X are not told them); empty when none is.
 */
export function stepsWords(pixels: Pixels, storeName: string): string {
  const only = { ...NO_PIXELS };
  for (const kind of stepKinds(pixels)) only[kind] = pixels[kind];
  const names = pixelNames(only);
  return names ? `${storeName} also tells ${names} which products you open and add to your cart.` : "";
}

/**
 * The version of the words that name these steps. Change it whenever those
 * words change, so an older yes does not count for the new words.
 */
export const STEPS_MARK_VERSION = "1";

/**
 * Kept beside the visitor's yes when they press "Allow": the version of the
 * words and the platforms they named ("1:meta,google,reddit"). A platform the
 * creator adds later is not in it, so it is not told until a new Allow.
 */
export function stepsMarkValue(pixels: Pixels): string | null {
  const kinds = stepKinds(pixels);
  return kinds.length ? `${STEPS_MARK_VERSION}:${kinds.join(",")}` : null;
}

export const stepsMarkKey = (handle: string) => `nl_px_steps:${handle}`;

/**
 * The platforms a step may be told to: none unless the pixels run, the
 * visitor said yes themselves, and that yes was to these words; then only
 * the platforms those words named.
 */
export function stepsAllowed(state: "unknown" | "ask" | "on" | "off", choice: "yes" | "no" | null, mark: string | null): StepKind[] {
  if (state !== "on" || choice !== "yes" || !mark) return [];
  const [version, list = ""] = mark.split(":", 2);
  if (version !== STEPS_MARK_VERSION || !mark.includes(":")) return [];
  const named = new Set(list.split(","));
  return STEP_KINDS.filter((kind) => named.has(kind));
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
