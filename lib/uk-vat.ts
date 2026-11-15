/**
 * UK VAT, unit 3 (IVA, 14/11/2026): Marktmorgen as the supplier of what a store sells electronically to a UK consumer
 * (the platform rule in HMRC's digital services guidance), collected on top of the price at the UK rate, with two
 * agreeing items of location evidence, a full VAT invoice, the sale's record and the figures of the VAT Return.
 * Pure: nothing here charges, stores, sends or files, nothing calls it yet, and UK_VAT_COLLECT_REVIEWED keeps it off.
 *
 * Sources, read on 14/11/2026 through the GOV.UK content API (date = the page's public_updated_at):
 *   - VAT rates (gov.uk/vat-rates, 12/12/2014): "The standard VAT rate is 20%".
 *   - VAT rules for supplies of digital services to consumers (28/03/2022): a platform that authorises the charge,
 *     authorises the delivery or sets the general terms "must treat the sales of third-party e-services as if they
 *     were your own"; "2 pieces of information as evidence of where a consumer normally lives" and "If the
 *     information does not match, you must contact the consumer"; a customer that "does not give you a VAT
 *     registration number" is a business-to-consumer supply; "Education, training [...] delivered by a person over
 *     the internet [...] is not considered to be an electronically supplied service".
 *   - VAT Notice 700/1, 9.3 (05/08/2026) and VAT Act 1994 Schedule 1A (legislation.gov.uk): no threshold for a
 *     non-established taxable person; register within 30 days; the 9-digit VAT registration number.
 *   - VAT Notice 700/21, 4.1 (18/03/2024): the details of a VAT invoice, among them "the total amount of VAT
 *     chargeable, expressed in sterling".
 *   - VAT Notice 700, 7.6 (25/06/2026, force of law under VAT Act 1994 Sch. 6 para 11): "amounts of money must always
 *     be expressed in sterling", converted at "the UK market selling rate at the time of the supply" or, as an
 *     alternative adopted for all supplies, "the period rate of exchange published by HMRC for customs purposes";
 *     any other rate needs HMRC's written agreement, so the ECB's rate is not accepted here.
 *   - VAT Notice 700/12 (How to fill in and submit your VAT Return): box 1 "VAT due in the period on sales", box 6
 *     "total value of sales and all other outputs excluding any VAT"; Sending a VAT Return (26/11/2024): due "one
 *     calendar month and 7 days after the end of an accounting period", the same for payment.
 *
 * Gaps kept closed rather than guessed (each refuses, never sells untaxed): goods (the online marketplace rules are not
 * built); a service a person gives live (its UK treatment is not recorded); the Isle of Man (inside the UK's VAT area
 * for some purposes, not settled here); a UK business's reverse charge (checking a UK VAT number needs an HMRC
 * developer application, an account not authorised): every UK buyer is charged UK VAT as a consumer, which never
 * understates the tax; whether an e-publication's zero rate applies (VAT Notice 701/10 not read): the standard rate.
 */
import type { EuSupply } from "@/lib/eu-vat-supply";

/** Collecting UK VAT is built but off until a reviewer checks the treatment and the owner's UK VAT registration. */
export const UK_VAT_COLLECT_REVIEWED = false;

export const UK_VAT_RATE = { basisPoints: 2000, source: "https://www.gov.uk/vat-rates", readOn: "2026-11-14", publicUpdatedAt: "2014-12-12" } as const;
/** The rate is read again before this day; past it no UK sale is collected. */
export const UK_VAT_RATE_VALID_UNTIL = "2026-12-31";

/** Never a country here: user-assigned ranges, proxies' unknown markers, and "UK", which ISO 3166-1 reserves (the UK is GB). */
const NOT_A_COUNTRY = /^(AA|Q[M-Z]|X[A-Z]|ZZ|T1|UK)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const realDay = (value: unknown): value is string => {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
};
const dayOf = (seconds: unknown): string | null =>
  whole(seconds) && seconds > 0 && seconds <= 8_640_000_000_000 ? new Date(seconds * 1000).toISOString().slice(0, 10) : null;
