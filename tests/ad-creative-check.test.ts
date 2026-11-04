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
// Found in review (inbox C3-45, item 2): price $49, no sale running.
is("a lower price after now, today or sale is refused", [rules({ text: "Now $39." }), rules({ text: "Today $39 only." }), rules({ text: "Big sale $39 this week." })], [["price_mismatch"], ["price_mismatch"], ["price_mismatch"]]);
is("an earlier price with no sale running is refused, even when it is the real price now", [rules({ text: "Now $39 instead of $49." }), rules({ text: "Was $79, now $49." })], [["price_mismatch", "price_mismatch"], ["price_mismatch"]]);
is("with a real sale running, the earlier price is not taken for the price", rules({ text: "Was $79, now $49." }, { realDeadline: true }), []);
is("a sale that ends on a weekday, or today only, with no real end date is refused", [rules({ headline: "Sale ends Sunday" }), rules({ text: "Only today." }), rules({ text: "Ends this Friday." })].map((r) => r.includes("false_urgency")), [true, true, true]);
is("and allowed with a real end date behind it", rules({ headline: "Sale ends Sunday" }, { realDeadline: true }), []);
is("a fee, a saving or a stated value is still not the price", [rules({ text: "Save $10 today." }), rules({ text: "Now with a $5 shipping fee." })], [[], []]);
is("an amount in another currency is said not to be checked", AD_NOT_CHECKED.some((line) => line.includes("only when the store sells in US dollars")), true);

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

part("Edge tests of 4 November 2026: what hid a price or urgency, and ordinary words that were refused");
const refusedFor = (rule: string, lines: string[]) => lines.filter((text) => !rules({ headline: "Bread at home", text }).includes(rule as never));
is("a price behind fullwidth digits or a hidden character is still the price", refusedFor("price_mismatch", ["Only ＄59", "Only $５９", "Only $\u200b59"]), []);
is("an earlier price written 'Reg.' with no sale", refusedFor("price_mismatch", ["Reg. $59 now $49"]), []);
is("a price from, or starting at, that is not the price", refusedFor("price_mismatch", ["Courses from $59", "Starting at $59"]), []);
is("urgency hidden by spacing, a hyphen or fullwidth letters", refusedFor("false_urgency", ["last  chance", "last\nchance", "last-chance", "Limited-time", "Ｌａｓｔ ｃｈａｎｃｅ"]), []);
is("urgency in more plain English", refusedFor("false_urgency", ["Only three left", "Only 3 remaining", "Just 3 left", "3 spots left", "Only a few left", "Last few spots", "Ends midnight", "Ends in 2 hours", "Ends Nov 5", "Ends 11/5", "Offer ends on Friday", "Expires tonight", "Expires soon", "Final hours", "Last day", "Act fast", "Act today", "Don't miss out", "Selling out fast", "Sells fast", "Almost gone", "Nearly sold out", "While supplies last", "Price will rise", "Price is going up", "Prices increase soon"]), []);
is("ordinary words are not urgency", ["Selling fast food? Learn the menu", "Only 3 left-handed techniques", "Chapter 3: only 3 left turns", "This course ends today's lesson plan", "Learn to hurry less", "Hurry-up-and-wait tactics explained", "Last chapter", "3 lessons left in the course", "Ends with a Q&A", "The price goes down for students? No, it stays."].filter((text) => rules({ headline: "Bread at home", text }).includes("false_urgency")), []);
is("a word mixing two alphabets, or a hidden character, is refused as a disguise", [rules({ headline: "L\u0430st chance" }).includes("disguised"), rules({ headline: "Bread\u200b at home" }).includes("disguised"), rules({ headline: "Last\u202e chance" }).includes("disguised")], [true, true, true]);
is("and a line of hidden characters only is no headline", rules({ headline: "\u200b", text: "" }).includes("empty"), true);
is("ordinary words in other alphabets are not a disguise", [rules({ headline: "Хлеб дома" }).includes("disguised"), rules({ headline: "Ψωμί at home" }).includes("disguised")], [false, false]);
is("the check says it reads English words only", AD_NOT_CHECKED.some((line) => line.includes("English words only")), true);

done();
