import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * WCAG 2.2 1.4.8 Visual Presentation, AAA (274 [AX1]): no block of the digital
 * consent box (components/digital-consent-box.tsx: the course page, renewing,
 * moving, free items and buying) is wider than 80 characters.
 *
 * Found by a browser audit (11 November 2026, Chromium, a synthetic course,
 * a local build of main 7b04206e): on a course's page the box's note ran 103
 * characters a line, its "Your access is provided by this store..." 91 and its
 * withdrawal line 82, at 768 and 1280 px; on a product's page the box sits in
 * .st-measure and was already capped. With every paragraph of the box held to
 * 46ch (its error box and its screen-reader-only line excepted), none ran over
 * 80 at 320, 768 or 1280 px, nor with 1.4.12 text spacing.
 *
 * The cap is drawn from the box's own marker, data-digital-consent, so the
 * component and the pages that show it are not edited.
 */
const css = readFileSync("app/globals.css", "utf8");

test("the consent box's paragraphs are at most 46ch wide", () => {
  const selector = "[data-digital-consent] p:not(.st-note, .sr-only)";
  const at = css.indexOf("\n" + selector + " {");
  assert.ok(at >= 0, `a rule for ${selector}`);
  const body = css.slice(at, css.indexOf("}", at));
  const cap = /max-width:\s*(\d+(?:\.\d+)?)ch;/.exec(body);
  assert.ok(cap && Number(cap[1]) <= 46, body);
});

test("the marker the rule relies on is still drawn by the component", () => {
  assert.match(readFileSync("components/digital-consent-box.tsx", "utf8"), /data-digital-consent=""/);
});
