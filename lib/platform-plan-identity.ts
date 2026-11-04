import { HANDLE_PATTERN } from "@/lib/store-handle-pattern";

/** Existing stats identifiers include synthetic contract identifiers too. */
export function platformStoreId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Missing history stays missing. Never read inherited fields or getters. */
export function releasedHandleTimes(value: unknown): Record<string, number> | null {
  try {
    const out: Record<string, number> = Object.create(null);
    if (value === undefined) return out;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !HANDLE_PATTERN.test(key)) return null;
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !Object.hasOwn(field, "value") ||
          !Number.isSafeInteger(field.value) || field.value <= 0) return null;
      out[key] = field.value;
    }
    return out;
  } catch { return null; }
}

/** Stripe's created clock is whole epoch seconds: equality is not "before". */
export function beforeHandleRelease(times: unknown, handle: string, created: unknown): boolean {
  if (typeof created !== "number" || !Number.isSafeInteger(created) || created < 0) return false;
  try {
    if (!times || typeof times !== "object" || Array.isArray(times) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(times))) return false;
    const field = Object.getOwnPropertyDescriptor(times, handle);
    return Boolean(field && Object.hasOwn(field, "value") && Number.isSafeInteger(field.value) &&
      field.value > 0 && created < field.value);
  } catch { return false; }
}

/** Capture the optional Store field once; its descriptor is not review evidence if executable. */
export function ownReleasedHandleTimes(store: object): Record<string, number> | null {
  try {
    const field = Object.getOwnPropertyDescriptor(store, "releasedHandleAt");
    if (field && !Object.hasOwn(field, "value")) return null;
    return releasedHandleTimes(field?.value);
  } catch { return null; }
}
