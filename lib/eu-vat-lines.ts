/**
 * EU VAT under art. 9a, part 2 of the build, unit 6a: the checkout's lines for a one-off sale whose VAT is collected
 * (docs/eu-vat-article-9a.md, "The code that would be needed", point 3; "The margin consequence", points 1 and 2).
 * Pure on the request body a checkout builds; nothing calls it yet, and sales stay closed by lib/opening.ts.
 *
 *   - The creator's own automatic tax (lib/tax.ts, applyTax) is removed for the sale: Marktmorgen is the supplier for
 *     EU VAT, so a second VAT line under the creator's account would charge it twice.
 *   - The VAT is its own line on top of the price, named with its country and rate, so the buyer sees it before paying.
 *   - The VAT reaches the LLC only through the platform's fee on the direct charge (the money lands on the creator's
 *     account), so the fee becomes share + VAT + the VAT money's own costs (conversion, remittance), never taken from
 *     the share. Those costs must be given by the caller: unknown is never zero, so without them nothing is written and
 *     the sale is refused.
 *   - A membership's fee is a percent of each payment (lib/platform-share.ts, applyShare), which cannot carry an exact
 *     VAT amount: a membership for an EU consumer is refused until its own design is built.
 * On refusal the body is left exactly as it was.
 */
import type { VatOnTop } from "@/lib/eu-vat-amount";

const FEE = "payment_intent_data[application_fee_amount]";
const WHOLE = /^(0|[1-9]\d{0,14})$/;

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en-US"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function percent(basisPoints: number): string {
  const whole = basisPoints / 100;
  return Number.isInteger(whole) ? String(whole) : whole.toFixed(2).replace(/0$/, "");
}

export function applyEuVatLines(
  body: URLSearchParams,
  input: { vat: VatOnTop; recurring: boolean; vatCostsCents: number | null; currency: string },
): "ok" | "refuse" {
  const { vat } = input;
  if (input.recurring) return "refuse";
  if (input.vatCostsCents === null || !Number.isSafeInteger(input.vatCostsCents) || input.vatCostsCents < 0) return "refuse";
  if (!vat || !Number.isSafeInteger(vat.vatCents) || vat.vatCents < 0 || !Number.isSafeInteger(vat.basisPoints) || !/^[A-Z]{2}$/.test(vat.country)) return "refuse";
  if (typeof input.currency !== "string" || !/^[a-z]{3}$/i.test(input.currency)) return "refuse";
  const feeNow = body.get(FEE);
  if (feeNow !== null && !WHOLE.test(feeNow)) return "refuse";
  const fee = (feeNow === null ? 0 : Number(feeNow)) + vat.vatCents + input.vatCostsCents;
  if (!Number.isSafeInteger(fee)) return "refuse";
  // The next free line index.
  let next = 0;
  for (const key of body.keys()) {
    const line = /^line_items\[(\d+)\]/.exec(key);
    if (line) next = Math.max(next, Number(line[1]) + 1);
  }
  // Checked everything; now write.
  body.delete("automatic_tax[enabled]");
  for (const key of [...body.keys()]) if (/^line_items\[\d+\]\[price_data\]\[tax_behavior\]$/.test(key)) body.delete(key);
  body.set(`line_items[${next}][price_data][currency]`, input.currency.toLowerCase());
  body.set(`line_items[${next}][price_data][unit_amount]`, String(vat.vatCents));
  body.set(`line_items[${next}][price_data][product_data][name]`, `VAT (${countryName(vat.country)}, ${percent(vat.basisPoints)}%)`);
  body.set(`line_items[${next}][quantity]`, "1");
  body.set(FEE, String(fee));
  body.set("payment_intent_data[metadata][eu_vat]", `${vat.country}:${vat.basisPoints}:${vat.vatCents}`);
  return "ok";
}
