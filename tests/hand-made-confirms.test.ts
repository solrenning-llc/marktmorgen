/**
 * Three "are you sure" questions in the studio were made by hand instead of with ConfirmAction
 * (components/confirm-action.tsx): removing a saved section, a form with its answers, and a page of the site.
 * Pressing Remove took that button away and drew the question elsewhere, so the browser dropped the focus to the
 * top of the page and nothing took it to the question (WCAG 2.4.3); "Keep it" did the same; Escape did nothing
 * (2.1.1, WAI-ARIA Authoring Practices); and the Yes button was disabled while it waited. ConfirmAction does all of
 * it: the focus on "Keep it", Escape keeps, the focus back to Remove, Yes busy but focusable, and when the item
 * goes, the focus on the one beside it (tests/confirm-action-*-browser.test.ts).
 *
 * What fails here: a hand-made question again in any of the three.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

part("The three questions are ConfirmActions");
for (const [file, question, handMade] of [
  ["components/saved-sections.tsx", "Remove this section from the library? Pages keep their blocks.", /removing === section\.id \?/],
  ["components/forms-editor.tsx", "Remove this form and its answers?", /removing === form\.id \?/],
  ["components/site-pages-editor.tsx", "Remove this page and its blocks?", /\{confirm \? \(/],
] as const) {
  const text = readFileSync(file, "utf8");
  is(`${file}: no hand-made question`, handMade.test(text), false);
  is(`${file}: asks through ConfirmAction`, text.includes("<ConfirmAction") && text.includes(question), true);
}
done();
