/** Strictly reads the saved exposure before any new payout batch is allowed. */
export type PendingPayoutBatch = {
  at: number;
  currency: string;
  lines: { a: string; c: number }[];
  /** A batch whose answer was not known (lib/paypal-payouts.ts): when it was last sent again, ms. */
  t?: number;
  /** 1: it could not be confirmed with PayPal and needs the creator's own check; it is not sent again. */
  m?: 1;
};

const unavailable = (): never => { throw new Error("Pending payout records are unavailable"); };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Accepts both HGETALL response shapes. A missing or malformed response is never empty. */
export function readPendingPayoutBatches(results: unknown): Map<string, PendingPayoutBatch> {
  if (!Array.isArray(results) || results.length !== 1) return unavailable();
  const raw: unknown = results[0];
  const pairs: [string, unknown][] = [];
  if (Array.isArray(raw)) {
    if (raw.length % 2 !== 0) return unavailable();
    for (let i = 0; i < raw.length; i += 2) {
      if (typeof raw[i] !== "string") return unavailable();
      pairs.push([raw[i], raw[i + 1]]);
    }
  } else if (record(raw)) {
    pairs.push(...Object.entries(raw));
  } else return unavailable();
  const out = new Map<string, PendingPayoutBatch>();
  for (const [id, rawValue] of pairs) {
    if (!id || out.has(id) || typeof rawValue !== "string") return unavailable();
    let value: unknown;
    try { value = JSON.parse(rawValue); } catch { return unavailable(); }
    if (!record(value) || !Number.isSafeInteger(value.at) || (value.at as number) < 0 ||
        typeof value.currency !== "string" || !/^[a-z]{3}$/i.test(value.currency) ||
        !Array.isArray(value.lines)) return unavailable();
    const seen = new Set<string>();
    const lines: PendingPayoutBatch["lines"] = [];
    for (const line of value.lines) {
      if (!record(line) || typeof line.a !== "string" || !line.a.trim() || seen.has(line.a) ||
          !Number.isSafeInteger(line.c) || (line.c as number) <= 0) return unavailable();
      seen.add(line.a);
      lines.push({ a: line.a, c: line.c as number });
    }
    // The two marks of a batch whose answer was not known, each only in its own shape.
    if (value.t !== undefined && (!Number.isSafeInteger(value.t) || (value.t as number) < 0)) return unavailable();
    if (value.m !== undefined && value.m !== 1) return unavailable();
    out.set(id, {
      at: value.at as number, currency: value.currency, lines,
      ...(value.t !== undefined ? { t: value.t as number } : {}),
      ...(value.m === 1 ? { m: 1 as const } : {}),
    });
  }
  return out;
}
