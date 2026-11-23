/**
 * What receiving one sale's EU or UK VAT through the platform's fee costs (789 [IV1] step 3, unit 6; AGENTS.md, IV (b):
 * `application_fee_amount` = the plan's share + the tax + the costs of receiving that tax). Read by lib/eu-vat-collect.ts
 * as euVatCollectionCostCents, which the checkout adds to the fee beside the VAT itself.
 *
 * The rates come from lib/receiving-costs.ts, rounded up; no figure is typed here. Conversion applies to the whole
 * collected fee (VAT plus its costs); the other parts apply to the VAT. The fee
 * carries Marktmorgen's own costs of receiving the VAT (feeCents):
 *   - conversion: the fee turned into the platform's currency (Stripe's conversion percentage);
 *   - exchange-rate movement until the OSS or HMRC return is paid, from a reviewed allowance with its source and the
 *     days it holds (REVIEWED_VAT_FX_ALLOWANCES); none is reviewed, so the cost is unknown and the sale refused;
 *   - paying the return: wire and exchange, the same allowance as REMITTANCE_BPS;
 *   - the refund and dispute reserves on the VAT (REFUND_RESERVE_BPS, DISPUTE_RESERVE_BPS).
 * Never in the fee: the processing fee on the VAT part of the charge (processingCents, the dearer provider's percentages,
 * no fixed fee, which the charge pays once, VAT or not). In a direct charge Stripe already takes it from the creator's
 * account, so putting it in the fee would charge the creator twice (coordinator, 21/11/2026 06:20 UTC). Whether the
 * creator bears it or Marktmorgen gives it back is the owner's question; until then Marktmorgen's worst case counts it,
 * as if it gave it back (worstCaseCents).
 * The fixed costs (the OSS, IOSS and UK VAT registrations and filings, the import intermediary) are not per sale: they
 * belong to the LLC's fixed costs (FX275). Unknown is never zero: an unread currency, an amount that is not a whole cent
 * count, an unreadable clock or no allowance in force each answer null. Pure: no IO.
 */
import { decimalsOf, isCurrency } from "@/lib/money";
import { DISPUTE_RESERVE_BPS, PROVIDER_FEES, REFUND_RESERVE_BPS, REMITTANCE_BPS } from "@/lib/receiving-costs";
import { httpsSource } from "@/lib/reviewed-https-source";

/**
 * One reviewed allowance, in basis points. Without `against`: the exchange-rate movement between a sale and the payment
 * of its return, read in the return's currency (`currency`: eur or gbp). With `against` (unit 7, Claude 1's MEDIUM on
 * #5032): the gap between the VAT owed in the return's currency at the tax authority's period rate (HMRC's, fixed for
 * the month) and what the VAT collected in the charge's currency (`currency`) buys at the market rate on the sale.
 */
export type VatFxAllowance = Readonly<{
  currency: string;
  against?: "eur" | "gbp";
  bps: number;
  /** The official page the allowance was set from, and the UTC days it holds. */
  source: string;
  checkedOn: string;
  validThrough: string;
}>;

/** Empty on purpose: an allowance is added only with its source and the day it was read. */
export const REVIEWED_VAT_FX_ALLOWANCES: readonly VatFxAllowance[] = Object.freeze([]);

export type VatCollectionCost = Readonly<{
  conversionCents: number;
  fxCents: number;
  /** The gap to the return currency's period rate; zero for a sale in the return's own currency. */
  periodGapCents: number;
  returnPaymentCents: number;
  refundReserveCents: number;
  disputeReserveCents: number;
  /** What the platform's fee carries beside the VAT: the six parts above. */
  feeCents: number;
  /** The processing fee on the VAT part, never in the fee. */
  processingCents: number;
  /** Marktmorgen's worst case: the fee's part and the processing part, as if Marktmorgen gave the latter back. */
  worstCaseCents: number;
}>;

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const CURRENCIES = new Set(["eur", "gbp"]);

/** `cents` × `bps` / 10,000, rounded up, exactly. */
function up(cents: number, bps: number): number {
  return Number((BigInt(cents) * BigInt(bps) + BigInt(9_999)) / BigInt(10_000));
}

