/**
 * What a buyer typed into a product page's gift form, kept in their own
 * browser tab while the server checks it, so a refusal never makes them type
 * it again (WCAG 3.3.7; audit 21, MEDIUM D). The form posts to
 * app/api/store/checkout/route.ts, which either opens Stripe's page or sends
 * the buyer back with `?gift=<reason>#gift`; the page is then drawn anew, so
 * without this every field came back empty.
 *
 * Kept in the tab's sessionStorage only, under one key per store and product,
 * never used after GIFT_TYPED_KEEP_MS, removed as soon as it is read back and
 * whenever the page opens with no refusal to answer. A browser may give a
 * reopened tab its storage back, so closing the tab is not counted on: every
 * store page removes what is too old (sweepGiftTyped), and the thank-you page
 * and the store's front page, where the checkout comes back, remove all of it
 * (components/gift-typed-sweeper.tsx). Never sent to us. Privacy policy:
 * #gift-typed. Browser-safe; no storage here, only the rules
 * (components/gift-typed-keeper.tsx reads and writes).
 */

/** The gift form's own fields, in the order they are on the form. */
export const GIFT_TYPED_FIELDS = ["option", "gift_to", "gift_from", "gift_message"] as const;
export type GiftTypedField = (typeof GIFT_TYPED_FIELDS)[number];
export type GiftTyped = Record<GiftTypedField, string>;

/** At most what each field itself takes (components/store-product.tsx, EmailField's 254). */
const CAPS: Record<GiftTypedField, number> = { option: 64, gift_to: 254, gift_from: 60, gift_message: 500 };

/** Long enough to read the reason and fix one field; short enough not to linger in a shared tab. */
export const GIFT_TYPED_KEEP_MS = 30 * 60_000;

export const GIFT_TYPED_PREFIX = "mm:gift-typed:";

export function giftTypedKey(handle: string, productId: string): string {
  return `${GIFT_TYPED_PREFIX}${handle}:${productId}`;
}

/**
 * The field a reason from the server belongs to, which is marked invalid and
 * takes the focus; null when no field can fix it (the reason itself takes the
 * focus) or, for "consent", when the consent box marks and focuses itself
 * (components/digital-consent-box.tsx).
 */
export function giftProblemField(problem: string): GiftTypedField | null {
  if (problem === "email") return "gift_to";
  if (problem === "option") return "option";
  return null;
}

/**
 * The store's own notices (buyer words `notices`) a checkout refused after the
 * gift was written down sends back to the gift form (app/api/store/checkout/
 * route.ts): someone else holding the last unit, the store's orders paused,
 * and a payment page Stripe would not open. A sold-out product goes to the
 * store's front page instead, since its page no longer draws the gift form.
 */
export const GIFT_RETURN_NOTICES = ["busy", "paused", "error"] as const;
export type GiftReturnNotice = (typeof GIFT_RETURN_NOTICES)[number];

export function isGiftReturnNotice(problem: string): problem is GiftReturnNotice {
  return (GIFT_RETURN_NOTICES as readonly string[]).includes(problem);
}

/** The four fields only, each a string capped at what the form takes, with the time it was kept. */
export function packGiftTyped(values: Partial<Record<string, unknown>>, now: number): string {
  const v = {} as GiftTyped;
  for (const field of GIFT_TYPED_FIELDS) {
    const value = values[field];
    v[field] = typeof value === "string" ? value.slice(0, CAPS[field]) : "";
  }
  return JSON.stringify({ at: now, v });
}

/** What was kept, or null when there is nothing, it is not ours, it is from the future or it is too old. */
export function unpackGiftTyped(raw: string | null, now: number): GiftTyped | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { at, v } = parsed as { at?: unknown; v?: unknown };
  if (typeof at !== "number" || !Number.isFinite(at) || at > now || now - at > GIFT_TYPED_KEEP_MS) return null;
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = {} as GiftTyped;
  for (const field of GIFT_TYPED_FIELDS) {
    const value = (v as Record<string, unknown>)[field];
    if (value !== undefined && typeof value !== "string") return null;
    out[field] = (value ?? "").slice(0, CAPS[field]);
  }
  return out;
}


/** The part of the tab's storage the sweep uses. */
export type GiftTypedStorage = Pick<Storage, "length" | "key" | "getItem" | "removeItem">;

/**
 * Removes the kept gift forms that can no longer be used (too old, from the
 * future, or not ours), or, with `all`, every one of them: back from paying
 * (the thank-you page) or from the checkout (the store's front page), nothing
 * kept is needed any more. Other keys are never touched. A storage that
 * refuses is left as it is: the page goes on. Returns how many were removed.
 */
export function sweepGiftTyped(storage: GiftTypedStorage, now: number, all = false): number {
  let keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(GIFT_TYPED_PREFIX)) keys.push(key);
    }
  } catch {
    keys = [];
  }
  let removed = 0;
  for (const key of keys) {
    try {
      if (!all && unpackGiftTyped(storage.getItem(key), now) !== null) continue;
      storage.removeItem(key);
      removed++;
    } catch {
      // Refused for this key: the next store page tries again.
    }
  }
  return removed;
}

// RED stubs for tests/group-error-a11y.test.ts; the fix replaces them.
export const GROUP_TYPED_FIELDS = [] as readonly string[];
export function groupTypedKey(_handle: string, _productId: string): string {
  return "";
}
export function packGroupTyped(_values: Partial<Record<string, unknown>>, _now: number): string {
  return JSON.stringify({ at: _now, v: {} });
}
export function unpackGroupTyped(_raw: string | null, _now: number): Record<string, string> | null {
  return null;
}
