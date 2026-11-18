/**
 * EU VAT under art. 9a, part 2 of the build, unit 10a: the two items of location evidence a checkout has before it
 * opens (docs/eu-vat-article-9a.md, "The code that would be needed", point 1). Pure; nothing calls it yet.
 *
 *   ip       the country of the request's IP address, from the x-vercel-ip-country header Vercel's edge sets (the
 *            header lib/visitor.ts reads; a visitor cannot set it there);
 *   billing  the billing country the buyer gives in the checkout's form (BILLING_COUNTRY_FIELD).
 * Each is read as it is, trimmed and upper case, or null when absent: never filled in from the other and never
 * defaulted, so lib/eu-vat-supply.ts (consumerPlace) decides on what was really given. A value is cut to 64
 * characters before anything else, so a long one is never kept.
 */
export const BILLING_COUNTRY_FIELD = "billing_country";

function item(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.slice(0, 64).trim().toUpperCase();
  return value === "" ? null : value;
}

export function checkoutEvidence(headers: Headers, form: URLSearchParams | FormData): { ip: string | null; billing: string | null } {
  return { ip: item(headers.get("x-vercel-ip-country")), billing: item(form.get(BILLING_COUNTRY_FIELD)) };
}
