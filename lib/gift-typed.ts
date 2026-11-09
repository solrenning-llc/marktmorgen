/**
 * What a buyer typed into a product page's gift form, or its form to buy for
 * several people, kept in their own browser tab while the server checks it,
 * so a refusal never makes them type it again (WCAG 3.3.7; audit 21, MEDIUM
 * D). Both forms post to app/api/store/checkout/route.ts, which either opens
 * Stripe's page or sends the buyer back with `?gift=<reason>#gift` or
 * `?group=<reason>#group`; the page is then drawn anew, so without this every
 * field came back empty.
 *
 * Kept in the tab's sessionStorage only, under one key per form, store and product,
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

/** The group form's own fields (GroupBox): which option, and how many people. */
export const GROUP_TYPED_FIELDS = ["option", "people"] as const;
export type GroupTypedField = (typeof GROUP_TYPED_FIELDS)[number];
export type GroupTyped = Record<GroupTypedField, string>;

/**
 * At most what each field itself takes (components/store-product.tsx, EmailField's 254), or, for how many people,
 * what the route reads of it (app/api/store/checkout/route.ts, `read("people", 12)`).
 */
const CAPS: Record<GiftTypedField | GroupTypedField, number> = { option: 64, gift_to: 254, gift_from: 60, gift_message: 500, people: 12 };

/** Long enough to read the reason and fix one field; short enough not to linger in a shared tab. */
export const GIFT_TYPED_KEEP_MS = 30 * 60_000;

export const GIFT_TYPED_PREFIX = "mm:gift-typed:";

export function giftTypedKey(handle: string, productId: string): string {
  return `${GIFT_TYPED_PREFIX}${handle}:${productId}`;
}

/**
 * The group form's key: the gift form's with `:group` after it, so the two forms on one product page never read
 * each other's, and the same sweep (sweepGiftTyped) and privacy section (#gift-typed) cover both.
 */
export function groupTypedKey(handle: string, productId: string): string {
  return `${giftTypedKey(handle, productId)}:group`;
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
 * The field a reason from the server belongs to on the group form (GroupBox),
 * as giftProblemField for the gift form: how many people for a number that
 * cannot be sold ("people") or that one payment cannot carry ("amount", whose
 * words say to try fewer people), the option list for "option"; null for a
 * reason no field can fix, which is then the alert.
 */
export function groupProblemField(problem: string): GroupTypedField | null {
  if (problem === "people" || problem === "amount") return "people";
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

/** The given fields only, each a string capped at what the form takes, with the time it was kept. */
function packTyped(fields: readonly (GiftTypedField | GroupTypedField)[], values: Partial<Record<string, unknown>>, now: number): string {
  const v: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field];
    v[field] = typeof value === "string" ? value.slice(0, CAPS[field]) : "";
  }
  return JSON.stringify({ at: now, v });
}

/** What was kept of the given fields, or null when there is nothing, it is not ours, it is from the future or it is too old. */
function unpackTyped(fields: readonly (GiftTypedField | GroupTypedField)[], raw: string | null, now: number): Record<string, string> | null {
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
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = Object.hasOwn(v, field) ? (v as Record<string, unknown>)[field] : undefined;
    if (value !== undefined && typeof value !== "string") return null;
    out[field] = (value ?? "").slice(0, CAPS[field]);
  }
  return out;
}

/** The gift form's four fields only, each a string capped at what the form takes, with the time it was kept. */
export function packGiftTyped(values: Partial<Record<string, unknown>>, now: number): string {
  return packTyped(GIFT_TYPED_FIELDS, values, now);
}

/** What was kept of a gift form, or null when there is nothing, it is not ours, it is from the future or it is too old. */
export function unpackGiftTyped(raw: string | null, now: number): GiftTyped | null {
  return unpackTyped(GIFT_TYPED_FIELDS, raw, now) as GiftTyped | null;
}

/** The group form's two fields only, the same way. */
export function packGroupTyped(values: Partial<Record<string, unknown>>, now: number): string {
  return packTyped(GROUP_TYPED_FIELDS, values, now);
}

/** What was kept of a group form, the same way. */
export function unpackGroupTyped(raw: string | null, now: number): GroupTyped | null {
  return unpackTyped(GROUP_TYPED_FIELDS, raw, now) as GroupTyped | null;
}

/** The part of the tab's storage the sweep uses. */
export type GiftTypedStorage = Pick<Storage, "length" | "key" | "getItem" | "removeItem">;

/**
 * Removes the kept gift and group forms that can no longer be used (too old, from the
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
      // Each read as the form it is from: a group form's key ends in ":group" (groupTypedKey).
      const fields = key.endsWith(":group") ? GROUP_TYPED_FIELDS : GIFT_TYPED_FIELDS;
      if (!all && unpackTyped(fields, storage.getItem(key), now) !== null) continue;
      storage.removeItem(key);
      removed++;
    } catch {
      // Refused for this key: the next store page tries again.
    }
  }
  return removed;
}

