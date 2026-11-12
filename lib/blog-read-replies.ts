/** Pure validation for blog reads; no commands, writes, counters or defaults. */
export function blogReadArray(raw: unknown, size?: number): unknown[] | null {
  try {
    if (!Array.isArray(raw) || Object.getOwnPropertySymbols(raw).length) return null;
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
