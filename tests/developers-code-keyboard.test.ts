import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * The API reference's code blocks (app/developers/page.tsx, Code), held to
 * WCAG 2.2 2.1.1 Keyboard (A) and 2.4.13 Focus Appearance (AAA) (274 [AX1]).
 *
 * Found by a browser audit (11 November 2026, Chromium, axe-core 4.13, a local
 * build of main 7b04206e): the blocks scroll sideways, and axe reported
 * scrollable-region-focusable on 15 of them at 320 px. Chromium and Firefox
 * let Tab reach a scroller on their own; Safari does not, so a keyboard user
 * there could not read the end of a long line. Where Tab did reach one, its
 * focus was the browser's default 1 px ring on the dark block.
 *
 * Each block now takes focus in every browser (tabIndex 0), is a named group
 * so the stop it makes says what it is, and draws a 3 px ring in the site's
 * light accent, the same pattern as a lesson's code (components/lesson-text.tsx).
 */
const page = readFileSync("app/developers/page.tsx", "utf8");
const code = page.slice(page.indexOf("function Code("), page.indexOf("function Endpoint("));

test("each code block takes keyboard focus and names itself", () => {
  assert.match(code, /<pre\s[^>]*tabIndex=\{0\}/);
  assert.match(code, /<pre\s[^>]*role="group"/);
  assert.match(code, /<pre\s[^>]*aria-label="Code"/);
});

test("its focus ring is 3 px", () => {
  const cls = /<pre\s[^>]*className="([^"]*)"/.exec(code)?.[1] ?? "";
  assert.match(cls, /focus-visible:outline-\[3px\]/);
  assert.match(cls, /focus-visible:outline-offset-\[3px\]/);
});
