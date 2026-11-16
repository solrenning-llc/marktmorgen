/**
 * The legal information a creator fills on a physical product, as it is kept
 * on the product record and sent by the studio (618 [SZ2] unit 2;
 * docs/sz2-physical-legal-fields.md). The rules come from
 * lib/physical-legal.ts; this file adds the stored shape, the strict check of
 * a write (each problem named by its field, nothing cut or blanked), the
 * studio's words and the check that a save was confirmed.
 *
 * These are information fields: nothing here decides that a law applies to a
 * product or says that the product complies. Browser-safe and pure.
 */
import { SHIP_COUNTRIES } from "./shipping";
import { MAX_OPTIONS } from "./product-option";
import {
  type NetQuantity,
  type SafetyGap,
  type SafetyInfo,
  GPSR_AREA,
  MAX_ELECTRONIC,
  MAX_IDENTIFIER,
  MAX_NAME,
  MAX_POSTAL,
  MAX_PROP65,
  MAX_TYPE,
  MAX_WARNINGS,
  checkProp65,
  electronicAddress,
  readNetQuantity,
  readSafetyInfo,
  safetyGaps,
} from "./physical-legal";

/** A net quantity on one price of the product: "" is the product's own price, otherwise an option's id. */
export type PriceQuantity = NetQuantity & { price: string };

export type PhysicalLegal = {
  /** EU product safety (GPSR art. 19); null when nothing was filled. */
  safety: SafetyInfo | null;
  /** The creator's own Proposition 65 text; "" is none. */
  prop65: string;
  /** At most one per price. */
  quantities: PriceQuantity[];
};

/** One price for the product's own and one per option. */
export const MAX_QUANTITIES = MAX_OPTIONS + 1;
const MAX_PRICE_ID = 40;

export type LegalProblem = "shape" | "long" | "control" | "address" | "country" | "both" | "signal" | "site" | "amount" | "price";
export type LegalFieldProblem = { field: string; problem: LegalProblem };

/** The visible label of each field, as the studio prints it and as an error names it. */
export const LEGAL_LABELS: Record<string, string> = {
  "manufacturer.name": "Manufacturer name",
  "manufacturer.postal": "Manufacturer postal address",
  "manufacturer.electronic": "Manufacturer email or web page",
  "manufacturer.country": "Manufacturer country",
  "responsible.name": "EU responsible person name",
  "responsible.postal": "EU responsible person postal address",
  "responsible.electronic": "EU responsible person email or web page",
  "responsible.country": "EU responsible person country",
  productType: "Product type or model",
  identifier: "Batch or serial number",
  warnings: "Warnings and safety information",
  noWarnings: "This product has no warnings",
  prop65: "California Proposition 65 warning",
  quantity: "Net quantity",
  safety: "Product safety and manufacturer",
};

const MAX_OF: Record<string, number> = {
  "manufacturer.name": MAX_NAME,
  "manufacturer.postal": MAX_POSTAL,
  "manufacturer.electronic": MAX_ELECTRONIC,
  "responsible.name": MAX_NAME,
  "responsible.postal": MAX_POSTAL,
  "responsible.electronic": MAX_ELECTRONIC,
  productType: MAX_TYPE,
  identifier: MAX_IDENTIFIER,
  warnings: MAX_WARNINGS,
  prop65: MAX_PROP65,
};

/** The label for a field, a quantity's field ("quantity:<price>") read as "Net quantity". */
export function legalLabel(field: string): string {
  return LEGAL_LABELS[field.startsWith("quantity") ? "quantity" : field] ?? "This field";
}

/** One error, in plain words, naming its field (AX274, 3.3.1 and 3.3.3). */
export function legalProblemMessage({ field, problem }: LegalFieldProblem): string {
  const label = legalLabel(field);
  switch (problem) {
    case "long":
      return `${label}: use up to ${MAX_OF[field] ?? 0} characters.`;
    case "control":
      return `${label}: remove the hidden control characters (they often come with pasted text).`;
    case "address":
      return `${label}: type an email address, or a web page that starts with https://.`;
    case "country":
      return `${label}: pick a country from the list.`;
    case "both":
      return `${label}: write the warnings, or check “This product has no warnings”, not both.`;
    case "signal":
      return `${label}: start with WARNING:, CA WARNING: or CALIFORNIA WARNING:, as the warning you were given does.`;
    case "site":
      return `${label}: name the website www.P65Warnings.ca.gov, as the warning you were given does.`;
    case "amount":
      return `${label}: type a number greater than 0 with up to 3 decimals, like 250 or 1.5, and pick its unit.`;
    case "price":
      return `${label}: that price is no longer on this product. Reload the page and try again.`;
    case "shape":
      return `${label}: this could not be read. Reload the page and try again.`;
  }
}

