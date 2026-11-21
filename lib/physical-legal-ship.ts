/**
 * Where a physical product ships now (618 [SZ2] unit 3, 6 November 2026;
 * docs/sz2-physical-legal-fields.md): its shipping (lib/shipping.ts,
 * activeShipping) without the EU/EEA countries while the product safety
 * information the creator fills (lib/physical-legal.ts, safetyGaps) is not
 * complete, and, until the opening, without the EU and the UK, whose VAT on
 * goods is not collected yet (789 [IV1] unit 1, lib/eu-vat-goods.ts). The rest
 * of its countries keep selling.
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
import { gpsrCloses, gpsrClosedCountries, safetyGaps } from "./physical-legal";
import { SHIP_COUNTRIES, type ShipCandidate, type Shipping, activeShipping } from "./shipping";
import { vatShipCloses } from "./eu-vat-goods";

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
 * What a shipping list that lost countries can be said as, in a few words rather than some two hundred codes (review
 * of #3029, finding 2): "eu-uk" when it is every country Stripe ships to but the ones the VAT lock closes
 * (lib/eu-vat-goods.ts), "eea-uk" when the closed EU/EEA of a product whose safety fields are not filled is left out
 * too; null for any other list, which is said country by country.
 */
export type ShipsExcept = "eu-uk" | "eea-uk";
export function everywhereBut(countries: readonly string[]): ShipsExcept | null {
  const same = (open: readonly string[]) => countries.length === open.length && open.every((code) => countries.includes(code));
  if (same(SHIP_COUNTRIES.filter((code) => !vatShipCloses(code)))) return "eu-uk";
  if (same(SHIP_COUNTRIES.filter((code) => !vatShipCloses(code) && !gpsrCloses(code)))) return "eea-uk";
  return null;
}

/** The shipping a product offers now; `except` when it is everywhere Stripe ships to but the closed countries. */
export type ShippingNow = Shipping & { except?: ShipsExcept };

/**
 * The shipping a product offers now, or null when it is not shipped. Two locks, each on its own, close countries:
 *   - the VAT lock (lib/eu-vat-goods.ts, vatShipCloses), always until the opening: the EU, its outermost regions and
 *     Åland, Monaco and the United Kingdom with the Isle of Man, where the checkout refuses a consumer;
 *   - the product safety lock (618 [SZ2]), while the safety fields are not filled: every EU/EEA country.
 * Filling the safety fields never opens a country the VAT lock closes. Never null for a shipped product (that would
 * read as digital): when every country is closed, the countries are empty and nothing can be paid for. A region that
 * loses countries becomes "custom", so nothing reads its countries back from the region and reopens them.
 */
export function shippingNow(product: SafetyCandidate): ShippingNow | null {
  const shipping = activeShipping(product);
  if (!shipping) return null;
  // Not filled: gpsrClosedCountries with nothing filled closes every EU/EEA country it ships to.
  const gpsr = filled(product) ? [] : gpsrClosedCountries(shipping.countries, null, false);
  const closed = (code: string) => vatShipCloses(code) || gpsr.includes(code);
  if (!shipping.countries.some(closed)) return shipping;
  const countries = shipping.countries.filter((code) => !closed(code));
  const except = everywhereBut(countries);
  return { ...shipping, region: "custom", countries, ...(except ? { except } : {}) };
}

/** A shipped product with no country it can be sent to now: not sold until its safety fields are filled, or, for one
 * shipped only where the VAT lock closes, until the opening. */
export function shipsNowhere(product: SafetyCandidate): boolean {
  const shipping = shippingNow(product);
  return shipping !== null && shipping.countries.length === 0;
}
