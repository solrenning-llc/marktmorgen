/**
 * Fees and what the creator keeps, sale by sale (282 [HG1], unit 1).
 *
 * Read only from the balance transactions of the creator's own Stripe
 * account (the reading, its cache and its ceiling are the next units; this
 * one is the rule). Each sale gets one row per currency it settled in:
 * gross, Stripe's fee (with pass-through fees and dispute fees), tax on
 * Stripe's fee, an application fee (the Marktmorgen commission: the account
 * records none while COMMISSION_LIVE is false, and whatever it records is
 * shown as recorded), other fees of a kind not known here, refunds,
 * disputes (with money given back) and the net Stripe itself recorded.
 * Stripe Tax fees and other Stripe fees charged to the account (Billing,
 * Radar, currency conversion) belong to no sale and stay apart, by currency.
 * A bank payment that bounced (payment_reversal) takes the sale back, as a
 * refund does.
 *
 * Only the types named here are read. Payouts, transfers and top-ups are
 * named as money that is no sale and no fee; every other type, and every
 * adjustment that is not a dispute, cannot be read, so the report is
 * unavailable rather than missing money (rule 24).
 *
 * Amounts are in the currency the account recorded, in its smallest unit;
 * currencies are never added together and nothing is converted here.
 *
 * Unknown is said, never zero (rule 24). A line is read only when it is
 * whole and adds up: object "balance_transaction", a txn_ id, whole numbers,
 * amount - fee = net, the fee is the sum of its details, every detail in the
 * line's own currency and never negative, and a refund or dispute names its
 * charge through the expanded source. One line that cannot be read, the same
 * line twice, the same sale twice, a reading that did not finish or a list
 * longer than MAX_FEE_LINES makes the whole report unavailable, never a lower
 * number. A refund or dispute of a sale outside the reading gives a row whose
 * gross and net are unknown (null), never zero.
 *
 * Pure: imports nothing, so the page, the CSV and the tests read one rule.
 */

/** The most lines one report reads; past it the report is unavailable. */
export const MAX_FEE_LINES = 10_000;

export type FeeLineKind = "sale" | "refund" | "dispute" | "tax_fee" | "stripe_fee";

export type FeeLine = {
  id: string;
  kind: FeeLineKind;
  /** The charge (ch_) or payment (py_) the money belongs to; null for an account fee. */
  sale: string | null;
  /** Seconds since 1970, as Stripe records `created`. */
  at: number;
  currency: string;
  amount: number;
  stripeFee: number;
  feeTax: number;
  applicationFee: number;
  otherFee: number;
  net: number;
};

const TXN_ID = /^txn_[A-Za-z0-9]{1,255}$/;
const SALE_ID = /^(ch|py)_[A-Za-z0-9]{1,255}$/;
const CURRENCY = /^[a-z]{3}$/;

const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const SALE_TYPES = new Set(["charge", "payment"]);
const REFUND_TYPES = new Set(["refund", "payment_refund", "refund_failure", "payment_failure_refund"]);
const REVERSAL_TYPES = new Set(["payment_reversal"]);
const DISPUTE_CATEGORIES = new Set(["dispute", "dispute_reversal"]);
const ACCOUNT_FEE_TYPES = new Map<string, "tax_fee" | "stripe_fee">([
  ["tax_fee", "tax_fee"],
  ["stripe_fee", "stripe_fee"],
  ["stripe_fx_fee", "stripe_fee"],
]);
/** Types known to carry no sale money and no fee: read and left out. */
const NO_SALE_TYPES = new Set([
  "payout", "payout_cancel", "payout_failure",
  "transfer", "transfer_cancel", "transfer_failure",
  "topup", "topup_reversal",
]);
const STRIPE_FEE_DETAILS = new Set(["stripe_fee", "payment_method_passthrough_fee"]);

/** The sale a sale line is for: its source, as an id or expanded. */
function saleSource(source: unknown): string | null {
  const id = record(source) ? source.id : source;
  return typeof id === "string" && SALE_ID.test(id) ? id : null;
}

/** The sale a refund or dispute line is for: the charge on its expanded source. */
function chargeOf(source: unknown): string | null {
  if (!record(source)) return null;
  const charge = record(source.charge) ? source.charge.id : source.charge;
  return typeof charge === "string" && SALE_ID.test(charge) ? charge : null;
}

/** The sale a payment reversal is for: the payment itself, or the charge on its expanded source. */
function reversedSale(source: unknown): string | null {
  return saleSource(source) ?? chargeOf(source);
}

/**
 * One balance transaction: a FeeLine, "other" (a payout, a transfer or a
 * top-up: money that is no sale and no fee), or null when it cannot be read,
 * which includes every type not named here.
 */
