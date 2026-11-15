/**
 * AX274 Part A / 310 [AX2] (WCAG 1.4.10 Reflow), found in the sweep of every /studio route on a seeded local build
 * (Claude 4 cloud AA, 15 November 2026; #4770): in a form drawn as a row that wraps (`flex flex-wrap`), a label given
 * `flex-1` beside a button has a basis of 0, so the row never wraps and, at 320 px, the field gets what the button
 * leaves: 31 px for the member's email on /studio/memberships, 83 px on /studio/people, 97 px for a share code on
 * /studio/funnels. Each such label now has a minimum basis, so the button goes to its own line first and the field
 * takes the whole width; wider screens keep the row.
 *
 * Read from every .tsx under components/ and app/: a <form> whose classes wrap and that holds a button may not hold a
 * label that grows (`flex-1`) with no basis or minimum width of its own.
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

const classOf = (tag: string): string => /className=(?:"([^"]*)"|\{`([^`]*)`\})/s.exec(tag)?.slice(1).find(Boolean) ?? "";
const grows = (cls: string) => /(?<![\w-])flex-1\b/.test(cls);
const holdsItsWidth = (cls: string) => /\bbasis-|\bmin-w-\[|\bmin-w-(?:[4-9]|\d\d)\b/.test(cls);

part("1.4.10: a growing label in a wrapping form row keeps a minimum width");
const squeezed: string[] = [];
let rows = 0;
for (const file of [...tsxFiles("components"), ...tsxFiles("app")]) {
  const source = readFileSync(file, "utf8");
  for (const form of source.matchAll(/<form\b[^>]*?>/gs)) {
    if (!/\bflex-wrap\b/.test(classOf(form[0]))) continue;
    const start = (form.index ?? 0) + form[0].length;
    const body = source.slice(start, source.indexOf("</form>", start));
    if (!body.includes("<button")) continue;
    rows += 1;
    for (const label of body.matchAll(/<label\b[^>]*?>/gs)) {
      const cls = classOf(label[0]);
      if (grows(cls) && !holdsItsWidth(cls)) squeezed.push(`${file}:${source.slice(0, start + (label.index ?? 0)).split("\n").length}`);
    }
  }
}
is(`wrapping form rows with a button are found (${rows})`, rows >= 4, true);
is("no growing label without a minimum width", squeezed.join(", "), "");

done();
