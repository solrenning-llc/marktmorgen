/**
 * The creator's own profit before taxes (545 [LU1], unit 1,
 * lib/creator-profit-rules.ts; added 1 November 2026). Checked: an empty
 * cost is "not set", never 0; the fee is the one given, never estimated;
 * refunds, costs per unit, other costs and ads taken off; a missing cost
 * makes the line incomplete and an unread figure unavailable, never zero;
 * currencies apart; a loss said in words; the before-taxes sentence; an
 * export cell never runs as a formula.
 */
import { BEFORE_TAXES, SHARE_WORDS, SOURCES, csvRow, orderProfit, periodProfit, productKey, productProfit, profitWords, readCostPerSale } from "@/lib/creator-profit-rules";
import { done, is, part } from "./check";

part("The cost the creator enters");
is("empty is not set, never 0", [readCostPerSale("", "usd"), readCostPerSale("   ", "usd")], [null, null]);
is("an amount in the store's currency", [readCostPerSale("4.50", "usd"), readCostPerSale("300", "jpy")], [450, 300]);
is("not an amount: refused, not guessed", [readCostPerSale("cheap", "usd"), readCostPerSale("-2", "usd")], [undefined, undefined]);
is("zero, typed, is zero", readCostPerSale("0", "usd"), 0);

part("One order");
const order = { currency: "usd", paid: 4900, refunded: 0, fee: 172, lines: [{ productId: "a", units: 1, costPerSale: 800 }], otherCosts: 0 };
is("paid, less the real fee and the cost", orderProfit(order), { state: "complete", cents: 3928 });
is("the fee is exactly the one read, not a rate", orderProfit({ ...order, fee: 199 }), { state: "complete", cents: 3901 });
is("a refund is taken off", orderProfit({ ...order, refunded: 4900 }), { state: "complete", cents: -972 });
is("cost per unit, times units", orderProfit({ ...order, lines: [{ productId: "a", units: 3, costPerSale: 800 }] }), { state: "complete", cents: 2328 });
is("a cost not set: incomplete, never as if 0", orderProfit({ ...order, lines: [...order.lines, { productId: "b", units: 1, costPerSale: null }] }), { state: "incomplete", why: "cost not set" });
is("a partial refund: the rest of the payment counts, the cost stays", orderProfit({ ...order, refunded: 1900 }), { state: "complete", cents: 2028 });
is("a line that is not a whole number of units, or a cost that is not an amount: unavailable, never rounded", [orderProfit({ ...order, lines: [{ productId: "a", units: 2.9, costPerSale: 800 }] }).state, orderProfit({ ...order, lines: [{ productId: "a", units: Number.NaN, costPerSale: 800 }] }).state, orderProfit({ ...order, lines: [{ productId: "a", units: 1, costPerSale: -500 }] }).state, orderProfit({ ...order, lines: [{ productId: "a", units: 1, costPerSale: Number.NaN }] }).state], ["unavailable", "unavailable", "unavailable", "unavailable"]);
is("a fee or a payment not read: unavailable", [orderProfit({ ...order, fee: null }).state, orderProfit({ ...order, paid: null }).state, orderProfit({ ...order, otherCosts: null }).state], ["unavailable", "unavailable", "unavailable"]);

part("A period, per currency");
const eur = { ...order, currency: "eur", paid: 3000, fee: 120, lines: [{ productId: "a", units: 1, costPerSale: 500 }] };
const totals = periodProfit([order, order, eur], { usd: 1000 });
is("each currency on its own, ads taken off where they were spent", [totals.get("usd"), totals.get("eur")], [{ state: "complete", cents: 3928 * 2 - 1000 }, { state: "complete", cents: 2380 }]);
is("one incomplete order makes its currency's total incomplete", periodProfit([order, { ...order, lines: [{ productId: "b", units: 1, costPerSale: null }] }], {}).get("usd"), { state: "incomplete", why: "cost not set" });
is("ads in a currency with no order are still taken off: a loss, never lost", periodProfit([order], { eur: 5000 }).get("eur"), { state: "complete", cents: -5000 });
is("a currency written in capitals is the same currency", periodProfit([{ ...order, currency: "USD" }], { usd: 1000 }).get("usd"), { state: "complete", cents: 2928 });
is("ads that could not be read make the total unavailable", periodProfit([order], { usd: null }).get("usd"), { state: "unavailable" });

