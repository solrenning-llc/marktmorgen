/**
 * Claude 2's second review of #2980 (CX-116, LOW), kept as the regression test, LEVE: a sale refunded in full gave its tax
 * back to the buyer (Stripe refunds the tax with the payment), yet the
 * summary still counts that tax as collected, while the page says only
 * "refunds are not in these figures", which reads as if refunded sales were
 * left out. The page should say the tax of refunded sales is still counted.
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
process.env.STRIPE_SECRET_KEY = "sk_test_c2_2980_refund";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[]) => new Response(JSON.stringify({ data, has_more: false }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) return list([{
    id: "cs_test_refd0001", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
    currency: "usd", amount_total: 10_800, created: S, payment_intent: "pi_refd0001",
    customer_details: { email: "refd@example.com", address: { country: "US", state: "NY", postal_code: "10001" } },
    total_details: { amount_discount: 0, amount_tax: 800 }, metadata: { store: "refdtax", product: "p1" },
  }]);
  if (url.pathname.endsWith("/refunds")) return list([{ id: "re_test_refd0001", object: "refund", status: "succeeded", amount: 10_800, currency: "usd", created: S + 60, payment_intent: "pi_refd0001" }]);
  return list([]);
}) as typeof fetch;

async function main() {
  redis.clear();
  const owner = "refdtax-owner@example.com";
  await claimHandle(owner, "refdtax", "Refunded tax", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestRefdTax1", true);
  const store = (await storeForEmail(owner))!;
  const sales = (await readSales(store, NOW))!;
  const stats = (await readStats(store, NOW))!;
  const panel = studioStats(store, stats, sales, "ok", []);
  const html = renderToStaticMarkup(createElement(TaxCollected, { data: panel, range: "d7" }));

  part("A sale refunded in full");
  is("its $8 of tax is still in the figure (the refund was read)", [panel.refunds?.d7.reduce((n, r) => n + r.refunds, 0), html.includes(">$8<")], [1, true]);
  is("so the page says the tax of refunded sales is still counted", /tax (on|of) (sales|payments) (later )?refunded[^.]*(still|is) (counted|included|in)/i.test(html), true);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
