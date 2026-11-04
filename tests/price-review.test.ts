/**
 * "Check what buyers pay" (487 [IT4], item 8; added 2 November 2026): every
 * change a save makes to what buyers pay for a product they can see, one row
 * each, the way it is now and once saved, each leading back to its own field;
 * nothing for a draft, an unreadable price, a save the route refuses or a
 * change that is not one; and, for a membership, what happens to members who
 * already joined, which is what the code does.
 */
import { readFileSync } from "node:fs";
import { optionPriceReview, priceReview, type PricedProduct, type PriceDraft } from "@/lib/price-review";
import { formatMoney, readMoney } from "@/lib/money";
import { done, is, part } from "./check";

const read = (typed: string) => readMoney(typed, "usd");
const money = (cents: number) => formatMoney(cents, "usd");
const NONE = { free: false, membership: false, choose: false };
const once: PricedProduct = { hidden: false, options: 0, priceCents: 2900, interval: null, suggestedCents: null, intro: null, yearlyCents: null, id: "p1", tiers: [], bounds: { min: 100, max: 500_000 }, refuses: NONE, taxOnTop: false };
const member: PricedProduct = { ...once, priceCents: 900, interval: "month" };
const chosen: PricedProduct = { ...once, priceCents: 500, suggestedCents: 1500 };
const draft = (more: Partial<PriceDraft>): PriceDraft => ({ price: "29", every: "", pwyw: false, suggested: "", introPrice: "", introCount: "1", yearlyPrice: "", ...more });
const review = (p: PricedProduct, d: Partial<PriceDraft>) => priceReview(p, draft(d), read, money);
const rows = (r: ReturnType<typeof priceReview>) => r?.rows.map((x) => [x.label, x.now, x.then, x.field]) ?? null;
const PRICE = "Your store's price is this, before any sale, offer or discount code.";
const TAXED = "Your store's price is this, before any sale, offer or discount code, plus sales tax or VAT where it applies.";
const STORE = `Your store shows this as soon as you save. ${PRICE}`;
const KEEP = `New members join at this once you save. ${PRICE} A checkout already open keeps what it opened with. Members who already joined keep the price, schedule, trial and end they joined at.`;
// A trial or an end alone: no price changed, so nothing said about sales or tax.
const KEEP_TERMS = "New members join at this once you save. A checkout already open keeps what it opened with. Members who already joined keep the price, schedule, trial and end they joined at.";
const STOPPED = "Members who already joined are still charged what they joined at. Saving does not cancel them. Each membership ends when they or you cancel it, or after its last payment. To stop them, cancel their memberships in your Stripe dashboard. New buyers see this once you save.";
const STILL = `${STOPPED} ${PRICE}`;

part("Bought once");
is("a new price: one row, back to the price", [rows(review(once, { price: "39" })), review(once, { price: "39" })?.note], [[["Price", "$29", "$39", "price"]], STORE]);
is("made free: said as given for an email address", rows(review(once, { price: "0" })), [["Price", "$29", "Free, for an email address", "price"]]);
is("the same amount written another way is not a change", [review(once, { price: "29.00" }), review(once, { price: "29" })], [null, null]);
is("nothing for a draft, or a price that cannot be read", [review({ ...once, hidden: true }, { price: "39" }), review(once, { price: "abc" })], [null, null]);
is("made free: nothing said about sales or tax, there being no price", review(once, { price: "0" })?.note, "Your store shows this as soon as you save.");

