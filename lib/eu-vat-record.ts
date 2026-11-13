/**
 * EU VAT under art. 9a, part 2 of the build, unit 4a: the record Council Implementing Regulation (EU) No 282/2011
 * art. 63c asks of each supply under the non-Union scheme, kept ten years (Directive 2006/112/EC art. 369) and made
 * available electronically without delay (docs/eu-vat-article-9a.md, "What follows", point 4).
 *
 * Pure: builds and checks the record, stores nothing. Its storage (ten years, apart from the store, its place in
 * lib/data-families.ts and tests/store-data-registry.ts, its cost, and how it stands against a person's erasure) is
 * unit 4b and not built here. Nothing here records a treatment or opens a sale.
 *
 * Whole or none. A sale missing any field the article lists, or whose parts disagree (the VAT's country not the
 * consumer's, the payments not adding up to the total charged, a place that is not an EU consumer's, a supply that is
 * not a service), makes no record (null): it can never be taken as recorded. Fields kept, per art. 63c(1):
 *   (a) the Member State of consumption; (b) the type of service; (c) the date; (d) the taxable amount and currency;
 *   (e) any later increase or reduction (adjustments, one entry each, never a rewrite); (f) the VAT rate; (g) the VAT
 *   amount and currency; (h) each payment's date and amount; (j) the customer's name where known; (k) the information
 *   used to determine where the customer belongs. Point (i), an invoice's content where one is issued, is added when
 *   invoices under art. 9a are built.
 */
import type { ConsumerPlace } from "@/lib/eu-vat-supply";
import type { VatOnTop } from "@/lib/eu-vat-amount";

export const EU_VAT_RECORD_VERSION = 1;

export type EuVatAdjustment = { date: string; taxableCents: number; vatCents: number; reason: string };

export type EuVatRecord = {
  v: typeof EU_VAT_RECORD_VERSION;
  /** The sale's own id (the checkout session or the order), the record's key. */
  sale: string;
  /** The store's id, never its address. */
  store: string;
  memberState: string;
  service: string;
  supply: "ess" | "human";
  date: string;
  currency: string;
  taxableCents: number;
  rateBasisPoints: number;
  vatCents: number;
  payments: { date: string; cents: number }[];
  customerName: string | null;
  location: { ip: string; billing: string; card?: string };
  adjustments: EuVatAdjustment[];
};

export type EuVatSale = {
  sale: string;
  store: string;
  supply: "ess" | "human";
  service: string;
  /** When the supply was made, seconds since the epoch. */
  at: number;
  currency: string;
  vat: VatOnTop;
  place: ConsumerPlace;
  payments: { at: number; cents: number }[];
  customerName: string | null;
};

const text = (value: unknown, most = 500) => typeof value === "string" && value.trim().length > 0 && value.length <= most;
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
/** The UTC day of a moment in seconds; null for anything that is not a moment a Date can hold. */
const dayOf = (seconds: number): string | null =>
  whole(seconds) && seconds > 0 && seconds <= 8_640_000_000_000 ? new Date(seconds * 1000).toISOString().slice(0, 10) : null;

/** The record of one sale, or null when anything art. 63c asks is missing or the parts disagree. */
export function euVatRecord(sale: EuVatSale): EuVatRecord | null {
  if (!sale || typeof sale !== "object") return null;
  if (!text(sale.sale, 255) || !text(sale.store, 64) || !text(sale.service, 200)) return null;
  if (sale.supply !== "ess" && sale.supply !== "human") return null;
  if (typeof sale.currency !== "string" || !/^[a-z]{3}$/i.test(sale.currency)) return null;
  const date = dayOf(sale.at);
  if (!date) return null;
  const vat = sale.vat;
  if (!vat || !whole(vat.priceCents) || !whole(vat.vatCents) || !whole(vat.totalCents) || !whole(vat.basisPoints)) return null;
  if (vat.priceCents < 0 || vat.vatCents < 0 || vat.totalCents !== vat.priceCents + vat.vatCents) return null;
  const place = sale.place;
  if (!place || place.kind !== "eu" || place.country !== vat.country) return null;
  if (!Array.isArray(sale.payments) || sale.payments.length === 0) return null;
  const payments: { date: string; cents: number }[] = [];
  let paid = 0;
  for (const payment of sale.payments) {
    const day = dayOf(payment?.at);
    if (!day || !whole(payment.cents) || payment.cents <= 0) return null;
    payments.push({ date: day, cents: payment.cents });
    paid += payment.cents;
  }
  if (paid !== vat.totalCents) return null;
  if (sale.customerName !== null && !text(sale.customerName, 300)) return null;
  const evidence = place.evidence;
  return {
    v: EU_VAT_RECORD_VERSION,
    sale: sale.sale,
    store: sale.store,
    memberState: place.country,
    service: sale.service,
    supply: sale.supply,
    date,
    currency: sale.currency.toUpperCase(),
    taxableCents: vat.priceCents,
    rateBasisPoints: vat.basisPoints,
    vatCents: vat.vatCents,
    payments,
    customerName: sale.customerName,
    location: { ip: evidence.ip, billing: evidence.billing, ...(evidence.card !== undefined ? { card: evidence.card } : {}) },
    adjustments: [],
  };
}

/**
 * A later increase or reduction (art. 63c(1)(e)), added as its own entry: a refund is negative. Never more taken back
 * than the sale and its earlier adjustments leave, never an entry of nothing, never one without its reason. Null when
 * refused; the record given is not changed.
 */
export function euVatAdjustment(record: EuVatRecord, change: { at: number; taxableCents: number; vatCents: number; reason: string }): EuVatRecord | null {
  const date = dayOf(change?.at);
  if (!record || !date || !whole(change.taxableCents) || !whole(change.vatCents) || !text(change.reason, 100)) return null;
  if (change.taxableCents === 0 && change.vatCents === 0) return null;
  const taxableLeft = record.taxableCents + record.adjustments.reduce((n, a) => n + a.taxableCents, 0) + change.taxableCents;
  const vatLeft = record.vatCents + record.adjustments.reduce((n, a) => n + a.vatCents, 0) + change.vatCents;
  if (taxableLeft < 0 || vatLeft < 0) return null;
  return { ...record, adjustments: [...record.adjustments, { date, taxableCents: change.taxableCents, vatCents: change.vatCents, reason: change.reason }] };
}
