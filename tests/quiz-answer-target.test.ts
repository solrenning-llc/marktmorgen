/**
 * AX274 Part A (WCAG 2.5.5 Target Size (Enhanced), AAA), found on a seeded local build (Claude 4 cloud AA,
 * 15 November 2026; /studio/course/<product>, a lesson's quiz open): the box or circle that marks an answer as right
 * ("Answer 1 is right") measured 20 x 20 px, with no label around it, so nothing larger could be clicked or tapped.
 * It now sits in a label 44 x 44 px, which ticks it too; its name stays on the field.
 *
 * And no radio or checkbox named only by `aria-label` sits bare anywhere in the components: each has a label around
 * it that takes the click.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? tsxFiles(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

/** Each `<input ...>` in a file, read to its own end: braces in its props (arrow functions) are skipped over. */
function inputTags(source: string): { index: number; tag: string }[] {
  const tags: { index: number; tag: string }[] = [];
  for (let start = source.indexOf("<input"); start >= 0; start = source.indexOf("<input", start + 1)) {
    let depth = 0;
    for (let at = start; at < source.length; at += 1) {
      const c = source[at];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) {
        tags.push({ index: start, tag: source.slice(start, at + 1) });
        break;
      }
    }
  }
  return tags;
}

/** The opening tag of the label an input sits in, or "" when it sits in none. */
function wrappingLabel(source: string, index: number): string {
  const before = source.slice(Math.max(0, index - 600), index);
  const open = before.lastIndexOf("<label");
  if (open < 0 || open < before.lastIndexOf("</label>")) return "";
  return before.slice(open, before.indexOf(">", open) + 1);
}

part("2.5.5: the mark for a right answer in the quiz editor is a 44 x 44 px target");
const quiz = readFileSync(join("components", "quiz-editor.tsx"), "utf8");
const right = inputTags(quiz).find(({ tag }) => tag.includes("is right`}"));
is("the right-answer field is found", !!right, true);
const label = right ? wrappingLabel(quiz, right.index) : "";
is("it sits in a label", label !== "", true);
is("the label is at least 44 px tall", /\b(min-)?h-11\b/.test(label), true);
is("the label is at least 44 px wide", /\b(min-)?w-11\b/.test(label), true);
is("its name stays on the field", right ? /aria-label=\{`Answer \$\{ci \+ 1\} is right`\}/.test(right.tag) : false, true);

part("2.5.5: no radio or checkbox named only by aria-label sits outside a label");
const bare: string[] = [];
for (const file of [...tsxFiles("components"), ...tsxFiles("app")]) {
  const source = readFileSync(file, "utf8");
  for (const { index, tag } of inputTags(source)) {
    if (!/type=(\{[^}]*\b(radio|checkbox)\b[^}]*\}|"(radio|checkbox)")/.test(tag)) continue;
    if (/\bsr-only\b/.test(tag) || !/\baria-label=/.test(tag)) continue;
    if (!wrappingLabel(source, index)) bare.push(`${file}:${source.slice(0, index).split("\n").length}`);
  }
}
is("every such field has a label around it", bare.join(", "), "");

done();
