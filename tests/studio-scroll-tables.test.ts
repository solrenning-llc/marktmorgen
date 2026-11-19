/**
 * AX274 Part A (WCAG 2.1.1 Keyboard, A; axe `scrollable-region-focusable`) in the studio, found on a seeded local
 * build (Claude 4 cloud AA, 15 November 2026; /studio/deals at 390 px): a table wider than a phone (`min-w-[...]`)
 * sits in a box that scrolls sideways, and the box could not take the focus, so its far columns could not be
 * reached from the keyboard. Each such box is now a focusable region named after its table, as #4512 does for the
 * memberships tables ("..., as a table").
 *
 * And on /studio/team (axe `landmark-unique`), the roles table's region had the very name of its section, "What each
 * role can do": two landmarks with one name. The region now says it is the table.
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

part("2.1.1: a sideways-scrolling box around a wide table takes the focus and has a name");
const unreachable: string[] = [];
let wide = 0;
for (const file of [...tsxFiles("components"), ...tsxFiles(join("app", "studio"))]) {
  const source = readFileSync(file, "utf8");
  const pattern = /<div\b([^>]*\boverflow-x-auto\b[^>]*)>\s*<table\b[^>]*\bmin-w-\[/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    wide += 1;
    const attrs = match[1];
    if (!/tabIndex=\{0\}/.test(attrs) || !/role="region"/.test(attrs) || !/aria-label(ledby)?=/.test(attrs)) {
      unreachable.push(`${file}:${source.slice(0, match.index).split("\n").length}`);
    }
  }
}
is("wide tables in sideways-scrolling boxes are found", wide >= 8, true);
is("every one is a focusable, named region", unreachable, []);

part("landmark-unique: the roles table's region is not named as its section");
const team = readFileSync(join("components", "team-manager.tsx"), "utf8");
const heading = /<h2 id="roles-title"[^>]*>\s*([^<]+?)\s*</.exec(team)?.[1] ?? "";
const region = /role="region" aria-label="([^"]+)"/.exec(team.slice(team.indexOf('id="roles-title"')))?.[1] ?? "";
is("the section and its table region are found", [heading !== "", region !== ""], [true, true]);
is("their names differ", region !== heading, true);

done();
