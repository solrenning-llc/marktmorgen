/**
 * The information fields a creator fills on a physical product, and the
 * arithmetic behind them (618 [SZ2], 6 November 2026;
 * docs/sz2-physical-legal-fields.md):
 *
 *   - EU product safety (Regulation (EU) 2023/988, art. 19): the
 *     manufacturer, the EU responsible person when the manufacturer is outside
 *     the EU/EEA, what identifies the product, and its warnings. While a gap
 *     remains, the product does not ship to the EU/EEA; the rest of its
 *     countries keep selling.
 *   - California Proposition 65: the creator's own warning text, checked for
 *     its shape, never written or required by this code.
 *   - Unit price (Directive 98/6/EC): computed from the price charged and the
 *     net quantity, never typed.
 *   - The prior lowest price of an announced reduction (98/6/EC art. 6a; CJEU
 *     C-330/23): the lowest price applied in the 30 days before it, from a
 *     short price history.
 *
 * These are fields and arithmetic; they do not decide whether a law applies
 * to a product or say that anything complies. Pure and browser-safe: nothing
 * here reads or writes storage.
 */
import { MAX_SALE_DAYS } from "./store-sale";
import { SHIP_COUNTRIES, SHIP_REGIONS } from "./shipping";

const DAY = 86_400;

/** Where GPSR art. 19 is taken to apply: the EU 27, and Iceland, Liechtenstein and Norway (stricter reading of its EEA relevance). */
export const GPSR_AREA: readonly string[] = [...SHIP_REGIONS.eu.countries, "IS", "LI", "NO"];

export const MAX_NAME = 200;
export const MAX_POSTAL = 300;
export const MAX_ELECTRONIC = 254;
export const MAX_TYPE = 200;
export const MAX_IDENTIFIER = 100;
export const MAX_WARNINGS = 2000;
export const MAX_PROP65 = 600;

export type Contact = {
  /** Name, registered trade name or registered trade mark. */
  name: string;
  postal: string;
  /** An email address or an https contact page. */
  electronic: string;
  /** Two letters, as Stripe names countries; "" when unknown. */
  country: string;
};

export type SafetyInfo = {
  manufacturer: Contact;
  /** The EU responsible person (GPSR art. 16(1)); needed when the manufacturer is outside GPSR_AREA. */
  responsible: Contact | null;
  /** The type or model a buyer can recognise. */
  productType: string;
  /** Batch, serial or other identifier; optional. */
  identifier: string;
  /** The warnings or safety information that go on or with the product. */
  warnings: string;
  /** The creator stated there are none; never inferred from an empty field. */
  noWarnings: boolean;
};

export type SafetyGap =
  | "manufacturer-name"
  | "manufacturer-postal"
  | "manufacturer-electronic"
  | "manufacturer-country"
  | "responsible"
  | "responsible-name"
  | "responsible-postal"
  | "responsible-electronic"
  | "responsible-country"
  | "responsible-outside"
  | "picture"
  | "type"
  | "warnings";

const countries = new Set(SHIP_COUNTRIES);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A short text as stored: line breaks folded to spaces; a control character or an overlong value reads as "", never cut. */
function text(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  const folded = raw.replace(/[\r\n\t]+/g, " ");
  if (CONTROL.test(folded)) return "";
  const value = folded.replace(/\s+/g, " ").trim();
  return value.length <= max ? value : "";
}

function country(raw: unknown): string {
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return countries.has(code) ? code : "";
}

function contact(raw: unknown): Contact {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    name: text(value.name, MAX_NAME),
    postal: text(value.postal, MAX_POSTAL),
    electronic: text(value.electronic, MAX_ELECTRONIC),
    country: country(value.country),
  };
}

