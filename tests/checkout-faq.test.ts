/**
 * The questions someone starting out asks about the checkout tools (534
 * [FQ1], unit 7, lib/checkout-faq.ts; added 2 November 2026). Checked: the
 * discount editor's own words and that it alone waits for canSell (a
 * connected Stripe account, a paid-up plan, a trial included), while the
 * product's own checkout settings do not; the shared trial answer in both
 * states; Stripe's count of uses; no figure; first in the page's own
 * Questions block, no question asked twice.
 */
import { readFileSync } from "node:fs";
import { DISCOUNT_WORDS, checkoutBeginnerQuestions } from "@/lib/checkout-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";

part("The studio's own words");
const editor = flat(read("components/discount-editor.tsx"));
is("the discount editor's title, fields, choices and button", Object.values(DISCOUNT_WORDS).every((w) => editor.includes(w)), true);
is("it opens only when the store can sell, and says the trial counts", [editor.includes("this opens once your Stripe account is connected and your subscription is running. The trial counts."), flat(read("app/studio/page.tsx")).includes("<DiscountEditor selling={current ? canSell(current) : false}")], [true, true]);
const sell = flat(read("lib/store-checkout.ts"));
const canSell = sell.slice(sell.indexOf("export function canSell("), sell.indexOf("export function canSellProduct("));
is("canSell needs a connected Stripe account and a paid-up plan, which a trial passes", [canSell.includes("Boolean(store.stripeAccountId)"), canSell.includes("store.stripeChargesEnabled"), canSell.includes("isPaidUp(store)"), /A creator inside the trial (\/\/ )?passes this too/.test(canSell)], [true, true, true, true]);
const productEditor = flat(read("components/product-editor.tsx"));
is("the product's own checkout settings do not wait for the store to sell", [/<CheckoutExtras\b[^>]*\/>/.test(productEditor) && !/<CheckoutExtras\b[^>]*selling/.test(productEditor), /<CheckoutFieldsEditor\b[^>]*\/>/.test(productEditor) && !/<CheckoutFieldsEditor\b[^>]*selling/.test(productEditor), !/canSell|isPaidUp/.test(read("app/api/store/extras/route.ts")), !/canSell|isPaidUp/.test(read("app/api/store/fields/route.ts"))], [true, true, true, true]);
is("the editor's own order: the button that opens it, the code, what it takes off, the amount, then the button that makes it", (() => { const at = [` ${DISCOUNT_WORDS.code} </label>`, DISCOUNT_WORDS.off, '"Percent"', `"${DISCOUNT_WORDS.make}"`].map((w) => editor.indexOf(w)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])) && editor.includes(DISCOUNT_WORDS.open); })(), true);
is("it counts each code's uses from Stripe", [editor.includes("{`Used ${entry.timesRedeemed}"), read("lib/discount.ts").includes("times_redeemed")], [true, true]);

part("The answers");
const now = checkoutBeginnerQuestions(false);
const later = checkoutBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["What are the checkout tools here?", "How do I start one?", "Can I try it before paying?", "Do the checkout tools bring more sales?"]);
is("the main tools named as the page's own intro names them, never as a promise to earn more", [/earn more/i.test(answer(now, "What are the checkout tools here?"))], [false]);
is("and in the intro's own list", answer(now, "What are the checkout tools here?").includes("discount codes, a product added at checkout, one-click offers after paying, payment plans, pay what you want, questions at checkout, limited quantities and sales tax"), findPage("platform", "checkout")?.intro.includes("Discount codes, a product added at checkout, one-click offers after paying, payment plans, pay what you want, questions at checkout, limited quantities and sales tax"));
is("start: the editor's own words, in order, and when it opens", [(() => { const a = answer(now, "How do I start one?"); const at = [DISCOUNT_WORDS.title, DISCOUNT_WORDS.open, DISCOUNT_WORDS.code, DISCOUNT_WORDS.off, DISCOUNT_WORDS.percent, DISCOUNT_WORDS.amount, DISCOUNT_WORDS.make].map((w) => a.indexOf(`“${w}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), answer(now, "How do I start one?").includes("once your Stripe account is connected and your plan is running, the trial included")], [true, true]);
const setUp = "pay what you want, a payment plan, a product added at checkout, questions at checkout and a limited quantity";
is("try before paying: the shared answer for what is set on a product, then discount codes said apart", [answer(now, "Can I try it before paying?"), answer(later, "Can I try it before paying?")], [`${tryBeforePaying("Pay what you want, a payment plan, a product added at checkout, questions at checkout and a limited quantity", `${setUp} on a product`, false)} Discount codes open once your Stripe account is connected and your plan is running.`, `${tryBeforePaying("Pay what you want, a payment plan, a product added at checkout, questions at checkout and a limited quantity", `${setUp} on a product`, true, TRIAL_DAYS)} Discount codes open once your Stripe account is connected and your plan is running.`]);
is("while plans are off sale, it says the codes open for no one today", [answer(now, "How do I start one?").endsWith("Paid plans are not on sale yet, so it opens for no one today."), answer(later, "How do I start one?").includes("not on sale")], [true, false]);
is("more sales: no figure, the studio's count from Stripe", [answer(now, "Do the checkout tools bring more sales?").startsWith("We publish no number"), answer(now, "Do the checkout tools bring more sales?").includes("as Stripe counts it on your own account")], [true, true]);
is("one space between sentences, never two", /\s{2}/.test([...now, ...later].map((x) => x.a).join(" ")), false);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no number of sales, buyers or earnings, no percent, no result promised", /\b\d{2,}\s+(sales|buyers|creators|codes)|%|guarantee|proven|results?\b/i.test(all), false);

part("On the checkout page");
const faq = (findPage("platform", "checkout")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);

done();
