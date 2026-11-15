/**
 * AX274 Part A / 310 [AX2] (WCAG 1.4.4 Resize Text, AA; 1.4.10), found in the sweep of every /studio route on a
 * seeded local build with the text at 200% (Claude 4 cloud AA, 15 November 2026; #4787): `.btn` kept
 * `white-space: nowrap` with no `max-width` at every width above 479 px, so a long label ("Turn on two-step login",
 * "See the journey and what you need: …") pushed the studio 21 to 129 px past the screen.
 *
 * At every width, a .btn outside a store page body may now break its label onto a second line when the label is
 * wider than its room (`max-width: 100%`, `white-space: normal`), and keeps its own width in a row
 * (`flex-shrink: 0`), so a button that fits is drawn exactly as before.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

const css = readFileSync(join("app", "globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The rules at the top level of the sheet (not inside @media, @container or @layer), as [selector, body]. */
function topLevelRules(sheet: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < sheet.length; at += 1) {
    if (sheet[at] === "{") {
      if (depth === 0) start = at;
      depth += 1;
    } else if (sheet[at] === "}") {
      depth -= 1;
      if (depth === 0) {
        const head = sheet.slice(sheet.lastIndexOf("}", start - 1) + 1, start).trim();
        if (!head.startsWith("@")) out.push([head, sheet.slice(start + 1, at)]);
      }
    }
  }
  return out;
}

part("1.4.4: at any width, a long button label wraps inside its room");
const rules = topLevelRules(css).filter(([selector]) => selector.split(",").some((s) => s.trim() === ".btn:where(:not(.sp-body *))"));
const body = rules.map(([, b]) => b).join(";");
is("a top-level rule for .btn outside a store page body", rules.length > 0, true);
is("max-width: 100%", /max-width:\s*100%/.test(body), true);
is("white-space: normal", /white-space:\s*normal/.test(body), true);
is("flex-shrink: 0, so a button that fits keeps its width in a row", /flex-shrink:\s*0/.test(body), true);

done();