/** Whatever came back from storage, made safe to use; null when it is not a record. */
export function readSafetyInfo(raw: unknown): SafetyInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const warnings = text(value.warnings, MAX_WARNINGS);
  return {
    manufacturer: contact(value.manufacturer),
    responsible: value.responsible && typeof value.responsible === "object" ? contact(value.responsible) : null,
    productType: text(value.productType, MAX_TYPE),
    identifier: text(value.identifier, MAX_IDENTIFIER),
    warnings,
    noWarnings: value.noWarnings === true && warnings === "",
  };
}

const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

/** An email address or an https page: what GPSR calls an electronic address. */
export function electronicAddress(value: string): boolean {
  if (EMAIL.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.includes(".");
  } catch {
    return false;
  }
}

/** What is still missing for an EU/EEA sale, in a fixed order; empty when complete. */
export function safetyGaps(info: SafetyInfo | null, hasPicture: boolean): SafetyGap[] {
  const gaps: SafetyGap[] = [];
  const maker = info?.manufacturer;
  if (!maker?.name) gaps.push("manufacturer-name");
  if (!maker?.postal) gaps.push("manufacturer-postal");
  if (!maker || !electronicAddress(maker.electronic)) gaps.push("manufacturer-electronic");
  if (!maker?.country) gaps.push("manufacturer-country");
  if (maker?.country && !GPSR_AREA.includes(maker.country)) {
    const rep = info?.responsible ?? null;
    if (!rep) gaps.push("responsible");
    else {
      if (!rep.name) gaps.push("responsible-name");
      if (!rep.postal) gaps.push("responsible-postal");
      if (!electronicAddress(rep.electronic)) gaps.push("responsible-electronic");
      if (!rep.country) gaps.push("responsible-country");
      else if (!GPSR_AREA.includes(rep.country)) gaps.push("responsible-outside");
    }
  }
  if (!hasPicture) gaps.push("picture");
  if (!info?.productType) gaps.push("type");
  if (!info?.warnings && !info?.noWarnings) gaps.push("warnings");
  return gaps;
}

/** The shipping countries in GPSR_AREA that stay closed while any gap remains, in the order given. */
export function gpsrClosedCountries(shipsTo: readonly string[], info: SafetyInfo | null, hasPicture: boolean): string[] {
  if (safetyGaps(info, hasPicture).length === 0) return [];
  return shipsTo.filter((code) => GPSR_AREA.includes(code));
}

/** Whether a Proposition 65 field is worth offering: the product ships to the US. */
export function prop65Matters(shipsTo: readonly string[]): boolean {
  return shipsTo.includes("US");
}

export type Prop65Problem = "control" | "long" | "signal" | "site";

const SIGNAL = /^(WARNING|CA WARNING|CALIFORNIA WARNING):/;
/**
 * The site named on its own: at the start, after a space or an opening mark,
 * optionally after http(s)://, and ending there (a space, a closing mark, a
 * path, or a final period), so www.P65Warnings.ca.gov.example.invalid or
 * evil.example/www.P65Warnings.ca.gov does not count. Text shape only; no URL
 * is fetched.
 */
const SITE = /(?:^|[\s(<"'])(?:https?:\/\/)?www\.P65Warnings\.ca\.gov(?=$|[\s)>"'/,;:!?]|\.(?:$|[\s)>"']))/i;

/**
 * The creator's Proposition 65 text, as their manufacturer or supplier gave
 * it: null when empty (nothing shown) or when it has the shape of a warning,
 * a signal word first and the P65Warnings site named. The wording itself is
 * theirs; this never writes or completes it.
 */
export function checkProp65(raw: string): Prop65Problem | null {
  const value = raw.trim();
  if (value === "") return null;
  if (CONTROL.test(value.replace(/[\r\n]+/g, " "))) return "control";
  if (value.length > MAX_PROP65) return "long";
  if (!SIGNAL.test(value)) return "signal";
  if (!SITE.test(value)) return "site";
  return null;
}

