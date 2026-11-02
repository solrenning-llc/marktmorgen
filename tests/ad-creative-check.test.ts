/**
 * 632 [AA2] (c), unit 2: an ad's words are refused when they promise money
 * or results, invent urgency, misstate the price or quote a buyer whose words
 * are not a verified review (lib/ad-creative-check.ts). Pure, synthetic text.
 */
import { AD_NOT_CHECKED, AD_TEXT_MAX, type AdContext, type AdText, checkAdText } from "@/lib/ad-creative-check";
import { done, is, part } from "./check";

const context: AdContext = { priceCents: 4900, currency: "usd", ownHosts: ["breadclass.com"], realDeadline: false, realStockLimit: false, verifiedReviews: ["My first loaf rose and tasted great."] };
const ad = (over: Partial<AdText>): AdText => ({ headline: "Bake bread at home", text: "A six-week course with videos and recipes.", description: "", button: "Learn more", ...over });
const rules = (over: Partial<AdText>, ctx: Partial<AdContext> = {}) => checkAdText(ad(over), { ...context, ...ctx }).refusals.map((r) => r.rule);

part("An honest ad goes");
const honest = checkAdText(ad({}), context);
is("sendable", [honest.sendable, honest.refusals, honest.warnings], [true, [], []]);
is("what is not checked is said", honest.notChecked, AD_NOT_CHECKED);

part("Money and results are never promised");
is("fast money", rules({ headline: "Make $5,000 a month from home with no experience" }).length > 0, true);
is("earnings", rules({ text: "Guaranteed results: replace your job with passive income." }).some((r) => r === "earnings_claim" || r === "fast_money"), true);
is("a negation is not a promise", rules({ text: "We do not promise any income: this is a baking course." }), []);

part("Urgency only when it is real");
const urgent = { text: "Only 3 spots left! Offer ends tonight." };
is("refused without a real deadline or stock", rules(urgent).includes("false_urgency"), true);
is("allowed with both behind it", rules(urgent, { realDeadline: true, realStockLimit: true }), []);

part("The price is the product's");
is("a wrong price is refused", rules({ text: "Join for just $19." }), ["price_mismatch"]);
is("the right price goes", rules({ text: "Join for $49." }), []);

part("Testimonials only from verified reviews");
is("an invented quote is refused", rules({ text: "“Best course I ever took!” — Maria" }), ["testimonial_unverified"]);
is("a verified review, word for word, goes", rules({ text: "“My first loaf rose and tasted great.” — Ana" }), []);
is("a verified review changed is refused", rules({ text: "“My first loaf rose and tasted amazing.” — Ana" }), ["testimonial_unverified"]);
is("plain quotes with said", rules({ text: "\"This changed my life completely\", said Joe" }), ["testimonial_unverified"]);

part("Other companies are a warning, not a refusal");
const named = checkAdText(ad({ text: "Better than the course on udemy.com" }), context);
is("sendable with a warning", [named.sendable, named.warnings.map((w) => w.rule)], [true, ["other_company"]]);

part("Empty and oversized");
is("no headline and no text", rules({ headline: " ", text: "" }), ["empty"]);
is("past the size", rules({ text: "x".repeat(AD_TEXT_MAX + 1) }), ["too_long"]);
is("a long run of quotes is read fast", (() => { const t = Date.now(); checkAdText(ad({ text: "“".repeat(4000) }), context); return Date.now() - t < 1000; })(), true);

done();
