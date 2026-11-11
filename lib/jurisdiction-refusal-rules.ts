/**
 * Whether a checkout may sell to a buyer at all, from where the buyer is.
 *
 * AV1 step 5 (docs/codex-queue.md): until a jurisdiction's tax treatment is
 * built, its deemed-supplier record may say "refuse-consumers": that
 * jurisdiction's consumers cannot buy (lib/deemed-supplier.ts). This is the
 * pure rule a checkout calls BEFORE it asks Stripe for anything, so a refused
 * buyer is never charged. It is not wired into any checkout yet, and it
 * records nothing: DEEMED_SUPPLIER_RECORDS stays as it is, and so does
 * PLANS_ON_SALE.
 *
 * It fails closed, everywhere:
 *   - without one complete, valid record per jurisdiction, nobody can buy;
 *   - location needs MIN_LOCATION_EVIDENCE pieces (the visitor's IP country
 *     and the billing country the buyer gives, as planned in
 *     docs/eu-vat-article-9a.md, "The code that would be needed", step 1),
 *     each an ISO 3166-1 alpha-2 country code; anything else is unknown and
 *     refused, never guessed;
 *   - every piece counts: if any piece points to a jurisdiction that refuses,
 *     the sale is refused, whatever the other pieces say;
 *   - "refuse-consumers" refuses every product: the record type says that
 *     jurisdiction's consumers cannot buy, and no official text read in this
 *     repository narrows it per product. Every buyer is taken as a consumer:
 *     no business number is verified yet (VIES is a later unit);
 *   - a territory whose VAT or sales-tax status was not read in an official
 *     text in this repository (Monaco, Åland, the French overseas
 *     departments, the Crown Dependencies, US territories and the like)
 *     counts for every jurisdiction it may belong to, so it is refused if
 *     any of them refuses. Collecting a tax there needs its own reading
 *     first; this list never decides where a tax is due.
 *
 * Imports only lib/deemed-supplier.ts, which imports nothing, so a page drawn
 * in the browser can read it.
 */
import { DEEMED_SUPPLIER_JURISDICTIONS, DEEMED_SUPPLIER_RECORDS, deemedSupplierProblems, type DeemedSupplierJurisdiction, type DeemedSupplierRecord } from "@/lib/deemed-supplier";

/** The 27 member states of the European Union, by ISO 3166-1 alpha-2 code (Greece is GR; EL is only its VAT prefix). */
export const EU_MEMBER_STATES = Object.freeze([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
] as const);

/** Location pieces needed before a sale: two, and every one is read. */
export const MIN_LOCATION_EVIDENCE = 2;

/** Territories that may belong to more than one jurisdiction for tax, each with all of them. */
const MAY_BELONG: Readonly<Record<string, readonly DeemedSupplierJurisdiction[]>> = Object.freeze({
  // Tied to an EU member state or inside its borders, with a special status not read here.
  MC: ["EU", "other"], SM: ["EU", "other"], VA: ["EU", "other"], AD: ["EU", "other"],
  AX: ["EU", "other"], GP: ["EU", "other"], MQ: ["EU", "other"], GF: ["EU", "other"],
  RE: ["EU", "other"], YT: ["EU", "other"], MF: ["EU", "other"], BL: ["EU", "other"],
  PM: ["EU", "other"], NC: ["EU", "other"], PF: ["EU", "other"], WF: ["EU", "other"],
  TF: ["EU", "other"], GL: ["EU", "other"], FO: ["EU", "other"], CW: ["EU", "other"],
  AW: ["EU", "other"], SX: ["EU", "other"], BQ: ["EU", "other"],
  // ISO's exceptionally reserved codes for parts of member states.
  EA: ["EU", "other"], IC: ["EU", "other"], FX: ["EU", "other"], CP: ["EU", "other"],
  // Gibraltar: once in the EU through the UK, now neither on any text read here.
  GI: ["EU", "UK", "other"],
  // Crown Dependencies and British Overseas Territories.
  IM: ["UK", "other"], JE: ["UK", "other"], GG: ["UK", "other"], AI: ["UK", "other"],
  BM: ["UK", "other"], IO: ["UK", "other"], VG: ["UK", "other"], KY: ["UK", "other"],
  FK: ["UK", "other"], MS: ["UK", "other"], PN: ["UK", "other"], SH: ["UK", "other"],
  TC: ["UK", "other"], GS: ["UK", "other"], AC: ["UK", "other"], TA: ["UK", "other"],
  DG: ["UK", "other"],
  // US territories: not states, with sales-tax rules of their own not read here.
  PR: ["US", "other"], GU: ["US", "other"], VI: ["US", "other"], AS: ["US", "other"],
  MP: ["US", "other"], UM: ["US", "other"],
});
export const UNVERIFIED_TERRITORIES = Object.freeze(Object.keys(MAY_BELONG));