/** A review day is a real UTC calendar day, not only a string with a date's shape. */
function reviewedDay(day: string): boolean {
  return typeof day === "string" && DAY.test(day) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

/** The dearer allowance in force today for the currency (and, for a period-rate gap, against the return's), or null. */
function allowanceOf(currency: string, allowances: readonly VatFxAllowance[], day: string, against?: string): number | null {
  const valid = allowances.filter((a) => a.currency === currency && a.against === against && Number.isSafeInteger(a.bps) && a.bps > 0 && a.bps <= 10_000
    && httpsSource(a.source) && reviewedDay(a.checkedOn) && reviewedDay(a.validThrough) && a.checkedOn <= day && day <= a.validThrough);
  return valid.length ? Math.max(...valid.map((a) => a.bps)) : null;
}

/**
 * The cost of receiving `vatCents` of VAT charged in `currency`, part by part, or null when any part is unknown. The
 * exchange-rate allowance is the one of the currency the return is paid in (`returnCurrency`: euros for the OSS,
 * pounds for HMRC), which is the charge's own currency unless named (unit 7: a UK sale in euros or dollars is declared
 * in pounds). A named return currency lets the charge be in any store currency written in hundredths; without one,
 * only euros and pounds are read, as before.
 */
export function vatCollectionCostOf(vatCents: number, currency: string, allowances: readonly VatFxAllowance[], now: Date, returnCurrency?: string): VatCollectionCost | null {
  if (!Number.isSafeInteger(vatCents) || vatCents < 0) return null;
  const code = typeof currency === "string" ? currency.toLowerCase() : "";
  const back = returnCurrency === undefined ? code : typeof returnCurrency === "string" ? returnCurrency.toLowerCase() : "";
  if (!CURRENCIES.has(back) || !Number.isFinite(now.getTime())) return null;
  if (returnCurrency === undefined ? !CURRENCIES.has(code) : !(isCurrency(code) && decimalsOf(code) === 2)) return null;
  const day = now.toISOString().slice(0, 10);
  const fxBps = allowanceOf(back, allowances, day);
  if (fxBps === null) return null;
  // A sale charged in another currency than its return's: the gap to the period rate needs its own reviewed allowance.
  const gapBps = code === back ? 0 : allowanceOf(code, allowances, day, back);
  if (gapBps === null) return null;
  const s = PROVIDER_FEES.stripe;
  const stripe = up(vatCents, s.cardBps) + up(vatCents, s.internationalBps) + up(vatCents, s.conversionBps) + up(vatCents, s.billingBps) + up(vatCents, s.taxBps);
  const otherParts = {
    fxCents: up(vatCents, fxBps),
    periodGapCents: up(vatCents, gapBps),
    returnPaymentCents: up(vatCents, REMITTANCE_BPS),
    refundReserveCents: up(vatCents, REFUND_RESERVE_BPS),
    disputeReserveCents: up(vatCents, DISPUTE_RESERVE_BPS),
  };
  const otherCents = Object.values(otherParts).reduce((sum, cents) => sum + cents, 0);
  if (!Number.isSafeInteger(otherCents) || !Number.isSafeInteger(s.conversionBps) || s.conversionBps < 0 || s.conversionBps >= 10_000) return null;
  // The full application fee is converted: VAT + other costs + conversion itself. The minimum conversion C obeys
  // C >= ceil((VAT + other + C) * bps / 10,000), hence C = ceil((VAT + other) * bps / (10,000 - bps)).
  // BigInt keeps that ceiling exact; the existing safe-cent check below refuses an unrepresentable result.
  const divisor = BigInt(10_000 - s.conversionBps);
  const conversionCents = Number(((BigInt(vatCents) + BigInt(otherCents)) * BigInt(s.conversionBps) + divisor - BigInt(1)) / divisor);
  const parts = { conversionCents, ...otherParts };
  const feeCents = otherCents + conversionCents;
  const processingCents = Math.max(stripe, up(vatCents, PROVIDER_FEES.paddle.bps));
  const worstCaseCents = feeCents + processingCents;
  return Number.isSafeInteger(worstCaseCents) ? { ...parts, feeCents, processingCents, worstCaseCents } : null;
}

/** The checkout's figure: the fee's part under the reviewed allowances, today; null (refused) while none is reviewed. */
export const euVatCollectionCostCents = (vatCents: number, currency: string, returnCurrency?: string): number | null =>
  vatCollectionCostOf(vatCents, currency, REVIEWED_VAT_FX_ALLOWANCES, new Date(), returnCurrency)?.feeCents ?? null;