const text = (value: unknown, most: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= most;

export type UkPlace =
  | { kind: "uk"; evidence: { ip: string; billing: string; card?: string } }
  | { kind: "outside"; country: string }
  | { kind: "unknown"; reason: "missing" | "not-a-country" | "contradiction" | "territory" };

function code(value: unknown): string | null | "bad" {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return "bad";
  const c = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && !NOT_A_COUNTRY.test(c) ? c : "bad";
}

/** Where the consumer belongs for UK VAT: every item given must agree; GB (Northern Ireland included) is the UK. */
export function ukPlace(items: { ip: unknown; billing: unknown; card?: unknown }): UkPlace {
  if (!items || typeof items !== "object") return { kind: "unknown", reason: "missing" };
  const ip = code(items.ip);
  const billing = code(items.billing);
  const card = items.card === undefined ? undefined : code(items.card);
  if (ip === null || billing === null || card === null) return { kind: "unknown", reason: "missing" };
  if (ip === "bad" || billing === "bad" || card === "bad") return { kind: "unknown", reason: "not-a-country" };
  if (ip !== billing || (card !== undefined && card !== ip)) return { kind: "unknown", reason: "contradiction" };
  if (ip === "IM") return { kind: "unknown", reason: "territory" };
  if (ip !== "GB") return { kind: "outside", country: ip };
  return { kind: "uk", evidence: { ip, billing, ...(card !== undefined ? { card } : {}) } };
}

export type UkVat = { priceCents: number; vatCents: number; totalCents: number; basisPoints: number };

/** UK VAT on top of a price in minor units, half up once on the line; null for a price that is not whole. */
export function ukVatOnTop(priceCents: number): UkVat | null {
  if (!whole(priceCents) || priceCents < 0) return null;
  const product = priceCents * UK_VAT_RATE.basisPoints;
  if (!whole(product)) return null;
  const vatCents = Math.floor((product + 5000) / 10000);
  return { priceCents, vatCents, totalCents: priceCents + vatCents, basisPoints: UK_VAT_RATE.basisPoints };
}

export type UkCheckout =
  | { kind: "outside"; country: string }
  | { kind: "free" }
  | { kind: "collect"; vat: UkVat; place: Extract<UkPlace, { kind: "uk" }> }
  | { kind: "refuse"; reason: "place" | "goods" | "human" | "supply" | "review" | "rate-expired" };

/** What a checkout does with one sale for UK VAT before it opens. */
export function ukCheckout(input: { supply: EuSupply; priceCents: number; items: { ip: unknown; billing: unknown; card?: unknown }; reviewed?: boolean; now?: Date }): UkCheckout {
  const now = input.now ?? new Date();
  const place = ukPlace(input.items);
  const clockOk = now instanceof Date && Number.isFinite(now.getTime());
  if (place.kind === "unknown") return { kind: "refuse", reason: "place" };
  if (place.kind === "outside") return { kind: "outside", country: place.country };
  if (input.supply === "free") return { kind: "free" };
  if (input.supply === "goods") return { kind: "refuse", reason: "goods" };
  if (input.supply === "human") return { kind: "refuse", reason: "human" };
  if (input.supply !== "ess") return { kind: "refuse", reason: "supply" };
  if (!clockOk) return { kind: "refuse", reason: "rate-expired" };
  if ((input.reviewed ?? UK_VAT_COLLECT_REVIEWED) !== true) return { kind: "refuse", reason: "review" };
  if (now.toISOString().slice(0, 10) > UK_VAT_RATE_VALID_UNTIL) return { kind: "refuse", reason: "rate-expired" };
  const vat = ukVatOnTop(input.priceCents);
  if (!vat) return { kind: "refuse", reason: "supply" };
  return { kind: "collect", vat, place };
}

/**
 * The sterling conversion of a sale in another currency: HMRC's period rate or the UK market selling rate at the
 * supply, given as HMRC publishes its rates, units of the currency per £1 (e.g. "1.3137" US dollars).
 */
export type UkSterlingRate = { perPound: string; basis: "hmrc-period" | "uk-market"; day: string; source: string };
const RATE = /^(0|[1-9]\d{0,6})(\.\d{1,6})?$/;

/** Minor units of a currency to pence at `perPound` (units per £1): cents / perPound, half up once, in integers; null when it does not read. */
export function toPence(cents: number, perPound: string): number | null {
  if (!whole(cents) || typeof perPound !== "string" || !RATE.test(perPound)) return null;
  const [units, decimals = ""] = perPound.split(".");
  const micro = BigInt(units) * BigInt(1_000_000) + BigInt((decimals + "000000").slice(0, 6));
  if (micro <= BigInt(0)) return null;
  const two = BigInt(2);
  // |cents| / (micro / 10^6), half up: floor((2 * |cents| * 10^6 + micro) / (2 * micro)); the sign put back after.
  const pence = (two * BigInt(Math.abs(cents)) * BigInt(1_000_000) + micro) / (two * micro);
  if (pence > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return cents < 0 ? -Number(pence) : Number(pence);
}

/** The sale's VAT in pence: itself in sterling; otherwise at a rate of the supply's day (or, for HMRC's period rate, its month). */
function vatInPence(vatCents: number, currency: string, suppliedOn: string, sterling: UkSterlingRate | null | undefined): { pence: number; rate: UkSterlingRate | null } | null {
  if (currency === "GBP") return { pence: vatCents, rate: null };
  if (!sterling || !realDay(sterling.day) || (sterling.basis !== "hmrc-period" && sterling.basis !== "uk-market") || !/^https:\/\/\S+$/.test(sterling.source)) return null;
  // "the appropriate rate for any supply is that current at the time of the supply" (Notice 700, 7.6).
  if (sterling.basis === "uk-market" ? sterling.day !== suppliedOn : sterling.day.slice(0, 7) !== suppliedOn.slice(0, 7)) return null;
  const pence = toPence(vatCents, sterling.perPound);
  return pence === null ? null : { pence, rate: sterling };
}

const NOT_HUNDREDTHS = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF", "BHD", "JOD", "KWD", "OMR", "TND"]);

export type UkInvoice = {
  number: string;
  timeOfSupply: string;
  issuedOn: string | null;
  supplier: { name: string; address: string; vatNumber: string };
  customer: { name: string; address: string };
  description: string;
  quantity: 1;
  currency: string;
  unitPriceCents: number;
  amountExVatCents: number;
  rateBasisPoints: number;
  vatCents: number;
  totalCents: number;
  vatSterlingPence: number;
  sterlingRate: UkSterlingRate | null;
};

/**
 * A full VAT invoice (Notice 700/21, 4.1), whole or none. The supplier's 9-digit VAT registration number is empty
 * until the owner registers, so until then no UK sale can be invoiced.
 */
export function ukInvoice(input: {
  number: string;
  suppliedAt: number;
  issuedAt: number;
  supplier: { name: string; address: string; vatNumber: string };
  customer: { name: string; address: string };
  description: string;
  currency: string;
  vat: UkVat;
  sterling?: UkSterlingRate | null;
}): UkInvoice | null {
  if (!input || typeof input !== "object") return null;
  if (!text(input.number, 64) || !/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(input.number)) return null;
  const suppliedOn = dayOf(input.suppliedAt);
  const issuedOn = dayOf(input.issuedAt);
  if (!suppliedOn || !issuedOn || input.issuedAt < input.suppliedAt) return null;
  const s = input.supplier;
  if (!s || !text(s.name, 300) || !text(s.address, 600) || typeof s.vatNumber !== "string" || !/^\d{9}$/.test(s.vatNumber)) return null;
  const c = input.customer;
  if (!c || !text(c.name, 300) || !text(c.address, 600) || !text(input.description, 200)) return null;
  if (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency) || NOT_HUNDREDTHS.has(input.currency)) return null;
  const vat = input.vat;
  if (!vat || !whole(vat.priceCents) || vat.priceCents <= 0 || vat.basisPoints !== UK_VAT_RATE.basisPoints) return null;
  const expected = ukVatOnTop(vat.priceCents);
  if (!expected || expected.vatCents !== vat.vatCents || expected.totalCents !== vat.totalCents) return null;
  const sterling = vatInPence(vat.vatCents, input.currency, suppliedOn, input.sterling);
  if (!sterling) return null;
  return {
    number: input.number,
    timeOfSupply: suppliedOn,
    issuedOn: issuedOn === suppliedOn ? null : issuedOn,
    supplier: { name: s.name.trim(), address: s.address.trim(), vatNumber: s.vatNumber },
    customer: { name: c.name.trim(), address: c.address.trim() },
    description: input.description.trim(),
    quantity: 1,
    currency: input.currency,
    unitPriceCents: vat.priceCents,
    amountExVatCents: vat.priceCents,
    rateBasisPoints: vat.basisPoints,
    vatCents: vat.vatCents,
    totalCents: vat.totalCents,
    vatSterlingPence: sterling.pence,
    sterlingRate: sterling.rate,
  };
}

/** A refund's entry: in the sale's currency, which what is left is checked in, and in pence, which the return adds up. */
export type UkVatAdjustment = { date: string; exVatCents: number; vatCents: number; exVatPence: number; vatPence: number; reason: string };
export type UkVatRecord = {
  v: 1;
  sale: string;
  store: string;
  date: string;
  currency: string;
  exVatCents: number;
  vatCents: number;
  rateBasisPoints: number;
  /** The sale in sterling at the supply's rate (Notice 700, 7.6): what the return declares. */
  exVatPence: number;
  vatPence: number;
  sterlingRate: UkSterlingRate | null;
  location: { ip: string; billing: string; card?: string };
  invoice: string;
  adjustments: UkVatAdjustment[];
};

/** The record of one UK sale from its invoice and evidence, whole or none. */
export function ukVatRecord(sale: { sale: string; store: string; invoice: UkInvoice; place: UkPlace }): UkVatRecord | null {
  if (!sale || !text(sale.sale, 255) || !text(sale.store, 64) || !sale.invoice || sale.place?.kind !== "uk") return null;
  const inv = sale.invoice;
  const exVat = inv.currency === "GBP" ? { pence: inv.amountExVatCents } : inv.sterlingRate ? { pence: toPence(inv.amountExVatCents, inv.sterlingRate.perPound) } : null;
  if (!exVat || exVat.pence === null) return null;
  return {
    v: 1, sale: sale.sale, store: sale.store, date: inv.timeOfSupply, currency: inv.currency, exVatCents: inv.amountExVatCents, vatCents: inv.vatCents,
    rateBasisPoints: inv.rateBasisPoints, exVatPence: exVat.pence, vatPence: inv.vatSterlingPence, sterlingRate: inv.sterlingRate,
    location: { ...sale.place.evidence }, invoice: inv.number, adjustments: [],
  };
}

/**
 * A refund (a credit note) as its own entry, in pence at the sale's own rate so it reverses what was charged; never
 * more than what is left, never nothing. Null when refused; the record given is unchanged.
 */
export function ukVatAdjustment(record: UkVatRecord, change: { at: number; exVatCents: number; vatCents: number; reason: string }): UkVatRecord | null {
  const date = dayOf(change?.at);
  if (!record || !date || date < record.date || !whole(change.exVatCents) || !whole(change.vatCents) || !text(change.reason, 100)) return null;
  // A refund gives value back: VAT given back with nothing refunded is refused (Claude 7 on #4574).
  if (change.exVatCents >= 0 || change.vatCents > 0) return null;
  if (!Array.isArray(record.adjustments) || record.adjustments.some((a) => !whole(a?.exVatCents) || !whole(a?.vatCents))) return null;
  const sum = (field: "exVatCents" | "vatCents" | "exVatPence" | "vatPence") => record[field] + record.adjustments.reduce((n, a) => n + a[field], 0);
  const exLeft = sum("exVatCents") + change.exVatCents;
  const vatLeft = sum("vatCents") + change.vatCents;
  if (!whole(exLeft) || !whole(vatLeft) || exLeft < 0 || vatLeft < 0) return null;
  // What is left keeps the sale's own VAT proportion, within the one cent of its rounding. Checked on what is left, not
  // on each entry, so one-cent entries cannot pile up and declare a full-value supply with less VAT (Claude 7 on #4574).
  const expectedLeft = record.exVatCents > 0 ? Number((BigInt(2) * BigInt(exLeft) * BigInt(record.vatCents) + BigInt(record.exVatCents)) / (BigInt(2) * BigInt(record.exVatCents))) : 0;
  if (!whole(expectedLeft) || Math.abs(vatLeft - expectedLeft) > 1) return null;
  // Nothing left to tax leaves no VAT behind.
  if (exLeft === 0 && vatLeft !== 0) return null;
  const convert = (cents: number) => (record.currency === "GBP" ? cents : record.sterlingRate ? toPence(cents, record.sterlingRate.perPound) : null);
  // An entry that takes what is left to nothing takes what is left in pence too, not a fresh conversion, whose rounding
  // could pass below zero and refuse a full refund made in parts (Claude 7 on #4574, LEVE 2).
  const exVatPence = exLeft === 0 ? -sum("exVatPence") : convert(change.exVatCents);
  const vatPence = vatLeft === 0 ? -sum("vatPence") : convert(change.vatCents);
  if (exVatPence === null || vatPence === null || !whole(exVatPence) || !whole(vatPence)) return null;
  if (sum("exVatPence") + exVatPence < 0 || sum("vatPence") + vatPence < 0) return null;
  return { ...record, adjustments: [...record.adjustments, { date, exVatCents: change.exVatCents, vatCents: change.vatCents, exVatPence, vatPence, reason: change.reason }] };
}

export type UkReturn = { start: string; end: string; deadline: string; nil: boolean; box1Pence: number; box6Pence: number; sales: number };

/**
 * One calendar month and 7 days after the end of the period (Sending a VAT Return): HMRC's periods end on the last day
 * of a month, so it is the 7th day after the last day of the following month (30 June gives 7 August).
 */
function deadlineOf(end: string): string {
  const [y, m] = end.split("-").map(Number);
  return new Date(Date.UTC(y, m + 1, 0) + 7 * 86_400_000).toISOString().slice(0, 10);
}
const monthEnd = (day: string) => {
  const [y, m] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) === day;
};