part("A membership that stays one");
is("a new price: members who already joined keep theirs", [rows(review(member, { price: "12", every: "month" })), review(member, { price: "12", every: "month" })?.note], [[["Price", "$9", "$12", "price"]], KEEP]);
is("a new schedule: how buyers pay, back to the schedule, with the price shown", rows(review(member, { price: "9", every: "year" })), [["How buyers pay", "Every month", "Every year", "every"], ["Price", "$9", "$9", "price"]]);
const withYearly = { ...member, yearlyCents: 9000, intro: { cents: 100, count: 3 } };
const withIntro = { ...member, intro: { cents: 100, count: 3 } };
const yearlyOnly = { ...member, yearlyCents: 9000 };
is("a new schedule takes the yearly price away, and the introductory price down to one payment: both said", rows(review(withYearly, { price: "9", every: "week", yearlyPrice: "90", introPrice: "1", introCount: "3" })), [["How buyers pay", "Every month", "Every week", "every"], ["Price", "$9", "$9", "price"], ["Introductory price", "$1 for the first 3 payments", "$1 for the first payment", "intro"], ["Yearly price", "$90", "None", "yearly"]]);
is("a new yearly or introductory price on its own", [rows(review(yearlyOnly, { price: "9", every: "month", yearlyPrice: "80" })), rows(review(withIntro, { price: "9", every: "month", introPrice: "2", introCount: "3" }))], [[["Yearly price", "$90", "$80", "yearly"]], [["Introductory price", "$1 for the first 3 payments", "$2 for the first 3 payments", "intro"]]]);
is("an introductory or yearly price that cannot be read: nothing reviewed", [review(yearlyOnly, { price: "9", every: "month", yearlyPrice: "x" }), review(withIntro, { price: "9", every: "month", introPrice: "x" })], [null, null]);

const trialed: PricedProduct = { ...member, trialDays: 7, payments: 12 };
is("a new free trial or a new end, each its own row back to its field; members who joined keep theirs", [rows(review(trialed, { price: "9", every: "month", trial: "14", payments: "12" })), rows(review(trialed, { price: "9", every: "month", trial: "7", payments: "" })), review(trialed, { price: "9", every: "month", trial: "14", payments: "12" })?.note], [[["Free trial", "7 days free", "14 days free", "trial"]], [["Ends", "After 12 payments", "Runs until canceled", "payments"]], KEEP_TERMS]);
is("the same trial and end: nothing; a trial or end that is not a whole number: nothing, the save says why", [review(trialed, { price: "9", every: "month", trial: "7", payments: "12" }), review(trialed, { price: "9", every: "month", trial: "seven", payments: "12" }), review(trialed, { price: "9", every: "month", trial: "7", payments: "1.5" })], [null, null, null]);

is("a trial or an end the route would refuse (out of range): nothing reviewed", [review(trialed, { price: "9", every: "month", trial: "7", payments: "1" }), review(trialed, { price: "9", every: "month", trial: "7", payments: "37" }), review(trialed, { price: "9", every: "month", trial: "91", payments: "12" }), review(trialed, { price: "9", every: "month", trial: "-3", payments: "12" })], [null, null, null, null]);
is("nor a combination it refuses: an introductory price with a trial or an end, a yearly price with an end", [review(member, { price: "9", every: "month", introPrice: "1", trial: "7" }), review(member, { price: "9", every: "month", introPrice: "1", payments: "12" }), review(member, { price: "9", every: "month", yearlyPrice: "90", payments: "12" })], [null, null, null]);
is("something bought once neither ends nor runs, either way: said as not a membership, never an ambiguous None", [rows(review(trialed, { price: "9", every: "" }))?.find((r) => r[0] === "Ends"), rows(review(once, { price: "9", every: "month", payments: "12" }))?.find((r) => r[0] === "Ends")], [["Ends", "After 12 payments", "Not a membership", "payments"], ["Ends", "Not a membership", "After 12 payments", "payments"]]);
is("an introductory price with a trial or an end on any schedule, or on a yearly membership with an end: the route's own rules", [review(member, { price: "9", every: "week", introPrice: "1", trial: "3" }), review(member, { price: "9", every: "year", introPrice: "1", payments: "3" }), rows(review(member, { price: "9", every: "month", yearlyPrice: "90", trial: "7" }))], [null, null, [["Free trial", "None", "7 days free", "trial"], ["Yearly price", "None", "$90", "yearly"]]]);
is("on a product with price options, the trial and the end are still reviewed, with no price row", rows(review({ ...trialed, options: 2 }, { price: "9", every: "month", trial: "14", payments: "12" })), [["Free trial", "7 days free", "14 days free", "trial"]]);