/** The base units a unit price is shown in (98/6/EC art. 2(b)). */
export type BaseUnit = "kg" | "l" | "m" | "m2" | "m3";
export type QuantityUnit = "g" | "kg" | "ml" | "cl" | "l" | "mm" | "cm" | "m" | "cm2" | "m2" | "cm3" | "m3";

/** Each unit's base and how many millionths of the base one of it is. */
const UNITS: Record<QuantityUnit, { base: BaseUnit; micro: number }> = {
  g: { base: "kg", micro: 1_000 },
  kg: { base: "kg", micro: 1_000_000 },
  ml: { base: "l", micro: 1_000 },
  cl: { base: "l", micro: 10_000 },
  l: { base: "l", micro: 1_000_000 },
  mm: { base: "m", micro: 1_000 },
  cm: { base: "m", micro: 10_000 },
  m: { base: "m", micro: 1_000_000 },
  cm2: { base: "m2", micro: 100 },
  m2: { base: "m2", micro: 1_000_000 },
  cm3: { base: "m3", micro: 1 },
  m3: { base: "m3", micro: 1_000_000 },
};

export const QUANTITY_UNITS = Object.keys(UNITS) as QuantityUnit[];

/** The net quantity on one price: an amount with up to three decimals, as typed, and its unit. */
export type NetQuantity = { amount: string; unit: QuantityUnit };

const AMOUNT = /^(\d{1,9})(?:[.,](\d{1,3}))?$/;

export function readNetQuantity(raw: unknown): NetQuantity | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const unit = typeof value.unit === "string" && Object.hasOwn(UNITS, value.unit) ? (value.unit as QuantityUnit) : null;
  const typed = typeof value.amount === "number" ? String(value.amount) : typeof value.amount === "string" ? value.amount.trim() : "";
  const match = AMOUNT.exec(typed);
  if (!unit || !match) return null;
  const amount = match[2] ? `${match[1]}.${match[2]}` : match[1];
  return thousandths(amount) > BigInt(0) ? { amount, unit } : null;
}

function thousandths(amount: string): bigint {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * BigInt(1000) + BigInt((fraction + "000").slice(0, 3));
}

/**
 * The price per base unit, in the same smallest currency unit as the price,
 * rounded half up from exact integer arithmetic; `same` when the quantity is
 * one base unit (the unit price is then the selling price). Null without a
 * quantity, or when the result could not be shown exactly.
 */
export function unitPrice(priceCents: number, quantity: NetQuantity | null): { cents: number; unit: BaseUnit; same: boolean } | null {
  if (!quantity || !Number.isSafeInteger(priceCents) || priceCents < 0) return null;
  const { base, micro } = UNITS[quantity.unit];
  // Quantity in billionths of the base unit: thousandths of the typed amount times millionths per unit.
  const nano = thousandths(quantity.amount) * BigInt(micro);
  if (nano <= BigInt(0)) return null;
  const billion = BigInt(1_000_000_000);
  const cents = (BigInt(2) * BigInt(priceCents) * billion + nano) / (BigInt(2) * nano);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { cents: Number(cents), unit: base, same: nano === billion };
}

/** The base unit as printed beside a price and as read aloud (AX274, 3.1.4), in American English. */
export function unitWords(unit: BaseUnit): { short: string; long: string } {
  switch (unit) {
    case "kg":
      return { short: "kg", long: "per kilogram" };
    case "l":
      return { short: "L", long: "per liter" };
    case "m":
      return { short: "m", long: "per meter" };
    case "m2":
      return { short: "m²", long: "per square meter" };
    case "m3":
      return { short: "m³", long: "per cubic meter" };
  }
}

/** One price applied from a moment (seconds) until the next step. */
export type PriceStep = { at: number; cents: number };

