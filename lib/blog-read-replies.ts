import { types } from "node:util";

/**
 * Pure validation for blog reads; no commands, writes, counters or defaults. The blog's one reader of a reply: a Proxy,
 * a hole, a getter, an extra field or a symbol is refused (store-blog's own copy of it is gone, Claude 4's LEVE 2 on
 * #2695, board #5285).
 */
export function blogReadArray(raw: unknown, size?: number): unknown[] | null {
  try {
    if (types.isProxy(raw) || !Array.isArray(raw) || Object.getOwnPropertySymbols(raw).length) return null;
    const length = Object.getOwnPropertyDescriptor(raw, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || (size !== undefined && length !== size)) return null;
    if (Object.getOwnPropertyNames(raw).length !== length + 1) return null;
    const values: unknown[] = [];
    for (let i = 0; i < length; i += 1) {
      const field = Object.getOwnPropertyDescriptor(raw, String(i));
      if (!field || !Object.hasOwn(field, "value")) return null;
      values.push(field.value);
    }
    return values;
  } catch { return null; }
}

/** The exact body record written by savePost, including its nullable product. */
export function blogReadBody(raw: unknown): { body: string; product: string | null } | null {
  if (typeof raw !== "string") return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "body") || !Object.hasOwn(record, "product")) return null;
    if (typeof record.body !== "string" || (record.product !== null && (typeof record.product !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(record.product)))) return null;
    return { body: record.body, product: record.product };
  } catch { return null; }
}
