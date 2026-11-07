/**
 * 642 [WG2], Claude 5's two LIGHT notes on #2690:
 *
 *   - the plan line "from $X each" took the lowest payment of every price,
 *     an off-sale one included, so it named a payment nobody can choose;
 *   - the count under an off-sale price said "members still pay on it", but
 *     it counts every live membership on it: paying, in a free trial, or with
 *     a payment late (LIVE in lib/membership-numbers.ts). The words now say so.
 */
import { readFileSync } from "node:fs";
import { lowestPaymentOnSale } from "@/lib/product-extras";
import type { ProductOption } from "@/lib/product-option";
import { done, is, part } from "./check";

const option = (over: Partial<ProductOption>): ProductOption => ({ id: "o1", label: "Basic", priceCents: 1000, file: null, link: "https://example.com/a", details: [], best: false, ...over });
const plan = { payments: 3, interval: "month" as const, amountCents: 500, options: { p1: 500, p2: 1000, p3: 1500 } };

part("\"from $X each\" reads only the prices on sale");
is("with every price on sale, the lowest", lowestPaymentOnSale(plan, [option({ id: "p1" }), option({ id: "p2" }), option({ id: "p3" })]), 500);
is("the off-sale price's payment is never the \"from\"", lowestPaymentOnSale(plan, [option({ id: "p1", offSale: true }), option({ id: "p2" }), option({ id: "p3" })]), 1000);
is("a price on sale with no payment set adds nothing", lowestPaymentOnSale(plan, [option({ id: "p1", offSale: true }), option({ id: "p4" }), option({ id: "p3" })]), 1500);
is("no price on sale with a payment: nothing to say", lowestPaymentOnSale(plan, [option({ id: "p1", offSale: true }), option({ id: "p4" })]), null);
is("a plan without payments per price: nothing to say", lowestPaymentOnSale({ ...plan, options: undefined }, [option({ id: "p1" })]), null);
// Claude 5's focal return on #2690: a price on sale that delivers nothing (no file, link, course, podcast or shipping) is
// never offered (offeredOptions, planFor gives it no plan), so its payment is never the "from" either.
is("a price on sale that delivers nothing is not the \"from\"", lowestPaymentOnSale(plan, [option({ id: "p1", link: null }), option({ id: "p2" })]), 1000);
is("unless the product itself delivers (a course, a podcast, shipping)", lowestPaymentOnSale(plan, [option({ id: "p1", link: null }), option({ id: "p2" })], true), 500);
const extras = readFileSync("components/checkout-extras.tsx", "utf8");
is("the plan line reads it", /lowestPaymentOnSale\(current, product\.options\)/.test(extras), true);
is("and no longer prints the plan's own lowest", extras.includes("from ${formatMoney(current.amountCents, currency)} each"), false);

part("The count says who it counts");
const editor = readFileSync("components/product-editor.tsx", "utf8").replace(/\s+/g, " ");
is("it never says \"still pay on it\" for a count that includes trials", /members? still pays? on it here/.test(editor), false);
is("one", editor.includes("1 membership is still on it here (paying, in a free trial or with a late payment), as of your last membership reading."), true);
is("several", editor.includes("memberships are still on it here (paying, in a free trial or with a late payment), as of your last membership reading."), true);
done();
