import { commercialProfitMix, commercialProfitMixData, COMMERCIAL_PROFIT_SOURCES, type CommercialProfitMixInput } from "./commercial-margin";
import { canonicalFinancialSnapshot } from "./contract-funding-rules";
import { storeForgetLine, type StoreForgetMonth } from "./store-forget-retry";
import { keptStarLine } from "./two-step";

/** MR, owner27 October2026: a measured company target, never a sales gate. */
export const COMPANY_NET_MARGIN_TARGET_BPS = 6_000;
export const COMPANY_OPERATIONAL_OBSERVATION_MAX_CHARS = 4_096;
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
export type CompanyMonthlyMarginPresentation = Readonly<{
  schema: 1;
  reportId: string;
  month: string;
  currency: "USD";
  basis: "reconciled_actual";
  subject: string;
  text: string;
}>;

const MONTH_NAMES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
] as const;

function usd(cents: number): string {
  const amount = BigInt(cents);
  const negative = amount < BigInt(0);
  const absolute = negative ? -amount : amount;
  const whole = String(absolute / BigInt(100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}US$ ${whole},${String(absolute % BigInt(100)).padStart(2, "0")}`;
}

function percent(bps: number): string {
  const amount = BigInt(bps);
  const negative = amount < BigInt(0);
  const absolute = negative ? -amount : amount;
  return `${negative ? "-" : ""}${absolute / BigInt(100)},${String(absolute % BigInt(100)).padStart(2, "0")}%`;
}

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

const exactKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
};
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function operationalExceptionLines(serialized: string | null, month: string): string[] {
  let storeForget: StoreForgetMonth | null = null;
  let keptStarTimes: number | null = null;
  if (typeof serialized === "string" && serialized.length <= COMPANY_OPERATIONAL_OBSERVATION_MAX_CHARS) {
    try {
      const value: unknown = JSON.parse(serialized);
      if (
        value !== null && typeof value === "object" && !Array.isArray(value) &&
        JSON.stringify(value) === serialized &&
        exactKeys(value, ["schema", "month", "storeForget", "keptStarTimes"]) &&
        Reflect.get(value, "schema") === 1 && Reflect.get(value, "month") === month
      ) {
        const suppliedStore = Reflect.get(value, "storeForget");
        const suppliedStar = Reflect.get(value, "keptStarTimes");
        const validStore = suppliedStore === null || (
          suppliedStore !== null && typeof suppliedStore === "object" && !Array.isArray(suppliedStore) &&
          exactKeys(suppliedStore, ["month", "queued", "done", "gaveUp", "waitingNow", "keptNow"]) &&
          Reflect.get(suppliedStore, "month") === month &&
          ["queued", "done", "gaveUp", "waitingNow", "keptNow"].every(key => count(Reflect.get(suppliedStore, key)))
        );
        const validStar = suppliedStar === null || count(suppliedStar);
        if (validStore && validStar) {
          storeForget = suppliedStore as StoreForgetMonth | null;
          keptStarTimes = suppliedStar as number | null;
        }
      }
    } catch {
      // A malformed observation is unknown, never an empty or zero observation.
    }
  }
  return [storeForgetLine(storeForget), keptStarLine(month, keptStarTimes)].filter(Boolean);
}

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
  // Validate the original graph through the shared accounting boundary before
  // any copy, including inspection of the independent held-store observation.
  // The detached data must be captured before that observation can run traps.
  const data = commercialProfitMixData(input);
  // Aggregate observation is independent of financial reconciliation. Never
  // execute supplied getters or copy a store identifier/provenance into output.
  const aggregate = canonicalFinancialSnapshot(held);
  const observed = aggregate === null ? null : JSON.parse(aggregate);
  if (observed && typeof observed === "object" && !Array.isArray(observed) && observed.month === month &&
      Number.isSafeInteger(observed.count) && observed.count >= 0 &&
      Number.isSafeInteger(observed.peak) && observed.peak >= observed.count) {
    report.heldStores = observed.count; report.heldStoresPeak = observed.peak;
  }
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

/**
 * Produce an idempotent, aggregate-only envelope for private owner presentation.
 * Accept the accounting input, not a caller-supplied report, so a forged complete
 * status cannot bypass reconciliation. This pure function does not send, schedule,
 * persist, call a provider or grant release permission.
 */
export function companyMonthlyMarginPresentation(
  input: CommercialProfitMixInput | null,
  now = Date.now(),
  held: unknown = null,
  operations?: string | null,
): CompanyMonthlyMarginPresentation | null {
  const report = companyMonthlyMarginReport(input, now, held);
  if (
    report.status !== "complete" || report.month === null ||
    report.revenueCents === null || report.variableCostsCents === null ||
    report.fixedCostsCents === null || report.taxesCents === null ||
    report.refundsCents === null || report.reservesCents === null ||
    report.netProfitCents === null
  ) return null;

  const year = report.month.slice(0, 4);
  const monthName = MONTH_NAMES[Number(report.month.slice(5, 7)) - 1];
  if (monthName === undefined) return null;

  const zeroRevenue = report.revenueCents === 0;
  if (zeroRevenue !== (report.netMarginBps === null && report.targetMet === null)) return null;
  const reportId = `company-margin:${report.month}:v1`;
  const subject = `Margem da empresa Marktmorgen — ${monthName} de ${year}`;
  const marginLine = report.netMarginBps === null
    ? `Margem líquida: não mensurável porque a receita foi ${usd(report.revenueCents)}.`
    : `Margem líquida: ${percent(report.netMarginBps)}`;
  const targetLine = report.targetMet === null
    ? `Meta: ${percent(report.targetBps)} — não mensurável porque a receita foi ${usd(report.revenueCents)}.`
    : `Meta: ${percent(report.targetBps)} — ${report.targetMet ? "atingida" : "não atingida"}.`;
  const heldLine = report.heldStores === null || report.heldStoresPeak === null
    ? "Lojas retidas para recuperação: desconhecido (não zero)."
    : `Lojas retidas para recuperação: ${report.heldStores} no fim do mês; pico mensal ${report.heldStoresPeak}.`;
  // The pure presentation never invokes the paid Redis readers. Once a caller
  // explicitly supplies this source, missing or invalid evidence is visible as
  // unknown; omission preserves the earlier presentation until a funded caller exists.
  const operationalLines = operations === undefined ? [] : operationalExceptionLines(operations, report.month);

  return Object.freeze({
    schema: 1,
    reportId,
    month: report.month,
    currency: report.currency,
    basis: report.basis,
    subject,
    text: [
      subject,
      `ID do relatório: ${reportId}`,
      "Base: dados reais reconciliados do mês-calendário UTC completo.",
      `Receita: ${usd(report.revenueCents)}`,
      `Custos variáveis: ${usd(report.variableCostsCents)}`,
      `Custos fixos: ${usd(report.fixedCostsCents)}`,
      `Impostos: ${usd(report.taxesCents)}`,
      `Reembolsos: ${usd(report.refundsCents)}`,
      `Reservas: ${usd(report.reservesCents)}`,
      `Lucro líquido: ${usd(report.netProfitCents)}`,
      marginLine,
      targetLine,
      heldLine,
      ...operationalLines,
      "Somente informativo: este relatório não abre vendas nem altera preço, limite, comissão, sinalizador ou trava.",
    ].join("\n"),
  });
}

/** Read the completed monthly operational observation, without inventing actual
 * reconciled money inputs or scheduling/sending any owner communication. */
export async function companyMonthlyMarginReportWithHeld(input: CommercialProfitMixInput | null, now = Date.now()): Promise<CompanyMonthlyMarginReport> {
  const month = lastCompleteCompanyMonth(now);
  const held = month === null ? null : await (await import("./held-stores")).readHeldMonth(month);
  return companyMonthlyMarginReport(input, now, held);
}
