/**
 * AX274 Part A, item 4 (WCAG 2.2 AAA, 2.5.5 Target Size (Enhanced)) on every page of a creator's store, not only
 * its front page.
 *
 * A link drawn as `.st-footer-link` mostly stands alone: "Back to <store>" on the tip page, "Visit <store>'s store"
 * on the letters page, the way back from a form, a group, a certificate or an agreement. The rule that makes it a
 * 44 px target was written for the store front only (`[data-store-layout] .st-footer-link`), and only the front page
 * carries `data-store-layout`, so on every other store page such a link was 20 px tall (measured on a seeded local
 * build: /@shop/tip 195 x 20, /@shop/letters 222 x 20).
 *
 * Now the rule holds on every page. A link inside a running sentence is exempt by 2.5.5 and must keep breaking with
 * its sentence: it is marked `st-in-sentence`, and every `.st-footer-link` written right after words in the same
 * paragraph carries that mark.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

const css = readFileSync(join("app", "globals.css"), "utf8");

/** The declarations of the first rule whose selector is exactly `selector`, or null. */
function ruleBody(selector: string): string | null {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) return null;
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

part("The 44 px rule holds on every store page, not only the front");
const link = ruleBody(".st-footer-link:not(summary, figcaption > *, .st-in-sentence)");
is("a rule for every .st-footer-link outside a sentence exists, with no [data-store-layout] prefix", link !== null, true);
is("it is an inline-flex box", /display:\s*inline-flex/.test(link ?? ""), true);
is("at least 44 px tall", /min-height:\s*2\.75rem/.test(link ?? ""), true);
const summary = ruleBody("summary.st-footer-link");
is("a summary drawn as such a link keeps its 44 px row everywhere too", /min-height:\s*2\.75rem/.test(summary ?? ""), true);
is("the front-only rules are gone (one rule for all pages)", /\[data-store-layout\] (summary)?\.st-footer-link/.test(css), false);

part("A link inside a sentence keeps breaking with it");
function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? tsxFiles(path) : path.endsWith(".tsx") ? [path] : [];
  });
}
const unmarked: string[] = [];
let inSentence = 0;
for (const file of [...tsxFiles("app"), ...tsxFiles("components")]) {
  const source = readFileSync(file, "utf8");
  const pattern = /<(Link|a)\b[^>]*className=\{?[`"]([^`"]*\bst-footer-link\b[^`"]*)[`"]/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const before = source.slice(Math.max(0, match.index - 80), match.index).trimEnd();
    // Words right before it in the same paragraph: a `{" "}` after an expression, or a template literal that ends in a space.
    const afterWords = /\{" "\}$/.test(before) || /` *\}$/.test(before) && /\$\{[^}]*\} `\}$/.test(before);
    if (!afterWords) continue;
    inSentence += 1;
    if (!/\bst-in-sentence\b/.test(match[2])) unmarked.push(`${file}:${source.slice(0, match.index).split("\n").length}`);
  }
}
is("the store's sentences with such a link are found (group, affiliate and ad notices)", inSentence >= 3, true);
is("every one of them is marked st-in-sentence", unmarked, []);

done();
