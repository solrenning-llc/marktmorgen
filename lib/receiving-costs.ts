/** Non-tax receiving fees/reserves and the explicit BRL tax arithmetic primitive.
 * No review is supplied and no sale is approved here. Superseded percentage
 * readings live only in tests/historical-receiving-model.ts.
 * The receiving terms remain the dearer provider on the amount charged,
 * remittance allowance and full refund/dispute reserves, rounded up.
 */
/** MR27Oct2026: no percentage floor; every unit must retain a positive net cent. */
export const FLOOR_BPS = 0;
export const POSITIVE_NET_CENTS = 1;

/** The two payment providers' fees, on the amount charged; the dearer is used for every charge. */
export const PROVIDER_FEES = {
  stripe: { cardBps: 290, internationalBps: 150, conversionBps: 100, billingBps: 70, taxBps: 50, fixedCents: 30 },
  paddle: { bps: 500, fixedCents: 50 },
} as const;
/** Stripe's fees summed: 6.6%. */
export const STRIPE_TOTAL_BPS =
  PROVIDER_FEES.stripe.cardBps + PROVIDER_FEES.stripe.internationalBps + PROVIDER_FEES.stripe.conversionBps + PROVIDER_FEES.stripe.billingBps + PROVIDER_FEES.stripe.taxBps;
/** Stripe's fee for a dispute received, and again for one countered (stripe.com/pricing, 17 October 2026). */
export const DISPUTE_FEE_CENTS = 1_500;
export const DISPUTE_COUNTER_FEE_CENTS = 1_500;
/** One payment in a hundred disputed, lost in full with both fees: the card networks' monitoring threshold. */
export const DISPUTE_RESERVE_BPS = 100;
/** One payment in a hundred refunded in full. */
export const REFUND_RESERVE_BPS = 100;
/** Bringing the money from the company's account to the owner's: wire and exchange, a deliberately high allowance (IOF is a tax). */
export const REMITTANCE_BPS = 150;

/** A tax reading: what is inside the price, added on top, sent home, taken of profit and of revenue. */
export type Reading = {
  id: string;
  label: string;
  salesTaxInsideBps: number;
  salesTaxOnTopBps: number;
  remittanceBps: number;
  profitTaxBps: number;
  revenueTaxBps: number;
};

/** TX metadata alone is never evidence of applicable facts, FX or operations.
 * reviewed-receiving requires the complete scoped review before calculation. */
export const MOST_CORRECT_READING: Readonly<Reading & { incomingExchangeIofBps: number }> = Object.freeze({
  id: "most-correct",
  label: "TX scenario: annual IRPF 15%; IOF 0.38% per incoming exchange; buyer tax on top up to 27%",
  salesTaxInsideBps: 0,
  salesTaxOnTopBps: 2_700,
  remittanceBps: REMITTANCE_BPS,
  profitTaxBps: 1_500,
  revenueTaxBps: 0,
  incomingExchangeIofBps: 38,
});

/** Evidence-work bound only: larger annual books refuse, never truncate. */
const MAX_INCOMING_EXCHANGE_ENTRIES = 10_000;

export type MostCorrectTaxBases = {
  /** Both bases must already be expressed in BRL cents, never USD cents. */
  currency: "BRL";
  /** The annual accounting profit at 31 December, after the applicable costs.
   * A loss gives no IRPF here and never offsets IOF on an actual entry. */
  annualProfitCents: number | null;
  /** Each exchange operation separately. An explicit empty list means no
   * incoming exchange; omitted/unknown operations must not become zero. */
  incomingExchangeCents: readonly (number | null)[] | null;
};
export type MostCorrectTaxes = {
  currency: "BRL";
  annualProfitCents: number;
  incomingExchangeCents: number;
  irpfCents: number;
  iofCents: number;
  totalTaxCents: number;
};

/**
 * Conservative whole-cent scenario arithmetic, not a tax review or a payment.
 * IRPF is annual even with no distribution. A distribution of profit already
 * taxed is not another annual profit; it can still create an exchange entry.
 * No amount is inferred from another base and no currency conversion is
 * invented. Every own data field/entry must be explicit; unknown refuses.
 */
