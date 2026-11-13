/**
 * EU VAT, part 2 of the build, unit 9a: goods shipped to an EU address (docs/eu-vat-article-9a.md, "The code that
 * would be needed", point 8; question 27). Pure.
 *
 * Directive 2006/112/EC art. 14a deems an electronic interface that facilitates a supply of goods within the EU by a
 * seller not established there (or an import in consignments up to EUR 150) to have received and supplied them. That
 * treatment is not built. So, until it is, the countries a physical product may ship to leave out every Member State,
 * and the territories whose VAT treatment the code cannot settle by their code (lib/eu-vat-supply.ts,
 * TERRITORY_UNSETTLED), whenever the creator's own Stripe account is not in a Member State, or its country is not
 * known. An account in a Member State keeps the list: art. 14a(2) concerns a supplier not established in the EU.
 * Whether an EU-established creator's own VAT then applies is the creator's, as today.
 */
import { EU_VAT_COUNTRIES, TERRITORY_UNSETTLED } from "@/lib/eu-vat-supply";

const CODE = /^[A-Z]{2}$/;

export function shipCountriesUnderEuVat(countries: readonly string[], accountCountry: unknown): string[] | null {
  if (!Array.isArray(countries) || countries.some((c) => typeof c !== "string" || !CODE.test(c))) return null;
  const account = typeof accountCountry === "string" ? accountCountry.trim().toUpperCase() : "";
  if (CODE.test(account) && EU_VAT_COUNTRIES.has(account)) return [...countries];
  return countries.filter((c) => !EU_VAT_COUNTRIES.has(c) && !TERRITORY_UNSETTLED.has(c));
}
