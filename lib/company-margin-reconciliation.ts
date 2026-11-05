import { canonicalFinancialSnapshot } from "./contract-funding-rules";
import { commercialProfitMix, COMMERCIAL_PROFIT_SOURCES, type CommercialProfitMixInput, type ProfitSourceAmounts } from "./commercial-margin";
import { lastCompleteCompanyMonth } from "./company-margin-report";

/** An already reconciled source packet, not a provider response or proof that a
 * real ledger is complete. Ingestion, authentication and paid work are separate.
 */
export type CompanyMonthlySourceEvidence = {
  period: string;
  currency: "USD";
  complete: true;
  amounts: ProfitSourceAmounts;
};
export type CompanyMonthlyEvidence = {
  period: string;
  currency: "USD";
  companyFixedCostsCents: number | null;
  sources: Record<typeof COMMERCIAL_PROFIT_SOURCES[number], CompanyMonthlySourceEvidence>;
};

/** Read the small packet envelope's own data descriptors only. The financial
 * rows remain ORIGINAL references for the shared accounting validator below.
 */
function ownPacket(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key))) return null;
  const data: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable) return null;
    data[key] = field.value;
  }
  return data;
}

/** Refuse executable or nested row values before any encoder/clone can inspect
 * them. Amount validity and the exact financial schema stay with commercialProfitMix.
 */
function scalarFinancialRow(value: unknown): boolean {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 7) return false;
  return keys.every(key => {
    if (typeof key !== "string") return false;
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable) return false;
    return field.value === null || ["number", "string", "boolean"].includes(typeof field.value);
  });
}

/** Pure, bounded assembly of nine completed same-month USD packets. Nothing is
 * collected, persisted, scheduled, sent or approved for spending. Unknown never
 * becomes an empty source or zero. A returned dataset is descriptive accounting,
 * not a reviewed forecast, release permission or certified actual company profit.
 */
export function reconcileCompanyMonthlyEvidence(input: unknown, now = Date.now()): CommercialProfitMixInput | null {
  const month = lastCompleteCompanyMonth(now);
  if (month === null) return null;
  try {
    const root = ownPacket(input, ["period", "currency", "companyFixedCostsCents", "sources"]);
    if (!root || root.period !== month || root.currency !== "USD") return null;
    const sources = ownPacket(root.sources, COMMERCIAL_PROFIT_SOURCES);
    if (!sources) return null;
    const rows = Object.create(null) as CommercialProfitMixInput["sources"];
    for (const source of COMMERCIAL_PROFIT_SOURCES) {
      const packet = ownPacket(sources[source], ["period", "currency", "complete", "amounts"]);
      if (!packet || packet.period !== month || packet.currency !== "USD" || packet.complete !== true) return null;
      if (!scalarFinancialRow(packet.amounts)) return null;
      rows[source] = packet.amounts as ProfitSourceAmounts;
    }
    const accounting: CommercialProfitMixInput = {
      basis: "reconciled_actual", interval: "month", period: month, currency: "USD",
      companyFixedCostsCents: root.companyFixedCostsCents as number | null, sources: rows,
    };
    // Reuse the financial boundary on original rows BEFORE canonical encoding.
    const mix = commercialProfitMix(accounting);
    if (mix.totalNetProfitCents === null || (mix.reason !== "known" && mix.reason !== "nonpositive_total")) return null;
    const encoded = canonicalFinancialSnapshot(accounting);
    if (encoded === null) return null;
    const result = JSON.parse(encoded) as CommercialProfitMixInput;
    for (const source of COMMERCIAL_PROFIT_SOURCES) Object.freeze(result.sources[source]);
    Object.freeze(result.sources);
    return Object.freeze(result);
  } catch {
    return null;
  }
}
import { types } from "node:util";
