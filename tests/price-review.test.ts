/**
 * "Check what buyers pay" (487 [IT4], item 8; added 2 November 2026): every
 * change a save makes to what buyers pay for a product they can see, one row
 * each, the way it is now and once saved, each leading back to its own field;
 * nothing for a draft, a product with price options, an unreadable price or a
 * change that is not one; and, for a membership, what happens to members who
 * already joined, which is what the code does.
 */
import { readFileSync } from "node:fs";
import { priceReview, type PricedProduct, type PriceDraft } from "@/lib/price-review";
import { formatMoney, readMoney } from "@/lib/money";
import { done, is, part } from "./check";

const read = (typed: string) => readMoney(typed, "usd");
const money = (cents: number) => formatMoney(cents, "usd");
const once: PricedProduct = { hidden: false, options: 0, priceCents: 2900, interval: null, suggestedCents: null, intro: null, yearlyCents: null };
const member: PricedProduct = { ...once, priceCents: 900, interval: "month" };
const chosen: PricedProduct = { ...once, priceCents: 500, suggestedCents: 1500 };
const draft = (more: Partial<PriceDraft>): PriceDraft => ({ price: "29", every: "", pwyw: false, suggested: "", introPrice: "", introCount: "1", yearlyPrice: "", ...more });
const review = (p: PricedProduct, d: Partial<PriceDraft>) => priceReview(p, draft(d), read, money);
const rows = (r: ReturnType<typeof priceReview>) => r?.rows.map((x) => [x.label, x.now, x.then, x.field]) ?? null;
const STORE = "Your store shows this as soon as you save.";
const KEEP = "New members pay this once you save; a checkout already open keeps what it opened with. Members who already joined keep the price and schedule they joined at.";
const STILL = "Members who already joined keep being charged the price and schedule they joined at until they or you cancel: saving this does not cancel them. To stop them, cancel their memberships in your Stripe dashboard. New buyers pay what this summary shows once you save.";

part("Bought once");
is("a new price: one row, back to the price", [rows(review(once, { price: "39" })), review(once, { price: "39" })?.note], [[["Price", "$29", "$39", "price"]], STORE]);
is("made free: said as given for an email address", rows(review(once, { price: "0" })), [["Price", "$29", "Free, for an email address", "price"]]);
is("the same amount written another way is not a change", [review(once, { price: "29.00" }), review(once, { price: "29" })], [null, null]);
is("nothing for a draft, a product with price options, or a price that cannot be read", [review({ ...once, hidden: true }, { price: "39" }), review({ ...once, options: 2 }, { price: "39" }), review(once, { price: "abc" })], [null, null, null]);

part("A membership that stays one");
is("a new price: members who already joined keep theirs", [rows(review(member, { price: "12", every: "month" })), review(member, { price: "12", every: "month" })?.note], [[["Price", "$9", "$12", "price"]], KEEP]);
is("a new schedule: how buyers pay, back to the schedule, with the price shown", rows(review(member, { price: "9", every: "year" })), [["How buyers pay", "Every month", "Every year", "every"], ["Price", "$9", "$9", "price"]]);
const withYearly = { ...member, yearlyCents: 9000, intro: { cents: 100, count: 3 } };
is("a new schedule takes the yearly price away, and the introductory price down to one payment: both said", rows(review(withYearly, { price: "9", every: "week", yearlyPrice: "90", introPrice: "1", introCount: "3" })), [["How buyers pay", "Every month", "Every week", "every"], ["Price", "$9", "$9", "price"], ["Introductory price", "$1 for the first 3 payments", "$1 for the first payment", "intro"], ["Yearly price", "$90", "None", "yearly"]]);
is("a new yearly or introductory price on its own", [rows(review(withYearly, { price: "9", every: "month", yearlyPrice: "80", introPrice: "1", introCount: "3" })), rows(review(withYearly, { price: "9", every: "month", yearlyPrice: "90", introPrice: "2", introCount: "3" }))], [[["Yearly price", "$90", "$80", "yearly"]], [["Introductory price", "$1 for the first 3 payments", "$2 for the first 3 payments", "intro"]]]);
is("an introductory or yearly price that cannot be read: nothing reviewed", [review(withYearly, { price: "9", every: "month", yearlyPrice: "x" }), review(withYearly, { price: "9", every: "month", introPrice: "x" })], [null, null]);

part("A membership that stops being one");
const toOnce = review(member, { price: "9", every: "" });
is("bought once: said that members already joined keep being charged until canceled, and where to stop them", [rows(toOnce), toOnce?.note], [[["How buyers pay", "Every month", "Once", "every"], ["Price", "$9", "$9", "price"]], STILL]);
is("made free: the same, the price said as free", [rows(review(member, { price: "0", every: "" })), review(member, { price: "0", every: "" })?.note], [[["How buyers pay", "Every month", "Once", "every"], ["Price", "$9", "Free, for an email address", "price"]], STILL]);
is("bought once made a membership: nobody was a member, so the store's note", [rows(review(once, { price: "9", every: "month" })), review(once, { price: "9", every: "month" })?.note], [[["How buyers pay", "Once", "Every month", "every"], ["Price", "$29", "$9", "price"]], STORE]);

part("Buyers choose what to pay");
is("a new lowest price", rows(review(chosen, { price: "7", pwyw: true, suggested: "15" })), [["Lowest price", "$5", "$7", "price"]]);
is("a new starting price", rows(review(chosen, { price: "5", pwyw: true, suggested: "20" })), [["Price their box starts at", "$15", "$20", "suggested"]]);
is("switched on: how, back to the choice itself, and where the box starts (the lowest price when none is typed)", rows(review(once, { price: "29", pwyw: true, suggested: "" })), [["How buyers pay", "Once", "They choose what to pay", "pwyw"], ["Lowest price", "$29", "$29", "price"], ["Price their box starts at", "None", "$29", "suggested"]]);
is("switched off: back to once, with the price they will pay", rows(review(chosen, { price: "5", pwyw: false })), [["How buyers pay", "They choose what to pay", "Once", "pwyw"], ["Price", "$5", "$5", "price"]]);
is("a starting price that cannot be read: nothing reviewed", review(chosen, { price: "5", pwyw: true, suggested: "x" }), null);

part("What the member notes rest on");
const checkout = readFileSync("lib/store-checkout.ts", "utf8");
const route = readFileSync("app/api/store/product/route.ts", "utf8");
is("each membership is made at checkout at that moment's price and schedule; saving the product calls Stripe for no subscription", [checkout.includes('body.set("line_items[0][price_data][recurring][interval]", membership.interval);'), /\/subscriptions/.test(route)], [true, false]);
const editor = readFileSync("components/product-editor.tsx", "utf8");
is("every field a row names is on the form under the id its Change goes to, the price when it is not shown", [["price", "pwyw", "suggested", "every", "intro", "yearly"].every((f) => editor.includes(`id={\`product-${f}-\${id}\`}`)), editor.includes("document.getElementById(`product-${field}-${productId}`) ?? document.getElementById(`product-price-${productId}`)")], [true, true]);

done();
