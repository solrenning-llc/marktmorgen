/**
 * The warnings on a creator's own terms, refund policy and description
 * (493 [DE2] unit 1, lib/terms-check-rules.ts). Pure: nothing is reached.
 *
 * What fails here: a warning missing for another company's name or site, a
 * price that differs from the checkout's, "no refunds" where the immediate-
 * access consent does not apply, a promise of earnings, urgency or scarcity
 * with nothing real behind it, or resale rights without a license; a warning
 * raised for the creator's own site, the right price, a real deadline or a
 * held license; a warning without its passage, reason and fix; or unbounded
 * work on a huge text.
 */
import { done, is, part } from "./check";
import { MAX_TEXT, MAX_WARNINGS, checkCreatorTerms, replaceWords, type TermsCheckInput, withoutSentence } from "@/lib/terms-check-rules";

const base: TermsCheckInput = {
  text: "",
  ownHosts: ["maya.marktmorgen.com", "mayamakes.com"],
  priceCents: 4_900,
  currency: "usd",
  immediateAccessConsent: true,
  realDeadline: false,
  realStockLimit: false,
  resaleLicense: false,
};
const kinds = (text: string, over: Partial<TermsCheckInput> = {}) => checkCreatorTerms({ ...base, ...over, text }).map((w) => w.kind);

part("Another company or site");
is("another site in the terms", kinds("Questions? Visit https://www.othershop.com/help."), ["other_company"]);
is("a selling platform named", kinds("These terms apply to all purchases on Gumroad."), ["other_company"]);
is("Stan Store named", kinds("Bought through Stan Store, refunds follow its policy."), ["other_company"]);
is("the creator's own site is fine", kinds("Visit mayamakes.com or www.mayamakes.com/faq or maya.marktmorgen.com."), []);
is("Marktmorgen itself is fine", kinds("Payments are handled at marktmorgen.com."), []);
is("an email address is not a site", kinds("Write to help@example.com with questions."), []);

part("A price that differs");
is("a different price in the text", kinds("The course costs $99 and includes ten lessons."), ["price_mismatch"]);
is("the same price is fine", kinds("The course costs $49 and includes ten lessons."), []);
is("cents are read", kinds("Pay just $49.00 today."), []);
is("thousands are read", kinds("The price is $1,200 for the program.", { priceCents: 120_000 }), []);
is("an amount far from any price word is left alone", kinds("Shipping refunds above $20 take a week to arrive at your bank."), []);
is("not compared for another currency", kinds("The course costs $99.", { currency: "eur" }), []);
is("not compared without one price", kinds("The course costs $99.", { priceCents: null }), []);
const mismatch = checkCreatorTerms({ ...base, text: "The course costs $99 today." })[0];
is("the fix names the checkout's price", mismatch.fix, "Change it to $49, or remove the amount.");

part("No refunds");
const noRefund = "All sales are final. No refunds.";
is("where the consent does not apply (a membership)", kinds(noRefund, { immediateAccessConsent: false }), ["no_refunds", "no_refunds"]);
is("where the checkout's consent applies, no warning", kinds(noRefund), []);
is("other wordings", kinds("This product is non-refundable. Refunds will not be issued.", { immediateAccessConsent: false }), ["no_refunds", "no_refunds"]);

part("Earnings and results");
is("guaranteed results", kinds("Guaranteed results in 30 days."), ["earnings_claim"]);
is("earn a figure", kinds("Students earn up to $10,000 a month."), ["earnings_claim"]);
is("six figures, passive income", kinds("Build a six-figure business with passive income."), ["earnings_claim", "earnings_claim"]);
is("a plain description is fine", kinds("Ten video lessons on watercolor, with worksheets."), []);

part("Urgency and scarcity");
is("time pressure with no deadline", kinds("Limited time! Price goes up tomorrow."), ["false_urgency", "false_urgency"]);
is("time pressure with a real deadline is fine", kinds("Limited time! Price goes up tomorrow.", { realDeadline: true }), []);
is("scarcity with no limit", kinds("Only 3 spots left."), ["false_urgency"]);
is("scarcity with a real limit is fine", kinds("Only 3 spots left.", { realStockLimit: true }), []);

part("Resale rights");
is("resale rights without a license", kinds("Comes with master resell rights."), ["resale_rights"]);
is("PLR without a license", kinds("Includes PLR for every chapter."), ["resale_rights"]);
is("with the license held, fine", kinds("Comes with master resell rights.", { resaleLicense: true }), []);

