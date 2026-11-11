/**
 * "Add a question" in a course quiz (components/quiz-editor.tsx; AX274 Part
 * A; WCAG 2.2 2.4.3, 4.1.3). It added the question and left the focus on the
 * button without a word, so a screen reader user never learned a question
 * was there to fill in. As the page editor and the FAQ editor already do, the
 * focus now goes into the new question's text, "Question N", once it is
 * drawn (lib/focus-when-drawn.ts), which says it by its label.
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const src = readFileSync("components/quiz-editor.tsx", "utf8");
const at = src.indexOf("Add a question\n");
const button = src.slice(src.lastIndexOf("<button", at), at);
is("the Add a question button is found", at > 0, true);
is("it adds the blank question, then sends the focus to its text once drawn", /onClick=\{\(\) => \{\s*const next = draft\.questions\.length;\s*setDraft\(\{ \.\.\.draft, questions: \[\.\.\.draft\.questions, blankQuestion\(\)\] \}\);\s*focusWhenDrawn\(\(\) => document\.getElementById\(`\$\{prefix\}-q\$\{next\}-text`\), browserFrames\(\)\);\s*\}\}/.test(button), true);
is("the new question's text has that id and is labelled Question N", /htmlFor=\{`\$\{qid\}-text`\}[^>]*>\{`Question \$\{qi \+ 1\}`\}/.test(src) && /const qid = `\$\{prefix\}-q\$\{qi\}`;/.test(src), true);
is("it uses the shared helper", /import \{ browserFrames, focusWhenDrawn \} from "@\/lib\/focus-when-drawn";/.test(src), true);

done();
