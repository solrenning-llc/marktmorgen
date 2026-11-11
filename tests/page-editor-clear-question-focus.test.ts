/**
 * The page editor's "Clear the page" question, from a keyboard
 * (components/page-editor.tsx; AX274 Part A; WCAG 2.2 2.4.3 Focus Order, 4.1.2,
 * 3.3.6). Seen in Chromium on 11 November 2026, /studio/pages, keyboard only:
 * Enter on "Clear the page" swapped the button for the question "Back to the
 * plain page?" with "Yes, clear it" and "Keep it", and the focus fell to the
 * page's body, since the button it was on was gone; "Keep it" did the same on
 * the way back. tests/page-editor-undo-clear-a11y.test.ts already holds the
 * focus after "Yes, clear it"; this holds the two steps before it.
 *
 * Now the focus goes to "Keep it", the choice that changes nothing, inside a
 * group named by the question, so a screen reader says the question with it;
 * "Keep it" sends the focus back to "Clear the page". Checked against the
 * source here; where the focus lands in a browser is in the pull request.
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const editor = readFileSync("components/page-editor.tsx", "utf8");
const askAt = editor.indexOf("Back to the plain page?");
const question = editor.slice(editor.lastIndexOf("confirmClear ? (", askAt), editor.indexOf("Clear the page\n", askAt));

is("the question is drawn where it was", askAt > 0 && question.length > 0, true);
is("it is a group named by its own words", /role="group" aria-labelledby="clear-question"/.test(question) && /id="clear-question"[^>]*>\s*Back to the plain page\?/.test(question), true);
is("Keep it holds a ref, so the focus can go to it", /<button ref=\{clearKeep\}[^>]*>\s*Keep it/.test(question), true);
is("Keep it marks that the focus goes back, then closes the question", /onClick=\{\(\) => \{\s*clearBack\.current = true;\s*setConfirmClear\(false\);\s*\}\}/.test(question), true);
is("Clear the page holds a ref, so the focus can come back to it", /<button ref=\{clearOpen\}[^>]*onClick=\{\(\) => setConfirmClear\(true\)\}/.test(question), true);

const effect = /useEffect\(\(\) => \{\s*if \(confirmClear\) clearKeep\.current\?\.focus\(\);\s*else if \(clearBack\.current\) \{\s*clearBack\.current = false;\s*clearOpen\.current\?\.focus\(\);\s*\}\s*\}, \[confirmClear\]\);/;
is("opening the question puts the focus on Keep it; Keep it puts it back on Clear the page", effect.test(editor), true);
is("after Yes, clear it, the focus is still sent by focusAfterClear, not by this effect", /function focusAfterClear\(\) \{/.test(editor) && !/clearBack\.current = true;[\s\S]{0,80}clearNow/.test(editor), true);

done();