/** The period before a reduction whose lowest price is its prior price (98/6/EC art. 6a(2): not less than 30 days). */
export const PRIOR_PRICE_SECONDS = 30 * DAY;
/** How long steps are kept: the period plus the longest store sale, so a sale still running finds its prior price. */
export const PRICE_KEEP_SECONDS = PRIOR_PRICE_SECONDS + MAX_SALE_DAYS * DAY;
/** The most steps kept per product; beyond it the oldest two merge into one at the lower price. */
export const MAX_PRICE_STEPS = 64;

function validStep(step: unknown): step is PriceStep {
  if (!step || typeof step !== "object") return false;
  const { at, cents } = step as Record<string, unknown>;
  return Number.isSafeInteger(at) && (at as number) > 0 && Number.isSafeInteger(cents) && (cents as number) >= 0;
}

/**
 * The history in time order, steps of the same second kept in the order they
 * were applied (a stable sort); null when it is not a list or any step is
 * unreadable, a missing slot included (every and map skip holes, so each index
 * is read), so a filtered subset is never taken for the whole history.
 */
function steps(history: unknown): PriceStep[] | null {
  if (!Array.isArray(history)) return null;
  const out: PriceStep[] = [];
  for (let index = 0; index < history.length; index += 1) {
    const step: unknown = history[index];
    if (!validStep(step)) return null;
    out.push({ at: step.at, cents: step.cents });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The history once `cents` is the price applied from `now` (seconds). The
 * same price adds nothing. A step is never stamped later than the latest time
 * seen: a change in the same second as the last step keeps that second, after
 * it in order, and a clock that went back stamps the step at the last step's
 * second, so no price that was applied is lost or moved into the future.
 * Steps that ended before the kept period are dropped; past the cap, the
 * oldest two merge at the lower price, so a prior price read later can only
 * come out lower than the truth (a smaller reduction announced), never
 * higher. An unreadable history comes back as it came, so it keeps reading as
 * unreadable instead of a filtered subset that would read as complete. Pure.
 */
export function recordPrice(history: readonly PriceStep[], cents: number, now: number): PriceStep[];
// The body takes any value: an unreadable one is handed back as it came, a list copied with its holes.
export function recordPrice(history: unknown, cents: number, now: number): unknown {
  const out = steps(history);
  if (!out) return Array.isArray(history) ? history.slice() : history;
  if (!Number.isSafeInteger(cents) || cents < 0 || !Number.isSafeInteger(now) || now <= 0) return out;
  const last = out[out.length - 1];
  if (!last) out.push({ at: now, cents });
  else if (last.cents !== cents) out.push({ at: Math.max(now, last.at), cents });
  const edge = Math.max(now, out[out.length - 1].at) - PRICE_KEEP_SECONDS;
  while (out.length > 1 && out[1].at <= edge) out.shift();
  while (out.length > MAX_PRICE_STEPS) out.splice(0, 2, { at: out[0].at, cents: Math.min(out[0].cents, out[1].cents) });
  return out;
}

/**
 * The lowest price applied in the 30 days before `start` (seconds), the
 * reduction's own price from `start` excluded; a price replaced within the
 * second of `start` itself counts as before it (it can only lower the
 * result). `complete` is false when the history begins inside that period (a
 * product priced less than 30 days before). Null when no price was applied
 * before `start`; "unreadable" when the history is not a list or any step is
 * unreadable: nothing is certified from it, never a filtered subset.
 */
export function priorLowestPrice(history: readonly PriceStep[], start: number): { cents: number; complete: boolean } | null | "unreadable" {
  const list = steps(history);
  if (!list) return "unreadable";
  const from = start - PRIOR_PRICE_SECONDS;
  let lowest: number | null = null;
  list.forEach((step, index) => {
    const end = index + 1 < list.length ? list[index + 1].at : Infinity;
    const before = step.at < start || (step.at === start && end === start);
    if (before && end > from) lowest = lowest === null ? step.cents : Math.min(lowest, step.cents);
  });
  if (lowest === null) return null;
  return { cents: lowest, complete: list[0].at <= from };
}