part("A membership that stops being one");
const toOnce = review(member, { price: "9", every: "" });
is("bought once: said that members already joined keep being charged until canceled, and where to stop them", [rows(toOnce), toOnce?.note], [[["How buyers pay", "Every month", "Once", "every"], ["Price", "$9", "$9", "price"]], STILL]);
is("made free: the same, the price said as free, with nothing about sales or tax", [rows(review(member, { price: "0", every: "" })), review(member, { price: "0", every: "" })?.note], [[["How buyers pay", "Every month", "Once", "every"], ["Price", "$9", "Free, for an email address", "price"]], STOPPED]);
is("bought once made a membership: nobody was a member, so the store's note", [rows(review(once, { price: "9", every: "month" })), review(once, { price: "9", every: "month" })?.note], [[["How buyers pay", "Once", "Every month", "every"], ["Price", "$29", "$9", "price"]], STORE]);

part("Buyers choose what to pay");
is("a new lowest price", rows(review(chosen, { price: "7", pwyw: true, suggested: "15" })), [["Lowest price", "$5", "$7", "price"]]);
is("a new starting price", rows(review(chosen, { price: "5", pwyw: true, suggested: "20" })), [["Price their box starts at", "$15", "$20", "suggested"]]);
is("switched on: how, back to the choice itself, and where the box starts (the lowest price when none is typed)", rows(review(once, { price: "29", pwyw: true, suggested: "" })), [["How buyers pay", "Once", "They choose what to pay", "pwyw"], ["Lowest price", "$29", "$29", "price"], ["Price their box starts at", "None", "$29", "suggested"]]);
is("switched off: back to once, with the price they will pay", rows(review(chosen, { price: "5", pwyw: false })), [["How buyers pay", "They choose what to pay", "Once", "pwyw"], ["Price", "$5", "$5", "price"]]);
is("a starting price that cannot be read: nothing reviewed", review(chosen, { price: "5", pwyw: true, suggested: "x" }), null);

part("One of several price options");
const week = { label: "5 weeks", priceCents: 3900 };
type OptionContext = { hidden?: boolean; interval?: "month" | null; shown?: boolean; taxOnTop?: boolean; plan?: { payments: number; cents: number } | null; planBefore?: boolean; planAfter?: (cents: number) => boolean };
const opt = (typed: string, hidden = false, interval: "month" | null = null, more: OptionContext = {}) => optionPriceReview(week, typed, { hidden, interval, shown: true, taxOnTop: false, plan: null, planBefore: false, planAfter: () => false, ...more }, read, money);
is("a new price: its own row, named by the option, back to its price field", [opt("45")?.rows.map((r) => [r.label, r.now, r.then]), opt("45")?.note], [[["“5 weeks”", "$39", "$45"]], STORE]);
is("the store's price, before any sale, offer or code, with tax on top where the store adds it", opt("45", false, null, { taxOnTop: true })?.note, `Your store shows this as soon as you save. ${TAXED}`);
is("nothing for the same amount written another way, a price that cannot be read, or a draft", [opt("39.00"), opt("x"), opt("45", true)], [null, null, null]);
is("nothing for an option not offered (nothing to hand over yet), whatever its price", opt("45", false, null, { shown: false }), null);
is("the name as typed, spaces around the price ignored", [optionPriceReview({ label: "Six weeks", priceCents: 3900 }, "  45 ", { hidden: false, interval: null, shown: true, taxOnTop: false, plan: null, planBefore: false, planAfter: () => false }, read, money)?.rows[0].label, opt(" 45 ")?.rows[0].then], ["“Six weeks”", "$45"]);
// The plan as lib/product-extras.ts reads it: offered while the option's 3 payments of $13 cover its price.
const covered = (cents: number) => 3 * 1300 >= cents;
const offered = { plan: { payments: 3, cents: 1300 }, planBefore: true, planAfter: covered };
is("with a payment plan: a price above what its payments add up to stops the plan, and says how to bring it back", opt("45", false, null, offered)?.note, `${STORE} Your payment plan stops being offered on this product. Its 3 payments of $13 for this price add up to $39, less than $45. Raise that payment in the plan to offer it again.`);
is("below it: those who pay in parts still pay what the payments add up to; equal: nothing to say", [opt("35", false, null, offered)?.note, opt("39.50", false, null, { ...offered, planBefore: false, planAfter: () => false })?.note.includes("payment plan")], [`${STORE} Buyers who pay in 3 payments still pay $13 each, $39 in all, until you change it in the plan.`, false]);
is("a plan paused by this price comes back with a lower one, and that is said", [opt("35", false, null, { ...offered, planBefore: false })?.note, opt("36", false, null, { plan: { payments: 3, cents: 1200 }, planBefore: false, planAfter: (cents) => 3600 >= cents })?.note], [`${STORE} Your payment plan is offered again on this product. Buyers who pay in 3 payments pay $13 each, $39 in all.`, `${STORE} Your payment plan is offered again on this product.`]);
is("a plan paused for something else stays paused: nothing said", opt("35", false, null, { ...offered, planBefore: false, planAfter: () => false })?.note, STORE);
is("on a membership: members who joined at it keep it", opt("45", false, "month")?.note, `New members who pick it join at this once you save. ${PRICE} A checkout already open keeps what it opened with. Members who already joined keep the price they joined at.`);
const optionsUi = readFileSync("components/product-editor.tsx", "utf8");
is("the option's editor reviews only a price the save can take, from the plan offered now and with the new price, and sends the price trimmed", [optionsUi.includes("return cents !== null && priceInRange(cents, currency) ? cents : null;"), optionsUi.includes("planBefore: activePlan(product as Listing) !== null,"), optionsUi.includes("planAfter: (cents) => activePlan({ ...product, options: product.options.map((o) => (o.id === option.id ? { ...o, priceCents: cents } : o)) } as Listing) !== null,"), optionsUi.includes("shown: optionDelivers(option, opens)"), optionsUi.includes('{ action: "edit", id: option.id, label, price: price.trim(),')], [true, true, true, true, true]);
is("the option's editor asks first with it, ends on its own confirm button, and a new price typed closes the review", [optionsUi.includes("const review = optionPriceReview(\n                { label: label.trim() || option.label, priceCents: option.priceCents },\n                price,"), optionsUi.includes("if (review && optionReview !== option.id) {"), /onClick=\{save\}>\s*Yes, save what buyers pay/.test(optionsUi.slice(optionsUi.indexOf("option-${option.id}-price-review-title"))), optionsUi.includes("setPrice(event.target.value);\n              setOptionReview(null);")], [true, true, true, true]);

