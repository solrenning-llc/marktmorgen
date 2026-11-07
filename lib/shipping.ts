/**
 * Physical products, shipped by the creator (added 11 October 2026): a
 * printed book, a poster, a T-shirt, a box of the planner on paper.
 *
 * Measured before it was built: Stan has no physical products; its help
 * center suggests a digital product with address questions and shipping
 * worked out by hand. Gumroad and Beacons sell them. Here it is a product
 * like any other, with three things of its own:
 *
 *   - Where it ships: the countries the creator sends to, picked from a few
 *     regions or listed one by one. Stripe's own checkout asks the buyer for
 *     an address in one of them, so nobody pays for something that cannot
 *     reach them.
 *   - What shipping costs: one amount per order, or nothing, added on
 *     Stripe's page as its own line before the buyer pays.
 *   - A line about when it ships, in the creator's words.
 *
 * The creator ships it themselves. The address is on the sale in the studio
 * and in their Stripe dashboard; pressing "Mark as shipped" emails the buyer,
 * with a tracking link if there is one (lib/shipments.ts).
 *
 * It is sold once, at one price or at several (sizes or versions: S, M, L;
 * signed or not): not with a price the buyer names, a payment plan, a gift
 * or a group purchase, and it delivers no file, link, course or call
 * besides. A limited quantity and the boxes at checkout work as they do on
 * any product. At one price and not limited, it goes in a cart with other
 * products the creator ships, to one address in a country they all ship to
 * (lib/cart-shipping.ts; 513 [PF1], unit 2b, 2 November 2026); not yet with
 * products handed over online (shipsWithOnline).
 *
 * Browser-safe: the studio reads the same rules the server holds it to.
 */

export type ShipRegion = "us" | "na" | "eu" | "europe" | "world" | "custom";

export type Shipping = {
  /** One amount per order, in the store currency's smallest unit; 0 is free shipping. */
  cents: number;
  /** Which of the regions below, or "custom" for the list as it is. */
  region: ShipRegion;
  /** The countries it ships to, as Stripe names them (two letters). */
  countries: string[];
  /** When it ships, in the creator's words: "Ships within 3 business days". */
  note: string;
  /** Optional creator inventory reference; never replaces a product or price ID. */
  sku?: string;
};

/** The countries Stripe's checkout will take a shipping address in. */
export const SHIP_COUNTRIES = (
  "AD AE AF AG AI AL AM AO AQ AR AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CD CF CG CH CI CK CL CM CN CO CR CV CW CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FO FR GA GB GD " +
  "GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IS IT JE JM JO JP KE KG KH " +
  "KI KM KN KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MK ML MM MN MO MQ MR MS MT MU MV MW MX " +
  "MY MZ NA NC NE NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PY QA RE RO RS RW SA SB SC SE SG " +
  "SH SI SJ SK SL SM SN SO SR SS ST SV SX SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC " +
  "VE VG VN VU WF WS XK YE YT ZA ZM ZW"
).split(" ");

const EU = "AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK".split(" ");

/** The regions a creator picks from, and the countries in each. */
export const SHIP_REGIONS: Record<Exclude<ShipRegion, "custom">, { label: string; countries: string[] }> = {
  us: { label: "The United States", countries: ["US"] },
  na: { label: "The United States and Canada", countries: ["US", "CA"] },
  eu: { label: "The European Union", countries: EU },
  europe: { label: "Europe: the EU, the UK, Switzerland, Norway and Iceland", countries: [...EU, "GB", "CH", "NO", "IS"] },
  world: { label: "Everywhere Stripe can ship to", countries: SHIP_COUNTRIES },
};

/** The most a shipping charge may be, in the currency's smallest unit (a thousand dollars, a hundred thousand yen). */
export const MAX_SHIPPING_CENTS = 100_000;
export const MAX_SHIP_NOTE = 80;
export const MAX_SHIPPING_SKU = 64;

