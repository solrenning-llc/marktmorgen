import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * WCAG 2.2 1.4.8 Visual Presentation, AAA (274 [AX1]): no block of the help
 * center's answers is wider than 80 characters.
 *
 * Found by a browser audit (11 November 2026, Chromium, a local build of main
 * 7b04206e, characters counted on each rendered line): 359 answer paragraphs
 * on /help and 15 on /help/buyers ran over 80 a line at 1280 px (13 at 768).
 * /help/buyers already capped them at 70ch, but Geist's "0" is wide (0.66em),
 * so 70ch was still about 95 characters. With 46ch none ran over 80 on /help.
 *
 * /help's answers are capped from the help center's own style sheet
 * (app/help/focus-scroll.css, loaded by app/help/layout.tsx), so the page is
 * not edited; /help/buyers's paragraph class is 46ch.
 */
const capOf = (text: string): number | null => {
  const m = /max-width:\s*(\d+(?:\.\d+)?)ch;/.exec(text) ?? /max-w-\[(\d+(?:\.\d+)?)ch\]/.exec(text);
  return m ? Number(m[1]) : null;
};

test("/help: every answer paragraph, list item and definition is at most 46ch", () => {
  const css = readFileSync("app/help/focus-scroll.css", "utf8");
  const at = css.indexOf("[data-help-section] :where(p, li, dd) {");
  assert.ok(at >= 0, "a rule for [data-help-section] :where(p, li, dd)");
  const cap = capOf(css.slice(at, css.indexOf("}", at)));
  assert.ok(cap !== null && cap <= 46, String(cap));
});

test("/help/buyers: every answer paragraph is at most 46ch", () => {
  const page = readFileSync("app/help/buyers/page.tsx", "utf8");
  const at = page.indexOf("{item.a.map((paragraph) => (");
  assert.ok(at >= 0);
  const tag = page.slice(page.indexOf("<p ", at), page.indexOf(">", page.indexOf("<p ", at)));
  const cap = capOf(tag);
  assert.ok(cap !== null && cap <= 46, tag);
});
