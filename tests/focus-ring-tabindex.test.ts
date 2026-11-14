/**
 * Everything a keyboard user can tab to shows the site's own focus ring (WCAG 2.4.7, and 2.4.13 at AAA): 3px of
 * --focus with room around it. The ring was given to links, buttons, inputs, selects, text areas and summaries
 * (app/globals.css); a region made focusable with tabIndex={0} (a table or a code block that scrolls sideways, so a
 * keyboard can scroll it: 2.1.1, axe scrollable-region-focusable) had only the browser's own default ring, thinner
 * and in the browser's colour. The rule stays inside :where(), so it weighs nothing and any element with a ring of its
 * own keeps it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

const root = process.cwd();
const css = readFileSync(join(root, "app/globals.css"), "utf8");
const ring = /:where\(([^)]*)\):focus-visible,\s*:where\(input\[type="radio"\]\):focus\s*\{([^}]*)\}/.exec(css);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) walk(path, out);
    else if (path.endsWith(".tsx")) out.push(path);
  }
  return out;
}
const focusable = ["app", "components"].flatMap((dir) => walk(dir)).filter((file) => readFileSync(join(root, file), "utf8").includes("tabIndex={0}"));

part("the site's focus ring");
is("is there", ring !== null, true);
is("is 3px of --focus with room around it", /outline:\s*3px solid var\(--focus\)/.test(ring?.[2] ?? "") && /outline-offset:\s*3px/.test(ring?.[2] ?? ""), true);
is("weighs nothing, so an element's own ring wins", ring?.[0].startsWith(":where(") ?? false, true);

part("a region made focusable by tabIndex={0} shows it too");
is("such regions exist", focusable.length > 0, true);
is('the ring includes [tabindex="0"]', (ring?.[1] ?? "").split(",").map((s) => s.trim()).includes('[tabindex="0"]'), true);

done();
