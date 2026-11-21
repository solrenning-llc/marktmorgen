/**
 * 793 [IV3] unit 2, the owner's decision OWNER-20261121-1529-ART9A-PENDING-DECISIONS, item 2 (b): the lines a sale
 * shows in the creator's list of sales when the Solrenning LLC collected its VAT (lib/eu-vat-lines.ts marks the sale
 * `eu_vat` or `uk_vat` as COUNTRY:basis points:VAT in the smallest unit).
 *
 *   - The VAT, collected for the tax office: it reached the LLC through the platform's fee, not the creator.
 *   - The part of Stripe's processing fee that fell on that VAT. Stripe takes its fee on the creator's account on the
 *     whole amount the buyer paid, VAT included, and the creator pays it, as on every sale (item 2: Marktmorgen does
 *     not pay it back). It is Stripe's own fee (`stripe_fee` in the charge's balance transaction, never the platform's
 *     `application_fee`) in proportion to the VAT in the amount charged, rounded half up, in the currency Stripe
 *     settled it in.
 *
 * Pure, on the payment intent Stripe gave with its charge and balance transaction expanded. No mark: null, nothing is
 * shown. A mark that cannot be read is "unreadable", never taken as no VAT. A fee Stripe has not given (the balance
 * transaction not yet made or not expanded, or a shape not read here) is "unknown", never 0.
 */

export type SaleVatLine = {
  country: string;
  basisPoints: number;
  vatCents: number;
  /** The currency of the sale, which the VAT is in. */
  currency: string;
  stripeFeeOnVat: { cents: number; currency: string } | "unknown";
};

const MARK = /^([A-Z]{2}):(0|[1-9]\d{0,4}):(0|[1-9]\d{0,14})$/;
const CURRENCY = /^[a-z]{3}$/;

function plain(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function whole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function stripeFeeOnVat(charge: Record<string, unknown> | null, vatCents: number): SaleVatLine["stripeFeeOnVat"] {
  const amount = charge?.amount;
  const balance = plain(charge?.balance_transaction);
  if (!charge || !whole(amount) || amount === 0 || !balance || balance.object !== "balance_transaction") return "unknown";
  const currency = balance.currency;
  if (typeof currency !== "string" || !CURRENCY.test(currency) || !Array.isArray(balance.fee_details)) return "unknown";
  let fee = 0;
  let found = false;
  for (const raw of balance.fee_details) {
    const detail = plain(raw);
    if (!detail) return "unknown";
    if (detail.type !== "stripe_fee") continue;
    if (!whole(detail.amount) || detail.currency !== currency) return "unknown";
    fee += detail.amount;
    found = true;
  }
  if (!found || !Number.isSafeInteger(fee)) return "unknown";
  // fee × VAT ÷ amount, rounded half up, in integers.
  const share = (BigInt(fee) * BigInt(vatCents) * BigInt(2) + BigInt(amount)) / (BigInt(2) * BigInt(amount));
  return share > BigInt(Number.MAX_SAFE_INTEGER) ? "unknown" : { cents: Number(share), currency };
}

export function saleVatLine(paymentIntent: unknown): SaleVatLine | "unreadable" | null {
  const intent = plain(paymentIntent);
  if (!intent || intent.object !== "payment_intent") return null;
  const meta = plain(intent.metadata) ?? {};
  const marks = (["eu_vat", "uk_vat"] as const).filter((key) => Object.hasOwn(meta, key));
  if (marks.length === 0) return null;
  if (marks.length > 1) return "unreadable";
  const raw = meta[marks[0]];
  const read = typeof raw === "string" ? MARK.exec(raw) : null;
  if (!read || (marks[0] === "uk_vat") !== (read[1] === "GB")) return "unreadable";
  const charge = plain(intent.latest_charge);
  const currency = charge?.currency;
  const vatCents = Number(read[3]);
  return {
    country: read[1],
    basisPoints: Number(read[2]),
    vatCents,
    currency: typeof currency === "string" && CURRENCY.test(currency) ? currency : "",
    stripeFeeOnVat: stripeFeeOnVat(charge, vatCents),
  };
}
