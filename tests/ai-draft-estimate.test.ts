/**
 * A number in an AI draft that the creator did not give is marked "Estimate"
 * (756 [STN3], unit 3).
 *
 * The writing box compares the numbers in the text of the draft it filled in
 * with what the creator typed in the box and sent with it (lib/ai-draft-review.ts,
 * unsourcedNumbers). Each one not found there is listed under the "AI draft"
 * checks with the "Estimate" badge, in words, and the creator is asked to check
 * it or change it. Only text is read: a number the draft holds as a setting
 * (a wait in days, a right answer's place) is never taken for a claim. Nothing
 * calls a model, reads or writes anything.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as review from "@/lib/ai-draft-review";
import { AiDraftReview } from "@/components/ai-draft-review";
import { done, is, part } from "./check";

const { ESTIMATE_BADGE, draftStrings, givenTexts, unsourcedNumbers } = review;

part("Only the draft's words are read");
is("strings at any depth, not numbers or keys", draftStrings({ wait: 3, right: 2, summary: "40 recipes", list: ["2 hours", { title: "Week 1" }] }), ["40 recipes", "2 hours", "Week 1"]);
is("nothing in it: none", draftStrings(null), []);

part("Numbers the creator did not give");
is("all given: none", unsourcedNumbers(["40 recipes on 40 pages"], "My 40 recipes"), []);
is("one not given", unsourcedNumbers(["40 recipes, ready in 20 minutes"], "My 40 recipes"), ["20"]);
is("each once, in the order they appear", unsourcedNumbers(["Save 3 hours. 3 hours a week, 95% of readers."], ""), ["3", "95%"]);
is("a number inside another is not the same number", unsourcedNumbers(["140 pages"], "40 pages"), ["140"]);
is("written with a comma, it is the same number", unsourcedNumbers(["1,200 students"], "1200 students"), []);
is("money and decimals are read whole", unsourcedNumbers(["Only $19.99 today"], "$19"), ["$19.99"]);
is("no number: none", unsourcedNumbers(["A calm guide to bread."], ""), []);

part("Drawn with the checks");
const html = renderToStaticMarkup(createElement(AiDraftReview, { checks: [false, false, false], onToggle: () => {}, estimates: ["20", "95%"] }));
is("each number with the badge in words", [html.split(`>${ESTIMATE_BADGE}<`).length - 1, html.includes(">20<"), html.includes(">95%<")], [2, true, true]);
is("and what to do", html.includes("These numbers are not in what you gave. Check each one, or change it to a figure you know."), true);
is("in a list read before the checks", html.indexOf(ESTIMATE_BADGE) < html.indexOf('type="checkbox"'), true);
const none = renderToStaticMarkup(createElement(AiDraftReview, { checks: [false, false, false], onToggle: () => {} }));
is("none: no list", none.includes(ESTIMATE_BADGE), false);

part("Where it is used");
const assist = readFileSync("components/ai-assist.tsx", "utf8");
is("the box compares the draft with what was typed and sent", assist.includes("setEstimates(unsourcedNumbers(draftStrings(data.value), [notes, ...givenTexts(sent)], data.language))"), true);
is("and passes them to the checks", assist.includes("estimates={estimates}"), true);

// A thrown error is a failure like any other, so one missing function does not hide the rest.
const safely = (read: () => unknown) => {
  try {
    return read();
  } catch (error) {
    return `threw: ${(error as Error).message}`;
  }
};
// An id made the way lib/store.ts makes them: randomUUID() without its dashes.
const id = "5e3a9c10b7d24f8e9a61c0d3b2f47e85";

part("Ids sent with the job are never taken for numbers the creator gave (Claude 6 review of #3437, MEDIUM 1)");
is("the quiz box: invented '10 pounds' and '3 weeks' are marked", safely(() => unsourcedNumbers(["Lose 10 pounds in 3 weeks"], ["", ...givenTexts({ kind: "quiz", id, lessonId: id, count: 4 })])), ["10", "3"]);
is("the page box: an invented 9 is marked", safely(() => unsourcedNumbers(["Join 9 other students"], ["", ...givenTexts({ kind: "page", product: id, readFile: false })])), ["9"]);
is("the sequence box: a product id is not given", safely(() => unsourcedNumbers(["5 emails over 2 weeks"], ["", ...givenTexts({ kind: "sequence", productId: id, count: 5 })])), ["2"]);
is("the job's own settings and typed fields are given", safely(() => givenTexts({ kind: "product", title: "40 recipes", price: "19", count: 4, readFile: true, id })), ["product", "40 recipes", "19", "4"]);
is("digits inside a word are not a number", safely(() => unsourcedNumbers(["Join 9 other students"], "ref a9b")), ["9"]);
const assistNow = readFileSync("components/ai-assist.tsx", "utf8");
is("the box compares with the typed values, never the JSON of the job", assistNow.includes("JSON.stringify(sent)"), false);
is("the box reads the job inside the try, so a failing payload resets the box", assistNow.indexOf("const sent = payload()") > assistNow.indexOf("    try {"), true);

part("Numbers written in words (MEDIUM 2)");
is("English number words, as written", safely(() => unsourcedNumbers(["Twenty minutes a day, three days a week, a dozen recipes"], "")), ["Twenty", "three", "a dozen"]);
is("double and half", safely(() => unsourcedNumbers(["Double your sales in half the time"], "")), ["Double", "half"]);
is("compound words", safely(() => unsourcedNumbers(["Twenty-five lessons and two hundred pages"], "")), ["Twenty-five", "two hundred"]);
is("'double-check' asks for a check, it claims no number", safely(() => unsourcedNumbers(["Double-check each step"], "")), []);
is("'one' is too common to read", safely(() => unsourcedNumbers(["One of the best, the one thing you need"], "")), []);
is("a word the creator gave in digits", safely(() => unsourcedNumbers(["Twenty recipes, a dozen cakes"], "20 recipes and 12 cakes")), []);
is("digits the creator gave in words", safely(() => unsourcedNumbers(["20 recipes, twice a week"], "twenty recipes, double the fun")), []);
is("Spanish", safely(() => unsourcedNumbers(["Veinte recetas en una docena de días"], "", "es")), ["Veinte", "docena"]);
is("French", safely(() => unsourcedNumbers(["Vingt recettes, deux fois plus vite"], "", "fr")), ["Vingt", "deux"]);
is("German", safely(() => unsourcedNumbers(["Zwanzig Rezepte in der Hälfte der Zeit"], "", "de")), ["Zwanzig", "Hälfte"]);
is("Italian", safely(() => unsourcedNumbers(["Venti ricette, il doppio dei risultati"], "", "it")), ["Venti", "doppio"]);
is("Dutch", safely(() => unsourcedNumbers(["Twintig recepten in drie weken"], "", "nl")), ["Twintig", "drie"]);
is("Portuguese", safely(() => unsourcedNumbers(["Vinte receitas em três semanas"], "", "pt")), ["Vinte", "três"]);
is("a percent in French is not a hundred", safely(() => unsourcedNumbers(["20 pour cent de remise"], "20%", "fr")), []);
is("an English store does not read Spanish words", safely(() => unsourcedNumbers(["Once a week"], "", "en")), []);
is("the list says what it reads", review.ESTIMATE_NOTE, "These numbers are not in what you gave. Check each one, or change it to a figure you know. We find numbers written in digits and common number words, such as twenty, a dozen or half, but not every way to write one, so read the rest of the draft too.");

part("The same number written another way (LOW 3, 4 and 5)");
is("a given number before a comma", safely(() => unsourcedNumbers(["40 recipes"], "40, 50 or 60 recipes")), []);
is("the price field '19', the draft '$19'", safely(() => unsourcedNumbers(["Only $19"], ["", ...givenTexts({ kind: "product", title: "Bread", price: "19" })])), []);
is("notes '$19', the draft '19 dollars'", safely(() => unsourcedNumbers(["19 dollars"], "$19")), []);
is("notes '20%', the draft '20 percent'", safely(() => unsourcedNumbers(["20 percent off"], "20%")), []);
is("'$1,200' is listed as written", safely(() => unsourcedNumbers(["Earn $1,200 a month"], "")), ["$1,200"]);
is("'$5K' is listed as written", safely(() => unsourcedNumbers(["Earn $5K a month"], "")), ["$5K"]);
is("'1.5M' is listed as written", safely(() => unsourcedNumbers(["1.5M views"], "")), ["1.5M"]);
is("'5K' is the 5000 the creator gave", safely(() => unsourcedNumbers(["5K readers"], "5000 readers")), []);

part("Read by a screen reader with the checks (LOW 6)");
const described = renderToStaticMarkup(createElement(AiDraftReview, { checks: [false, false, false], onToggle: () => {}, estimates: ["20"] }));
const listId = described.match(/<div id="([^"]+)"[^>]*><p>These numbers/)?.[1];
is("the list has an id", typeof listId, "string");
is("the group is described by it", described.includes(`aria-describedby="${listId}"`), true);
const both = renderToStaticMarkup(createElement(AiDraftReview, { checks: [false, false, false], onToggle: () => {}, topics: ["money"], estimates: ["20"] }));
is("with a warning too, both describe it", /aria-describedby="[^" ]+ [^" ]+"/.test(both), true);

part("A link and common wording are not figures (Claude 6 focal return on #3437, LOW 1 and LOW 2)");
// The email box sends the product's own page, ".../p/<id>" (lib/checkout-recovery.ts, productLink).
const link = (productId: string) => `https://marktmorgen.com/@bakery/p/${productId}`;
is("the product link's id is not a given 5", safely(() => unsourcedNumbers(["5 tips for better bread"], ["", ...givenTexts({ kind: "email", link: link(id) })])), ["5"]);
is("the product link's id is not a given 53", safely(() => unsourcedNumbers(["53 bakers joined"], ["", ...givenTexts({ kind: "email", link: link("53a9c10b7d24f8e9a61c0d3b2f47e851") })])), ["53"]);
is("a store on its own domain: the link is not given either", safely(() => unsourcedNumbers(["7 loaves"], ["", ...givenTexts({ kind: "email", link: "https://shop.example.com/p/7c3a9c10b7d24f8e9a61c0d3b2f47e85" })])), ["7"]);
is("a link the creator typed without https is not a figure", safely(() => unsourcedNumbers(["8 loaves"], "see shop.example.com/p/8b1a2c3d")), ["8"]);
is("a link in the draft is not an invented figure", safely(() => unsourcedNumbers([`Read more at ${link(id)}`], "")), []);
is("the rest of what was sent is still given", safely(() => unsourcedNumbers(["40 recipes"], ["", ...givenTexts({ kind: "email", subject: "40 recipes", link: link(id) })])), []);
is("'10m' is the 10 minutes the creator gave", safely(() => unsourcedNumbers(["Book a 10m call"], "a 10 minute call")), []);
is("'10m' with nothing given is still listed as written", safely(() => unsourcedNumbers(["Book a 10m call"], "")), ["10m"]);
is("'$10m' is still ten million", safely(() => unsourcedNumbers(["Raised $10m"], "10 minutes")), ["$10m"]);
is("'10M' is still ten million", safely(() => unsourcedNumbers(["10M views"], "10 minutes")), ["10M"]);
is("'3D printing' is not a 3", safely(() => unsourcedNumbers(["3D printing basics"], "")), []);
is("an ordinal is not a figure, like 'second' in words", safely(() => unsourcedNumbers(["In the 2nd week, the 1st draft, the 3rd and the 4th"], "")), []);
is("'Double chocolate' is a flavor, not twice", safely(() => unsourcedNumbers(["Double chocolate cookies and triple berry jam"], "")), []);
is("'double your' and 'triple the' still claim a number", safely(() => unsourcedNumbers(["Double your sales and triple the reach"], "")), ["Double", "triple"]);
is("'0.125' is not the 125 the creator gave (nit)", safely(() => unsourcedNumbers(["0.125 inch thick"], "125 pages")), ["0.125"]);
is("'1.250' in a European draft is still 1250", safely(() => unsourcedNumbers(["1.250 Rezepte"], "1250 recipes", "de")), []);

done();
