/**
 * An AI draft about health, money or the law says so (756 [STN3], unit 2).
 *
 * When the draft the writing box filled in is about one of those subjects,
 * the "AI draft" checks carry a warning in words: have someone who knows the
 * subject read it before publishing, and promise no result. Found by a local
 * word rule (lib/ai-draft-review.ts, sensitiveTopics); nothing calls a model,
 * reads or writes anything. Words inside other words are never taken for one.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as review from "@/lib/ai-draft-review";
import { readAiAnswer } from "@/lib/ai-response";
import { AiDraftReview } from "@/components/ai-draft-review";
import { done, is, part } from "./check";

const { draftStrings, draftTopics, sensitiveTopics, sensitiveWarning } = review;

part("Which subjects a draft is about");
is("a bread course: none", sensitiveTopics("Forty loaves, one a week, with a shopping list."), []);
is("health", sensitiveTopics("A gentle plan to manage your symptoms and talk to your doctor."), ["health"]);
is("money", sensitiveTopics("How I invest a small part of my income every month."), ["money"]);
is("the law", sensitiveTopics("What to put in a contract with a client, and when to call a lawyer."), ["law"]);
is("all three, in a fixed order", sensitiveTopics("Your lawyer, your doctor and your retirement savings."), ["health", "money", "law"]);
is("case does not matter", sensitiveTopics("CRYPTO for beginners"), ["money"]);
is("a word inside another word is not one", sensitiveTopics("The lawn, the outlaw-free garden, a treaty of flowers, curious cats."), []);
is("read from any text the draft holds, deep inside", sensitiveTopics(JSON.stringify({ summary: "A course", about: { lessons: ["Stock market basics"] } })), ["money"]);
is("nothing: none", sensitiveTopics(""), []);

part("What it says");
is("one subject", sensitiveWarning(["health"]), "This draft is about health. Before you publish, have someone who knows the subject read it, such as a doctor, and do not promise a result.");
is("two subjects", sensitiveWarning(["health", "money"]), "This draft is about health and money. Before you publish, have someone who knows each subject read it, such as a doctor or a financial advisor, and do not promise a result.");
is("three subjects", sensitiveWarning(["health", "money", "law"]), "This draft is about health, money and the law. Before you publish, have someone who knows each subject read it, such as a doctor, a financial advisor or a lawyer, and do not promise a result.");
is("none: nothing", sensitiveWarning([]), null);

part("Drawn with the checks");
const warned = renderToStaticMarkup(createElement(AiDraftReview, { checks: [false, false, false], onToggle: () => {}, topics: ["money"] }));
is("the warning is in words, with its own label", [warned.includes("Sensitive topic:"), warned.includes("This draft is about money.")], [true, true]);
is("it sits inside the group, read before the checks", warned.indexOf("Sensitive topic:") < warned.indexOf('type="checkbox"'), true);
const plain = renderToStaticMarkup(createElement(AiDraftReview, { checks: [false, false, false], onToggle: () => {} }));
is("no subject: no warning", plain.includes("Sensitive topic:"), false);

part("Where it is used");
const assist = readFileSync("components/ai-assist.tsx", "utf8");
is("the box reads the subjects from the draft it fills in", assist.includes("setTopics(draftTopics(draftStrings(data.value), data.language))"), true);
is("and passes them to the checks", assist.includes("topics={topics}"), true);

part("Read from the draft's own words, not its JSON (Claude 6 review of #3436, MEDIUM 1)");
// A thrown error is a failure like any other, so one missing function does not hide the rest.
const safely = (read: () => unknown) => {
  try {
    return read();
  } catch (error) {
    return `threw: ${(error as Error).message}`;
  }
};
is("a word right after a line break", safely(() => draftTopics(draftStrings({ title: "Week one", body: "Overview\nInvesting for beginners" }), "en")), ["money"]);
is("a word after a paragraph break", safely(() => draftTopics(draftStrings({ title: "Notes", body: "Hello.\n\nTaxes for freelancers" }), "en")), ["money"]);
is("a word after a tab", safely(() => draftTopics(draftStrings("Step 1:\tDiagnosis"), "en")), ["health"]);
is("a word deep inside a list", safely(() => draftTopics(draftStrings({ about: { lessons: ["Intro", "Stock market basics"] } }), "en")), ["money"]);
is("the keys of the draft are never read", safely(() => draftTopics(draftStrings({ health: "Bread", law: "Rye" }), "en")), []);
const assistNow = readFileSync("components/ai-assist.tsx", "utf8");
is("the box never reads the subjects from the JSON text", assistNow.includes("sensitiveTopics(JSON.stringify("), false);

part("A draft in another store language is never left without the warning (MEDIUM 2)");
is("a Portuguese draft: the general warning", safely(() => draftTopics(draftStrings("Um plano para cuidar da sua saúde"), "pt")), "unread");
is("a Spanish draft about nothing sensitive: still the general warning", safely(() => draftTopics(draftStrings("Pan casero"), "es")), "unread");
is("a draft whose language was not said: the general warning", safely(() => draftTopics(draftStrings("Brot backen"), null)), "unread");
is("the general warning says what to do and what is checked", safely(() => sensitiveWarning("unread")), "If this draft is about health, money or the law, have someone who knows the subject read it before you publish, such as a doctor, a financial advisor or a lawyer, and do not promise a result. We look for these subjects only in drafts written in English.");
is("the writing help says which language the draft is in", readAiAnswer(true, { ok: true, value: "Hola", left: 3, language: "es" }), { ok: true, value: "Hola", left: 3, language: "es" });
is("a language that is not a store language is not passed on", readAiAnswer(true, { ok: true, value: "Hola", left: 3, language: "xx" }), { ok: true, value: "Hola", left: 3 });
const route = readFileSync("app/api/store/ai/route.ts", "utf8");
is("the route answers with the store's language", route.includes("language: store.language"), true);
is("the box reads the subjects with the draft's language", assistNow.includes("draftTopics(draftStrings(data.value), data.language)"), true);
const general = String(safely(() => renderToStaticMarkup(createElement(AiDraftReview, { checks: [false, false, false], onToggle: () => {}, topics: "unread" }))));
is("the general warning is drawn with its own label", [general.includes("Health, money or the law:"), general.includes("We look for these subjects only in drafts written in English.")], [true, true]);

part("Common wording found, harmless drafts left alone (LOW 3 and 4)");
for (const [what, text, want] of [
  ["money itself", "Make money online in 30 days", ["money"]],
  ["finance", "Personal finance for nurses", ["health", "money"]],
  ["plural diseases", "Rare diseases explained", ["health"]],
  ["visas", "Visas explained", ["law"]],
  ["weight-loss with a hyphen", "A weight-loss plan", ["health"]],
  ["taxed", "How tips are taxed", ["money"]],
  ["cancer", "Life after cancer", ["health"]],
  ["chronic pain", "Yoga for chronic pain", ["health"]],
  ["healing", "Healing after loss", ["health"]],
  ["trauma", "Writing through trauma", ["health"]],
  ["dog treats", "Homemade dog treats, three flavors", []],
  ["stock photos", "100 stock photos for your blog", []],
  ["a commercial license on a font", "Includes a personal and commercial license", []],
  ["chicken stock and cured meats", "Chicken stock and cured meats", []],
  ["earn a certificate", "Earn a certificate when you finish", []],
  ["the basketball court", "Drills for the basketball court", []],
  ["a money-back guarantee", "A 30-day money-back guarantee", []],
] as const) is(what, safely(() => draftTopics([text], "en")), want);

part("Read by a screen reader with the checks (LOW 5)");
const described = renderToStaticMarkup(createElement(AiDraftReview, { checks: [false, false, false], onToggle: () => {}, topics: ["money"] }));
const warningId = described.match(/<p id="([^"]+)"[^>]*><strong>Sensitive topic:/)?.[1];
is("the warning has an id", typeof warningId, "string");
is("the group is described by the warning", described.includes(`aria-describedby="${warningId}"`), true);
is("no warning: the group is not described by one", renderToStaticMarkup(createElement(AiDraftReview, { checks: [false, false, false], onToggle: () => {} })).includes("aria-describedby"), false);

part("Sale and product wording is not a subject; the subject in a phrase still is (Claude 6 focal return on #3436, LOW)");
for (const [what, text, want] of [
  ["save money with a bundle", "Save money with the bundle", []],
  ["saves money", "This kit saves money on every batch", []],
  ["trading cards", "Pokemon trading cards, sorted by set", []],
  ["a trading card game", "Sleeves for any trading card game", []],
  ["while stocks last", "Free stickers while stocks last", []],
  ["big savings", "Big savings on every kit", []],
  ["savings on shipping", "Savings on shipping for every order", []],
  ["a taxing workout", "A taxing leg workout for runners", []],
  ["treated wood", "Planters made of treated wood", []],
  ["pressure-treated lumber", "A bench of pressure-treated lumber", []],
  ["treated with care", "Every order is packed and treated with care", []],
  ["the law of attraction", "The law of attraction journal", []],
  ["money is still money", "Why money feels stressful, and what to do", ["money"]],
  ["make money is still money", "Make money online in 30 days", ["money"]],
  ["save money on taxes: the taxes", "Save money on your taxes this year", ["money"]],
  ["day trading", "Day trading for beginners", ["money"]],
  ["trading stocks", "Trading stocks with a small account", ["money"]],
  ["penny stocks", "Penny stocks to watch", ["money"]],
  ["retirement savings", "Grow your retirement savings", ["money"]],
  ["a savings account", "Open a savings account that pays you", ["money"]],
  ["how depression is treated", "How depression is treated today", ["health"]],
  ["treated for anxiety, both words", "Treated for anxiety at twenty", ["health"]],
  ["the law", "What the law says about refunds", ["law"]],
] as const) is(what, safely(() => draftTopics([text], "en")), want);

part("The sale wording left out is narrow: a real subject that shares its words is still found (Claude 6 focal return on #3436, review 5831979153, LOW)");
for (const [what, text, want] of [
  ["saving money as the subject", "Saving money: a 30-day plan", ["money"]],
  ["save money on groceries", "How to save money on groceries", ["money"]],
  ["savings on autopilot", "Grow your savings on autopilot", ["money"]],
  ["put your savings on autopilot", "Put your savings on autopilot", ["money"]],
  ["build big savings", "Build big savings fast", ["money"]],
  ["taxing a side hustle", "Taxing your side hustle", ["money"]],
  ["wounds treated to prevent infection", "Wounds treated to prevent infection", ["health"]],
  ["patients treated like family", "Patients treated like family", ["health"]],
  ["save money with the kit: still none", "Save money with this kit", []],
  ["savings on your order: still none", "Savings on your order today", []],
  ["big savings alone: still none", "Big savings!", []],
  ["a taxing hill climb: still none", "A taxing hill climb", []],
  ["treated to a free gift: still none", "Every buyer is treated to a free gift", []],
  ["customers treated like royalty: still none", "Customers treated like royalty", []],
  ["a mother-in-law is not the law", "Gifts for your mother-in-law", []],
  ["Murphy's law is not the law", "A Murphy's law mug", []],
  ["tax included is a price, not a subject", "Free shipping, tax included", []],
  ["trading pins", "Trading pins for park fans", []],
  ["in-law still finds the law nearby", "Your rights as an in-law in court", ["law"]],
  ["sales tax as a subject", "Sales tax for online sellers", ["money"]],
] as const) is(what, safely(() => draftTopics([text], "en")), want);

done();