part("Protective sentences are never warned (the fix would tell the creator to delete them)");
is("no resale rights", kinds("Personal use only. No resale rights."), []);
is("resale rights not included", kinds("Resale rights are not included."), []);
is("does not include PLR", kinds("This product does not include PLR."), []);
is("no guarantee of income or results", kinds("We do not guarantee any income or results."), []);
is("there is no guarantee", kinds("There is no guarantee of income."), []);
is("not a get-rich scheme", kinds("This is not a get rich quick scheme."), []);
is("not a limited-time offer", kinds("Not a limited time offer: the price stays the same."), []);
is("refunds closed only after the 14 days, with the 14 days granted", kinds("Refunds are not available after 14 days; you may cancel within 14 days.", { immediateAccessConsent: false }), []);
is("no refunds after 30 days", kinds("No refunds after 30 days.", { immediateAccessConsent: false }), []);
is("no refunds after 7 days still warned", kinds("No refunds after 7 days.", { immediateAccessConsent: false }), ["no_refunds"]);
is("a negation in another clause does not hide a warning", kinds("No refunds, resale rights included.", { immediateAccessConsent: false }), ["no_refunds", "resale_rights"]);

part("Ordinary creator text is not warned");
is("tools the product is made with or delivered on", kinds("Made in Canva. Duplicate the template to your Notion workspace at notion.so, or open it at canva.com."), []);
is("where the calls and replays are", kinds("We meet on zoom.us and the replays are on youtube.com and https://www.youtube.com/@maya."), []);
is("a missing space is not a site", kinds("I love it.So does my sister."), []);
is("shipping is not the price", kinds("Shipping costs $5."), []);
is("a stated value is not the price", kinds("Only $49 today for the bundle (a $99 value)."), []);
is("a countdown product", kinds("A wedding countdown planner with 52 weekly pages."), []);
is("the creator's own community and tips", kinds("Join my Patreon for extra tutorials, or my Skool community. Tips on Ko-fi are welcome."), []);
is("a plain price sentence still compared", kinds("Get it today for only $99."), ["price_mismatch"]);
is("a selling platform in terms still warned", kinds("All purchases are subject to Gumroad's refund policy."), ["other_company"]);

part("Every warning is complete");
const all = checkCreatorTerms({ ...base, immediateAccessConsent: false, text: "Visit othershop.com. Costs $99. No refunds. Get rich fast. Hurry! Resale rights included." });
is("one of each kind", all.map((w) => w.kind).sort(), ["earnings_claim", "false_urgency", "no_refunds", "other_company", "price_mismatch", "resale_rights"]);
is("each has its passage, reason and fix", all.every((w) => w.excerpt.length > 0 && w.why.length > 20 && w.fix.length > 10), true);
is("the passage shows the words themselves", all.find((w) => w.kind === "no_refunds")!.excerpt.includes("No refunds"), true);
is("the same words twice are warned once", kinds("No refunds. No refunds.", { immediateAccessConsent: false }), ["no_refunds"]);

part("The fix, applied only when the creator approves it");
const text1 = "Ten lessons with worksheets. No refunds. Enjoy the course!";
const w1 = checkCreatorTerms({ ...base, immediateAccessConsent: false, text: text1 })[0];
is("each warning says where its words are", text1.slice(w1.at, w1.at + w1.length), "No refunds");
is("removing the sentence leaves the rest as written", withoutSentence(text1, w1.at), "Ten lessons with worksheets. Enjoy the course!");
const text2 = "Line one.\nAll sales are final.\nLine three.";
const w2 = checkCreatorTerms({ ...base, immediateAccessConsent: false, text: text2 })[0];
is("a sentence on its own line goes with its line", withoutSentence(text2, w2.at), "Line one.\nLine three.");
const text3 = "The course costs $99 and includes ten lessons.";
const w3 = checkCreatorTerms({ ...base, text: text3 })[0];
is("a price fix carries the checkout's price", w3.replacement, "$49");
is("and puts it in place of the amount only", replaceWords(text3, w3.at, w3.length, "$99", w3.replacement!), "The course costs $49 and includes ten lessons.");
is("text changed since: nothing replaced", replaceWords("The course costs $89 now.", w3.at, w3.length, "$99", "$49"), "The course costs $89 now.");
is("a place outside the text: unchanged", withoutSentence("Short.", 99), "Short.");
is("no fix tells the creator to use a setting that does not exist", checkCreatorTerms({ ...base, immediateAccessConsent: false, text: "Visit othershop.com. Costs $99. No refunds. Get rich fast. Hurry! Only 3 left. Resale rights included." }).every((w) => !/in the studio/.test(w.fix)), true);

