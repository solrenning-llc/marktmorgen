/**
 * Where a tax law makes Marktmorgen the supplier, or the collector, of what a
 * creator sells through a store, and whether that has been built and
 * recorded (docs/eu-vat-article-9a.md; docs/tax-uncertainty.md questions 20
 * and 23 to 27).
 *
 * Marktmorgen's terms make the creator the seller, and every sale is a
 * direct charge on the creator's own Stripe account. For EU VAT that does not
 * decide it: Council Implementing Regulation (EU) No 282/2011 art. 9a
 * presumes that a platform taking part in a supply of electronically supplied
 * services acts in its own name, and the presumption cannot be rebutted by
 * one that authorises the charge, authorises the delivery or sets the general
 * terms and conditions. The owner's TX decision (27 October 2026) retires
 * rule 19: do not infer identical liability for the UK, every US state or
 * every other country. Each product, jurisdiction and actual platform role
 * needs its own applicable source and implemented treatment. See the dated
 * source matrix in docs/tx-legal-source-review-2026-10-27.md.
 *
 * None of the treatment is built. Until each jurisdiction has a record below
 * (VAT or sales tax collected on top or from the creator's payout, never from
 * Marktmorgen's commission, with its registration; or that jurisdiction's
 * consumers refused at checkout), deemedSupplierReady() is false and
 * lib/opening.ts keeps every plan, and so every store's checkout, closed.
 *
 * Imports nothing, so a page drawn in the browser can read it.
 */

export const DEEMED_SUPPLIER_JURISDICTIONS = ["EU", "UK", "US", "other"] as const;
export type DeemedSupplierJurisdiction = (typeof DEEMED_SUPPLIER_JURISDICTIONS)[number];

/** The rule each jurisdiction's record answers, and the question of docs/tax-uncertainty.md it closes. */
export const DEEMED_SUPPLIER_RULES: Record<DeemedSupplierJurisdiction, { rule: string; questions: readonly number[] }> = {
  EU: {
    rule:
      "EU VAT, Council Implementing Regulation (EU) No 282/2011 art. 9a: Marktmorgen is presumed to supply what a store sells electronically to an EU consumer; VAT on top at checkout or from the creator's payout, two non-contradictory pieces of location evidence (arts. 24b, 24f), non-Union OSS registration from the first sale and the art. 63c records kept 10 years are not built and recorded (docs/eu-vat-article-9a.md); and physical goods under the Directive's art. 14a",
    questions: [20, 27],
  },
  UK: {
    rule:
      "UK VAT: art. 9a in the UK's text of Regulation 282/2011 and the online marketplace rules for goods; UK registration from the first sale to a UK consumer is not built and recorded (docs/eu-vat-article-9a.md, United Kingdom)",
    questions: [26],
  },
  US: {
    rule:
      "US states' marketplace facilitator laws on the creators' sales: product classification, platform role, nexus and applicable thresholds must be reviewed state by state; unverified treatment remains unbuilt, not liability presumed everywhere (docs/tx-legal-source-review-2026-10-27.md; question 23)",
    questions: [23],
  },
  other: {
    rule:
      "Other countries' platform rules: Canada, Norway and Switzerland have partially reviewed official sources with different scopes and thresholds; no complete country-by-country treatment, counters or registrations are built and recorded. Do not generalize one country's rule to all digital, human or physical supplies (docs/tx-legal-source-review-2026-10-27.md; question 24)",
    questions: [24],
  },
};

export type DeemedSupplierRecord = {
  jurisdiction: DeemedSupplierJurisdiction;
  /** "collect": the tax is charged on top of the buyer's price or taken from the creator's payout, never from the commission. "refuse-consumers": that jurisdiction's consumers cannot buy. */
  treatment: "collect" | "refuse-consumers";
  /** The files that implement it. */
  implementedIn: string;
  /** The day it was recorded, YYYY-MM-DD. */
  recordedOn: string;
  /** For "collect": where the LLC is registered, the date and its number (for the EU, the non-Union OSS Member State of identification). */
  registration: string;
  /** How it was tested, and where that can be read. */
  evidence: string;
};

/** Nothing is built or recorded yet (18 October 2026). */
export const DEEMED_SUPPLIER_RECORDS: readonly DeemedSupplierRecord[] = [];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
function calendarDay(value: unknown): boolean {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const said = (value: unknown) => typeof value === "string" && value.trim().length > 0;

/** A review is data, never inherited defaults or executable property reads.
 * Detach every field once before filtering or validating the same snapshot. */
function ownTreatmentRecords(value: unknown): DeemedSupplierRecord[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    // At most one record per known jurisdiction can ever form a valid review.
    // Reject larger arrays before enumerating keys or inspecting members.
    if (!Number.isSafeInteger(length) || length < 0 || length > DEEMED_SUPPLIER_JURISDICTIONS.length) return null;
    if (Reflect.ownKeys(value).length !== length + 1) return null;
    const keys = ["jurisdiction", "treatment", "implementedIn", "recordedOn", "registration", "evidence"] as const;
    const records: DeemedSupplierRecord[] = [];
    for (let index = 0; index < length; index += 1) {
      const entry = Object.getOwnPropertyDescriptor(value, String(index));
      if (!entry || !Object.hasOwn(entry, "value")) return null;
      const record: unknown = entry.value;
      if (!record || typeof record !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(record))
        || Reflect.ownKeys(record).length !== keys.length) return null;
      const fields = Object.getOwnPropertyDescriptors(record);
      const data: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        // Descriptor maps have Object.prototype too: a missing field must never
        // resolve to inherited data or execute an inherited getter.
        if (!Object.hasOwn(fields, key)) return null;
        const field = fields[key];
        if (!field || !Object.hasOwn(field, "value")) return null;
        data[key] = field.value;
      }
      if (!(DEEMED_SUPPLIER_JURISDICTIONS as readonly unknown[]).includes(data.jurisdiction)) return null;
      records.push(data as unknown as DeemedSupplierRecord);
    }
    return records;
  } catch {
    return null;
  }
}

/** Every reason sales must stay closed under the deemed-supplier rules: empty only when each jurisdiction has a complete record. */
export function deemedSupplierProblems(value: unknown = DEEMED_SUPPLIER_RECORDS): string[] {
  const records = ownTreatmentRecords(value);
  if (!records) return ["tax-treatment records: complete own data required"];
  const out: string[] = [];
  for (const jurisdiction of DEEMED_SUPPLIER_JURISDICTIONS) {
    const found = records.filter((record) => record?.jurisdiction === jurisdiction);
    if (found.length !== 1) {
      out.push(found.length === 0 ? `${jurisdiction}: not recorded. ${DEEMED_SUPPLIER_RULES[jurisdiction].rule}` : `${jurisdiction}: recorded more than once`);
      continue;
    }
    const record = found[0];
    if (record.treatment !== "collect" && record.treatment !== "refuse-consumers") out.push(`${jurisdiction}: treatment`);
    if (!said(record.implementedIn)) out.push(`${jurisdiction}: implementedIn`);
    if (!said(record.evidence)) out.push(`${jurisdiction}: evidence`);
    if (!calendarDay(record.recordedOn)) out.push(`${jurisdiction}: recordedOn`);
    if (record.treatment === "collect" && !said(record.registration)) out.push(`${jurisdiction}: a tax collected needs its registration`);
  }
  return out;
}

/** Whether every jurisdiction's treatment is built and recorded. Not permission to sell by itself. */
export function deemedSupplierReady(records: unknown = DEEMED_SUPPLIER_RECORDS): boolean {
  return deemedSupplierProblems(records).length === 0;
}