export function mostCorrectTaxesOf(value: MostCorrectTaxBases | null): MostCorrectTaxes | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const own = (record: object, key: string): unknown => {
      const field = Object.getOwnPropertyDescriptor(record, key);
      return field && Object.prototype.hasOwnProperty.call(field, "value") ? field.value : undefined;
    };
    const currency = own(value, "currency");
    const annualProfit = own(value, "annualProfitCents");
    const entries = own(value, "incomingExchangeCents");
    if (currency !== "BRL" || typeof annualProfit !== "number" ||
        !Number.isSafeInteger(annualProfit) || !Array.isArray(entries)) return null;
    const length = own(entries, "length");
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
        length > MAX_INCOMING_EXCHANGE_ENTRIES) return null;
    const ceiling = (cents: bigint, bps: number) =>
      (cents * BigInt(bps) + BigInt(9_999)) / BigInt(10_000);
    const maximum = BigInt(Number.MAX_SAFE_INTEGER);
    let incoming = BigInt(0), iof = BigInt(0);
    for (let index = 0; index < length; index += 1) {
      const entry = own(entries, String(index));
      if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) return null;
      incoming += BigInt(entry);
      iof += ceiling(BigInt(entry), MOST_CORRECT_READING.incomingExchangeIofBps);
      if (incoming > maximum || iof > maximum) return null;
    }
    const irpf = ceiling(BigInt(Math.max(0, annualProfit)), MOST_CORRECT_READING.profitTaxBps);
    const total = irpf + iof;
    if (total > maximum) return null;
    return { currency, annualProfitCents: annualProfit, incomingExchangeCents: Number(incoming),
      irpfCents: Number(irpf), iofCents: Number(iof), totalTaxCents: Number(total) };
  } catch {
    // Unreadable/proxy-backed evidence is unknown, never a zero-tax result.
    return null;
  }
}

/** Current metadata only; not a complete review or authorization. */
export const READINGS: readonly Reading[] = [MOST_CORRECT_READING];

const pct = (cents: number, bps: number) => Number.isSafeInteger(cents) && cents >= 0 && Number.isSafeInteger(bps) && bps >= 0
  ? Number((BigInt(cents) * BigInt(bps) + BigInt(9_999)) / BigInt(10_000))
  : Math.ceil((cents * bps) / 10_000);

/** What a price brings in once the sales tax inside it is taken out, rounded down. */
export function revenueOf(priceCents: number, reading: Reading = MOST_CORRECT_READING): number {
  return Number.isSafeInteger(priceCents) && priceCents >= 0 && Number.isSafeInteger(reading.salesTaxInsideBps) && reading.salesTaxInsideBps >= 0
    ? Number(BigInt(priceCents) * BigInt(10_000) / BigInt(10_000 + reading.salesTaxInsideBps))
    : Math.floor((priceCents * 10_000) / (10_000 + reading.salesTaxInsideBps));
}
/** What the buyer is charged for a price: the price plus the sales tax added on top, rounded up. */
export function chargedOf(priceCents: number, reading: Reading = MOST_CORRECT_READING): number {
  return priceCents + pct(priceCents, reading.salesTaxOnTopBps);
}

/** The dearer provider's fee on one charge. A line on a renewal invoice (ownTransaction false) pays only the percentages. */
export function providerFeeCents(chargedCents: number, ownTransaction = true): number {
  const s = PROVIDER_FEES.stripe;
  const stripe = pct(chargedCents, s.cardBps) + pct(chargedCents, s.internationalBps) + pct(chargedCents, s.conversionBps) + pct(chargedCents, s.billingBps) + pct(chargedCents, s.taxBps) + (ownTransaction ? s.fixedCents : 0);
  const paddle = pct(chargedCents, PROVIDER_FEES.paddle.bps) + (ownTransaction ? PROVIDER_FEES.paddle.fixedCents : 0);
  return Math.max(stripe, paddle);
}

export type Receiving = {
  revenueCents: number;
  chargedCents: number;
  feeCents: number;
  remittanceCents: number;
  refundReserveCents: number;
  disputeReserveCents: number;
  totalCents: number;
};

/** What receiving one payment costs, every fee and reserve, in whole cents rounded up. */
export function receivingOf(priceCents: number, reading: Reading = MOST_CORRECT_READING, ownTransaction = true): Receiving {
  const revenueCents = revenueOf(priceCents, reading);
  const chargedCents = chargedOf(priceCents, reading);
  const feeCents = providerFeeCents(chargedCents, ownTransaction);
  const remittanceCents = pct(revenueCents, reading.remittanceBps);
  const refundReserveCents = pct(revenueCents, REFUND_RESERVE_BPS);
  // A line on the renewal invoice is disputed with that invoice, whose own unit already reserves the fees.
  const disputeReserveCents = pct(chargedCents + (ownTransaction ? DISPUTE_FEE_CENTS + DISPUTE_COUNTER_FEE_CENTS : 0), DISPUTE_RESERVE_BPS);
  return { revenueCents, chargedCents, feeCents, remittanceCents, refundReserveCents, disputeReserveCents, totalCents: feeCents + remittanceCents + refundReserveCents + disputeReserveCents };
}

export type UnitResult = Receiving & {
  usageCents: number;
  costCents: number;
  pretaxCents: number;
  taxCents: number;
  netCents: number;
  /** Net over revenue, in basis points, rounded down. */
  netBps: number;
  /** The positive whole net cent MR requires; the existing spend-floor room is separate. */
  floorCents: number;
  meetsFloor: boolean;
  /** Net cents missing to positive profit (zero only when the unit is positive). */
  gapCents: number;
  /** Most usage may cost while keeping positive net (negative when no use still loses). */
  usageRoomCents: number;
};
