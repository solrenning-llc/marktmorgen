/**
 * Claude 2's second review of #2980 (CX-116, HIGH), kept as the regression test: a shipped order is taxed by Stripe at the
 * SHIPPING address (docs.stripe.com/tax/checkout/page, read 7 Nov 2026:
 * "Collect a shipping address: Checkout calculates taxes based on the shipping
 * address the customer provided"), and lib/store-checkout.ts collects one for
 * every shipped product with Stripe Tax on. The summary places the tax by the
 * billing address (customer_details.address), so the tax charged for New York
 * is shown under New Jersey, and French VAT under Germany.
 *
 * Synthetic: a stand-in for Stripe; no real account, payment or buyer.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readSales, readStats, studioStats } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { TaxCollected } from "@/components/tax-collected";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const S = NOW / 1000;

process.env.STRIPE_SECRET_KEY = "sk_test_c2_2980_shipping";
const shipped = (id: string, tax: number, currency: string, billing: Record<string, unknown>, shipTo: Record<string, unknown>) => ({
  id,
  object: "checkout.session",
  status: "complete",
  payment_status: "paid",
  mode: "payment",
  currency,
  amount_total: 5000 + tax,
  created: S,
  payment_intent: `pi_${id}`,
  customer_details: { email: `${id}@example.com`, address: billing },
  collected_information: { shipping_details: { name: "Synthetic Buyer", address: { line1: "1 Test St", city: "Town", ...shipTo } } },
  total_details: { amount_discount: 0, amount_shipping: 500, amount_tax: tax },
  metadata: { store: "shiptax", product: "p1", ship: "yes" },
});
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[]) => new Response(JSON.stringify({ data, has_more: false }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) return list([
    // Paid with a card billed in New Jersey, shipped to New York: Stripe charged New York's tax.
    shipped("cs_test_ship0001", 888, "usd", { country: "US", state: "NJ", postal_code: "07030" }, { country: "US", state: "NY", postal_code: "10001" }),
    // Billed in Germany, shipped to France: Stripe charged French VAT.
    shipped("cs_test_ship0002", 1000, "eur", { country: "DE", postal_code: "10115" }, { country: "FR", postal_code: "75001" }),
    // Control: a download, nothing shipped, billed in California: placed by the payment's address, as Stripe taxed it.
    { ...shipped("cs_test_digi0003", 500, "usd", { country: "US", state: "CA", postal_code: "94105" }, {}), collected_information: null, metadata: { store: "shiptax", product: "p1" } },
  ]);
  return list([]);
}) as typeof fetch;

async function main() {
  redis.clear();
  const owner = "shiptax-owner@example.com";
  await claimHandle(owner, "shiptax", "Ship tax", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestShipTax1", true);
  const store = (await storeForEmail(owner))!;
  const sales = (await readSales(store, NOW))!;
  const usd = sales.taxIn!.d7.currencies.find((c) => c.currency === "usd")!;
  const eur = sales.taxIn!.d7.currencies.find((c) => c.currency === "eur")!;

  part("The tax of a shipped order is placed where Stripe taxed it: the shipping address");
  is("New York's tax is under New York, and the download's under California", usd.regions.map((r) => [r.region, r.taxCents]), [["US-NY", 888], ["US-CA", 500]]);
  is("French VAT is under France", eur.regions.map((r) => [r.region, r.taxCents]), [["FR", 1000]]);

  part("What the page says");
  const stats = (await readStats(store, NOW))!;
  const html = renderToStaticMarkup(createElement(TaxCollected, { data: studioStats(store, stats, sales, "ok", []), range: "d7" }));
  is("no New Jersey tax is claimed for a parcel that went to New York", html.includes("United States, NJ"), false);
  is("no German VAT is claimed for a parcel that went to France", html.includes(">Germany<"), false);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
