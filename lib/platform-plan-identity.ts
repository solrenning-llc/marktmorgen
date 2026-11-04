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


const parsedHistories = new WeakSet<object>();
const indexedHistories = new WeakMap<object, Map<string, HandleOwnership[]>>();
export type HandleOwnership = { handle: string; acquiredAt: number | null; releasedAt: number | null };
/** Only recorded events are evidence. Old records are not backfilled. */
export function handleOwnership(value: unknown): HandleOwnership[] | null {
  if (value === undefined) return [];
  try {
    if (value && typeof value === "object" && parsedHistories.has(value)) return value as HandleOwnership[];
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const fields = Object.getOwnPropertyDescriptors(value as object);
    const size = fields.length?.value;
    if (!Number.isSafeInteger(size) || size < 0 || Reflect.ownKeys(fields).length !== size + 1) return null;
    const out: HandleOwnership[] = [], ends = new Map<string, number | null>();
    for (let i = 0; i < size; i++) {
      const slot = fields[String(i)];
      if (!slot || !Object.hasOwn(slot, "value")) return null;
      const row = slot.value;
      if (!row || typeof row !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(row))) return null;
      const d = Object.getOwnPropertyDescriptors(row);
      if (Reflect.ownKeys(d).length !== 3 || ["handle", "acquiredAt", "releasedAt"].some(k => !d[k] || !Object.hasOwn(d[k], "value"))) return null;
      const h = d.handle.value, a = d.acquiredAt.value, r = d.releasedAt.value;
      if (typeof h !== "string" || !HANDLE_PATTERN.test(h) ||
          [a,r].some(t => t !== null && (!Number.isSafeInteger(t) || t <= 0)) ||
          a === null && r === null || a !== null && r !== null && a > r) return null;
      if (ends.has(h) && (ends.get(h) === null || a === null || a < ends.get(h)!)) return null;
      ends.set(h, r); out.push(Object.freeze({ handle:h, acquiredAt:a, releasedAt:r }));
    }
    Object.freeze(out); parsedHistories.add(out); return out;
  } catch { return null; }
}
export function ownHandleOwnership(store: object): HandleOwnership[] | null {
  try {
    const field = Object.getOwnPropertyDescriptor(store, "handleOwnership");
    if (field && !Object.hasOwn(field, "value")) return null;
    return handleOwnership(field?.value);
  } catch { return null; }
}
export type PlanOwnership = "owned" | "foreign" | "unknown";
/** Stripe clocks use whole seconds; an unrecorded beginning never proves possession. */
export function legacyHandleOwnership(intervals: readonly HandleOwnership[], handle: string, created: unknown): PlanOwnership {
  if (typeof created !== "number" || !Number.isSafeInteger(created) || created < 0 || !Number.isSafeInteger(created * 1000)) return "unknown";
  const captured = handleOwnership(intervals);
  if (!captured) return "unknown";
  let index = indexedHistories.get(captured);
  if (!index) {
    index = new Map();
    for (const row of captured) { const rows = index.get(row.handle) ?? []; rows.push(row); index.set(row.handle, rows); }
    indexedHistories.set(captured, index);
  }
  const at = created * 1000;
  let afterRelease = false;
  for (const row of index.get(handle) ?? []) {
    if (row.acquiredAt !== null && at >= row.acquiredAt && (row.releasedAt === null || at + 1000 <= row.releasedAt)) return "owned";
    if (row.releasedAt !== null && at >= row.releasedAt) afterRelease = true;
  }
  return afterRelease ? "foreign" : "unknown";
}
export function acquireHandleOwnership(store: object, handle: string, at: number): HandleOwnership[] {
  const rows = ownHandleOwnership(store);
  if (!rows) throw new Error("The handle ownership history is unknown");
  if (rows.some(r => r.handle === handle && r.releasedAt === null)) throw new Error("The handle is already recorded as owned");
  const next = handleOwnership([...rows, {handle, acquiredAt:at, releasedAt:null}]);
  if (!next) throw new Error("The acquisition event is inconsistent with recorded ownership");
  return next;
}
export function releaseHandleOwnership(store: object, handle: string, at: number): HandleOwnership[] {
  const rows = ownHandleOwnership(store);
  if (!rows) throw new Error("The handle ownership history is unknown");
  const open = rows.findLastIndex(r => r.handle === handle && r.releasedAt === null);
  const next = handleOwnership(open < 0 ? [...rows, {handle, acquiredAt:null, releasedAt:at}] : rows.map((r,i) => i === open ? {...r, releasedAt:at} : r));
  if (!next) throw new Error("The release event is inconsistent with recorded ownership");
  return next;
}
