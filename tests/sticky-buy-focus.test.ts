/**
 * The buy bar held at the bottom of a phone's screen on a product's page
 * (components/sticky-buy.tsx) must never cover what has keyboard focus
 * (WCAG 2.2 2.4.11 Focus Not Obscured (Minimum), AA, and 2.4.12 (Enhanced),
 * AAA; 274 [AX1]).
 *
 * Found by a browser audit (11 November 2026, Chromium, a synthetic store,
 * tests/e2e/sticky-buy-focus.mjs): at 320, 390 and 600 px, Tab brought the
 * "Everything from Quiet Oven" link to the bottom of the screen, under the bar,
 * hidden whole; a product card above it was half hidden. The browser scrolls a
 * focused element into view, but the fixed bar sits over the bottom of that
 * view. The page's scroll padding is what tells the browser that the bottom of
 * the view is taken.
 *
 * This reads the style sheet; the browser check is tests/e2e/sticky-buy-focus.mjs.
 * It certifies nothing else.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const css = readFileSync("app/globals.css", "utf8");

/** Each `@media (max-width: 639.98px) { ... }` block's body, braces matched. */
function phoneBlocks(text: string): string[] {
  const blocks: string[] = [];
  const head = "@media (max-width: 639.98px)";
  for (let at = text.indexOf(head); at !== -1; at = text.indexOf(head, at + head.length)) {
    const open = text.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) {
        blocks.push(text.slice(open + 1, i));
        break;
      }
    }
  }
  return blocks;
}

/** The declarations of the first rule in `block` whose selector is exactly `selector`. */
function ruleBody(block: string, selector: string): string | null {
  const at = block.indexOf(selector + " {");
  if (at === -1) return null;
  const open = block.indexOf("{", at);
  return block.slice(open + 1, block.indexOf("}", open));
}

/** A length in rem, as the declaration writes it ("calc(5.5rem + ...)" or "5.5rem"); NaN when there is none. */
function remOf(value: string): number {
  const m = /(\d+(?:\.\d+)?)rem/.exec(value);
  return m ? Number(m[1]) : Number.NaN;
}

part("2.4.11 / 2.4.12: while the phone's buy bar is shown, the page's scroll padding keeps focus above it");
const blocks = phoneBlocks(css);
const bar = blocks.map((b) => ruleBody(b, ".st-sticky-buy")).find(Boolean) ?? "";
is("the bar is fixed to the bottom of a phone's screen", /position:\s*fixed/.test(bar) && /inset:\s*auto 0 0 0/.test(bar), true);
// Not only while the bar is shown: Tab can bring a card into view while the bar is away, scroll the buy box off
// screen and so bring the bar back over that card (the browser check found 13 such stops when the padding
// followed the bar).
const padded = blocks.map((b) => ruleBody(b, "html:has(.st-sticky-buy)")).find(Boolean) ?? "";
const declared = /scroll-padding-bottom:\s*([^;]+);/.exec(padded)?.[1] ?? "";
is("the page has a bottom scroll padding whenever the bar is on a phone's page", declared !== "", true);
// The bar: 0.65rem above and below a 44 px (2.75rem) button, and a 1 px border: about 4.1rem, without a phone's safe area.
is("the padding is taller than the bar (more than 4.1rem)", remOf(declared) > 4.1, true);
is("the padding adds the phone's safe area, as the bar does", /env\(safe-area-inset-bottom\)/.test(declared), true);
const away = blocks.map((b) => ruleBody(b, ".st-sticky-buy[data-away]")).find(Boolean) ?? "";
is("the bar still slides away while the buy box is on screen", /translateY\(110%\)/.test(away), true);

done();
