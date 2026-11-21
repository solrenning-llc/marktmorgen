/**
 * What receiving one sale's EU or UK VAT through the platform's fee costs (789 [IV1] step 3, unit 6; AGENTS.md, IV (b):
 * `application_fee_amount` = the plan's share + the tax + the costs of receiving that tax). Read by lib/eu-vat-collect.ts
 * as euVatCollectionCostCents, which the checkout adds to the fee beside the VAT itself.
 *
 * Every part is a percentage of the VAT, from lib/receiving-costs.ts, rounded up; no figure is typed here. The fee
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
import { DISPUTE_RESERVE_BPS, PROVIDER_FEES, REFUND_RESERVE_BPS, REMITTANCE_BPS } from "@/lib/receiving-costs";

/** One reviewed allowance for the exchange-rate movement between a sale and the payment of its return, in basis points. */
export type VatFxAllowance = Readonly<{
  currency: "eur" | "gbp";
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
  returnPaymentCents: number;
  refundReserveCents: number;
  disputeReserveCents: number;
  /** What the platform's fee carries beside the VAT: the five parts above. */
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

/** The dearer allowance in force today for the currency, or null. */
function allowanceOf(currency: string, allowances: readonly VatFxAllowance[], day: string): number | null {
  const valid = allowances.filter((a) => a.currency === currency && Number.isSafeInteger(a.bps) && a.bps > 0 && a.bps <= 10_000
    && /^https:\/\//.test(a.source) && DAY.test(a.checkedOn) && DAY.test(a.validThrough) && a.checkedOn <= day && day <= a.validThrough);
  return valid.length ? Math.max(...valid.map((a) => a.bps)) : null;
}

/** The cost of receiving `vatCents` of VAT in `currency`, part by part, or null when any part is unknown. */
export function vatCollectionCostOf(vatCents: number, currency: string, allowances: readonly VatFxAllowance[], now: Date): VatCollectionCost | null {
  if (!Number.isSafeInteger(vatCents) || vatCents < 0) return null;
  const code = typeof currency === "string" ? currency.toLowerCase() : "";
  if (!CURRENCIES.has(code) || !Number.isFinite(now.getTime())) return null;
  const fxBps = allowanceOf(code, allowances, now.toISOString().slice(0, 10));
  if (fxBps === null) return null;
  const s = PROVIDER_FEES.stripe;
  const stripe = up(vatCents, s.cardBps) + up(vatCents, s.internationalBps) + up(vatCents, s.conversionBps) + up(vatCents, s.billingBps) + up(vatCents, s.taxBps);
  const parts = {
    conversionCents: up(vatCents, s.conversionBps),
    fxCents: up(vatCents, fxBps),
    returnPaymentCents: up(vatCents, REMITTANCE_BPS),
    refundReserveCents: up(vatCents, REFUND_RESERVE_BPS),
    disputeReserveCents: up(vatCents, DISPUTE_RESERVE_BPS),
  };
  const feeCents = Object.values(parts).reduce((sum, cents) => sum + cents, 0);
  const processingCents = Math.max(stripe, up(vatCents, PROVIDER_FEES.paddle.bps));
  const worstCaseCents = feeCents + processingCents;
  return Number.isSafeInteger(worstCaseCents) ? { ...parts, feeCents, processingCents, worstCaseCents } : null;
}

/** The checkout's figure: the fee's part under the reviewed allowances, today; null (refused) while none is reviewed. */
export const euVatCollectionCostCents = (vatCents: number, currency: string): number | null =>
  vatCollectionCostOf(vatCents, currency, REVIEWED_VAT_FX_ALLOWANCES, new Date())?.feeCents ?? null;
