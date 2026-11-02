/**
 * TX3: exact, in-memory totals for one explicitly reviewed place and interval.
 * This validates a supplied snapshot, not its provenance, legal classification,
 * completeness in a provider, exchange rate or statutory reporting period.
 * No IO, registration, checkout permission or persistent counter is created.
 */
export type TaxSalesPlace = { country: string; state: string | null };
export type TaxSalesEntry = TaxSalesPlace & {
  /** One unique ledger entry, including across settled/reserved/proposed. */
  id: string;
  currency: string;
  /** Tax supply date, not the date a reservation was written. */
  supplyOn: string;
  position: "settled" | "reserved" | "proposed";
  amountMinor: number | null;
  /** Determined by the applicable rule upstream; null means unknown. */
  applicable: boolean | null;
};
export type TaxSalesLedger = {
  place: TaxSalesPlace;
  currency: string;
  /** Explicit inclusive dates; the caller must review the legal interval. */
  periodStart: string;
  periodEnd: string;
  coverageFrom: string;
  coverageThrough: string;
  complete: boolean;
  entries: readonly TaxSalesEntry[];
};
export type TaxSalesTotals = {
  status: "known";
  place: TaxSalesPlace;
  currency: string;
  periodStart: string;
  periodEnd: string;
  settledApplicableMinor: number;
  reservedApplicableMinor: number;
  proposedApplicableMinor: number;
  applicableEntries: number;
};
export type TaxSalesCount = TaxSalesTotals | { status: "unknown" | "invalid" };
/** An evidence-processing bound, never a plan entitlement or permission to
 * truncate a larger ledger. Larger snapshots fail in full before enumeration. */
export const MAX_TAX_SALES_ENTRIES = 100_000;
const LEDGER_KEYS = ["place", "currency", "periodStart", "periodEnd", "coverageFrom", "coverageThrough", "complete", "entries"] as const;
const ENTRY_KEYS = ["id", "country", "state", "currency", "supplyOn", "position", "amountMinor", "applicable"] as const;
const PLACE_KEYS = ["country", "state"] as const;
const unknown = (): TaxSalesCount => ({ status: "unknown" });
const invalid = (): TaxSalesCount => ({ status: "invalid" });

/** Detach plain own data once; no inherited evidence or getters. */
function data(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  if (Reflect.ownKeys(value).length !== keys.length) return null;
  const fields = Object.getOwnPropertyDescriptors(value);
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (!Object.hasOwn(fields, key)) return null;
    const field = fields[key];
    if (!field || !Object.hasOwn(field, "value")) return null;
    out[key] = field.value;
  }
  return out;
}
function day(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = new Date(value + "T00:00:00Z");
  return Number.isFinite(stamp.getTime()) && stamp.toISOString().slice(0, 10) === value;
}
function place(value: Record<string, unknown>): boolean {
  return typeof value.country === "string" && /^[A-Z]{2}$/.test(value.country)
    && (value.state === null || typeof value.state === "string" && /^[A-Z0-9]{1,8}$/.test(value.state));
}
const currency = (value: unknown): value is string => typeof value === "string" && /^[A-Z]{3}$/.test(value);

/**
 * National scopes include every state; a state scope includes only that state.
 * No FX conversion or default amount is inferred. Duplicate IDs, uncertain
 * classification, incomplete coverage and unknown locations fail the snapshot.
 * A pending supply outside the interval fails rather than silently disappearing.
 * Settled supplies outside it are validated but do not enter these totals.
 */
export function countTaxSales(value: unknown): TaxSalesCount {
  try {
    const ledger = data(value, LEDGER_KEYS);
    if (!ledger) return unknown();
    const target = data(ledger.place, PLACE_KEYS);
    if (!target || !place(target) || !currency(ledger.currency)) return unknown();
    if (!day(ledger.periodStart) || !day(ledger.periodEnd)
      || !day(ledger.coverageFrom) || !day(ledger.coverageThrough)) return unknown();
    if (ledger.periodStart > ledger.periodEnd) return invalid();
    if (ledger.complete !== true || ledger.coverageFrom > ledger.periodStart
      || ledger.coverageThrough < ledger.periodEnd) return unknown();
    const entries = ledger.entries;
    if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype) return unknown();
    const length = Object.getOwnPropertyDescriptor(entries, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_TAX_SALES_ENTRIES) return unknown();
    if (Reflect.ownKeys(entries).length !== length + 1) return unknown();
    const ids = new Set<string>();
    const totals = { settled: BigInt(0), reserved: BigInt(0), proposed: BigInt(0) };
    let applicableEntries = 0;
    for (let index = 0; index < length; index += 1) {
      const field = Object.getOwnPropertyDescriptor(entries, String(index));
      if (!field || !Object.hasOwn(field, "value")) return unknown();
      const entry = data(field.value, ENTRY_KEYS);
      if (!entry || !place(entry) || !currency(entry.currency) || !day(entry.supplyOn)
        || typeof entry.id !== "string" || entry.id.length > 200 || !entry.id.trim()
        || typeof entry.applicable !== "boolean"
        || !["settled", "reserved", "proposed"].includes(entry.position as string)) return unknown();
      if (ids.has(entry.id)) return unknown();
      ids.add(entry.id);
      if (entry.amountMinor === null || entry.amountMinor === undefined) return unknown();
      if (typeof entry.amountMinor !== "number" || !Number.isSafeInteger(entry.amountMinor) || entry.amountMinor < 0) return invalid();
      // Require a single evidenced currency, including excluded rows: the
      // snapshot cannot silently treat a foreign-currency amount as local.
      if (entry.currency !== ledger.currency) return unknown();
      const inPeriod = entry.supplyOn >= ledger.periodStart && entry.supplyOn <= ledger.periodEnd;
      if (entry.position !== "settled" && !inPeriod) return unknown();
      const inPlace = entry.country === target.country && (target.state === null || entry.state === target.state);
      // Missing state evidence must not make a potentially local sale vanish.
      if (target.state !== null && entry.country === target.country && entry.state === null) return unknown();
      if (!entry.applicable || !inPlace || !inPeriod) continue;
      const position = entry.position as keyof typeof totals;
      totals[position] += BigInt(entry.amountMinor);
      applicableEntries += 1;
    }
    const maximum = BigInt(Number.MAX_SAFE_INTEGER);
    if (totals.settled + totals.reserved + totals.proposed > maximum) return invalid();
    return {
      status: "known", place: { country: target.country as string, state: target.state as string | null },
      currency: ledger.currency, periodStart: ledger.periodStart, periodEnd: ledger.periodEnd,
      settledApplicableMinor: Number(totals.settled), reservedApplicableMinor: Number(totals.reserved),
      proposedApplicableMinor: Number(totals.proposed), applicableEntries,
    };
  } catch { return unknown(); }
}
