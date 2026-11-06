/** TEST/ARCHIVE ONLY: superseded receiving and tax readings. Never import from production. */
export * from "../lib/receiving-costs";
import { POSITIVE_NET_CENTS, REMITTANCE_BPS, receivingOf, type Reading, type UnitResult } from "../lib/receiving-costs";
export const STRESS_PROFIT_TAX_BPS = 2_750;

/** Historical18Oct sizing reading; MR27Oct replaces its60% floor with positive net.
 * This favorable reading never replaces the unchanged most-tax release reading. */
export const SIZING_READING: Reading = {
  id: "sizing",
  label: "Sizing reading: 27.5% on profit, the buyer's tax on top at 27%",
  salesTaxInsideBps: 0,
  salesTaxOnTopBps: 2_700,
  remittanceBps: REMITTANCE_BPS,
  profitTaxBps: STRESS_PROFIT_TAX_BPS,
  revenueTaxBps: 0,
};

/**
 * The reading with MORE tax for every open question (rule 19), as in
 * Hazelsong: 27% VAT inside every price; US federal 37% on effectively
 * connected income, California 13.3%, Brazil 27.5% and IOF 0.38% on profit,
 * added, with no credit (78.18%); ISS at 5% of revenue, not deductible; IOF
 * at 3.5% on what is sent home on top of the remittance allowance.
 */
export const MOST_TAX_READING: Reading = {
  id: "most-tax",
  label: "Most-tax reading: 27% VAT inside, 78.18% on profit, ISS 5% of revenue",
  salesTaxInsideBps: 2_700,
  salesTaxOnTopBps: 0,
  remittanceBps: REMITTANCE_BPS + 350,
  profitTaxBps: 3_700 + 1_330 + 2_750 + 38,
  revenueTaxBps: 500,
};

/**
 * EU hosting, so the LLC has no US-source income: Brazil 15% (Lei
 * 14.754/2023) + IOF 0.38% + California 13.3% on profit, on every customer;
 * ISS at 5% of revenue; the buyer's tax on top at 27%.
 */
export const EU_HOSTING_READING: Reading = {
  id: "eu-hosting",
  label: "EU hosting (no US tax): 28.68% on profit, ISS 5% of revenue, tax on top 27%",
  salesTaxInsideBps: 0,
  salesTaxOnTopBps: 2_700,
  remittanceBps: REMITTANCE_BPS,
  profitTaxBps: 1_500 + 38 + 1_330,
  revenueTaxBps: 500,
};

/** EU hosting with ISS at 0% (a Fortaleza consultation answered in the owner's favor). */
export const EU_HOSTING_ISS_ZERO: Reading = { ...EU_HOSTING_READING, id: "eu-iss0", label: "EU hosting, ISS 0% (Fortaleza consultation)", revenueTaxBps: 0 };
/** EU hosting with business-only sales: the buyer's tax on top at 15%, the realistic worst (US state tax, BC/SK/MB PST). */
export const EU_HOSTING_BUSINESS: Reading = { ...EU_HOSTING_READING, id: "eu-b2b", label: "EU hosting, business-only sales (tax on top 15%)", salesTaxOnTopBps: 1_500 };
/** All three design choices at once. */
export const EU_HOSTING_ISS_ZERO_BUSINESS: Reading = { ...EU_HOSTING_READING, id: "eu-iss0-b2b", label: "EU hosting, ISS 0% and business-only sales", revenueTaxBps: 0, salesTaxOnTopBps: 1_500 };
/** Business-only sales under the sizing reading. */
export const SIZING_BUSINESS: Reading = { ...SIZING_READING, id: "sizing-b2b", label: "Sizing reading, business-only sales (tax on top 15%)", salesTaxOnTopBps: 1_500 };



export const READINGS: readonly Reading[] = [SIZING_READING, SIZING_BUSINESS, MOST_TAX_READING, EU_HOSTING_READING, EU_HOSTING_ISS_ZERO, EU_HOSTING_BUSINESS, EU_HOSTING_ISS_ZERO_BUSINESS];
const pct = (cents: number, bps: number) => Math.ceil(cents * bps / 10_000);

/** The profit and revenue taxes on a pretax profit. The profit tax is never below the stress floor. */
export function taxOf(revenueCents: number, pretaxCents: number, reading: Reading): number {
  const profitBps = Math.max(reading.profitTaxBps, STRESS_PROFIT_TAX_BPS);
  return pct(Math.max(0, pretaxCents), profitBps) + pct(revenueCents, reading.revenueTaxBps);
}

/** Whether a unit with this non-tax cost keeps the floor under a reading. */
function keeps(revenueCents: number, costCents: number, reading: Reading): boolean {
  const pretax = revenueCents - costCents;
  return pretax - taxOf(revenueCents, pretax, reading) >= POSITIVE_NET_CENTS;
}

/** Largest non-tax cost preserving a positive net cent under the supplied reading. */
export function costBudgetCents(revenueCents: number, reading: Reading): number {
  const profitBps = Math.max(reading.profitTaxBps, STRESS_PROFIT_TAX_BPS);
  const target = POSITIVE_NET_CENTS + pct(revenueCents, reading.revenueTaxBps);
  let budget = revenueCents - Math.ceil((target * 10_000) / (10_000 - profitBps));
  while (budget > -revenueCents && !keeps(revenueCents, budget, reading)) budget -= 1;
  while (keeps(revenueCents, budget + 1, reading)) budget += 1;
  return budget;
}

/** One unit of sale under a reading: its price, its usage at full use (in cents), its receiving, its taxes and its net. */
export function unitUnder(priceCents: number, usageCents: number, reading: Reading = SIZING_READING, ownTransaction = true): UnitResult {
  const r = receivingOf(priceCents, reading, ownTransaction);
  const costCents = r.totalCents + usageCents;
  const pretaxCents = r.revenueCents - costCents;
  const taxCents = taxOf(r.revenueCents, pretaxCents, reading);
  const netCents = pretaxCents - taxCents;
  const floorCents = POSITIVE_NET_CENTS;
  const budget = costBudgetCents(r.revenueCents, reading);
  return {
    ...r,
    usageCents,
    costCents,
    pretaxCents,
    taxCents,
    netCents,
    netBps: r.revenueCents > 0 ? Math.floor((netCents * 10_000) / r.revenueCents) : 0,
    floorCents,
    meetsFloor: netCents >= floorCents,
    gapCents: Math.max(0, floorCents - netCents),
    usageRoomCents: budget - r.totalCents,
  };
}
