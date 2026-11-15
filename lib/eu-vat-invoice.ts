/**
 * EU VAT under art. 9a, unit 1 (IVA, 14/11/2026): the invoice of an EU sale Marktmorgen supplies as the deemed supplier,
 * collected under the non-Union OSS scheme or reverse-charged to a business. Pure: builds and checks the fields, stores
 * and sends nothing; nothing calls it yet (the checkout wiring is a later unit, behind EU_VAT_COLLECT_REVIEWED).
 *
 * Sources, read on 14/11/2026 at legislation.gov.uk/eudr/2006/112 (the EU text of Directive 2006/112/EC as at
 * 31/12/2020; EUR-Lex refuses automated reading, so later EU amendments are not seen there and stay to be checked):
 *   - art. 219a(2)(b): a supplier "making use of one of the special schemes" invoices under "the rules applying in the
 *     Member State where [it] is identified" (the non-Union OSS Member State of identification); art. 219a(1) and
 *     (2)(a)(i): otherwise the rules of the Member State of supply, or of establishment when the customer is liable.
 *     Whatever rules apply, this invoice carries every detail art. 226 lists, so none is missing under any of them.
 *   - art. 226: (1) the date of issue; (2) a sequential number that uniquely identifies the invoice; (3) the supplier's
 *     VAT identification number; (4) the customer's VAT identification number where the customer is liable; (5) the
 *     full name and address of the supplier and the customer; (6) the nature and extent of the service; (7) the date of
 *     the supply where it differs from the date of issue; (8) the taxable amount per rate and the unit price exclusive of
 *     VAT; (9) the VAT rate; (10) the VAT amount payable; (11a) "where the customer is liable for the payment of the
 *     VAT, the mention 'Reverse charge'".
 *   - art. 230: amounts "may be expressed in any currency, provided that the amount of VAT payable [...] is expressed
 *     in the national currency of the Member State, using the conversion rate mechanism provided for in Article 91";
 *     art. 91(2): Member States "shall accept [...] the latest exchange rate published by the European Central Bank at
 *     the time the tax becomes chargeable".
 *
 * Whole or none: a missing or broken detail gives null, never an invoice with a blank. Under the OSS the supplier's
 * number is the EUxxxyyyyyz the Member State of identification gives (OSS guide, annex 2, note 1, read 13/11/2026):
 * until the owner's registration is configured it is empty, so no collected sale can be invoiced and none is made.
 * Only Ireland, whose national currency is the euro, is accepted as the Member State of identification for now (the
 * owner's choice, 14/11/2026); another needs its currency sourced first. Amounts are integer minor units; currencies
 * whose minor unit is not a hundredth are refused until they are modelled.
 */
import type { VatOnTop } from "@/lib/eu-vat-amount";
import { EU_VAT_COUNTRIES } from "@/lib/eu-vat-supply";
import { splitVatNumber } from "@/lib/eu-vat-vies";

/** The mention art. 226(11a) requires when the customer is liable for the VAT. */
export const REVERSE_CHARGE_MENTION = "Reverse charge";

/** The ECB's reference rates, the source of an art. 91(2) conversion. */
export const ECB_REFERENCE_RATES = "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html";

/** The oldest an ECB rate may be, in days before the sale's day, to count as the latest published one. */
export const ECB_RATE_MOST_DAYS_OLD = 7;

/** Member States accepted as the OSS Member State of identification, with their ISO 3166-1 numeric code and currency. */
const IDENTIFICATION: Record<string, { numeric: string; currency: string }> = { IE: { numeric: "372", currency: "EUR" } };

/** Currencies whose minor unit is not a hundredth (Stripe's zero- and three-decimal lists): refused here for now. */
const NOT_HUNDREDTHS = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
  "BHD", "JOD", "KWD", "OMR", "TND",
]);

export type EuInvoiceParty = { name: string; address: string; country: string };