/** Keep inventory references as typed, including case and Unicode; reject controls or oversized values. */
export function readShippingSku(raw: unknown): string | null {
  if (raw === undefined) return "";
  if (typeof raw !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(raw)) return null;
  const value = raw.trim();
  return value.length <= MAX_SHIPPING_SKU ? value : null;
}

const allowed = new Set(SHIP_COUNTRIES);

/** A list of country codes, as typed or stored, kept to the ones Stripe ships to, once each, in order. */
export function readCountries(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,;]+/) : [];
  const out: string[] = [];
  for (const item of list) {
    const code = typeof item === "string" ? item.trim().toUpperCase() : "";
    if (allowed.has(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

/** Whatever came back from storage, made safe to use; null is not shipped. */
export function parseShipping(raw: unknown): Shipping | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.cents !== "number") return null;
  const cents = value.cents;
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_SHIPPING_CENTS) return null;
  const region: ShipRegion = value.region === "us" || value.region === "na" || value.region === "eu" || value.region === "europe" || value.region === "world" ? value.region : "custom";
  const countries = region === "custom" ? readCountries(value.countries) : SHIP_REGIONS[region].countries;
  if (countries.length === 0) return null;
  const note = typeof value.note === "string" ? value.note.replace(/\s+/g, " ").trim().slice(0, MAX_SHIP_NOTE) : "";
  const sku = readShippingSku(value.sku);
  // Corrupt optional metadata must not turn a physical product into an unshipped one.
  return { cents, region, countries, note, ...(typeof value.sku === "string" && sku !== null ? { sku } : {}) };
}

/** The facts about a product that decide whether it can be shipped. */
export type ShipCandidate = {
  priceCents: number;
  recurring: unknown;
  call: unknown;
  options: { file?: unknown; link?: unknown }[];
  pwyw: unknown;
  plan: unknown;
  file: unknown;
  link: unknown;
  course: unknown;
  podcast?: unknown;
  bundle: unknown;
};

export type ShipProblem = "free" | "membership" | "call" | "pwyw" | "plan" | "delivery";

/** Why this product cannot be shipped, or null when it can: sold once, at one price, delivering nothing else. */
export function shipProblem(product: ShipCandidate): ShipProblem | null {
  if (product.priceCents <= 0) return "free";
  if (product.recurring) return "membership";
  if (product.call) return "call";
  // Several prices are sizes or versions of the same thing (added 11 October 2026): each ships the same way.
  if (product.pwyw) return "pwyw";
  if (product.plan) return "plan";
  if (product.file || product.link || product.course || product.podcast || product.bundle) return "delivery";
  if (product.options.some((option) => option.file || option.link)) return "delivery";
  return null;
}

/** The shipping a product offers now, or null: set, and on a product that can still be shipped. */
export function activeShipping(product: ShipCandidate & { shipping?: Shipping | null }): Shipping | null {
  const shipping = product.shipping ?? null;
  return shipping && shipProblem(product) === null ? shipping : null;
}

/**
 * "the United States and Canada", "France, Belgium and 3 more", in the reader's language.
 * `exceptGpsr` (lib/physical-legal-ship.ts): everywhere but the EU/EEA while
 * a product's safety fields are not filled, said in a few words.
 */
export function shipsToWords(
  shipping: Pick<Shipping, "region" | "countries"> & { exceptGpsr?: boolean },
  locale: string,
  words: { and: string; more: (n: number) => string; everywhere: string; everywhereElse?: string },
): string {
  if (shipping.region === "world") return words.everywhere;
  if (shipping.exceptGpsr && words.everywhereElse) return words.everywhereElse;
  let names: string[];
  try {
    const display = new Intl.DisplayNames([locale], { type: "region" });
    names = shipping.countries.map((code) => display.of(code) ?? code);
  } catch {
    names = shipping.countries;
  }
  if (names.length === 1) return names[0];
  if (names.length <= 4) return `${names.slice(0, -1).join(", ")} ${words.and} ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(", ")} ${words.more(names.length - 3)}`;
}
