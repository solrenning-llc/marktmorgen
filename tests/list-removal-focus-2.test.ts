/**
 * WCAG 2.4.3, the next three studio lists after tests/list-removal-focus.test.ts: a form's questions and its
 * results (components/forms-editor.tsx) and a lesson quiz's questions (components/quiz-editor.tsx). Removing one
 * took its Remove button with it and the browser dropped the focus to the top of the page. Each now hands the
 * focus on with handFocusOnAfterRemoval (lib/focus-when-drawn.ts): the item now in its place, or the one before,
 * or the list's Add button when none is left or the one left cannot be removed. The helper itself is proven in
 * Chromium by tests/list-removal-focus-browser.test.ts.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

part("A form's questions and results, and a quiz's questions, hand the focus on");
for (const [file, mark, add] of [
  ["components/forms-editor.tsx", '"form-question"', '"form-question-add"'],
  ["components/forms-editor.tsx", '"form-result"', '"form-result-add"'],
  ["components/quiz-editor.tsx", "{`${prefix}-question`}", "{`${prefix}-question-add`}"],
] as const) {
  const text = readFileSync(file, "utf8");
  is(`${file}: its Remove buttons carry data-list-remove=${mark}`, text.includes(`data-list-remove=${mark}`), true);
  is(`${file}: its Add button has the id ${add}`, text.includes(`id=${add}`), true);
  is(`${file}: the removal hands the focus on`, text.includes("handFocusOnAfterRemoval("), true);
}
done();