/**
 * The sales side of the VAT Return of the period HMRC set (start and end, inclusive), built after it ended: box 1,
 * the VAT on the period's UK supplies, refunds dated in it netted in, and their value without VAT (part of box 6).
 * The owner's own purchases (box 4) and any other outputs are not Marktmorgen's records and are not filled here.
 */
export function ukReturn(records: readonly UkVatRecord[], input: { start: string; end: string; filedOn: string }): UkReturn | null {
  if (!input || typeof input !== "object") return null;
  if (!Array.isArray(records) || !realDay(input.start) || !realDay(input.end) || !realDay(input.filedOn) || input.start > input.end || input.filedOn <= input.end) return null;
  if (!monthEnd(input.end) || input.start.slice(8) !== "01") return null;
  let box1 = 0;
  let box6 = 0;
  let sales = 0;
  const inside = (day: string) => day >= input.start && day <= input.end;
  for (const r of records) {
    if (!r || !realDay(r.date) || !whole(r.vatPence) || !whole(r.exVatPence) || !Array.isArray(r.adjustments)) return null;
    if (inside(r.date)) {
      box1 += r.vatPence;
      box6 += r.exVatPence;
      sales += 1;
    }
    for (const a of r.adjustments) {
      if (!a || !realDay(a.date) || !whole(a.vatPence) || !whole(a.exVatPence)) return null;
      if (inside(a.date)) {
        box1 += a.vatPence;
        box6 += a.exVatPence;
      }
    }
  }
  if (!whole(box1) || !whole(box6)) return null;
  return { start: input.start, end: input.end, deadline: deadlineOf(input.end), nil: sales === 0 && box1 === 0 && box6 === 0, box1Pence: box1, box6Pence: box6, sales };
}

const pounds = (pence: number) => `${pence < 0 ? "-" : ""}${Math.floor(Math.abs(pence) / 100)}.${String(Math.abs(pence) % 100).padStart(2, "0")}`;

/** The figures as a CSV the owner copies into the return; null until the 9-digit VAT registration number is configured. */
export function ukReturnCsv(ret: UkReturn, vatNumber: string): string | null {
  if (!ret || typeof vatNumber !== "string" || !/^\d{9}$/.test(vatNumber)) return null;
  const rows = [
    ["box", "item", "amount_gbp"],
    ["", `VAT registration number ${vatNumber}, period ${ret.start} to ${ret.end}, due ${ret.deadline}`, ""],
    ["1", "VAT due on sales (Marktmorgen's UK digital supplies)", pounds(ret.box1Pence)],
    // NOT CHECKED: whether box 6 must be given in whole pounds; the value is kept to the penny for the owner.
    ["6", "Value of those supplies excluding VAT (add every other output of the business)", pounds(ret.box6Pence)],
    ["4", "VAT reclaimed on purchases: from the owner's own purchase records, not filled here", ""],
  ];
  return rows.map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(",")).join("\n") + "\n";
}
