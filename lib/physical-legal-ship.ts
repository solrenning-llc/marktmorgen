/**
 * Where a physical product ships now (618 [SZ2] unit 3, 6 November 2026;
 * docs/sz2-physical-legal-fields.md): its shipping (lib/shipping.ts,
 * activeShipping) without the EU/EEA countries while the product safety
 * information the creator fills (lib/physical-legal.ts, safetyGaps) is not
 * complete. The rest of its countries keep selling.
 *
 * Unknown is closed, never open:
 *   - a full product (read with its own record, so it has `fields`) is judged
 *     only from that record; one that cannot be read is not filled, whatever
 *     its listing says;
 *   - a listing (the store page, the cart before paying) carries only the
 *     mark `safetyFilled`, computed by the code when the product was saved
 *     (catalog.ts, listingOf); anything but exactly true is not filled;
 *   - an object told what was read (`legal`, even null) is judged from that.
 *
 * Every checkout reads the product in full, so what is paid for follows the
 * record itself. These are information fields: nothing here says that a
 * product complies with anything. Pure and browser-safe.
 */
import { type PhysicalLegal } from "./physical-legal-record";
import { GPSR_AREA, gpsrClosedCountries, safetyGaps } from "./physical-legal";
import { SHIP_REGIONS, type ShipCandidate, type Shipping, activeShipping } from "./shipping";

export type SafetyCandidate = ShipCandidate & {
  shipping?: Shipping | null;
  image?: unknown;
  /** On a full product: its legal record, absent when it has none or it could not be read. */
  legal?: PhysicalLegal | null;
  /** On a listing: the mark computed when it was saved. */
  safetyFilled?: boolean;
  /** Only a full product has it. */
  fields?: unknown;
};

/** Whether a full product's own record has every EU/EEA safety item, its picture included. */
export function safetyComplete(product: { legal?: PhysicalLegal | null; image?: unknown }): boolean {
  const safety = product.legal?.safety ?? null;
  return safety !== null && safetyGaps(safety, Boolean(product.image)).length === 0;
}

function filled(product: SafetyCandidate): boolean {
  if (Object.hasOwn(product, "legal") || Object.hasOwn(product, "fields")) return safetyComplete(product);
  return product.safetyFilled === true;
}

/**
 * The shipping a product offers now, or null when it is not shipped. Never
 * null for a shipped product (that would read as digital): when every country
 * is closed, the countries are empty and nothing can be paid for.
 */
export function shippingNow(product: SafetyCandidate): Shipping | null {
  const shipping = activeShipping(product);
  if (!shipping) return null;
  // Not filled: gpsrClosedCountries with nothing filled closes every EU/EEA country it ships to.
  const closed = filled(product) ? [] : gpsrClosedCountries(shipping.countries, null, false);
  if (closed.length === 0) return shipping;
  const countries = shipping.countries.filter((code) => !closed.includes(code));
  // Said as the region it was cut from, without the EU/EEA (shipsToWords, deliveryWords), never as the list left.
  return { ...shipping, region: "custom", countries, ...(shipping.region !== "custom" ? { before: shipping.region } : {}) };
}

const sameCountries = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set(a).size === a.length && b.every((code) => a.includes(code));

/**
 * The shape a list of countries is said in, where only the list is known (the cart, which ships an order to where
 * every product in it goes): everywhere, everywhere but the EU/EEA, or the list itself.
 */
export function shipsToShape(countries: readonly string[]): Pick<Shipping, "region" | "countries" | "before"> {
  const world = SHIP_REGIONS.world.countries;
  if (sameCountries(countries, world)) return { region: "world", countries: [...countries] };
  if (sameCountries(countries, world.filter((code) => !GPSR_AREA.includes(code)))) return { region: "custom", countries: [...countries], before: "world" };
  return { region: "custom", countries: [...countries] };
}

/** A shipped product with no country it can be sent to now: not sold until its safety fields are filled. */
export function shipsNowhere(product: SafetyCandidate): boolean {
  const shipping = shippingNow(product);
  return shipping !== null && shipping.countries.length === 0;
}

