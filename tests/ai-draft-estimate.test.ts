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
import { ESTIMATE_BADGE, draftStrings, unsourcedNumbers } from "@/lib/ai-draft-review";
import { AiDraftReview } from "@/components/ai-draft-review";
import { done, is, part } from "./check";

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
is("the box compares the draft with what was typed and sent", assist.includes("setEstimates(unsourcedNumbers(draftStrings(data.value), `${notes}\\n${JSON.stringify(sent)}`))"), true);
is("and passes them to the checks", assist.includes("estimates={estimates}"), true);

done();
