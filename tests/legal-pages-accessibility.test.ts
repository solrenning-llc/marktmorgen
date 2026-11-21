import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * The legal pages (components/legal-page.tsx: Terms, Privacy, Refunds,
 * Accessibility, Copyright, Status), held to WCAG 2.2 AAA where a browser
 * audit found them short (274 [AX1]; 11 November 2026, Chromium, a local
 * build of main 7b04206e):
 *
 * - 1.4.8 Visual Presentation: the body text ran over 80 characters a line,
 *   151 blocks on /privacy, 79 on /terms, 29 on /accessibility, 22 on
 *   /refunds, 14 on /copyright, 9 on /status, at 768 and 1280 px. Every p,
 *   li, dd and blockquote of .legal-body is now at most 46ch: none over 80 at
 *   320, 768 and 1280 px, nor with 1.4.12 text spacing (48ch also passed;
 *   46 keeps a margin for a wider fallback font).
 * - 2.5.5 Target Size (Enhanced): each link of the page index was 240 x 30.
 *   It is now at least 44 px tall.
 *
 * This reads the style sheet; the browser audit is the evidence.
 */
const css = readFileSync("app/globals.css", "utf8");
const body = (selector: string): string => {
  const at = css.indexOf("\n" + selector + " {");
  assert.ok(at >= 0, selector);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
};

test("1.4.8: the legal pages' text blocks are at most 46ch wide", () => {
  const rule = body(".legal-body :where(p, li, dd, blockquote)");
  const cap = /max-width:\s*(\d+(?:\.\d+)?)ch;/.exec(rule);
  assert.ok(cap && Number(cap[1]) <= 46, rule.trim());
});

test("2.5.5: each link of the legal page index is a 44 px tall target", () => {
  const rule = body(".toc-link");
  assert.match(rule, /min-height:\s*2\.75rem;/);
  assert.match(rule, /display:\s*flex;/);
  assert.match(rule, /align-items:\s*center;/);
});
