/**
 * The creator's tax summary (601 [KB22], unit U4): the tax Stripe added to
 * the store's checkouts, by where the buyer is, each currency on its own.
 *
 *   - totals per region equal the sum of each session's total_details.amount_tax;
 *   - a session whose tax could not be read is counted as such, never as $0;
 *   - currencies are never added together or converted;
 *   - PayPal sales are counted aside: Stripe collected nothing on them;
 *   - a one-click extra is a payment with no tax calculation (lib/upsell.ts): $0 read, not unknown;
 *   - an incomplete reading shows no figure;
 *   - the rows are bounded, and a rolled-up row keeps the totals exact;
 *   - it is computed from the sales the numbers already read (readSales), with no read of its own;
 *   - the sales file leaves an unread tax blank instead of writing 0.00.
 *
 * Run against a stand-in for Stripe; no real account, payment or buyer.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { TAX_CURRENCY_ROWS, TAX_REGION_ROWS, regionOf, taxOf, taxSummary, type TaxSale } from "@/lib/tax-summary";
import { readSales, readStats, salesCsv, studioStats } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { TaxCollected } from "@/components/tax-collected";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const S = NOW / 1000;
const DAY = 86_400_000;

const session = (tax: unknown, currency: string, address: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  object: "checkout.session",
  status: "complete",
  payment_status: "paid",
  currency,
  customer_details: address === undefined ? undefined : { address },
  ...(tax === undefined ? {} : { total_details: tax === null ? null : { amount_discount: 0, amount_tax: tax } }),
  ...extra,
});
const sale = (row: Record<string, unknown>, at = NOW, upsell = false): TaxSale => ({ created: at, currency: String(row.currency ?? "usd"), row, upsell });

part("Each sale's tax, as read");
is("a whole number of cents is read", taxOf(sale(session(80, "usd", { country: "US", state: "NY" }))), { kind: "read", cents: 80 });
is("zero tax is a real zero when Stripe says zero", taxOf(sale(session(0, "usd", { country: "GB" }))), { kind: "read", cents: 0 });
for (const [label, tax] of [["no total_details", undefined], ["total_details null", null], ["a string", "12"], ["a fraction", 1.5], ["a negative", -3], ["too large to be exact", 2 ** 60]] as const) {
  is(`${label}: could not be read, never zero`, taxOf(sale(session(tax, "usd", { country: "US", state: "NY" }))), { kind: "unread" });
}
is("total_details without amount_tax is unread", taxOf(sale({ ...session(undefined, "usd", { country: "US" }), total_details: { amount_discount: 0 } })), { kind: "unread" });
is("a one-click extra carries no tax calculation: read as zero", taxOf(sale({ object: "payment_intent", amount: 900, currency: "usd" }, NOW, true)), { kind: "read", cents: 0 });
is("a PayPal sale is outside Stripe's tax", taxOf(sale({ ...session(0, "usd", undefined), object: "paypal.order" })), { kind: "paypal" });

part("Where the buyer is");
is("US and Canada by state or province", [regionOf(session(0, "usd", { country: "US", state: "NY" })), regionOf(session(0, "cad", { country: "CA", state: "ON" }))], ["US-NY", "CA-ON"]);
is("elsewhere by country", regionOf(session(0, "eur", { country: "DE", state: "BE" })), "DE");
is("a US address with no state is the country alone", regionOf(session(0, "usd", { country: "US" })), "US");
is("no address, a malformed country or state: no region", [regionOf(session(0, "usd", undefined)), regionOf(session(0, "usd", { country: "usa" })), regionOf(session(0, "usd", { country: "US", state: "<b>" }))], ["", "", "US"]);

part("The summary, per currency and region");
const rows: TaxSale[] = [
  sale(session(80, "usd", { country: "US", state: "NY" })),
  sale(session(120, "usd", { country: "US", state: "NY" })),
  sale(session(190, "eur", { country: "DE" })),
  sale(session(0, "usd", { country: "GB" })),
  sale(session(undefined, "usd", { country: "US", state: "CA" })),
  sale(session("12", "usd", { country: "US", state: "NY" })),
  sale({ object: "payment_intent", amount: 900, currency: "usd" }, NOW, true),
  sale({ ...session(0, "usd", undefined), object: "paypal.order" }),
  sale(session(500, "usd", { country: "US", state: "TX" }), NOW - 40 * DAY),
];
const cuts = { d7: "2026-10-07", d30: "2026-09-14", d90: "2026-07-16" };
const summary = taxSummary(rows, cuts, "usd", false);
const d7usd = summary.d7.currencies.find((c) => c.currency === "usd")!;
const d7eur = summary.d7.currencies.find((c) => c.currency === "eur")!;
const region = (c: typeof d7usd, r: string) => c.regions.find((row) => row.region === r);
is("the store's own currency first, each currency on its own", summary.d7.currencies.map((c) => c.currency), ["usd", "eur"]);
is("New York: the sum of amount_tax of the sessions read, the unread one counted aside", region(d7usd, "US-NY"), { region: "US-NY", sales: 3, taxCents: 200, unread: 1 });
is("California: only unread, so no figure is claimed", region(d7usd, "US-CA"), { region: "US-CA", sales: 1, taxCents: 0, unread: 1 });
is("the dollar total is the sum of the dollar sessions read, never the euros", [d7usd.taxCents, d7usd.unread, d7usd.sales], [200, 2, 6]);
is("euros on their own", [d7eur.taxCents, d7eur.unread, d7eur.sales, d7eur.regions], [190, 0, 1, [{ region: "DE", sales: 1, taxCents: 190, unread: 0 }]]);
is("the one-click extra is a sale with no region and no tax", region(d7usd, ""), { region: "", sales: 1, taxCents: 0, unread: 0 });
is("PayPal counted aside, not in any currency", [summary.d7.paypal, summary.d7.currencies.reduce((n, c) => n + c.sales, 0)], [1, 7]);
is("an older sale is only in the windows that reach it", [region(d7usd, "US-TX"), summary.d30.currencies[0].regions.find((r) => r.region === "US-TX"), summary.d90.currencies[0].regions.find((r) => r.region === "US-TX")], [undefined, undefined, { region: "US-TX", sales: 1, taxCents: 500, unread: 0 }]);
is("the largest tax first, no region last", d7usd.regions.map((r) => r.region), ["US-NY", "GB", "US-CA", ""]);
is("an incomplete reading is carried, so no figure is shown", [summary.partial, taxSummary(rows, cuts, "usd", true).partial], [false, true]);
const regionsSum = (c: typeof d7usd) => c.regions.reduce((n, r) => n + r.taxCents, 0) + (c.more?.taxCents ?? 0);
is("the regions add up to the currency's total", regionsSum(d7usd), d7usd.taxCents);

part("Bounded, and the totals stay exact");
const many: TaxSale[] = [];
for (let i = 0; i < 60; i += 1) {
  const code = String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));
  many.push(sale(session(i + 1, "usd", { country: code })));
}
many.push(sale(session(undefined, "usd", { country: "ZZ" })));
const big = taxSummary(many, cuts, "usd", false).d7.currencies[0];
is("at most TAX_REGION_ROWS regions listed", big.regions.length, TAX_REGION_ROWS);
is("the rest rolled into one row, totals exact", [big.more?.sales, big.taxCents, regionsSum(big), big.unread, big.regions.reduce((n, r) => n + r.unread, 0) + (big.more?.unread ?? 0)], [61 - TAX_REGION_ROWS, (60 * 61) / 2, (60 * 61) / 2, 1, 1]);
const currencies = ["usd", "eur", "gbp", "cad", "aud", "jpy", "chf"].map((c) => sale(session(10, c, { country: "FR" })));
const capped = taxSummary(currencies, cuts, "usd", false).d7;
is("at most TAX_CURRENCY_ROWS currencies, the store's own kept, the rest counted, never added", [capped.currencies.length, capped.currencies[0].currency, capped.moreCurrencies], [TAX_CURRENCY_ROWS, "usd", 7 - TAX_CURRENCY_ROWS]);
is("nothing sold is an empty window, not an error", taxSummary([], cuts, "usd", false).d7, { currencies: [], moreCurrencies: 0, paypal: 0 });

process.env.STRIPE_SECRET_KEY = "sk_test_tax_summary_stand_in";
let stripeCalls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  stripeCalls.push(url.pathname);
  const list = (data: unknown[]) => new Response(JSON.stringify({ data, has_more: false }), { status: 200 });
  const paid = (id: string, tax: unknown, currency: string, address: unknown) => ({
    id, ...session(tax, currency, address), amount_total: 5000, created: S, payment_intent: `pi_${id}`,
    customer_email: `${id}@example.com`, metadata: { store: "taxes", product: "p1" },
  });
  if (url.pathname.endsWith("/checkout/sessions")) return list([
    paid("cs_test_tax0001", 400, "usd", { country: "US", state: "NY" }),
    paid("cs_test_tax0002", 350, "usd", { country: "US", state: "NY" }),
    paid("cs_test_tax0003", 950, "eur", { country: "FR" }),
    paid("cs_test_tax0004", undefined, "usd", { country: "US", state: "WA" }),
  ]);
  return list([]);
}) as typeof fetch;

async function main() {
  redis.clear();
  const owner = "taxes-owner@example.com";
  await claimHandle(owner, "taxes", "Taxes", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestTaxes01", true);
  const store = (await storeForEmail(owner))!;

  part("From the sales the numbers already read");
  stripeCalls = [];
  const sales = (await readSales(store, NOW))!;
  const usd = sales.taxIn!.d7.currencies.find((c) => c.currency === "usd")!;
  is("New York is the sum of its two sessions' amount_tax", usd.regions.find((r) => r.region === "US-NY"), { region: "US-NY", sales: 2, taxCents: 750, unread: 0 });
  is("Washington could not be read, and says so", usd.regions.find((r) => r.region === "US-WA"), { region: "US-WA", sales: 1, taxCents: 0, unread: 1 });
  is("euros apart", sales.taxIn!.d7.currencies.find((c) => c.currency === "eur")?.taxCents, 950);
  is("no Stripe read of its own: only the lists readSales already reads", [...new Set(stripeCalls)].every((p) => /\/v1\/(checkout\/sessions|payment_intents|refunds|invoices|disputes)$/.test(p)), true);
  is("no tax-specific Stripe endpoint is called", stripeCalls.some((p) => /\/tax\//.test(p)), false);
  const stats = (await readStats(store, NOW))!;
  const panel = studioStats(store, stats, sales, "ok", []);
  is("the panel's data carries the summary and no buyer", [panel.taxCollected?.d7.currencies.length, /@/.test(JSON.stringify(panel.taxCollected))], [2, false]);

  part("What the page says");
  const html = renderToStaticMarkup(createElement(TaxCollected, { data: panel, range: "d7" }));
  is("a heading and a table with header cells", [/<h3[^>]*>Tax collected at checkout, last 7 days<\/h3>/.test(html), /<th scope="col"/.test(html), /<th scope="row"/.test(html)], [true, true, true]);
  is("New York in its own money", html.includes("United States, NY") && html.includes("$7.50"), true);
  is("euros on their own table", html.includes("€9.50") && html.includes(">EUR<"), true);
  const waRow = html.split("</tr>").find((r) => r.includes("United States, WA")) ?? "";
  is("the unread region says it could not be read, never $0.00", [waRow.includes("Could not be read"), waRow.includes("$0.00")], [true, false]);
  is("says it is a record, not tax advice", html.includes("This is a record of what was collected, not tax advice"), true);
  is("says currencies are never added together", html.includes("currencies are never added together"), true);
  is("says renewals are not in it", html.includes("Renewals and later payments of payment plans are not in these figures"), true);
  // Claude 2's review of #2980 (LOW): a refunded sale's tax is still counted, and the page says so.
  is("says the tax of refunded sales is still counted", html.includes("Tax on sales later refunded is still counted here: refunds are not taken off."), true);

  const partialHtml = renderToStaticMarkup(createElement(TaxCollected, { data: { ...panel, taxCollected: { ...panel.taxCollected!, partial: true } }, range: "d7" }));
  is("an incomplete reading shows no figure and says why", [partialHtml.includes("$7.50"), partialHtml.includes("Not every sale could be read")], [false, true]);
  const missingHtml = renderToStaticMarkup(createElement(TaxCollected, { data: { ...panel, taxCollected: null }, range: "d7" }));
  is("no summary at all says it could not be read, never $0", [missingHtml.includes("could not be read"), missingHtml.includes("$0")], [true, false]);
  const paypalHtml = renderToStaticMarkup(createElement(TaxCollected, { data: { ...panel, taxCollected: { ...panel.taxCollected!, d7: { ...panel.taxCollected!.d7, paypal: 2 } } }, range: "d7" }));
  is("PayPal sales are named, not counted as tax", paypalHtml.includes("2 sales paid with PayPal are not in this summary"), true);
  is("the studio shows it beside what was kept", /<TaxCollected data=\{data\} range=\{range\} \/>/.test(readFileSync("components/stats-panel.tsx", "utf8")), true);

  part("The sales file");
  const csv = (await salesCsv(store, 0)).csv.split("\r\n");
  const header = csv[0].split(",");
  const taxAt = header.indexOf('"tax"');
  const line = (id: string) => csv.find((l) => l.includes(id))!.split(",");
  is("tax read is written", line("cs_test_tax0001")[taxAt], '"4.00"');
  is("tax that could not be read is left blank, never 0.00", line("cs_test_tax0004")[taxAt], '""');
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