/** What each gap asks for, as the studio's summary lists it. */
export const GAP_WORDS: Record<SafetyGap, string> = {
  "manufacturer-name": "the manufacturer's name",
  "manufacturer-postal": "the manufacturer's postal address",
  "manufacturer-electronic": "the manufacturer's email or web page",
  "manufacturer-country": "the manufacturer's country",
  responsible: "an EU responsible person (the manufacturer is outside the EU/EEA)",
  "responsible-name": "the EU responsible person's name",
  "responsible-postal": "the EU responsible person's postal address",
  "responsible-electronic": "the EU responsible person's email or web page",
  "responsible-country": "the EU responsible person's country",
  "responsible-outside": "an EU responsible person located in the EU/EEA",
  picture: "a picture of the product",
  type: "the product type or model",
  warnings: "the warnings, or a check that it has none",
};

/**
 * "" when nothing is missing; otherwise one sentence listing what is. It says
 * what is needed, not what happens: no country is closed in this unit, so the
 * cart still ships the product there (docs/sz2-physical-legal-fields.md,
 * "Next units").
 */
export function gapSummary(gaps: readonly SafetyGap[]): string {
  if (gaps.length === 0) return "";
  const words = gaps.map((gap) => GAP_WORDS[gap]);
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  return `Needed before selling to buyers in the EU/EEA: ${list}.`;
}

/**
 * The studio's one-sentence status of the EU/EEA product safety fields, from
 * where the product ships: a product that ships to no EU/EEA country is not
 * told about EU/EEA gaps.
 */
