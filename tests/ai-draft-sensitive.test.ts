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
import { sensitiveTopics, sensitiveWarning } from "@/lib/ai-draft-review";
import { AiDraftReview } from "@/components/ai-draft-review";
import { done, is, part } from "./check";

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
is("one subject", sensitiveWarning(["health"]), "This draft is about health. Before you publish, have someone who knows health read it, and do not promise a result.");
is("two subjects", sensitiveWarning(["health", "money"]), "This draft is about health and money. Before you publish, have someone who knows health and money read it, and do not promise a result.");
is("three subjects", sensitiveWarning(["health", "money", "law"]), "This draft is about health, money and the law. Before you publish, have someone who knows health, money and the law read it, and do not promise a result.");
is("none: nothing", sensitiveWarning([]), null);

part("Drawn with the checks");
const warned = renderToStaticMarkup(createElement(AiDraftReview, { checks: [false, false, false], onToggle: () => {}, topics: ["money"] }));
is("the warning is in words, with its own label", [warned.includes("Sensitive topic:"), warned.includes("This draft is about money.")], [true, true]);
is("it sits inside the group, read before the checks", warned.indexOf("Sensitive topic:") < warned.indexOf('type="checkbox"'), true);
const plain = renderToStaticMarkup(createElement(AiDraftReview, { checks: [false, false, false], onToggle: () => {} }));
is("no subject: no warning", plain.includes("Sensitive topic:"), false);

part("Where it is used");
const assist = readFileSync("components/ai-assist.tsx", "utf8");
is("the box reads the subjects from the draft it fills in", assist.includes("setTopics(sensitiveTopics(JSON.stringify(data.value)))"), true);
is("and passes them to the checks", assist.includes("topics={topics}"), true);

done();