part("Sales, offers, codes and tax: the store's price, not always what a buyer pays");
const taxed = { ...once, taxOnTop: true };
is("tax added on top: said beside the price, on the store's note and a membership's", [review(taxed, { price: "39" })?.note, review({ ...member, taxOnTop: true }, { price: "12", every: "month" })?.note.includes(TAXED)], [`Your store shows this as soon as you save. ${TAXED}`, true]);
is("only how buyers pay changed, on a product with price options: no price, so nothing said about it", review({ ...once, options: 2 }, { price: "29", every: "month" })?.note, "Your store shows this as soon as you save.");
const editorTax = readFileSync("app/studio/page.tsx", "utf8");
is("the studio says tax is on top exactly when the checkout adds it (lib/tax.ts: on, not included)", [editorTax.includes("taxOnTop={store.tax.enabled && !store.tax.included}"), readFileSync("lib/tax.ts", "utf8").includes('store.tax.included ? "inclusive" : "exclusive"')], [true, true]);

part("A save the route refuses is never reviewed (WCAG 3.3.6): the save says why");
is("a price out of the currency's range, above or below", [review(once, { price: "0.50" }), review(once, { price: "5001" }), review(once, { price: "5000" }) !== null], [null, null, true]);
is("a membership at $0, a price buyers choose at $0, or free on price options", [review(member, { price: "0", every: "month" }), review(once, { price: "0", pwyw: true, suggested: "5" }), review({ ...once, options: 2 }, { price: "0" })], [null, null, null]);
is("free, a membership or a price they choose, where the kind refuses it", [review({ ...once, refuses: { ...NONE, free: true } }, { price: "0" }), review({ ...once, refuses: { ...NONE, membership: true } }, { price: "9", every: "month" }), review({ ...once, refuses: { ...NONE, choose: true } }, { price: "29", pwyw: true, suggested: "35" })], [null, null, null]);
is("a starting price below the lowest price or above the currency's most; one at the lowest is fine", [review(chosen, { price: "5", pwyw: true, suggested: "4" }), review(chosen, { price: "5", pwyw: true, suggested: "5001" }), rows(review(chosen, { price: "5", pwyw: true, suggested: "5" }))], [null, null, [["Price their box starts at", "$15", "$5", "suggested"]]]);
is("a price they choose on price options", review({ ...once, options: 2 }, { price: "29", pwyw: true, suggested: "35" }), null);
is("an introductory price at or above the price, below the least charged, or on a plan members switch between", [review(member, { price: "9", every: "month", introPrice: "9" }), review(member, { price: "9", every: "month", introPrice: "0.50" }), review({ ...member, tiers: ["p1"] }, { price: "9", every: "month", introPrice: "5" }), rows(review(member, { price: "9", every: "month", introPrice: "5" }))], [null, null, null, [["Introductory price", "None", "$5 for the first payment", "intro"]]]);
is("a yearly price at or above twelve monthly payments, beside an introductory price, or on a plan members switch between", [review(member, { price: "9", every: "month", yearlyPrice: "108" }), review(member, { price: "9", every: "month", yearlyPrice: "90", introPrice: "5" }), review({ ...member, tiers: ["p1"] }, { price: "9", every: "month", yearlyPrice: "90" }), rows(review(member, { price: "9", every: "month", yearlyPrice: "107" }))], [null, null, null, [["Yearly price", "None", "$107", "yearly"]]]);
is("an introductory or yearly price on price options", [review({ ...member, options: 2 }, { price: "9", every: "month", introPrice: "5" }), review({ ...member, options: 2 }, { price: "9", every: "month", yearlyPrice: "90" })], [null, null]);
const rules = readFileSync("lib/store.ts", "utf8");
is("the rules are the save's own: free or in range, never free as a membership or with options, the kinds that refuse", [rules.includes('if (priceCents === 0) return { title, priceCents };\n  if (!priceInRange(priceCents, currency)) return "price";'), rules.includes('if (fields.priceCents === 0 && recurring) return { ok: false, reason: "free" };'), rules.includes('if (fields.priceCents === 0 && product.options.length > 0) return { ok: false, reason: "free" };'), rules.includes('if (isBundle(product) && (fields.priceCents === 0 || recurring || pwywCents !== null)) return { ok: false, reason: "bundle" };')], [true, true, true, true]);
const editorRules = readFileSync("components/product-editor.tsx", "utf8");
is("the editor gives the review the currency's range, the plans members switch between and what the kind refuses", [editorRules.includes("bounds: priceBounds(currency),"), editorRules.includes("free: Boolean(product.call || product.course || product.podcast || product.shipping) || isBundle(product),"), editorRules.includes("choose: Boolean(product.call || product.plan || product.bumps.length || product.shipping) || isBundle(product),"), readFileSync("app/studio/page.tsx", "utf8").includes("tiers={store.tiers}")], [true, true, true, true]);

