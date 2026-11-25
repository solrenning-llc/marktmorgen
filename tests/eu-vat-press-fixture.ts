/**
 * A buyer's press from outside the EU and the UK, as the EU VAT gate reads it (lib/eu-vat-gate.ts pressGate): the
 * connection's country Vercel adds and the billing country the buyer chose, both the United States. Given by the tests
 * that open the welcome offer's, the come-back offer's or a moved member's checkout for something other than the
 * gate itself; tests/eu-vat-offer-paths-gate.test.ts checks what happens from the EU, the UK and with no country.
 */
import type { PressEvidence } from "@/lib/eu-vat-gate";
import { BILLING_COUNTRY_FIELD } from "@/lib/eu-vat-evidence";

export const OUTSIDE_EU: PressEvidence = { headers: new Headers({ "x-vercel-ip-country": "US" }), form: new URLSearchParams({ [BILLING_COUNTRY_FIELD]: "US" }) };

/** The billing country a buyer outside the EU and the UK chose, for a test that posts the button's form. */
export function fromOutsideEu<T extends { set: (name: string, value: string) => void }>(form: T): T {
  form.set(BILLING_COUNTRY_FIELD, "US");
  return form;
}
