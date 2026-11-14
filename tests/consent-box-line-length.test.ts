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

/*
 * Review of #3787 (Claude 1 cloud, MEDIUM): the sentence the buyer checks is a span inside the box's label, not a p,
 * and ran about 90 characters a line on a course's page at 768 and 1280 px: it is capped with the paragraphs.
 * Review LOW: the cap sits in @layer components under :where, like the store front's 34ch caps, so where the box is
 * drawn inside .st-measure or [data-store-layout] the narrower cap still applies (a later rule of the same layer and
 * weight), and Tailwind's utilities still win.
 */
const RULE = ":where([data-digital-consent]) :where(p:not(.st-note, .sr-only), label > span)";

test("the consent box's paragraphs and the sentence the buyer checks are at most 46ch wide", () => {
  const at = css.indexOf(RULE + " {");
  assert.ok(at >= 0, `a rule for ${RULE}`);
  const body = css.slice(at, css.indexOf("}", at));
  const cap = /max-width:\s*(\d+(?:\.\d+)?)ch;/.exec(body);
  assert.ok(cap && Number(cap[1]) <= 46, body);
});

test("the cap is in @layer components, so the store front's narrower caps and Tailwind's utilities still win", () => {
  const at = css.indexOf(RULE + " {");
  const layer = css.lastIndexOf("@layer components {", at);
  assert.ok(layer >= 0 && at > layer, "inside @layer components");
  // No brace closes the layer between its opening and the rule.
  const between = css.slice(layer + "@layer components {".length, at);
  let depth = 1;
  for (const ch of between) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
  assert.equal(depth, 1, "the rule is directly inside the layer");
  assert.equal(css.includes("\n[data-digital-consent] p:not(.st-note, .sr-only) {"), false, "no unlayered cap left");
});

test("the box's sentence is still the label's span the rule caps", () => {
  assert.match(readFileSync("components/digital-consent-box.tsx", "utf8"), /<span>\{c\.box\[kind\]\}<\/span>\s*<\/label>/);
});

test("the marker the rule relies on is still drawn by the component", () => {
  assert.match(readFileSync("components/digital-consent-box.tsx", "utf8"), /data-digital-consent=""/);
});
