/**
 * The rules of the sales filters, and the total and average of what is filtered (767 [STN14], unit 1; Claude 4,
 * 9 November 2026). Pure and browser-safe: the filter bar, saved filters and bulk actions are the next units.
 *
 * What must hold: the total is exactly the sum of the sales the filter keeps; currencies are never added
 * together; a free trial is an order but nothing was charged, so it is out of the average; an amount that is not
 * a whole number of cents is unknown, so no total is given at all (never a total that counts it as zero); what
 * comes from the address bar is cleaned and bounded. Synthetic data only.
 */
import { EMPTY_FILTER, FILTER_TEXT_MAX, type FilterableSale, filterQuery, filterSales, isFiltered, readSalesFilter, salesTotals } from "@/lib/sales-filter-rules";
import { done, is, part } from "./check";

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;
const sale = (over: Partial<FilterableSale>): FilterableSale => ({
  title: "Watercolor basics",
  amount: 2_900,
  currency: "usd",
  email: "ana@example.com",
  paidAt: day("2026-11-02") + 3_600,
  trial: false,
  isTip: false,
  isCall: false,
  ...over,
});

const SALES: FilterableSale[] = [
  sale({}),
  sale({ title: "Watercolor basics", amount: 2_900, email: "ben@example.com", paidAt: day("2026-11-03") }),
  sale({ title: "Ink course", amount: 9_900, email: "cy@example.com", paidAt: day("2026-11-04") + 86_399 }),
  sale({ title: "Ink course", amount: 0, trial: true, email: "dee@example.com", paidAt: day("2026-11-05") }),
  sale({ title: "Support my work", amount: 500, isTip: true, email: "ana@example.com", paidAt: day("2026-11-05") }),
  sale({ title: "Portfolio review call", amount: 15_000, isCall: true, email: "eve@example.com", paidAt: day("2026-11-06") }),
  sale({ title: "Watercolor basics", amount: 2_500, currency: "eur", email: "fil@example.com", paidAt: day("2026-11-06") }),
];

part("Reading a filter from the address bar");
is("nothing asked: the empty filter, which filters nothing", [readSalesFilter({}), isFiltered(readSalesFilter({}))], [EMPTY_FILTER, false]);
is(
  "each field is read, trimmed, and the kind kept when it is one of the list",
  readSalesFilter({ product: "  Ink course ", from: "2026-11-01", to: "2026-11-30", email: " ANA@example.com ", kind: "calls" }),
  { product: "Ink course", from: "2026-11-01", to: "2026-11-30", email: "ana@example.com", kind: "calls" },
);
is(
  "a date that is not a real day, a kind not on the list and a repeated field are left out, never guessed",
  readSalesFilter({ from: "2026-02-30", to: "11/30/2026", kind: "everything", product: ["a", "b"] }),
  EMPTY_FILTER,
);
is("text is cut at FILTER_TEXT_MAX characters", readSalesFilter({ product: "x".repeat(FILTER_TEXT_MAX + 50) }).product.length, FILTER_TEXT_MAX);
is("a field named like an object's own property is not read as a filter", readSalesFilter(JSON.parse('{"__proto__": {"kind": "calls"}, "constructor": "x"}')), EMPTY_FILTER);
is(
  "the filter goes back to the address bar with only what is set, so a saved filter is the same link",
  [filterQuery(EMPTY_FILTER), filterQuery({ ...EMPTY_FILTER, product: "Ink course", kind: "trials" })],
  ["", "product=Ink+course&kind=trials"],
);
is(
  "and reads back to the same filter",
  readSalesFilter(Object.fromEntries(new URLSearchParams(filterQuery({ product: "Ink & co", from: "2026-11-01", to: "", email: "a@b.co", kind: "products" })))),
  { product: "Ink & co", from: "2026-11-01", to: "", email: "a@b.co", kind: "products" },
);

part("Filtering");
const titles = (rows: FilterableSale[]) => rows.map((r) => `${r.title}/${r.email}`);
is("the empty filter keeps every sale, in the order given", filterSales(SALES, EMPTY_FILTER).length, SALES.length);
is("by product: the words of the title, any case", titles(filterSales(SALES, { ...EMPTY_FILTER, product: "ink" })), ["Ink course/cy@example.com", "Ink course/dee@example.com"]);
is("by buyer: part of the email address, any case", titles(filterSales(SALES, { ...EMPTY_FILTER, email: "ANA@" })), ["Watercolor basics/ana@example.com", "Support my work/ana@example.com"]);
is(
  "by day, both ends included, counted in UTC as the list shows them",
  titles(filterSales(SALES, { ...EMPTY_FILTER, from: "2026-11-03", to: "2026-11-04" })),
  ["Watercolor basics/ben@example.com", "Ink course/cy@example.com"],
);
is("a start after the end keeps nothing (said by the page, never swapped in silence)", filterSales(SALES, { ...EMPTY_FILTER, from: "2026-11-06", to: "2026-11-01" }).length, 0);
is(
  "by kind: products, calls, tips and free trials are apart",
  (["products", "calls", "tips", "trials"] as const).map((kind) => filterSales(SALES, { ...EMPTY_FILTER, kind }).length),
  [3, 1, 1, 1],
);
is("a sale with no email address is kept by every filter but one on the buyer", [filterSales([sale({ email: null })], EMPTY_FILTER).length, filterSales([sale({ email: null })], { ...EMPTY_FILTER, email: "a" }).length], [1, 0]);

part("Total and average of what is filtered");
is(
  "per currency, never added together; the total is the sum of the sales kept; a trial is an order but out of the average",
  salesTotals(SALES),
  [
    { currency: "EUR", orders: 1, charged: 1, totalCents: 2_500, averageCents: 2_500 },
    { currency: "USD", orders: 6, charged: 5, totalCents: 2_900 + 2_900 + 9_900 + 500 + 15_000, averageCents: Math.round((2_900 + 2_900 + 9_900 + 500 + 15_000) / 5) },
  ],
);
const ink = filterSales(SALES, { ...EMPTY_FILTER, product: "ink" });
is("the total of a filter matches its sales exactly", salesTotals(ink), [{ currency: "USD", orders: 2, charged: 1, totalCents: 9_900, averageCents: 9_900 }]);
is("only trials: orders, nothing charged, no average (never 0)", salesTotals(filterSales(SALES, { ...EMPTY_FILTER, kind: "trials" })), [{ currency: "USD", orders: 1, charged: 0, totalCents: 0, averageCents: null }]);
is("nothing kept: no totals, never a total of 0", salesTotals([]), []);
is("an average is rounded to the nearest cent, half up", salesTotals([sale({ amount: 1 }), sale({ amount: 2 })])[0].averageCents, 2);
for (const [label, amount] of [["a fraction of a cent", 10.5], ["a negative amount", -100], ["not a number", Number.NaN], ["past the safe integers", 2 ** 53]] as const) {
  is(`an amount that is ${label} is unknown: no totals at all, never one that counts it as zero`, salesTotals([sale({}), sale({ amount })]), null);
}
is("a currency that is not three letters is unknown too", salesTotals([sale({ currency: "" })]), null);

done();
