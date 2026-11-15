/**
 * EU and UK VAT, unit 4 (IVA, 14/11/2026): the two switches that decide whether Marktmorgen collects VAT as the deemed
 * supplier, one per jurisdiction, and the registrations they need. Coordinator, 14/11/2026 20h50 Fortaleza: the LLC
 * is not formed yet, so there is no EIN, no bank account and no VAT registration; build everything ready and off,
 * "O número de cadastro fica como campo vazio, a ser preenchido pelo dono depois, e as travas continuam false".
 *
 * A switch is on only when all three of its own hold together:
 *   1. its reviewed constant (EU_VAT_COLLECT_REVIEWED, UK_VAT_COLLECT_REVIEWED) is true, set by a reviewer once the
 *      whole treatment is checked;
 *   2. its registration is configured: for the EU the non-Union OSS number the Member State of identification gives
 *      (format EUxxxyyyyyz, xxx its ISO numeric code: only Ireland, 372, is accepted for now, the owner's choice), for
 *      the UK the 9-digit VAT registration number HMRC gives; the seller's legal name and address that every invoice
 *      prints; and the day the registration took effect, not after today;
 *   3. the owner's commercial review names that very registration, dated, not after today.
 * The switches are separate: neither reads the other's registration or review. Nothing here opens sales:
 * PLANS_ON_SALE, OPENING_REQUESTED, DEEMED_SUPPLIER_RECORDS, the tax gate, art. 9a's records, the commercial review in
 * lib/commercial-margin.ts and stripePlatformEligibilityReady keep every store closed by themselves. Imports nothing,
 * so the checkouts import it without a cycle.
 */

/** Collecting EU VAT (and the art. 196 reverse charge): false until a reviewer checks the whole EU treatment. */
export const EU_VAT_COLLECT_REVIEWED = false;
/** Collecting UK VAT: false until a reviewer checks the whole UK treatment. */
export const UK_VAT_COLLECT_REVIEWED = false;

/** The seller every invoice names: the LLC's exact legal name and its address. Empty until the LLC exists. */
export const VAT_SELLER: { legalName: string; address: string } = { legalName: "", address: "" };

/** The non-Union OSS registration: Member State of identification, EUxxxyyyyyz and the day it took effect. Empty. */
export const EU_OSS_REGISTRATION: { memberState: string; vatNumber: string; effectiveFrom: string } = { memberState: "", vatNumber: "", effectiveFrom: "" };

/** The UK VAT registration: the 9-digit number and the effective date of registration HMRC gives. Empty. */
export const UK_VAT_REGISTRATION: { vatNumber: string; effectiveFrom: string } = { vatNumber: "", effectiveFrom: "" };

export type VatCommercialReview = { jurisdiction: "EU" | "UK"; registration: string; reviewedOn: string; reviewer: "owner" };
/** The owner's commercial reviews, one per jurisdiction, each naming the registration it reviewed. None yet. */
export const VAT_COMMERCIAL_REVIEWS: readonly VatCommercialReview[] = [];

/** The Member States accepted as the OSS Member State of identification, with their ISO 3166-1 numeric code. */
export const OSS_IDENTIFICATION_CODES: Readonly<Record<string, string>> = { IE: "372" };

type SwitchInput = {
  reviewed?: boolean;
  seller?: { legalName: string; address: string };
  eu?: { memberState: string; vatNumber: string; effectiveFrom: string };
  uk?: { vatNumber: string; effectiveFrom: string };
  reviews?: readonly unknown[];
  now?: Date;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (value: unknown): value is string => {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
};
const said = (value: unknown, most: number) => typeof value === "string" && value.trim().length > 0 && value.length <= most;
const validClock = (now: unknown): now is Date => now instanceof Date && Number.isFinite(now.getTime());
/** A real day not after `now`; a clock that is not a moment confirms nothing. */
const notAfter = (day: unknown, now: Date): boolean => validClock(now) && realDay(day) && day <= now.toISOString().slice(0, 10);

/** The EU registration's number when it is complete and in effect on `now`; else null. */
export function euOssNumber(eu: SwitchInput["eu"] = EU_OSS_REGISTRATION, now = new Date()): string | null {
  if (!eu || typeof eu !== "object") return null;
  const numeric = typeof eu.memberState === "string" ? OSS_IDENTIFICATION_CODES[eu.memberState] : undefined;
  if (!numeric || typeof eu.vatNumber !== "string" || !/^EU\d{9}$/.test(eu.vatNumber) || eu.vatNumber.slice(2, 5) !== numeric) return null;
  return notAfter(eu.effectiveFrom, now) ? eu.vatNumber : null;
}

/** The UK registration's number when it is complete and in effect on `now`; else null. */
export function ukVatNumber(uk: SwitchInput["uk"] = UK_VAT_REGISTRATION, now = new Date()): string | null {
  if (!uk || typeof uk !== "object" || typeof uk.vatNumber !== "string" || !/^\d{9}$/.test(uk.vatNumber)) return null;
  return notAfter(uk.effectiveFrom, now) ? uk.vatNumber : null;
}

function reviewed(reviews: readonly unknown[], jurisdiction: "EU" | "UK", registration: string | null, now: Date): boolean {
  if (registration === null || !Array.isArray(reviews)) return false;
  const found = reviews.filter((r) => !!r && typeof r === "object" && (r as VatCommercialReview).jurisdiction === jurisdiction);
  if (found.length !== 1) return false;
  const review = found[0] as VatCommercialReview;
  return review.reviewer === "owner" && review.registration === registration && notAfter(review.reviewedOn, now);
}

/** What keeps a jurisdiction's switch off; empty means it is on. */
export function vatSwitchProblems(jurisdiction: "EU" | "UK", input: SwitchInput = {}): string[] {
  const now = input.now ?? new Date();
  const out: string[] = [];
  const constant = jurisdiction === "EU" ? "EU_VAT_COLLECT_REVIEWED" : "UK_VAT_COLLECT_REVIEWED";
  const flag = input.reviewed ?? (jurisdiction === "EU" ? EU_VAT_COLLECT_REVIEWED : UK_VAT_COLLECT_REVIEWED);
  if (flag !== true) out.push(`${jurisdiction}: ${constant} is false`);
  const seller = input.seller ?? VAT_SELLER;
  if (!seller || !said(seller.legalName, 300) || !said(seller.address, 600)) out.push(`${jurisdiction}: the seller's legal name and address are not configured`);
  const number = jurisdiction === "EU" ? euOssNumber(input.eu ?? EU_OSS_REGISTRATION, now) : ukVatNumber(input.uk ?? UK_VAT_REGISTRATION, now);
  if (number === null) {
    out.push(jurisdiction === "EU"
      ? "EU: the non-Union OSS registration (Ireland, EUxxxyyyyyz) is not configured"
      : "UK: the 9-digit UK VAT registration number is not configured");
  }
  if (!reviewed(input.reviews ?? VAT_COMMERCIAL_REVIEWS, jurisdiction, number, now)) out.push(`${jurisdiction}: the owner's commercial review of this registration is missing`);
  return out;
}

/** Whether EU VAT may be collected now: EU_VAT_COLLECT_REVIEWED, the OSS registration and the owner's review together. */
export const euVatCollectOn = (input: SwitchInput = {}): boolean => vatSwitchProblems("EU", input).length === 0;
/** Whether UK VAT may be collected now: UK_VAT_COLLECT_REVIEWED, the UK registration and the owner's review together. */
export const ukVatCollectOn = (input: SwitchInput = {}): boolean => vatSwitchProblems("UK", input).length === 0;