part("A product with price options");
const optioned = { ...once, options: 2 };
is("how buyers pay is still reviewed, without a price row: each option has its own", [rows(review(optioned, { price: "29", every: "month" })), rows(review(optioned, { price: "39" }))], [[["How buyers pay", "Once", "Every month", "every"]], null]);

part("What the member notes rest on");
const checkout = readFileSync("lib/store-checkout.ts", "utf8");
const route = readFileSync("app/api/store/product/route.ts", "utf8");
is("an option's price is what its checkout charges, read on the server from the saved option", checkout.includes("const priceCents = plan ? plan.amountCents : chosen ? chosen.priceCents : product.priceCents;"), true);
is("each membership is made at checkout at that moment's price and schedule; saving the product or one of its prices calls Stripe for no subscription", [checkout.includes('body.set("line_items[0][price_data][recurring][interval]", membership.interval);'), /\/subscriptions/.test(route), /\/subscriptions/.test(readFileSync("app/api/store/option/route.ts", "utf8"))], [true, false, false]);
const editor = readFileSync("components/product-editor.tsx", "utf8");
is("every field a row names is on the form under the id its Change goes to, the price when it is not shown", [["price", "pwyw", "suggested", "every", "intro", "yearly", "trial", "payments"].every((f) => editor.includes(`id={\`product-${f}-\${id}\`}`)), editor.includes("document.getElementById(`product-${field}-${productId}`) ?? document.getElementById(`product-price-${productId}`)")], [true, true]);

done();