part("Review findings: sentences, the creator's own pages, stale fixes");
const cut = (t: string) => { const w = checkCreatorTerms({ ...base, immediateAccessConsent: false, text: t })[0]; return withoutSentence(t, w.at, t.slice(w.at, w.at + w.length)); };
is("a dot in an address does not end the sentence", cut("Intro. Read the rules at othershop.com before buying. Thanks!"), "Intro. Thanks!");
is("a dot in an amount does not end the sentence", cut("Ten lessons. The course costs $99.00 today. Enjoy."), "Ten lessons. Enjoy.");
is("a dot in a version does not end the sentence", cut("Hello. Version 2.0 is non-refundable. Bye."), "Hello. Bye.");
is("the creator's own patreon page", kinds("Check out my patreon.com/jane page."), []);
is("the creator's own community link", kinds("Join my community at skool.com/jane."), []);
is("the creator's own tip page", kinds("Support me at ko-fi.com/jane."), []);
is("another site in terms still warned", kinds("These terms are those of othershop.com."), ["other_company"]);
const two = "No refunds. Ten lessons. All sales are final.";
const [r1, r2] = checkCreatorTerms({ ...base, immediateAccessConsent: false, text: two });
const after1 = withoutSentence(two, r1.at, two.slice(r1.at, r1.at + r1.length));
is("the first fix applied", after1, "Ten lessons. All sales are final.");
is("an old warning's fix on the changed text changes nothing", withoutSentence(after1, r2.at, two.slice(r2.at, r2.at + r2.length)), after1);

part("Re-review: a possessive elsewhere is not the creator's own page; quotes stay with their sentence");
is("our policy follows another platform's: warned", kinds("Our refund policy follows Gumroad terms."), ["other_company"]);
is("our terms are another site's: warned", kinds("Our terms are the same as othershop.com/terms."), ["other_company"]);
is("me, elsewhere in the sentence: warned", kinds("Email me about refunds under the Gumroad refund policy."), ["other_company"]);
const quoted = 'Our promise is "no questions asked." Resale rights included. Thanks.';
const q1 = checkCreatorTerms({ ...base, text: quoted })[0];
is("the previous sentence keeps its closing quote", withoutSentence(quoted, q1.at, quoted.slice(q1.at, q1.at + q1.length)), 'Our promise is "no questions asked." Thanks.');
const shout = '"Amazing!" Resale rights included. Thanks.';
const q2 = checkCreatorTerms({ ...base, text: shout })[0];
is("and after an exclamation", withoutSentence(shout, q2.at, shout.slice(q2.at, q2.at + q2.length)), '"Amazing!" Thanks.');

part("Bounds");
const huge = "Hurry! Only 2 left. ".repeat(10_000) + " Visit othershop.com.";
const capped = checkCreatorTerms({ ...base, text: huge });
is(`at most ${MAX_WARNINGS} warnings`, capped.length <= MAX_WARNINGS, true);
is(`text past ${MAX_TEXT} characters is not read`, capped.some((w) => w.kind === "other_company"), false);
is("not a string: no warnings, no error", checkCreatorTerms({ ...base, text: undefined as unknown as string }), []);

part("Terms keep the narrower urgency and price words: plain facts are not urgency (review of 4 November 2026)");
const plainFacts = ["Act today to protect your data.", "Last day of the course is a review.", "Prices increase each year with inflation.", "Support ends in 30 days after refund.", "Your access ends on 12/31 unless renewed.", "Membership expires soon after you cancel.", "Final hours of the video show the build.", "Don't miss out on the lessons in module 2."];
is("none of these warn in terms", plainFacts.filter((text) => kinds(text).includes("false_urgency")), []);
is("but the same sentences in an ad are urgency where they are", ["Act today.", "Last day!", "Prices increase soon."].filter((text) => !kinds(text, { asAd: true }).includes("false_urgency")), []);
is("'from $10' is a price only in an ad", [kinds("Plans start from $10 per month.").includes("price_mismatch"), kinds("Courses from $10.", { asAd: true }).includes("price_mismatch")], [false, true]);
is("the old phrases still warn in terms, spaced or hyphenated", ["Last-chance offer.", "Limited  time only.", "Hurry!"].filter((text) => !kinds(text).includes("false_urgency")), []);

done();
