/**
 * Sales by discount code (760 [STN7], unit 2; lib/discount-impact.ts,
 * components/discount-impact.tsx; added 16 November 2026). The table by kind
 * of discount said "Discount code" for every code together; this one says
 * which code sold. Checked:
 *
 *   - each checkout with a code is grouped by the code its own note names (a
 *     code from a link, a code for returning buyers, a call's code), compared
 *     upper case as Stripe compares codes; a code a buyer typed in Stripe's
 *     own box is not named by the checkout, so those are one row, said
 *     plainly, never guessed;
 *   - the same days, currency and checkouts as the table by kind (no
 *     one-click extras, tips, other currencies, other kinds of discount), and
 *     the rows add up to its "Discount code" row;
 *   - at most CODE_ROWS_MAX codes one by one, the rest in one row, so the
 *     table stays short; a note that is not a code is never shown as one;
 *   - nothing more is asked of Stripe: worked out from the same sales;
 *   - the numbers kept for the API take the rows in a checked shape, and a
 *     copy kept before they existed still opens;
 *   - the studio shows a real table with a caption, column and row headers,
 *     money with its currency, the refunded column only when refunds were
 *     read, and nothing when no sale had a code.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DiscountImpact } from "@/components/discount-impact";
import { CODE_ROWS_MAX, codeOf, discountCodes, discountImpact, type DiscountSale } from "@/lib/discount-impact";
import { keptNumbersCopy, openKeptNumbers } from "@/lib/api-numbers";
import { studioStats, type Stats } from "@/lib/stats";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 16, 12);

const checkout = (daysAgo: number, paid: number, off: number, meta: Record<string, string> = {}, pi = "", email = "buyer@example.com"): DiscountSale => ({
  created: NOW - daysAgo * DAY,
  cents: paid,
  currency: "usd",
  upsell: false,
  paymentIntent: pi,
  row: { customer_details: { email }, total_details: { amount_discount: off }, metadata: { store: "harbor", product: "guide", ...meta } },
});

part("Which code a checkout names");
is("a code from a link, upper case", codeOf({ metadata: { code: "spring" } }), "SPRING");
is("a code for returning buyers", codeOf({ metadata: { returning: "THANKS-10" } }), "THANKS-10");
is("spaces around it are not part of it", codeOf({ metadata: { code: "  vip " } }), "VIP");
is("none named: a code typed in Stripe's box, or no code", [codeOf({ metadata: {} }), codeOf({}), codeOf({ metadata: null })], [null, null, null]);
is("a note that is not a code is never shown as one", [
  codeOf({ metadata: { code: "<b>x</b>" } }),
  codeOf({ metadata: { code: "AB" } }),
  codeOf({ metadata: { code: "X".repeat(25) } }),
  codeOf({ metadata: { code: 12345 as unknown as string } }),
  codeOf({ metadata: { code: "SPR ING" } }),
], [null, null, null, null, null]);

part("Sales by code, last 90 days");
const sales: DiscountSale[] = [
  checkout(1, 1500, 500, { code: "SPRING" }, "pi_spring_1"),
  checkout(2, 1500, 500, { code: "spring" }, "pi_spring_2"),
  checkout(3, 1600, 400, { returning: "THANKS" }, "pi_thanks_1"),
  // Typed in Stripe's own box: the checkout cannot say which code it was.
  checkout(4, 1800, 200, {}, "pi_typed_1"),
  // A call's code taken off before Stripe's page (lib/deposit-code.ts): its note says how much.
  checkout(5, 900, 0, { code: "CALL20", code_off: "300" }, "pi_call_1"),
  // Left out: full price, another kind of discount, a one-click extra, a tip, another currency, before the 90 days.
  checkout(1, 2000, 0, {}, "pi_full"),
  checkout(1, 1600, 400, { sale: "20" }, "pi_sale"),
  { ...checkout(1, 900, 100, { code: "SPRING" }), upsell: true },
  checkout(1, 500, 0, { kind: "tip", code: "SPRING" }),
  { ...checkout(1, 1500, 500, { code: "SPRING" }), currency: "eur" },
  checkout(120, 1500, 500, { code: "OLD" }),
];
const refunded = new Set(["pi_spring_2"]);
const codes = discountCodes(sales, refunded, "usd", NOW);
is("each code's sales, revenue, what it took off and refunds; most sales first; typed codes last", codes, [
  { code: "SPRING", group: "code", sales: 2, cents: 3000, off: 1000, refunded: 1 },
  { code: "THANKS", group: "code", sales: 1, cents: 1600, off: 400, refunded: 0 },
  { code: "CALL20", group: "code", sales: 1, cents: 900, off: 300, refunded: 0 },
  { code: null, group: "typed", sales: 1, cents: 1800, off: 200, refunded: 0 },
]);
const kinds = discountImpact(sales, refunded, "usd", NOW);
const codeRow = kinds?.find((row) => row.kind === "code");
is("the rows add up to the table's Discount code row", [
  codes.reduce((n, r) => n + r.sales, 0),
  codes.reduce((n, r) => n + r.cents, 0),
  codes.reduce((n, r) => n + r.off, 0),
  codes.reduce((n, r) => n + r.refunded, 0),
], [codeRow?.sales, codeRow?.cents, codeRow?.off, codeRow?.refunded]);
is("no sale with a code, no rows", discountCodes([checkout(1, 2000, 0), checkout(1, 1600, 400, { sale: "20" })], new Set(), "usd", NOW), []);
is("ties: more revenue first, then the code's letters", discountCodes([
  checkout(1, 1000, 100, { code: "BETA" }),
  checkout(1, 1000, 100, { code: "ALPHA" }),
  checkout(1, 2000, 100, { code: "ZED" }),
], new Set(), "usd", NOW).map((r) => r.code), ["ZED", "ALPHA", "BETA"]);

part("A short table, whatever the store had");
const many: DiscountSale[] = Array.from({ length: CODE_ROWS_MAX + 3 }, (_, i) => checkout(1, 1000 + i, 100, { code: `CODE${String(i).padStart(2, "0")}` }, `pi_many_${i}`));
const manyRows = discountCodes(many, new Set(["pi_many_0"]), "usd", NOW);
is("CODE_ROWS_MAX codes one by one, then one row for the rest", [manyRows.length, manyRows.filter((r) => r.group === "code").length, manyRows.at(-1)?.group], [CODE_ROWS_MAX + 1, CODE_ROWS_MAX, "others"]);
is("the rest is added up, never dropped", [
  manyRows.at(-1),
  manyRows.reduce((n, r) => n + r.sales, 0),
  manyRows.reduce((n, r) => n + r.refunded, 0),
], [{ code: null, group: "others", sales: 3, cents: 1000 + 1001 + 1002, off: 300, refunded: 1 }, CODE_ROWS_MAX + 3, 1]);

part("Kept for the API");
const keptStore = { sid: "discount-codes", statsId: "c".repeat(32), handle: "discount-codes", name: "Codes", currency: "usd", links: [] } as unknown as Parameters<typeof keptNumbersCopy>[0];
const kept = (discounts: unknown) => {
  const empty = { visitors: 0, views: 0, checkouts: 0, sources: [], mediums: [], campaigns: [], checkoutsByProduct: {}, viewsByProduct: {}, linkClicks: {}, countries: [], devices: [], checkoutsBySource: [], freeBySource: [], reach: {}, heard: {}, searchMisses: [] };
  const none = { visitors: 0, views: 0, checkouts: 0 };
  const data = studioStats(keptStore, { days: [], windows: { d7: empty, d30: empty, d90: empty }, previous: { d7: none, d30: none, d90: none }, life: null } as unknown as Stats, null, "none", []);
  (data as { discounts?: unknown }).discounts = discounts;
  const raw = keptNumbersCopy(keptStore, "plain", data, NOW);
  return raw ? openKeptNumbers(keptStore, "plain", raw, NOW) !== null : null;
};
is("with the rows, without them (kept before), and malformed ones refused", [
  kept({ rows: kinds, refundsRead: true, elsewhere: [], codes }),
  kept({ rows: kinds, refundsRead: true, elsewhere: [] }),
  kept({ rows: kinds, refundsRead: true, elsewhere: [], codes: [{ code: "SPRING", group: "code", sales: "2", cents: 3000, off: 1000, refunded: 1 }] }),
  kept({ rows: kinds, refundsRead: true, elsewhere: [], codes: [{ code: 7, group: "code", sales: 2, cents: 3000, off: 1000, refunded: 1 }] }),
  kept({ rows: kinds, refundsRead: true, elsewhere: [], codes: [{ code: null, group: "secret", sales: 2, cents: 3000, off: 1000, refunded: 1 }] }),
  kept({ rows: kinds, refundsRead: true, elsewhere: [], codes: "SPRING" }),
], [true, true, false, false, false, false]);

part("In the studio");
const html = renderToStaticMarkup(createElement(DiscountImpact, { rows: kinds ?? [], refundsRead: true, currency: "usd", codes }));
const table = html.slice(html.indexOf("data-discount-codes"));
is("a table with its own caption", table.includes('<caption id="numbers-discount-codes"') && table.includes("Sales by discount code, last 90 days"), true);
is("column headers", ["Code", "Sales", "Revenue", "Given off", "Refunded"].every((h) => table.includes(`<th scope="col"`) && table.includes(`>${h}</th>`)), true);
is("each code is a row header, as the creator would type it", ['<th scope="row"', ">SPRING</th>", ">CALL20</th>", ">THANKS</th>"].every((part) => table.includes(part)), true);
is("typed codes said plainly", table.includes("Typed at checkout (Stripe does not say which code)"), true);
is("money with its currency", table.includes("$30") && table.includes("$10"), true);
is("the scrolling region is named by its caption and reachable by keyboard", table.includes('aria-labelledby="numbers-discount-codes"') && table.includes('tabindex="0"'), true);
const noRefunds = renderToStaticMarkup(createElement(DiscountImpact, { rows: kinds ?? [], refundsRead: false, currency: "usd", codes }));
is("no refunded column when refunds were not read", noRefunds.slice(noRefunds.indexOf("data-discount-codes")).includes(">Refunded</th>"), false);
const others = renderToStaticMarkup(createElement(DiscountImpact, { rows: kinds ?? [], refundsRead: true, currency: "usd", codes: manyRows }));
is("the rest said as other codes", others.includes("Other codes"), true);
is("no table when no sale had a code", [
  renderToStaticMarkup(createElement(DiscountImpact, { rows: kinds ?? [], refundsRead: true, currency: "usd", codes: [] })).includes("data-discount-codes"),
  renderToStaticMarkup(createElement(DiscountImpact, { rows: kinds ?? [], refundsRead: true, currency: "usd" })).includes("data-discount-codes"),
], [false, false]);

done();
