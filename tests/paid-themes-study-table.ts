/**
 * Section 5 of docs/paid-themes-study.md (345 [RN3]): worst case per template or theme sale,
 * computed only from lib/receiving-costs.ts (no fee, reserve or tax rate typed here).
 * Arithmetic for a study, not a review: no sale, fee or price is approved by it.
 *
 * Rounding: integer cents; every fee, reserve and tax rounded up as lib/receiving-costs.ts
 * does; the marketplace fee rounded down; break-even rounded up to 0.01%; margins rounded.
 */
import {
  DISPUTE_COUNTER_FEE_CENTS,
  DISPUTE_FEE_CENTS,
  DISPUTE_RESERVE_BPS,
  MOST_CORRECT_READING,
  POSITIVE_NET_CENTS,
  PROVIDER_FEES,
  REFUND_RESERVE_BPS,
  chargedOf,
  providerFeeCents,
  receivingOf,
} from "@/lib/receiving-costs";

/** The owner's TM1 decision (item 430): 10% of a template sale. Not a proposal. */
export const TM1_FEE_BPS = 1_000;
/** Calculation points only, not proposed prices. */
export const STUDY_PRICES_CENTS = [1_900, 4_900, 9_900, 30_000] as const;

/** Same convention as lib/receiving-costs.ts `pct`: whole cents, rounded up. */
const ceilBps = (cents: number, bps: number) => Math.ceil((cents * bps) / 10_000);

/** IRPF and IOF of MOST_CORRECT_READING on a positive pre-IRPF profit (IOF base approximated by it). */
export const taxOf = (pretaxCents: number) =>
  pretaxCents > 0
    ? ceilBps(pretaxCents, MOST_CORRECT_READING.profitTaxBps) + ceilBps(pretaxCents, MOST_CORRECT_READING.incomingExchangeIofBps)
    : 0;
const netAfterTax = (pretaxCents: number) => pretaxCents - taxOf(pretaxCents);

/** Reading A: Marktmorgen bears every receiving cost of the whole sale. */
export function readingANetCents(priceCents: number, feeCents: number): number {
  const charged = chargedOf(priceCents);
  const disputeReserve = ceilBps(charged + DISPUTE_FEE_CENTS + DISPUTE_COUNTER_FEE_CENTS, DISPUTE_RESERVE_BPS);
  const costs = providerFeeCents(charged) + disputeReserve +
    ceilBps(feeCents, MOST_CORRECT_READING.remittanceBps) + ceilBps(feeCents, REFUND_RESERVE_BPS);
  return netAfterTax(feeCents - costs);
}

/** Reading B: fee, disputes and refunds on the seller's account; Marktmorgen bears remittance and
 * refund reserve on its fee, plus Stripe Tax on the amount charged. */
export function readingBNetCents(priceCents: number, feeCents: number): number {
  const costs = ceilBps(feeCents, MOST_CORRECT_READING.remittanceBps) + ceilBps(feeCents, REFUND_RESERVE_BPS) +
    ceilBps(chargedOf(priceCents), PROVIDER_FEES.stripe.taxBps);
  return netAfterTax(feeCents - costs);
}

/** Smallest fee, in cents, whose reading-A net keeps MR's positive net cent. */
export function breakEvenFeeCents(priceCents: number): number {
  for (let fee = 0; fee <= priceCents; fee += 1) if (readingANetCents(priceCents, fee) >= POSITIVE_NET_CENTS) return fee;
  throw new Error(`no break-even fee at ${priceCents}`);
}

/** Option 1: Marktmorgen sells its own theme; receiving costs and taxes only (unknown costs excluded). */
export function firstPartyNetCents(priceCents: number): number {
  return netAfterTax(priceCents - receivingOf(priceCents).totalCents);
}

export type StudyRow = {
  priceCents: number;
  readingACents: number;
  readingBCents: number;
  breakEvenBasisHundredths: number;
  firstPartyCents: number;
  firstPartyPercent: number;
};

export function studyRows(): StudyRow[] {
  return STUDY_PRICES_CENTS.map((priceCents) => {
    const fee = Math.floor((priceCents * TM1_FEE_BPS) / 10_000);
    const firstPartyCents = firstPartyNetCents(priceCents);
    return {
      priceCents,
      readingACents: readingANetCents(priceCents, fee),
      readingBCents: readingBNetCents(priceCents, fee),
      breakEvenBasisHundredths: Math.ceil((breakEvenFeeCents(priceCents) * 10_000) / priceCents),
      firstPartyCents,
      firstPartyPercent: Math.round((firstPartyCents * 100) / priceCents),
    };
  });
}

const usd = (cents: number) => {
  const abs = Math.abs(cents);
  const text = `US$${Math.floor(abs / 100)}${abs % 100 ? `.${String(abs % 100).padStart(2, "0")}` : ""}`;
  return cents < 0 ? `−${text}` : text;
};
const usdCents = (cents: number) => {
  const abs = Math.abs(cents);
  const text = `US$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return cents < 0 ? `−${text}` : text;
};

export const STUDY_TABLE_HEADER = [
  "| Sale price | Marktmorgen net at 10%, reading A | at 10%, reading B | Break-even fee, reading A | First-party theme at that price (option 1), receiving and tax only |",
  "| --- | --- | --- | --- | --- |",
];

/** The section 5 table, exactly as the document prints it. */
export function renderStudyTable(): string {
  const rows = studyRows().map((r) =>
    `| ${usd(r.priceCents)} | ${usdCents(r.readingACents)} | ${usdCents(r.readingBCents)} | ${(r.breakEvenBasisHundredths / 100).toFixed(2)}% | ${usdCents(r.firstPartyCents)} net (${r.firstPartyPercent}%) |`);
  return [...STUDY_TABLE_HEADER, ...rows].join("\n");
}