export function readFeeLine(raw: unknown): FeeLine | "other" | null {
  if (!record(raw) || raw.object !== "balance_transaction") return null;
  const { id, amount, fee, net, currency, created, type, reporting_category: category, fee_details: details } = raw;
  if (typeof id !== "string" || !TXN_ID.test(id)) return null;
  if (!whole(amount) || !whole(fee) || !whole(net) || amount - fee !== net) return null;
  if (typeof currency !== "string" || !CURRENCY.test(currency)) return null;
  if (!whole(created) || created <= 0) return null;
  if (typeof type !== "string" || typeof category !== "string") return null;
  if (!Array.isArray(details)) return null;

  let stripeFee = 0;
  let feeTax = 0;
  let applicationFee = 0;
  let otherFee = 0;
  for (const d of details) {
    if (!record(d) || !whole(d.amount) || d.amount < 0 || d.currency !== currency || typeof d.type !== "string") return null;
    if (STRIPE_FEE_DETAILS.has(d.type)) stripeFee += d.amount;
    else if (d.type === "tax") feeTax += d.amount;
    else if (d.type === "application_fee") applicationFee += d.amount;
    else otherFee += d.amount;
  }
  if (stripeFee + feeTax + applicationFee + otherFee !== fee) return null;

  let kind: FeeLineKind;
  let sale: string | null;
  if (SALE_TYPES.has(type)) {
    kind = "sale";
    sale = saleSource(raw.source);
  } else if (REFUND_TYPES.has(type)) {
    kind = "refund";
    sale = chargeOf(raw.source);
  } else if (REVERSAL_TYPES.has(type)) {
    kind = "refund";
    sale = reversedSale(raw.source);
  } else if (type === "adjustment" && DISPUTE_CATEGORIES.has(category)) {
    kind = "dispute";
    sale = chargeOf(raw.source);
  } else if (ACCOUNT_FEE_TYPES.has(type)) {
    return { id, kind: ACCOUNT_FEE_TYPES.get(type)!, sale: null, at: created, currency, amount, stripeFee, feeTax, applicationFee, otherFee, net };
  } else if (NO_SALE_TYPES.has(type)) {
    return "other";
  } else {
    return null;
  }
  if (sale === null) return null;
  return { id, kind, sale, at: created, currency, amount, stripeFee, feeTax, applicationFee, otherFee, net };
}

export type SaleRow = {
  sale: string;
  currency: string;
  /** When the sale was made; null when the sale itself is outside the reading. */
  at: number | null;
  /** Whether the sale line itself was read: when false, gross and net are unknown. */
  saleRead: boolean;
  gross: number | null;
  stripeFee: number;
  feeTax: number;
  applicationFee: number;
  otherFee: number;
  /** Refunds and bank payments reversed (negative), failed refunds given back (positive). */
  refunds: number;
  /** Disputed money taken (negative) and given back (positive). */
  disputes: number;
  net: number | null;
};

export type AccountFees = { currency: string; taxFees: number; stripeFees: number };

export type SaleFeesUnavailable = "incomplete" | "unreadable" | "repeated" | "too_large";

export type SaleFees =
  | { available: true; rows: SaleRow[]; accountFees: AccountFees[] }
  | { available: false; why: SaleFeesUnavailable };

/**
 * The report from one reading of the account's balance transactions.
 * `complete` is true only when the reading reached the end of what it asked
 * for; anything else is unavailable.
 */
export function saleFees(raws: readonly unknown[], reading: { complete: boolean }): SaleFees {
  if (!Array.isArray(raws)) return { available: false, why: "unreadable" };
  if (reading?.complete !== true) return { available: false, why: "incomplete" };
  if (raws.length > MAX_FEE_LINES) return { available: false, why: "too_large" };

  const ids = new Set<string>();
  const rows = new Map<string, SaleRow & { netSum: number }>();
  const account = new Map<string, AccountFees>();
  for (const raw of raws) {
    const line = readFeeLine(raw);
    if (line === null) return { available: false, why: "unreadable" };
    if (line === "other") continue;
    if (ids.has(line.id)) return { available: false, why: "repeated" };
    ids.add(line.id);

    if (line.sale === null) {
      const fees = account.get(line.currency) ?? { currency: line.currency, taxFees: 0, stripeFees: 0 };
      if (line.kind === "tax_fee") fees.taxFees += line.net;
      else fees.stripeFees += line.net;
      account.set(line.currency, fees);
      continue;
    }

    const key = `${line.sale}\u0000${line.currency}`;
    const row = rows.get(key) ?? {
      sale: line.sale, currency: line.currency, at: null, saleRead: false, gross: null,
      stripeFee: 0, feeTax: 0, applicationFee: 0, otherFee: 0, refunds: 0, disputes: 0, net: null, netSum: 0,
    };
    if (line.kind === "sale") {
      if (row.saleRead) return { available: false, why: "repeated" };
      row.saleRead = true;
      row.at = line.at;
      row.gross = line.amount;
    } else if (line.kind === "refund") {
      row.refunds += line.amount;
    } else {
      row.disputes += line.amount;
    }
    row.stripeFee += line.stripeFee;
    row.feeTax += line.feeTax;
    row.applicationFee += line.applicationFee;
    row.otherFee += line.otherFee;
    row.netSum += line.net;
    rows.set(key, row);
  }

  const out: SaleRow[] = [...rows.values()].map(({ netSum, ...row }) => ({ ...row, net: row.saleRead ? netSum : null }));
  out.sort((a, b) => (b.at ?? -1) - (a.at ?? -1) || (a.sale < b.sale ? -1 : a.sale > b.sale ? 1 : 0) || (a.currency < b.currency ? -1 : 1));
  const accountFees = [...account.values()].sort((a, b) => (a.currency < b.currency ? -1 : 1));
  return { available: true, rows: out, accountFees };
}