export function safetySummary(shipsTo: readonly string[], info: SafetyInfo | null, hasPicture: boolean): string {
  if (!shipsTo.some((code) => GPSR_AREA.includes(code))) return "This product does not ship to the EU/EEA.";
  return gapSummary(safetyGaps(info, hasPicture)) || "The EU/EEA product safety fields are filled.";
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const countries = new Set(SHIP_COUNTRIES);

type Read<T> = { ok: true; value: T } | { ok: false; problem: LegalProblem };

/** A text as sent: absent is "", line breaks folded to spaces, a control character or an overlong value refused. */
function strictText(raw: unknown, max: number): Read<string> {
  if (raw === undefined || raw === null) return { ok: true, value: "" };
  if (typeof raw !== "string") return { ok: false, problem: "shape" };
  const folded = raw.replace(/[\r\n\t]+/g, " ");
  if (CONTROL.test(folded)) return { ok: false, problem: "control" };
  const value = folded.replace(/\s+/g, " ").trim();
  return value.length <= max ? { ok: true, value } : { ok: false, problem: "long" };
}

function record(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/**
 * What the studio sent, checked strictly: the record to save, or every
 * problem with the field it is about. A field left empty is not a problem
 * (the gaps summary lists it); a value that is there must be valid.
 */
export function checkLegalWrite(raw: unknown): { ok: true; legal: PhysicalLegal } | { ok: false; problems: LegalFieldProblem[] } {
  const problems: LegalFieldProblem[] = [];
  const value = record(raw);
  if (!value) return { ok: false, problems: [{ field: "safety", problem: "shape" }] };
  const take = (field: string, raw: unknown, max: number): string => {
    const read = strictText(raw, max);
    if (read.ok) return read.value;
    problems.push({ field, problem: read.problem });
    return "";
  };

  let safety: SafetyInfo | null = null;
  if (value.safety !== undefined && value.safety !== null) {
    const s = record(value.safety);
    if (!s) problems.push({ field: "safety", problem: "shape" });
    else {
      const contact = (prefix: "manufacturer" | "responsible", raw: unknown) => {
        const c = raw === undefined || raw === null ? {} : record(raw);
        if (!c) {
          problems.push({ field: `${prefix}.name`, problem: "shape" });
          return { name: "", postal: "", electronic: "", country: "" };
        }
        const name = take(`${prefix}.name`, c.name, MAX_NAME);
        const postal = take(`${prefix}.postal`, c.postal, MAX_POSTAL);
        const electronic = take(`${prefix}.electronic`, c.electronic, MAX_ELECTRONIC);
        if (electronic && !electronicAddress(electronic)) problems.push({ field: `${prefix}.electronic`, problem: "address" });
        const typed = strictText(c.country, 20);
        const code = typed.ok ? typed.value.toUpperCase() : "";
        if (!typed.ok) problems.push({ field: `${prefix}.country`, problem: "country" });
        if (code && !countries.has(code)) problems.push({ field: `${prefix}.country`, problem: "country" });
        return { name, postal, electronic, country: code };
      };
      const manufacturer = contact("manufacturer", s.manufacturer);
      const rep = contact("responsible", s.responsible);
      const productType = take("productType", s.productType, MAX_TYPE);
      const identifier = take("identifier", s.identifier, MAX_IDENTIFIER);
      const warnings = take("warnings", s.warnings, MAX_WARNINGS);
      if (s.noWarnings !== undefined && typeof s.noWarnings !== "boolean") problems.push({ field: "noWarnings", problem: "shape" });
      const noWarnings = s.noWarnings === true;
      if (noWarnings && warnings) problems.push({ field: "warnings", problem: "both" });
      const responsible = rep.name || rep.postal || rep.electronic || rep.country ? rep : null;
      safety = { manufacturer, responsible, productType, identifier, warnings, noWarnings };
    }
  }

  let prop65 = "";
  if (value.prop65 !== undefined && value.prop65 !== null) {
    if (typeof value.prop65 !== "string") problems.push({ field: "prop65", problem: "shape" });
    else {
      const text = value.prop65.replace(/\r\n?/g, "\n").trim();
      const problem = checkProp65(text);
      if (problem === "control" || problem === "long" || problem === "signal" || problem === "site") problems.push({ field: "prop65", problem });
      else prop65 = text;
    }
  }

  const quantities: PriceQuantity[] = [];
  if (value.quantities !== undefined && value.quantities !== null) {
    if (!Array.isArray(value.quantities) || value.quantities.length > MAX_QUANTITIES) problems.push({ field: "quantity", problem: "shape" });
    else {
      for (const item of value.quantities) {
        const q = record(item);
        const price = q && typeof q.price === "string" && q.price.length <= MAX_PRICE_ID && !CONTROL.test(q.price) ? q.price : null;
        if (!q || price === null) {
          problems.push({ field: "quantity", problem: "shape" });
          continue;
        }
        const field = `quantity:${price}`;
        if (quantities.some((known) => known.price === price)) {
          problems.push({ field, problem: "price" });
          continue;
        }
        if (typeof q.amount === "string" && q.amount.trim() === "") continue;
        const read = readNetQuantity(q);
        if (!read) problems.push({ field, problem: "amount" });
        else quantities.push({ price, amount: read.amount, unit: read.unit });
      }
    }
  }

  return problems.length ? { ok: false, problems } : { ok: true, legal: { safety, prop65, quantities } };
}

/** Whatever came back from storage, made safe to use; null when there is no record. Anything unreadable reads as not filled. */
export function readPhysicalLegal(raw: unknown): PhysicalLegal | null {
  const value = record(raw);
  if (!value) return null;
  const prop65 = typeof value.prop65 === "string" && checkProp65(value.prop65) === null ? value.prop65.trim() : "";
  const quantities: PriceQuantity[] = [];
  for (const item of Array.isArray(value.quantities) ? value.quantities.slice(0, MAX_QUANTITIES) : []) {
    const q = record(item);
    const price = q && typeof q.price === "string" && q.price.length <= MAX_PRICE_ID && !CONTROL.test(q.price) ? q.price : null;
    const read = price === null ? null : readNetQuantity(q);
    if (price !== null && read && !quantities.some((known) => known.price === price)) quantities.push({ price, amount: read.amount, unit: read.unit });
  }
  return { safety: readSafetyInfo(value.safety), prop65, quantities };
}

/** Whether the server's answer confirms the save of exactly `expected` on this product; any other answer is not a save. */
export function confirmsLegal(data: unknown, ok: boolean, id: string, expected: PhysicalLegal | null): boolean {
  if (!ok) return false;
  const answer = record(data);
  if (!answer || answer.ok !== true) return false;
  const product = record(answer.product);
  if (!product || product.id !== id) return false;
  if (expected === null) return product.legal === null || product.legal === undefined;
  if (!Object.hasOwn(product, "legal")) return false;
  return JSON.stringify(readPhysicalLegal(product.legal)) === JSON.stringify(expected) && JSON.stringify(product.legal) === JSON.stringify(expected);
}