export type EuInvoiceInput = {
  kind: "collect" | "reverse-charge";
  /** The invoice's own number, from one sequence that never repeats (art. 226(2)). */
  number: string;
  /** Seconds since the epoch. */
  issuedAt: number;
  suppliedAt: number;
  seller: EuInvoiceParty & {
    /** For "collect": the OSS Member State of identification and the EUxxxyyyyyz number it gave; empty until registered. */
    oss: { memberState: string; vatNumber: string };
  };
  customer: EuInvoiceParty & { vatNumber?: string | null };
  service: string;
  currency: string;
  /** The price before VAT, the unit price exclusive of VAT (one unit). */
  taxableCents: number;
  /** For "collect": the VAT added on top (lib/eu-vat-amount.ts). */
  vat?: VatOnTop | null;
  /**
   * For "collect" in a currency other than the euro: the ECB's publications of that currency (units per euro, by
   * day). The code takes the latest one published before the sale's day; the caller never picks the rate.
   */
  ecb?: readonly { perEuro: string; day: string }[] | null;
};

export type EuInvoice = {
  kind: "collect" | "reverse-charge";
  number: string;
  issuedOn: string;
  suppliedOn: string | null;
  seller: EuInvoiceParty & { vatNumber: string | null };
  customer: EuInvoiceParty & { vatNumber: string | null };
  service: string;
  quantity: 1;
  currency: string;
  unitPriceCents: number;
  taxableCents: number;
  rateBasisPoints: number | null;
  vatCents: number;
  totalCents: number;
  /** The VAT in the identification Member State's currency (art. 230), with the rate used; null when no VAT is payable. */
  vatNational: { currency: string; cents: number; perEuro: string | null; day: string | null; source: string | null } | null;
  mentions: string[];
};

