import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * WCAG 2.2 1.4.8 Visual Presentation, AAA (274 [AX1]): a block of text is no
 * wider than 80 characters. Found by a browser audit (11 November 2026,
 * Chromium, synthetic store, characters counted on each rendered line) at
 * 1280 px: the buyer's purchases page note "What you bought is here while this
 * store is open..." ran 84 characters a line, and the library's "Purchases
 * count from October 11, 2026..." 85. Both sat in a 36rem (max-w-xl) column in
 * small type.
 *
 * Each is capped in `ch`, the width of the page font's "0", so the cap follows
 * the font and the buyer's language. Geist's "0" is wide (0.66em), so 60ch
 * was still 557 px and 84 characters a line; 50ch is about 70 in Geist and
 * stays under 80 for a font whose letters average up to 0.62 of its "0".
 * This reads the pages' source; the browser audit is the evidence.
 */
const capOf = (cls: string): number | null => {
  const m = /(?:^|\s)max-w-\[(\d+)ch\](?:\s|$)/.exec(cls);
  return m ? Number(m[1]) : null;
};

/** The class list of the first `<p` opening tag whose tag or next line holds `marker`. */
function paragraphClass(source: string, marker: string): string {
  const at = source.indexOf(marker);
  assert.ok(at > 0, `${marker} is on the page`);
  const open = source.lastIndexOf("<p ", at);
  const tag = source.slice(open, source.indexOf(">", open) + 1);
  return /className="([^"]*)"/.exec(tag)?.[1] ?? "";
}

test("the purchases page's closing note is at most 50ch wide", () => {
  const cls = paragraphClass(readFileSync("app/[handle]/orders/page.tsx", "utf8"), "data-while-open");
  const cap = capOf(cls);
  assert.ok(cap !== null && cap <= 50, `class "${cls}"`);
});

// Claude 3 on #3997 (6912741283, MEDIUM): at 56ch, Chromium's Buyer action AAA measured this note at 85 characters a
// line, over the 80 of WCAG 1.4.8 (about 1.5 characters a ch in its font); 50ch is what the notes beside it hold.
test("the library's note on what stays while a store is open is at most 50ch wide", () => {
  const cls = paragraphClass(readFileSync("app/library/page.tsx", "utf8"), "What you bought from a store is here");
  const cap = capOf(cls);
  assert.ok(cap !== null && cap <= 50, `class "${cls}"`);
});

test("the library's note on when purchases count is at most 50ch wide", () => {
  const cls = paragraphClass(readFileSync("app/library/page.tsx", "utf8"), "Purchases count from October 11, 2026");
  const cap = capOf(cls);
  assert.ok(cap !== null && cap <= 50, `class "${cls}"`);
});
