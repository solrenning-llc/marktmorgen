/**
 * Which page a buyer is on, in the store's page links (components/store-pages-nav.tsx, .st-pages-link) and in the
 * community's tabs, side list and chips (app/[handle]/community, .cm-tab, .cm-side, .cm-chip), must be seen
 * without colour alone (WCAG 2.2 1.4.1 Use of Color, A; 2.4.8 Location, AAA; 1.4.11 for the state of a control)
 * and in forced colors (Windows High Contrast), where the system replaces every background, border and text
 * colour and drops box shadows. 274 [AX1].
 *
 * Found reading the stylesheet on 13 November 2026 (buyer AAA audit, forced colors):
 *
 *   - .st-pages-link[aria-current="page"] differed from the other links only by the colour of its words and its
 *     edge, the same look as a link under the pointer: by colour alone in every mode;
 *   - .cm-tab[aria-current] by its filled background (and the others by opacity 0.78, which forced colors keep, so
 *     the other tabs' words lost contrast), .cm-side[aria-current] by a tint and an inset box shadow, and
 *     .cm-chip[aria-current] by its fill: forced colors draw all of them the same.
 *
 * Holds, reading app/globals.css (comments stripped):
 *   - the current store page link is underlined, in every mode, and a link under the pointer is not;
 *   - in forced colors the current community tab, side link and chip are drawn in the system's Highlight with
 *     HighlightText words, and no community tab is faded.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const css = readFileSync("app/globals.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selectors: string[]; body: string; forced: boolean };

/** Plain rules, and the rules inside each @media (forced-colors: active) block, one level deep. */
function rules(): Rule[] {
  const out: Rule[] = [];
  let at = 0;
  const media = /@media\s*\(forced-colors:\s*active\)\s*\{/g;
  const blocks: [number, number][] = [];
  for (let m = media.exec(css); m; m = media.exec(css)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (depth && i < css.length) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
      i += 1;
    }
    blocks.push([m.index + m[0].length, i - 1]);
  }
  const read = (text: string, forced: boolean) => {
    for (const r of text.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) out.push({ selectors: r[1].split(",").map((s) => s.trim()), body: r[2], forced });
  };
  for (const [start, end] of blocks) {
    read(css.slice(at, start).replace(/@media[^{]*\{$/, ""), false);
    read(css.slice(start, end), true);
    at = end + 1;
  }
  read(css.slice(at), false);
  return out;
}

const all = rules();
const declares = (selector: string, forced: boolean, test: RegExp) =>
  all.some((r) => r.forced === forced && r.selectors.includes(selector) && test.test(r.body));

part("the reader itself: it finds rules already there, inside and outside forced colors");
is("the forced-colors outline of the course progress bar", declares(".cm-progress", true, /outline:\s*1px solid CanvasText/), true);
is("the plain current community tab", declares('.cm-tab[aria-current="page"]', false, /background:\s*var\(--st-accent\)/), true);

part("1.4.1 and 2.4.8: the current store page link is told by more than colour, in every mode");
is("it is underlined", declares('.st-pages-link[aria-current="page"]', false, /text-decoration(-line)?:\s*underline/), true);
is(
  "a link under the pointer is not, so the two still look different",
  all.some((r) => !r.forced && r.selectors.includes(".st-pages-link:hover") && /text-decoration(-line)?:\s*underline/.test(r.body)),
  false,
);

part("forced colors: the current community tab, side link and chip keep a sign of their own");
for (const selector of ['.cm-tab[aria-current="page"]', '.cm-side[aria-current="page"]', '.cm-chip[aria-current="page"]']) {
  is(`${selector}: drawn in the system's Highlight`, declares(selector, true, /background(-color)?:\s*Highlight\b/), true);
  is(`${selector}: with HighlightText words`, declares(selector, true, /color:\s*HighlightText\b/), true);
  is(`${selector}: the system keeps those two colours`, declares(selector, true, /forced-color-adjust:\s*none/), true);
}
is(
  "the bold theme's own current tab, which outranks the plain one, takes the same",
  declares('.st-theme-bold .cm-bar .cm-tab[aria-current="page"]', true, /background(-color)?:\s*Highlight\b/),
  true,
);
is(
  "the focus ring around a current tab is the system's text colour, not the store's own",
  declares('.cm-tab[aria-current="page"]:focus-visible', true, /outline-color:\s*CanvasText\b/),
  true,
);
is("no community tab is faded in forced colors, where opacity would still dim its words", declares(".cm-tab", true, /opacity:\s*1\b/), true);
done();
