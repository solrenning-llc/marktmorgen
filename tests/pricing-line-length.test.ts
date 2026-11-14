import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * WCAG 2.2 1.4.8 Visual Presentation, AAA (274 [AX1]): a block of text on the
 * pricing page is no wider than 80 characters.
 *
 * Found by a browser audit (11 November 2026, Chromium, characters counted on
 * each rendered line): at 1280 px 36 paragraphs and definitions ran 81 to 167
 * characters a line (the fee model's note, the Hotmart comparison, the terms'
 * "Money back", the questions' answers), and at 768 px 34 plan-card items ran
 * 81 to 92. With every p, dd and li of the page held to 50ch (li of the
 * section index excepted, those are links in a grid), none ran over 80 at 320,
 * 390, 640, 768, 900, 1024, 1280, 1440 or 1920 px, nor with 1.4.12 text
 * spacing.
 *
 * `ch` is the width of the font's "0", so the cap follows the font and the
 * text size. The rule is scoped to the pricing page by its section index, so
 * it stays off any other page once this style sheet is loaded.
 */
const css = readFileSync("app/pricing/pricing.css", "utf8");
const SELECTOR = "main:has(.pricing-section-index) :where(p, dd, li:not(nav li))";

test("the pricing page caps its paragraphs, definitions and list items at 50ch or less", () => {
  const at = css.indexOf(SELECTOR + " {");
  assert.ok(at >= 0, `a rule for ${SELECTOR}`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  const cap = /max-width:\s*(\d+(?:\.\d+)?)ch;/.exec(body);
  assert.ok(cap && Number(cap[1]) <= 50, body.trim());
});

test("the cap is scoped to the pricing page, not to every main", () => {
  for (const rule of css.matchAll(/([^{}]+)\{[^}]*max-width:\s*\d+(?:\.\d+)?ch/g)) {
    assert.match(rule[1], /:has\(\.pricing-section-index\)/, rule[1].trim());
  }
});
