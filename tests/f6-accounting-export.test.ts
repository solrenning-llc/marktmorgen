/**
 * Sales for an accounting app (queue item 37 [F6], 6 November 2026): a
 * store's paid sales of one period as a file Xero's sales-invoice import or
 * QuickBooks Online's invoice import takes (lib/accounting-export-rules.ts,
 * lib/accounting-export.ts, app/api/store/export?what=sales&format=...).
 * Checked, with synthetic data only (no Stripe, PayPal or Redis service is
 * called):
 *
 *   - the period: a whole month or half of one, among the last twelve, and
 *     only whole UTC days that are over, so the same day never comes out
 *     twice with two different totals;
 *   - one invoice a day and a currency, one line a product, under the fixed
 *     contact "Online customers": no buyer's name or address leaves for the
 *     accounting app;
 *   - amounts written exactly from whole cents (yen, dollars, dinars), the
 *     tax the buyer paid in its own column, never a negative line;
 *   - every cell quoted, a quote written twice, and a cell that a
 *     spreadsheet would run as a formula (=, +, -, @, tab, CR) defused;
 *   - each app's own limits for one import: refused, never cut short;
 *   - every Stripe page and PayPal record read in its exact shape: a page or
 *     a sale that cannot be read exactly, or more than one file reads, makes
 *     no file at all (never a file with sales missing as if complete);
 *   - the reads are the sales file's own ceiling (EXPORT_PAGES of each list,
 *     EXPORT_PAGES hundred PayPal sales), behind the same counted window.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCOUNTING_CONTACT,
  IMPORT_LIMITS,
  QUICKBOOKS_HEADER,
  XERO_HEADER,
  accountingFile,
  accountingLines,
  accountingMonths,
  accountingPeriod,
  cleanAccountCode,
  cleanTaxName,
  exactAmount,
  type AccountingSale,
} from "@/lib/accounting-export-rules";
import { ACCOUNTING_PAGES, ACCOUNTING_PAYPAL_LIMIT, readAccountingSales } from "@/lib/accounting-export";
import { readPayPalSalesExact } from "@/lib/paypal-sales";
import { EXPORT_PAGES } from "@/lib/stats";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 6, 15, 30); // 6 November 2026, 15:30 UTC
const sec = (ms: number) => Math.floor(ms / 1000);

async function main(): Promise<void> {
  part("The period: a whole month or half of one, whole UTC days that are over");
  const october = accountingPeriod("2026-10", "", NOW);
  is("October 2026, all of it", october && [october.from, october.to, october.slug, october.label], [sec(Date.UTC(2026, 9, 1)), sec(Date.UTC(2026, 10, 1)), "2026-10", "October 2026"]);
  const first = accountingPeriod("2026-10", "1", NOW);
  const second = accountingPeriod("2026-10", "2", NOW);
  is("its first half, the 1st to the 15th", first && [first.from, first.to, first.slug, first.label], [sec(Date.UTC(2026, 9, 1)), sec(Date.UTC(2026, 9, 16)), "2026-10-01-to-15", "October 1–15, 2026"]);
  is("its second half, the 16th to its last day", second && [second.from, second.to, second.slug, second.label], [sec(Date.UTC(2026, 9, 16)), sec(Date.UTC(2026, 10, 1)), "2026-10-16-to-31", "October 16–31, 2026"]);
  const current = accountingPeriod("2026-11", "", NOW);
  is("this month only up to the end of yesterday, and said so", current && [current.from, current.to, current.label], [sec(Date.UTC(2026, 10, 1)), sec(Date.UTC(2026, 10, 6)), "November 1–5, 2026 (so far)"]);
  is("this month's second half has not started: nothing to read", accountingPeriod("2026-11", "2", NOW), null);
  is("the first day of a month has no whole day of it yet", accountingPeriod("2026-11", "", Date.UTC(2026, 10, 1, 9)), null);
  is("February in a leap year ends on the 29th", accountingPeriod("2028-02", "2", Date.UTC(2028, 5, 1))?.label, "February 16–29, 2028");
  is("twelve months back is the oldest (PayPal keeps 400 days)", [Boolean(accountingPeriod("2025-12", "", NOW)), accountingPeriod("2025-11", "", NOW)], [true, null]);
  is("a month to come, a bad month and a bad half are refused", [accountingPeriod("2026-12", "", NOW), accountingPeriod("2026-13", "", NOW), accountingPeriod("26-10", "", NOW), accountingPeriod("2026-10", "3", NOW)], [null, null, null, null]);
  const months = accountingMonths(NOW);
  is("the list offers the last twelve months, newest first", [months.length, months[0], months[11]], [12, { value: "2026-11", label: "November 2026" }, { value: "2025-12", label: "December 2025" }]);

  part("Amounts written exactly from whole units");
  is("dollars, yen, dinars, and a large one", [exactAmount(4900, "usd"), exactAmount(5, "usd"), exactAmount(4900, "jpy"), exactAmount(12345, "kwd"), exactAmount(123456789012, "usd")], ["49.00", "0.05", "4900", "12.345", "1234567890.12"]);
  is("never a negative or a broken amount", [exactAmount(-1, "usd"), exactAmount(1.5, "usd"), exactAmount(Number.NaN, "usd")], [null, null, null]);

  part("One invoice a day and a currency, one line a product");
  const day1 = sec(Date.UTC(2026, 9, 3, 10));
  const day2 = sec(Date.UTC(2026, 9, 4, 23, 59));
  const sales: AccountingSale[] = [
    { at: day1, product: "p1", title: "Sourdough Guide", currency: "usd", net: 4900, tax: 0 },
    { at: day1 + 60, product: "p1", title: "Sourdough Guide", currency: "usd", net: 3920, tax: 392 },
    { at: day1 + 120, product: "p2", title: 'The "Starter" Course', currency: "usd", net: 9900, tax: 0 },
    { at: day1 + 180, product: "p1", title: "Sourdough Guide", currency: "eur", net: 4500, tax: 855 },
    { at: day2, product: "p3", title: "=HYPERLINK(\"http://evil.example\")", currency: "jpy", net: 4900, tax: 0 },
  ];
  const lines = accountingLines(sales);
  is(
    "grouped by day, currency and product, summed, counted",
    lines.map((l) => [l.invoice, l.date, l.currency, l.description, l.net, l.tax]),
    [
      ["MM-20261003-EUR", "2026-10-03", "eur", "Sourdough Guide (1 sale)", 4500, 855],
      ["MM-20261003-USD", "2026-10-03", "usd", "Sourdough Guide (2 sales)", 8820, 392],
      ["MM-20261003-USD", "2026-10-03", "usd", 'The "Starter" Course (1 sale)', 9900, 0],
      ["MM-20261004-JPY", "2026-10-04", "jpy", '=HYPERLINK("http://evil.example") (1 sale)', 4900, 0],
    ],
  );
  is("an invoice number QuickBooks takes (at most 21 characters)", lines.every((l) => l.invoice.length <= 21), true);

  part("The Xero file");
  is("Xero's sales-invoice template columns, in its order", XERO_HEADER, [
    "*ContactName", "EmailAddress", "POAddressLine1", "POAddressLine2", "POAddressLine3", "POAddressLine4", "POCity", "PORegion", "POPostalCode", "POCountry",
    "*InvoiceNumber", "Reference", "*InvoiceDate", "*DueDate", "Total", "InventoryItemCode", "*Description", "*Quantity", "*UnitAmount", "Discount",
    "*AccountCode", "*TaxType", "TaxAmount", "TrackingName1", "TrackingOption1", "TrackingName2", "TrackingOption2", "Currency", "BrandingTheme",
  ]);
  const xero = accountingFile("xero", lines, { account: "200", tax: "Tax on Sales" });
  if (!xero.ok) throw new Error("the Xero file was refused");
  const xeroRows = xero.csv.split("\r\n");
  is("a header, a row a line, and a last line break", [xeroRows.length, xeroRows[xeroRows.length - 1]], [lines.length + 2, ""]);
  is(
    "the first line: the fixed contact, its invoice, US dates, one at the amount without tax, the tax in its own column",
    xeroRows[1],
    `"${ACCOUNTING_CONTACT}","","","","","","","","","","MM-20261003-EUR","Marktmorgen sales","10/03/2026","10/03/2026","","","Sourdough Guide (1 sale)","1","45.00","","200","Tax on Sales","8.55","","","","","EUR",""`,
  );
  is("a quote written twice", xeroRows[3].includes('"The ""Starter"" Course (1 sale)"'), true);
  is("a formula never runs: the cell starts with a quote mark", xeroRows[4].includes(`"'=HYPERLINK(""http://evil.example"") (1 sale)"`), true);
  is("yen with no decimals", xeroRows[4].includes('"1","4900","","200"'), true);
  is("no buyer's address or name in the file", /@|buyer/i.test(xero.csv), false);
  const blank = accountingFile("xero", lines, { account: "", tax: "" });
  is("without an account code or tax rate, those cells are left for Xero", blank.ok && blank.csv.split("\r\n")[1].includes('"45.00","","","","8.55"'), true);

  part("The QuickBooks file");
  is("the columns QuickBooks Online's invoice import maps", QUICKBOOKS_HEADER, ["InvoiceNo", "Customer", "InvoiceDate", "DueDate", "Memo", "Item(Product/Service)", "ItemDescription", "ItemQuantity", "ItemRate", "ItemAmount", "ItemTaxCode", "ItemTaxAmount", "Currency"]);
  const qb = accountingFile("quickbooks", lines, { account: "", tax: "" });
  if (!qb.ok) throw new Error("the QuickBooks file was refused");
  is("one line", qb.csv.split("\r\n")[2], `"MM-20261003-USD","${ACCOUNTING_CONTACT}","10/03/2026","10/03/2026","Marktmorgen sales","Sales","Sourdough Guide (2 sales)","1","88.20","88.20","","3.92","USD"`);

  part("Each app's limits for one import: refused, never cut short");
  const many = (n: number, days = 1): AccountingSale[] =>
    Array.from({ length: n }, (_, i) => ({ at: day1 + (i % days) * 86_400, product: `p${i}`, title: `Product ${i}`, currency: "usd", net: 100, tax: 0 }));
  is("the limits used", IMPORT_LIMITS, { xero: { rows: 500, invoices: 500 }, quickbooks: { rows: 1000, invoices: 100 } });
  is("Xero: 500 lines go, 501 are refused with the count", [accountingFile("xero", accountingLines(many(500)), { account: "", tax: "" }).ok, accountingFile("xero", accountingLines(many(501)), { account: "", tax: "" })], [true, { ok: false, rows: 501, invoices: 1 }]);
  is("QuickBooks: 1,000 lines go, 1,001 are refused", [accountingFile("quickbooks", accountingLines(many(1000)), { account: "", tax: "" }).ok, accountingFile("quickbooks", accountingLines(many(1001)), { account: "", tax: "" }).ok], [true, false]);
  const fourCurrencies: AccountingSale[] = [];
  for (const currency of ["usd", "eur", "gbp", "cad"]) for (let d = 0; d < 26; d += 1) fourCurrencies.push({ at: sec(Date.UTC(2026, 9, 1 + d, 12)), product: "p", title: "P", currency, net: 100, tax: 0 });
  is("QuickBooks: more than 100 invoices are refused", accountingFile("quickbooks", accountingLines(fourCurrencies), { account: "", tax: "" }), { ok: false, rows: 104, invoices: 104 });
  is("a sale with an amount that cannot be written makes no file", accountingFile("xero", [{ ...lines[0], net: -5 }], { account: "", tax: "" }), { ok: false, rows: 1, invoices: 1 });

  part("What the creator may type for the accounting app");
  is("an account code: letters and digits, up to ten", [cleanAccountCode("200"), cleanAccountCode(" 4000 "), cleanAccountCode(""), cleanAccountCode("=1+1"), cleanAccountCode("-200"), cleanAccountCode("12345678901")], ["200", "4000", "", null, null, null]);
  is("a tax rate's name: plain words, up to fifty", [cleanTaxName("Tax on Sales"), cleanTaxName("GST on Income 10%"), cleanTaxName(""), cleanTaxName("@SUM(1)"), cleanTaxName("a".repeat(51)), cleanTaxName("Tax\ton")], ["Tax on Sales", "GST on Income 10%", "", null, null, null]);

  part("Reading the sales: every page and sale in its exact shape");
  is("the same ceiling as the sales file", [ACCOUNTING_PAGES, ACCOUNTING_PAYPAL_LIMIT], [EXPORT_PAGES, EXPORT_PAGES * 100]);
  const store = { handle: "harbor", previousHandles: ["old-harbor"], releasedHandles: [], statsId: "s1", stripeAccountId: "acct_123", paypalSeller: "" } as unknown as Store;
  const from = sec(Date.UTC(2026, 9, 1));
  const to = sec(Date.UTC(2026, 10, 1));
  const period = { from, to, slug: "2026-10", label: "October 2026" };
  const session = (id: string, over: Record<string, unknown> = {}) => ({
    id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", amount_total: 4900, currency: "usd", created: from + 3600,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 }, metadata: { store: "harbor", product: "p1" }, ...over,
  });
  const upsell = (id: string, over: Record<string, unknown> = {}) => ({ id, object: "payment_intent", status: "succeeded", amount: 1900, currency: "usd", created: from + 7200, metadata: { kind: "upsell", store: "harbor", product: "p2" }, ...over });
  const titles: Record<string, string> = { p1: "Sourdough Guide", p2: "Starter Jar" };
  const world = (sessions: unknown[], intents: unknown[], paypal: Awaited<ReturnType<typeof readPayPalSalesExact>> = { sales: [], more: false }) => {
    const asked: string[] = [];
    return {
      asked,
      deps: {
        stripe: async (path: string) => {
          asked.push(path);
          const pages = path.startsWith("/checkout/sessions") ? sessions : intents;
          const after = /starting_after=([^&]+)/.exec(path)?.[1];
          const at = after ? Number(after.split("_").pop()) : 0;
          return pages[at];
        },
        paypal: async () => paypal,
        title: async (id: string) => titles[id] ?? "",
      },
    };
  };
  const page = (data: unknown[], hasMore: boolean) => ({ object: "list", data, has_more: hasMore });

  const happy = world(
    [page([session("cs_a_0"), session("cs_b_0", { metadata: { store: "other", product: "x" } }), session("cs_c_0", { payment_status: "unpaid", amount_total: null, total_details: null }), session("cs_d_1", { metadata: { store: "old-harbor", product: "p1" }, amount_total: 4312, total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 392 } })], true), page([session("cs_e_1", { created: from + 90_000 })], false)],
    [page([upsell("pi_a_0"), upsell("pi_b_0", { metadata: { kind: "upsell", store: "harbor", product: "p2" }, status: "requires_payment_method", amount: null })], false)],
  );
  const read = await readAccountingSales(store, period, happy.deps);
  is(
    "this store's paid sales under any of its names, with tax apart; other stores', unpaid and unfinished left out",
    read.ok && read.sales.map((s) => [s.product, s.title, s.net, s.tax, s.currency]).sort(),
    [["p1", "Sourdough Guide", 3920, 392, "usd"], ["p1", "Sourdough Guide", 4900, 0, "usd"], ["p1", "Sourdough Guide", 4900, 0, "usd"], ["p2", "Starter Jar", 1900, 0, "usd"]],
  );
  is("Stripe is asked only for the period, a hundred at a time", happy.asked.every((p) => p.includes(`created[gte]=${from}`) && p.includes(`created[lt]=${to}`) && p.includes("limit=100")), true);
  is("the next page starts after the last row read", happy.asked.includes(`/checkout/sessions?limit=100&created[gte]=${from}&created[lt]=${to}&starting_after=cs_d_1`), true);

  const refused = async (what: string, sessions: unknown[], intents: unknown[], reason: string, paypal?: Awaited<ReturnType<typeof readPayPalSalesExact>>) => {
    const result = await readAccountingSales(store, period, world(sessions, intents, paypal).deps).catch(() => ({ ok: false as const, reason: "threw" }));
    is(what, result.ok ? "a file" : result.reason, reason);
  };
  const empty = [page([], false)];
  await refused("a paid sale with no amount: no file", [page([session("cs_a_0", { amount_total: undefined })], false)], empty, "unreadable");
  await refused("a paid sale with no tax figure: no file (unknown is not zero)", [page([session("cs_a_0", { total_details: null })], false)], empty, "unreadable");
  await refused("tax larger than what was paid: no file", [page([session("cs_a_0", { total_details: { amount_tax: 5000 } })], false)], empty, "unreadable");
  await refused("a sale dated outside the period: no file", [page([session("cs_a_0", { created: to })], false)], empty, "unreadable");
  await refused("a currency that is not three letters: no file", [page([session("cs_a_0", { currency: "dollars" })], false)], empty, "unreadable");
  await refused("a row that is not a record: no file", [page([null], false)], empty, "unreadable");
  await refused("a row whose store cannot be read: no file", [page([session("cs_a_0", { metadata: "harbor" })], false)], empty, "unreadable");
  await refused("a page in another shape: no file", [{ data: "nope", has_more: false }], empty, "unreadable");
  await refused("a page that says there is more but holds nothing: no file", [page([], true)], empty, "unreadable");
  await refused("no answer from Stripe: no file", [undefined], empty, "unreadable");
  await refused("a one-click extra with no amount: no file", empty, [page([upsell("pi_a_0", { amount: "19" })], false)], "unreadable");
  const full = Array.from({ length: ACCOUNTING_PAGES }, (_, i) => page([session(`cs_x_${i + 1}`)], true));
  await refused("more pages than one file reads: no file, said as too many", [page([session("cs_x_1")], true), ...full.slice(1)], empty, "too_many");
  await refused("PayPal not read exactly: no file", empty, empty, "unreadable", null);
  await refused("more PayPal sales than one file reads: no file", empty, empty, "too_many", { sales: [], more: true });
  const paypalStore = await readAccountingSales({ ...store, stripeAccountId: "" } as Store, period, world([], [], { sales: [{ store: "s1", order: "5O190127TN3647201", capture: "C", email: "b@example.com", product: "p1", cents: 3920, currency: "usd", at: from + 10 }], more: false }).deps);
  is("a PayPal sale counted, on a store with no Stripe, with no tax (PayPal orders carry none)", paypalStore.ok && paypalStore.sales.map((s) => [s.product, s.net, s.tax, s.at]), [["p1", 3920, 0, from + 10]]);

  part("PayPal's own records, read exactly");
  redis.clear();
  const order = (n: number) => `5O190127TN36472${String(n).padStart(2, "0")}`;
  const paid = (n: number, at: number, over: Record<string, unknown> = {}) => JSON.stringify({ store: "s1", order: order(n), capture: `CAP${n}`, email: "b@example.com", product: "p1", cents: 3920, currency: "usd", at, ...over });
  await redis.pipeline([
    ["ZADD", "nl:ppsell:sales:s1", String(from - 10), order(1), String(from + 10), order(2), String(from + 20), order(3), String(to), order(4)],
    ["SET", `nl:ppsell:paid:${order(1)}`, paid(1, from - 10)],
    ["SET", `nl:ppsell:paid:${order(2)}`, paid(2, from + 10)],
    ["SET", `nl:ppsell:paid:${order(3)}`, paid(3, from + 20)],
    ["SET", `nl:ppsell:paid:${order(4)}`, paid(4, to)],
  ]);
  const exact = await readPayPalSalesExact("s1", from, to, 10);
  is("only the period's, each whole", exact && [exact.sales.map((s) => s.order), exact.more], [[order(2), order(3)], false]);
  is("more than the limit: said", (await readPayPalSalesExact("s1", from, to, 1))?.more, true);
  await redis.pipeline([["DEL", `nl:ppsell:paid:${order(3)}`]]);
  is("a sale whose record is gone: not known", await readPayPalSalesExact("s1", from, to, 10), null);
  await redis.pipeline([["SET", `nl:ppsell:paid:${order(3)}`, paid(3, from + 20, { cents: "39.20" })]]);
  is("a sale whose amount is not whole units: not known", await readPayPalSalesExact("s1", from, to, 10), null);
  await redis.pipeline([["SET", `nl:ppsell:paid:${order(3)}`, paid(3, from + 20, { store: "s2" })]]);
  is("another store's sale: not known", await readPayPalSalesExact("s1", from, to, 10), null);
  await redis.pipeline([["SET", `nl:ppsell:paid:${order(3)}`, "{not json"]]);
  is("a record that is not JSON: not known", await readPayPalSalesExact("s1", from, to, 10), null);
  await redis.pipeline([["SET", `nl:ppsell:paid:${order(3)}`, paid(3, from + 20)], ["ZADD", "nl:ppsell:sales:s1", String(from + 30), "bad id"]]);
  is("a name in the list that is not an order: not known", await readPayPalSalesExact("s1", from, to, 10), null);
  is("a store with no records id: nothing to read, said exactly", await readPayPalSalesExact(null, from, to, 10), { sales: [], more: false });

  part("The download is the studio's sales file's, behind its counted window");
  const route = readFileSync(join(process.cwd(), "app/api/store/export/route.ts"), "utf8");
  const counted = route.indexOf("count > EXPORTS_PER_WINDOW");
  const accounting = route.indexOf("readAccountingSales(");
  is("the route reads the accounting file only after the window is counted, with the export permission", [counted > 0, accounting > counted, /what === "sales" \|\| what === "store" \? "export"/.test(route)], [true, true, true]);
  is("a refusal never hands over a partial file", [/too_many/.test(route), /unreadable/.test(route), /-partial/.test(route.slice(accounting, accounting + 4000))], [true, true, false]);
  const panel = readFileSync(join(process.cwd(), "components/stats-panel.tsx"), "utf8");
  is("the studio offers it beside the sales file, to a role that may export", [/AccountingExportForm/.test(panel), /canExport \? <AccountingExportForm|canExport \? \(\s*<AccountingExportForm/.test(panel)], [true, true]);
  const form = readFileSync(join(process.cwd(), "components/accounting-export-form.tsx"), "utf8");
  is("its form: Xero or QuickBooks, a month, which half, labeled", ['name="format"', 'value="xero"', 'value="quickbooks"', 'name="month"', 'name="half"', 'name="account"', 'name="tax"', "<label"].map((s) => form.includes(s)), [true, true, true, true, true, true, true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
