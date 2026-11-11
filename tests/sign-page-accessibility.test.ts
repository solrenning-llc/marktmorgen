import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * The page where a person signs a creator's agreement
 * (app/[handle]/sign/[agreement]/page.tsx), held to WCAG 2.2 AAA where a
 * browser audit found it short (274 [AX1]; 11 November 2026, Chromium, an
 * agreement written and sent through the studio as tests/e2e/agreements.mjs
 * does, a local build of main 7b04206e):
 *
 * - 1.4.8: the three notes before signing and "Don't recognize this?..." ran
 *   85 to 89 characters a line at 768 and 1280 px. Each paragraph of the page
 *   is now at most 46ch (a notice box keeps its width): none over 80 at 320,
 *   768 or 1280 px, nor with 1.4.12 text spacing.
 * - 2.5.5: the "I agree" box is 13 x 13 and its label, the target that takes
 *   the click, was under 44 px tall at 768 and 1280 px. The label is now at
 *   least 2.75rem tall, its words centred.
 *
 * The rules are drawn from the page's own signing form (its action), so the
 * page is not edited; the second test keeps that hook honest.
 */
const css = readFileSync("app/globals.css", "utf8");
const page = readFileSync("app/[handle]/sign/[agreement]/page.tsx", "utf8");
const body = (selector: string): string => {
  const at = css.indexOf("\n" + selector + " {");
  assert.ok(at >= 0, selector);
  return css.slice(at, css.indexOf("}", at));
};

test("1.4.8: the signing page's paragraphs are at most 46ch", () => {
  const cap = /max-width:\s*(\d+(?:\.\d+)?)ch;/.exec(body('main:has(form[action="/api/store/agreement-sign"]) :where(p, li, dd):not(.st-note)'));
  assert.ok(cap && Number(cap[1]) <= 46);
});

test("2.5.5: the agree box's label is a 44 px tall target", () => {
  const rule = body('form[action="/api/store/agreement-sign"] label:has(> input[type="checkbox"])');
  assert.match(rule, /min-height:\s*2\.75rem;/);
  assert.match(rule, /align-items:\s*center;/);
});

test("the hook: the page still signs through that form, with the box inside its label", () => {
  assert.match(page, /<form action="\/api\/store\/agreement-sign"/);
  assert.match(page, /<label [^>]*>\s*<input type="checkbox" name="agree"/);
});
