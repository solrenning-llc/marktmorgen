/**
 * AX274 Part A (WCAG 2.4.7 Focus Visible, AA; 2.4.13 Focus Appearance, AAA), found on a seeded local build (Claude 4
 * cloud AA, 15 November 2026; /studio/course/<product>, a lesson open): "Upload a video", "Add a download", "Add
 * captions" and "Add lessons from videos" are labels drawn as buttons around, or beside, a file field kept visually
 * hidden (`sr-only`). The Tab key stops on the hidden field, whose own 3 px ring is clipped to one pixel, and the
 * label shows nothing: the person cannot see where the focus is. The same holds in the look editor, the email
 * picture button and the funnel-share file picker.
 *
 * The ring is now drawn on what is seen: the label that wraps the hidden field, the label just before it, or the
 * label just after it (app/globals.css). A hidden field that is out of the tab order (tabIndex -1) needs none.
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

/** Each `<input ... />` in a file, read to its own end: braces in its props (arrow functions) are skipped over. */
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

const css = readFileSync(join("app", "globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

part("2.4.7: the label of a visually hidden file field shows the focus ring");
const ring = /([^{}]+)\{([^{}]*)\}/g;
const selectors: string[] = [];
for (let match = ring.exec(css); match; match = ring.exec(css)) {
  if (/outline:\s*3px solid/.test(match[2])) selectors.push(...match[1].split(",").map((s) => s.trim()));
}
const has = (wanted: RegExp) => selectors.some((selector) => wanted.test(selector.replace(/\s+/g, " ")));
is("a label wrapping the hidden field draws the ring", has(/label:has\(> input\[type="file"\]\.sr-only:focus-visible\)/), true);
is("a label just before the hidden field draws the ring", has(/label:has\(\+ input\[type="file"\]\.sr-only:focus-visible\)/), true);
is("a label just after the hidden field draws the ring", has(/input\[type="file"\]\.sr-only:focus-visible \+ label/), true);

part("2.4.7: every visually hidden file field that takes the focus has a label the ring can be drawn on");
const bare: string[] = [];
let hidden = 0;
for (const file of [...tsxFiles("components"), ...tsxFiles("app")]) {
  const source = readFileSync(file, "utf8");
  for (const { index, tag } of inputTags(source)) {
    if (!/\btype="file"/.test(tag)) continue;
    if (!/\bsr-only\b/.test(tag) || /tabIndex=\{-1\}/.test(tag)) continue;
    hidden += 1;
    const before = source.slice(Math.max(0, index - 800), index);
    const after = source.slice(index + tag.length, index + tag.length + 200);
    const wrapped = before.lastIndexOf("<label") > before.lastIndexOf("</label>");
    const labelBefore = /<\/label>\s*$/.test(before);
    const labelAfter = /^\s*<label\b/.test(after);
    if (!wrapped && !labelBefore && !labelAfter) bare.push(`${file}:${source.slice(0, index).split("\n").length}`);
  }
}
is(`the hidden file fields are found (${hidden})`, hidden >= 7, true);
is("no hidden file field without a wrapping or neighbouring label", bare.join(", "), "");

done();
