/**
 * The checkout's billing country (EU VAT art. 9a, lib/eu-vat-gate.ts consumerGate): the buyer's own answer to where
 * they are buying from, the second item of location evidence beside the country of their connection. Asked of a
 * paid product only; never filled in from the connection (lib/eu-vat-evidence.ts), so the form makes the buyer pick.
 *
 * A native select with a visible label tied to it, required, so every browser and screen reader announces the label,
 * the choice and, when it is left empty, its own "fill in this field" message, and a phone shows its own picker. The
 * country names are the store language's own (Intl.DisplayNames), in that language's alphabetical order. Server-drawn:
 * no script.
 */
import { BILLING_COUNTRY_FIELD } from "@/lib/eu-vat-evidence";
import { SHIP_COUNTRIES } from "@/lib/shipping";

const sorted = new Map<string, { code: string; name: string }[]>();

/** Every country the checkout takes, named in this locale and sorted as it sorts. */
export function billingCountries(locale: string): { code: string; name: string }[] {
  const found = sorted.get(locale);
  if (found) return found;
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale], { type: "region" });
  } catch {
    names = null;
  }
  const list = SHIP_COUNTRIES.map((code) => ({ code, name: names?.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, locale));
  sorted.set(locale, list);
  return list;
}

export function BillingCountryField({ id, locale, label, choose }: { id: string; locale: string; label: string; choose: string }) {
  return (
    <div className="block">
      <label htmlFor={id} className="st-label">
        {label}
      </label>
      <select id={id} name={BILLING_COUNTRY_FIELD} required defaultValue="" autoComplete="country" className="st-field mt-2">
        <option value="" disabled>
          {choose}
        </option>
        {billingCountries(locale).map((country) => (
          <option key={country.code} value={country.code}>
            {country.name}
          </option>
        ))}
      </select>
    </div>
  );
}
