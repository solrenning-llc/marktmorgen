import { commercialProfitMix, COMMERCIAL_PROFIT_SOURCES, type CommercialProfitMixInput } from "./commercial-margin";
import { canonicalFinancialSnapshot } from "./contract-funding-rules";

/** MR, owner27 October2026: a measured company target, never a sales gate. */
export const COMPANY_NET_MARGIN_TARGET_BPS = 6_000;
export type CompanyMonthlyMarginReport = {
  schema: 1;
  month: string | null;
  currency: "USD";
  basis: "reconciled_actual";
  status: "unknown" | "complete";
  reason: "missing_or_invalid_data" | "invalid_clock" | "wrong_period_or_basis" | "fixed_cost_allocation_mismatch" | "complete";
  revenueCents: number | null;
  variableCostsCents: number | null;
  fixedCostsCents: number | null;
  taxesCents: number | null;
  refundsCents: number | null;
  reservesCents: number | null;
  netProfitCents: number | null;
  netMarginBps: number | null;
  targetBps: typeof COMPANY_NET_MARGIN_TARGET_BPS;
  targetMet: boolean | null;
  heldStores: number | null;
  heldStoresPeak: number | null;
};

/** Last complete UTC calendar month, not a rolling 30-day estimate. */
export function lastCompleteCompanyMonth(now: number): string | null {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) return null;
  const at = new Date(now);
  const month = new Date(0);
  month.setUTCFullYear(at.getUTCFullYear(), at.getUTCMonth() - 1, 1);
  const year = month.getUTCFullYear();
  if (year < 1 || year > 9999) return null;
  return String(year).padStart(4, "0") + "-" + String(month.getUTCMonth() + 1).padStart(2, "0");
}
const safe = (n: bigint): number | null =>
  n < BigInt(Number.MIN_SAFE_INTEGER) || n > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(n);

/**
 * Reuses the actual commercial profit accounting boundary and all nine sources.
 * Input must explicitly reconcile the whole LLC's same-month USD costs/taxes,
 * refunds and reserves. A missing source is unknown, including before sales.
 * Output is aggregate numbers and a month only: no provenance text, customer,
 * store, account, address, invoice identifier or supplied extra field is copied.
 * This pure calculation has no IO, email, persistence or release permission.
 * Scheduling, reconciled ingestion and owner presentation remain separate work.
 */
export function companyMonthlyMarginReport(input: CommercialProfitMixInput | null, now = Date.now(), held: unknown = null): CompanyMonthlyMarginReport {
  const month = lastCompleteCompanyMonth(now);
  const report: CompanyMonthlyMarginReport = {
    schema: 1, month, currency: "USD", basis: "reconciled_actual", status: "unknown",
    reason: month === null ? "invalid_clock" : "missing_or_invalid_data",
    revenueCents: null, variableCostsCents: null, fixedCostsCents: null,
    taxesCents: null, refundsCents: null, reservesCents: null, netProfitCents: null,
    netMarginBps: null, targetBps: COMPANY_NET_MARGIN_TARGET_BPS, targetMet: null,
    heldStores: null, heldStoresPeak: null,
  };
  if (month === null) return report;
  // Aggregate observation is independent of financial reconciliation. Never
  // execute supplied getters or copy a store identifier/provenance into output.
  const aggregate = canonicalFinancialSnapshot(held);
  const observed = aggregate === null ? null : JSON.parse(aggregate);
  if (observed && typeof observed === "object" && !Array.isArray(observed) && observed.month === month &&
      Number.isSafeInteger(observed.count) && observed.count >= 0 &&
      Number.isSafeInteger(observed.peak) && observed.peak >= observed.count) {
    report.heldStores = observed.count; report.heldStoresPeak = observed.peak;
  }
  const encoded = canonicalFinancialSnapshot(input);
  if (encoded === null) return report;
  const data = JSON.parse(encoded) as CommercialProfitMixInput | null;
  if (!data || typeof data !== "object" || Array.isArray(data)) return report;
  if (data.basis !== "reconciled_actual" || data.interval !== "month" || data.period !== month) {
    report.reason = "wrong_period_or_basis"; return report;
  }
  const mix = commercialProfitMix(data);
  if (mix.reason === "fixed_cost_allocation_mismatch") {
    report.reason = "fixed_cost_allocation_mismatch"; return report;
  }
  if (mix.totalNetProfitCents === null || (mix.reason !== "known" && mix.reason !== "nonpositive_total")) return report;
  const keys = ["revenueCents", "variableCostsCents", "allocatedFixedCostsCents", "taxesCents", "refundsCents", "reservesCents"] as const;
  const totals = keys.map(key => safe(COMMERCIAL_PROFIT_SOURCES.reduce((total, source) =>
    total + BigInt(data.sources[source]![key]!), BigInt(0))));
  if (totals.some(n => n === null)) return report;
  const [revenue, variable, fixed, taxes, refunds, reserves] = totals as number[];
  const margin = revenue > 0 ? safe(BigInt(mix.totalNetProfitCents) * BigInt(10_000) / BigInt(revenue)) : null;
  if (revenue > 0 && margin === null) return report;
  return {
    ...report, status: "complete", reason: "complete",
    revenueCents: revenue, variableCostsCents: variable, fixedCostsCents: fixed,
    taxesCents: taxes, refundsCents: refunds, reservesCents: reserves,
    netProfitCents: mix.totalNetProfitCents, netMarginBps: margin,
    // Exact comparison; a displayed rounded percentage never meets the target.
    targetMet: revenue > 0 ? BigInt(mix.totalNetProfitCents) * BigInt(10_000) >= BigInt(revenue) * BigInt(COMPANY_NET_MARGIN_TARGET_BPS) : null,
  };
}

/** Read the completed monthly operational observation, without inventing actual
 * reconciled money inputs or scheduling/sending any owner communication. */
export async function companyMonthlyMarginReportWithHeld(input: CommercialProfitMixInput | null, now = Date.now()): Promise<CompanyMonthlyMarginReport> {
  const month = lastCompleteCompanyMonth(now);
  const held = month === null ? null : await (await import("./held-stores")).readHeldMonth(month);
  return companyMonthlyMarginReport(input, now, held);
}
