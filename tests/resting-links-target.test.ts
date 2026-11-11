import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * WCAG 2.2 2.5.5 Target Size (Enhanced), AAA (274 [AX1]): every way out of a
 * resting store's page (components/store-resting.tsx) is a 44 x 44 CSS px
 * target.
 *
 * Found by a browser audit (11 November 2026, Chromium, a synthetic store,
 * a local build of main 7b04206e): "Bought something here? Get it again"
 * (244 x 18) and "Is this your store? Your studio says why..." (432 x 18) each
 * stand alone in their own paragraph, so 2.5.5's inline exception does not
 * apply. "Made with Marktmorgen" sits directly in a <div> and is already 44 px
 * tall. Each link held in a paragraph is now an inline-flex box at least
 * 2.75rem tall.
 */
const source = readFileSync("components/store-resting.tsx", "utf8");

test("every link alone in a paragraph of the resting page is 44 px tall", () => {
  const held = [...source.matchAll(/<p className="mb-4">\s*<Link [^>]*className="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(held.length, 3, "the three paragraph links (get it again, community, the owner's note)");
  for (const cls of held) {
    assert.match(cls, /(^|\s)st-footer-link(\s|$)/, cls);
    assert.match(cls, /(^|\s)inline-flex(\s|$)/, cls);
    assert.match(cls, /(^|\s)min-h-11(\s|$)/, cls);
    assert.match(cls, /(^|\s)items-center(\s|$)/, cls);
  }
});