part("Per product and option");
const two = { currency: "usd", paid: 6000, refunded: 0, fee: 300, otherCosts: 0, lines: [{ productId: "a", units: 1, costPerSale: 1000, charged: 4000 }, { productId: "b", optionId: "big", units: 1, costPerSale: 500, charged: 2000 }] };
const per = productProfit([two, two]);
is("the fee shared by each line's part of the payment, each line's own cost", [per.get(productKey("usd", "a", null)), per.get(productKey("usd", "b", "big"))], [{ state: "complete", cents: 2 * (3800 - 1000) }, { state: "complete", cents: 2 * (1900 - 500) }]);
is("the parts add up to the order exactly, the rounding on the last line", (() => { const p = productProfit([{ ...two, fee: 301 }]); const a = p.get(productKey("usd", "a", null)), b = p.get(productKey("usd", "b", "big")); return a?.state === "complete" && b?.state === "complete" ? a.cents + b.cents + 1500 : null; })(), 6000 - 301);
is("a line with no cost set is incomplete; the other still counts", [productProfit([{ ...two, lines: [two.lines[0], { ...two.lines[1], costPerSale: null }] }]).get(productKey("usd", "b", "big"))?.state, productProfit([{ ...two, lines: [two.lines[0], { ...two.lines[1], costPerSale: null }] }]).get(productKey("usd", "a", null))?.state], ["incomplete", "complete"]);
is("an order not read: each of its products unavailable", productProfit([{ ...two, fee: null }]).get(productKey("usd", "a", null)), { state: "unavailable" });
is("the rule said beside the figures, ads apart", [SHARE_WORDS.includes("by what each was charged"), SHARE_WORDS.includes("Ads are not included per product.")], [true, true]);
is("the rounding goes on the last line", (() => { const p = productProfit([{ ...two, fee: 301, lines: [{ ...two.lines[0], costPerSale: 0 }, { ...two.lines[1], costPerSale: 0 }] }]); return [p.get(productKey("usd", "a", null)), p.get(productKey("usd", "b", "big"))]; })(), [{ state: "complete", cents: 3799 }, { state: "complete", cents: 1900 }]);
is("a loss shared exactly, floored toward minus infinity", (() => { const p = productProfit([{ currency: "usd", paid: 0, refunded: 0, fee: 61, otherCosts: 0, lines: [1, 2, 3].map((n) => ({ productId: `p${n}`, units: 1, costPerSale: 0, charged: 100 })) }]); return [1, 2, 3].map((n) => (p.get(productKey("usd", `p${n}`, null)) as { cents: number }).cents); })(), [-21, -21, -19]);
is("never two products under one key", productKey("usd", "a|b", null) === productKey("usd", "a", "b|") || productKey("usd", "a", "") === productKey("usd", "a", null), false);
is("an order with no line, or lines charged nothing, cannot be shared: unavailable, never dropped", [productProfit([{ ...two, lines: [] }]).get(productKey("usd", "", null)), productProfit([{ ...two, lines: two.lines.map((l) => ({ ...l, charged: 0 })) }]).get(productKey("usd", "a", null))], [{ state: "unavailable" }, { state: "unavailable" }]);
is("a charged amount that is not a whole amount: unavailable", productProfit([{ ...two, lines: [{ ...two.lines[0], charged: 10.5 }, two.lines[1]] }]).get(productKey("usd", "a", null)), { state: "unavailable" });
is("large amounts, no cent lost", (() => { const big = { currency: "usd", paid: 900_000_000, refunded: 0, fee: 0, otherCosts: 0, lines: [{ productId: "a", units: 1, costPerSale: 0, charged: 899_999_999 }, { productId: "b", units: 1, costPerSale: 0, charged: 1 }] }; const p = productProfit([big]); return [p.get(productKey("usd", "a", null)), p.get(productKey("usd", "b", null))]; })(), [{ state: "complete", cents: 899_999_999 }, { state: "complete", cents: 1 }]);

part("Said plainly");
is("a loss in words, not only a color", profitWords({ state: "complete", cents: -972 }, "usd"), "$9.72 loss");
is("zero and yen", [profitWords({ state: "complete", cents: 0 }, "usd"), profitWords({ state: "complete", cents: -972 }, "jpy")], ["$0", "¥972 loss"]);
is("incomplete and unavailable in words", [profitWords({ state: "incomplete", why: "cost not set" }, "usd"), profitWords({ state: "unavailable" }, "usd")], ["Incomplete: cost not set", "Count unavailable"]);
is("before taxes, and no tax advice", BEFORE_TAXES, "Before taxes. Marktmorgen does not know your taxes; check with your own tax rules.");
is("where each number comes from", [SOURCES.fee, SOURCES.cost, SOURCES.ads], ["from your Stripe account", "you entered", "recorded ads"]);

part("The export");
is("the shared writer: every cell quoted", csvRow(["Bread course", "$39.28 loss", 1]), '"Bread course","$39.28 loss","1"');
is("commas and quotes kept in their cell", csvRow(['Bread, "sourdough"']), '"Bread, ""sourdough"""');
is("a cell that starts like a formula, spaces first too, stays text", [csvRow(["=HYPERLINK(1)"]), csvRow([" =1+1"]), csvRow(["@x"])], ['"\'=HYPERLINK(1)"', '"\' =1+1"', '"\'@x"']);
is("a cost past the ceiling is refused", readCostPerSale("2000000", "usd"), undefined);
done();
