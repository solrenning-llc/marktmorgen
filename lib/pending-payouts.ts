/** Strictly reads the saved exposure before any new payout batch is allowed. */
export type PendingPayoutBatch = {
  at: number;
  currency: string;
  /** `r`: the SHA-256 (hex) of the PayPal address the line was sent to, never the address itself (lib/paypal-payouts.ts). */
  lines: { a: string; c: number; r?: string }[];
  /** A batch whose answer was not known (lib/paypal-payouts.ts): when it was last sent again, ms. */
  t?: number;
  /** 1: it could not be confirmed with PayPal and needs the creator's own check; it is not sent again. */
  m?: 1;
  /**
   * A batch held under PayPal's id: the sender_batch_id it was sent under, so a "?" entry of that same request left
   * behind (its removal not confirmed) is known to be this batch and never sent to PayPal again.
   */
  s?: string;
};

/** PayPal's sender_batch_id: at most 127 characters, printable ASCII, no space (lib/paypal-payouts.ts writes "nl-..."). */
const SENDER_BATCH_ID = /^[\x21-\x7e]{1,127}$/;
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
      if (line.r !== undefined && (typeof line.r !== "string" || !/^[0-9a-f]{64}$/.test(line.r))) return unavailable();
      seen.add(line.a);
      lines.push({ a: line.a, c: line.c as number, ...(typeof line.r === "string" ? { r: line.r } : {}) });
    }
    // The two marks of a batch whose answer was not known, each only in its own shape.
    if (value.t !== undefined && (!Number.isSafeInteger(value.t) || (value.t as number) < 0)) return unavailable();
    if (value.m !== undefined && value.m !== 1) return unavailable();
    if (value.s !== undefined && (typeof value.s !== "string" || !SENDER_BATCH_ID.test(value.s))) return unavailable();
    out.set(id, {
      at: value.at as number, currency: value.currency, lines,
      ...(value.t !== undefined ? { t: value.t as number } : {}),
      ...(value.m === 1 ? { m: 1 as const } : {}),
      ...(typeof value.s === "string" ? { s: value.s } : {}),
    });
  }
  return out;
}
