/**
 * Claude 2's second review of #2980 (CX-116, MEDIUM), kept as the regression test: the store's checkouts never set
 * billing_address_collection (lib/store-checkout.ts, lib/tax.ts), so with
 * Stripe Tax on, Checkout "will collect the minimum number of fields required
 * for tax calculation" (Stripe API reference, billing_address_collection=auto,
 * read 7 Nov 2026), which for the United States is the country and the ZIP
 * code; Canada likewise by postal code (docs.stripe.com/tax/customer-locations).
 * Such a payment has no state, so regionOf() puts it under the bare country.
 * A New York sale paid by card (ZIP only) then sits under "United States",
 * while one paid with a wallet that gave the full address sits under
 * "United States, NY": the New York row shows only part of New York's tax as
 * if it were New York's, and nothing on the page says so.
 *
 * Synthetic: no real account, payment or buyer.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { taxSummary, type TaxSale } from "@/lib/tax-summary";
import { TaxCollected } from "@/components/tax-collected";
import type { StatsData } from "@/lib/stats";
import { done, is, part } from "./check";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const sale = (tax: number, address: Record<string, unknown>): TaxSale => ({
  created: NOW,
  currency: "usd",
  upsell: false,
  row: { object: "checkout.session", currency: "usd", customer_details: { address }, total_details: { amount_discount: 0, amount_tax: tax } },
});
const sales = [
  // A wallet gave the full address.
  sale(400, { country: "US", state: "NY", postal_code: "10001", line1: "1 Test St", city: "New York" }),
  // A card in Checkout with tax on: country and ZIP only, as Stripe collects the minimum (same ZIP, same state).
  sale(400, { country: "US", state: null, postal_code: "10001", line1: null, city: null }),
  sale(300, { country: "CA", state: null, postal_code: "M5V 2T6" }),
];
const summary = taxSummary(sales, { d7: "2026-10-07", d30: "2026-09-14", d90: "2026-07-16" }, "usd", false);
const html = renderToStaticMarkup(createElement(TaxCollected, { data: { taxCollected: summary } as unknown as StatsData, range: "d7" }));
const rowLabels = [...html.matchAll(/<th scope="row"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);

part("A payment that gave no state is not shown as the whole country, and the state rows say they may not hold every sale");
is("the US row without a state is not labeled as all of the United States", rowLabels.includes("United States"), false);
is("the Canadian row without a province is not labeled as all of Canada", rowLabels.includes("Canada"), false);
is("the page says a state's row may miss sales whose payment gave no state", /(state|province)[^.]*(not given|not known|not on the payment|unknown)/i.test(html), true);
is("control: the sale whose payment gave the state stays under that state", rowLabels.includes("United States, NY"), true);
is("control: the totals are still every sale's tax", summary.d7.currencies.map((c) => [c.currency, c.taxCents]), [["usd", 1100]]);
done();