/** User-assigned and non-country codes: a header or a form that sends one says nothing about a country. */
function notACountry(code: string): boolean {
  if (code === "XK") return false; // Kosovo, as providers send it.
  return code === "AA" || code === "ZZ" || /^Q[M-Z]$/.test(code) || /^X[A-Z]$/.test(code) || code === "EZ" || code === "UN" || code === "SU";
}

/** Every jurisdiction a country code may belong to; null when it is not a country code at all. */
export function candidateJurisdictions(code: unknown): readonly DeemedSupplierJurisdiction[] | null {
  if (typeof code !== "string" || !/^[A-Z]{2}$/.test(code) || notACountry(code)) return null;
  if (code === "EU" || (EU_MEMBER_STATES as readonly string[]).includes(code)) return ["EU"];
  if (code === "GB" || code === "UK") return ["UK"];
  if (code === "US") return ["US"];
  return Object.hasOwn(MAY_BELONG, code) ? MAY_BELONG[code] : ["other"];
}

export type RefusalReason = "not-recorded" | "location-unknown" | "refused-jurisdiction";
export type CheckoutLocationDecision =
  | Readonly<{ allowed: true; jurisdictions: readonly DeemedSupplierJurisdiction[] }>
  | Readonly<{ allowed: false; reason: RefusalReason; jurisdictions: readonly DeemedSupplierJurisdiction[]; buyerMessage: string }>;

/** What the buyer reads, in plain US English, before anything is charged. */
export const REFUSAL_WORDS: Readonly<Record<RefusalReason, string>> = Object.freeze({
  "not-recorded": "Orders can't be taken here yet. Nothing was charged.",
  "location-unknown": "We couldn't confirm your country, so this order can't go ahead. Nothing was charged.",
  "refused-jurisdiction": "This store can't take orders from your country yet. Nothing was charged.",
});

/** Own data fields only, copied once, so a getter or an inherited default can never answer later. */
function detachedRecords(value: unknown): DeemedSupplierRecord[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 64) return null;
    const out: DeemedSupplierRecord[] = [];
    for (let i = 0; i < length; i++) {
      const item = Object.getOwnPropertyDescriptor(value, String(i));
      if (!item || !Object.hasOwn(item, "value")) return null;
      const row: unknown = item.value;
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      const copy: Record<string, unknown> = Object.create(null);
      for (const key of ["jurisdiction", "treatment", "implementedIn", "recordedOn", "registration", "evidence"]) {
        const field = Object.getOwnPropertyDescriptor(row, key);
        if (!field || !Object.hasOwn(field, "value")) return null;
        copy[key] = field.value;
      }
      out.push(copy as DeemedSupplierRecord);
    }
    return out;
  } catch {
    return null;
  }
}

const refuse = (reason: RefusalReason, jurisdictions: readonly DeemedSupplierJurisdiction[]): CheckoutLocationDecision =>
  Object.freeze({ allowed: false, reason, jurisdictions: Object.freeze([...jurisdictions]), buyerMessage: REFUSAL_WORDS[reason] });

/**
 * Sell or refuse, from the buyer's location pieces and the deemed-supplier
 * records (the real ones by default). Pure: reads nothing else, writes nothing.
 */
export function checkoutLocationDecision(countries: readonly (string | null | undefined)[], records: unknown = DEEMED_SUPPLIER_RECORDS): CheckoutLocationDecision {
  const own = detachedRecords(records);
  if (!own || deemedSupplierProblems(own).length > 0) return refuse("not-recorded", []);
  const treatment = new Map<DeemedSupplierJurisdiction, DeemedSupplierRecord["treatment"]>();
  for (const row of own) treatment.set(row.jurisdiction, row.treatment);
  if (DEEMED_SUPPLIER_JURISDICTIONS.some((j) => !treatment.has(j))) return refuse("not-recorded", []);

  if (!Array.isArray(countries) || countries.length < MIN_LOCATION_EVIDENCE) return refuse("location-unknown", []);
  const found: DeemedSupplierJurisdiction[] = [];
  for (const piece of countries) {
    const candidates = candidateJurisdictions(piece);
    if (candidates === null) return refuse("location-unknown", []);
    for (const j of candidates) if (!found.includes(j)) found.push(j);
  }
  if (found.some((j) => treatment.get(j) !== "collect")) return refuse("refused-jurisdiction", found);
  return Object.freeze({ allowed: true, jurisdictions: Object.freeze(found) });
}
