/**
 * AX274 Part A (WCAG 2.5.5 Target Size (Enhanced), AAA), found in the browser by Claude 5FNwB (15 November 2026,
 * /studio, payment requests): the consent box #pr-consent ("This person agreed to pay me...") sat in a label 20 px tall,
 * its box 13 x 13 px, so the whole target was 20 px high. It now sits in a label at least 44 px tall (min-h-11), the box
 * and its words centered on one line (items-center), as the buyer's boxes are; the whole label still takes the click.
 * Read from the component's source, as tests/quiz-answer-target.test.ts reads its field.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

const source = readFileSync(join("components", "payment-requests-studio.tsx"), "utf8");
const at = source.indexOf('id="pr-consent"');
const before = source.slice(Math.max(0, at - 600), at);
const open = before.lastIndexOf("<label");
const label = open >= 0 && open > before.lastIndexOf("</label>") ? before.slice(open, before.indexOf(">", open) + 1) : "";

part("2.5.5: the payment request's consent box is a 44 px tall target");
is("the consent box is found", at >= 0, true);
is("it sits in a label, which takes the click", label !== "", true);
is("the label is at least 44 px tall", /\bmin-h-11\b/.test(label), true);
is("the box and its words are centered on the line", /\bitems-center\b/.test(label), true);
is("the label spans the row (a flex row, as before)", /\bflex\b/.test(label), true);
done();