const text = (value: unknown, most: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= most && !/[\u0000-\u001f\u007f]/.test(value.replace(/\n/g, " "));
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const dayOf = (seconds: unknown): string | null =>
  whole(seconds) && seconds > 0 && seconds <= 8_640_000_000_000 ? new Date(seconds * 1000).toISOString().slice(0, 10) : null;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (value: unknown): value is string => {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
};
/** An ECB reference rate as it is published: a positive decimal with at most six decimals. */
const RATE = /^(0|[1-9]\d{0,6})(\.\d{1,6})?$/;

function party(value: unknown): EuInvoiceParty | null {
  if (!value || typeof value !== "object") return null;
  const p = value as EuInvoiceParty;
  if (!text(p.name, 300) || !text(p.address, 600) || typeof p.country !== "string" || !/^[A-Z]{2}$/.test(p.country)) return null;
  return { name: p.name.trim(), address: p.address.trim(), country: p.country };
}

/**
 * A sale's VAT converted to euro cents at an ECB rate given as "currency per euro" (1 EUR = perEuro units), rounded
 * half up once, in integer arithmetic; null when the rate is not a published-looking positive decimal.
 */
export function toEuroCents(cents: number, perEuro: string): number | null {
  if (!whole(cents) || cents < 0 || typeof perEuro !== "string" || !RATE.test(perEuro)) return null;
  const [units, decimals = ""] = perEuro.split(".");
  const scale = BigInt(1_000_000);
  const micro = BigInt(units) * scale + BigInt((decimals + "000000").slice(0, 6));
  if (micro <= BigInt(0)) return null;
  // cents / (micro / 10^6), half up: floor((2 * cents * 10^6 + micro) / (2 * micro)).
  const two = BigInt(2);
  const result = (two * BigInt(cents) * scale + micro) / (two * micro);
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}

/**
 * The ECB rate art. 91(2) asks for: the latest published before the sale's day. The sale's own day is never used,
 * because the ECB publishes around 16:00 CET and the code cannot know a sale came after it. Never older than
 * ECB_RATE_MOST_DAYS_OLD days (working days only, so a long weekend with a holiday still has one inside it). Null
 * when none is there, a publication does not read, or a day is given twice with different rates.
 */
function latestBefore(publications: EuInvoiceInput["ecb"], suppliedOn: string): { perEuro: string; day: string } | null {
  if (!Array.isArray(publications)) return null;
  const byDay = new Map<string, string>();
  for (const p of publications) {
    if (!p || !realDay(p.day) || typeof p.perEuro !== "string" || !RATE.test(p.perEuro)) return null;
    if (byDay.has(p.day) && byDay.get(p.day) !== p.perEuro) return null;
    byDay.set(p.day, p.perEuro);
  }
  const before = [...byDay.keys()].filter((day) => day < suppliedOn).sort();
  const day = before[before.length - 1];
  if (!day) return null;
  if ((Date.parse(`${suppliedOn}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000 > ECB_RATE_MOST_DAYS_OLD) return null;
  return { perEuro: byDay.get(day)!, day };
}

/** The invoice of one EU sale, or null when any detail art. 226 asks is missing or the parts disagree. */
export function euInvoice(input: EuInvoiceInput): EuInvoice | null {
  if (!input || typeof input !== "object") return null;
  if (input.kind !== "collect" && input.kind !== "reverse-charge") return null;
  if (!text(input.number, 64) || !/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(input.number)) return null;
  const issuedOn = dayOf(input.issuedAt);
  const suppliedOn = dayOf(input.suppliedAt);
  if (!issuedOn || !suppliedOn || input.suppliedAt > input.issuedAt) return null;
  if (!text(input.service, 200)) return null;
  if (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency) || NOT_HUNDREDTHS.has(input.currency)) return null;
  if (!whole(input.taxableCents) || input.taxableCents <= 0) return null;
  const seller = party(input.seller);
  const customer = party(input.customer);
  if (!seller || !customer || !EU_VAT_COUNTRIES.has(customer.country)) return null;
  const base = {
    number: input.number,
    issuedOn,
    // Art. 226(7): the supply date only where it differs from the date of issue.
    suppliedOn: suppliedOn === issuedOn ? null : suppliedOn,
    service: input.service.trim(),
    quantity: 1 as const,
    currency: input.currency,
    unitPriceCents: input.taxableCents,
    taxableCents: input.taxableCents,
  };
  if (input.kind === "reverse-charge") {
    const typed = splitVatNumber(input.customer.vatNumber);
    if (!typed || typed.country !== customer.country || input.vat) return null;
    const prefix = typed.country === "GR" ? "EL" : typed.country;
    return {
      ...base,
      kind: "reverse-charge",
      // The LLC holds no VAT number for business supplies: its OSS number "can only be used to declare supplies falling
      // under the non-Union scheme" (Register to OSS, read 13/11/2026), so none is printed.
      seller: { ...seller, vatNumber: null },
      customer: { ...customer, vatNumber: `${prefix}${typed.number}` },
      rateBasisPoints: null,
      vatCents: 0,
      totalCents: input.taxableCents,
      vatNational: null,
      mentions: [REVERSE_CHARGE_MENTION],
    };
  }
  const vat = input.vat;
  if (!vat || vat.country !== customer.country || vat.priceCents !== input.taxableCents || !whole(vat.vatCents) || vat.vatCents < 0) return null;
  if (!whole(vat.basisPoints) || vat.basisPoints <= 0 || vat.totalCents !== vat.priceCents + vat.vatCents) return null;
  // The VAT is the rate's on the taxable amount, half up once (lib/eu-vat-amount.ts): any other figure is refused.
  const product = vat.priceCents * vat.basisPoints;
  if (!whole(product) || vat.vatCents !== Math.floor((product + 5000) / 10000)) return null;
  const oss = input.seller?.oss;
  const identification = oss && typeof oss.memberState === "string" ? IDENTIFICATION[oss.memberState] : undefined;
  if (!identification || typeof oss.vatNumber !== "string") return null;
  // EUxxxyyyyyz: xxx the identification Member State's ISO numeric code, yyyyy its number, z a check digit.
  if (!/^EU\d{9}$/.test(oss.vatNumber) || oss.vatNumber.slice(2, 5) !== identification.numeric) return null;
  let vatNational: EuInvoice["vatNational"];
  if (input.currency === identification.currency) {
    vatNational = { currency: identification.currency, cents: vat.vatCents, perEuro: null, day: null, source: null };
  } else {
    const ecb = latestBefore(input.ecb, suppliedOn);
    if (!ecb) return null;
    const cents = toEuroCents(vat.vatCents, ecb.perEuro);
    if (cents === null) return null;
    vatNational = { currency: identification.currency, cents, perEuro: ecb.perEuro, day: ecb.day, source: ECB_REFERENCE_RATES };
  }
  return {
    ...base,
    kind: "collect",
    seller: { ...seller, vatNumber: oss.vatNumber },
    customer: { ...customer, vatNumber: null },
    rateBasisPoints: vat.basisPoints,
    vatCents: vat.vatCents,
    totalCents: vat.totalCents,
    vatNational,
    mentions: [],
  };
}
