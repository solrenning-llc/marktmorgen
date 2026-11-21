import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * WCAG 2.2 2.5.5 Target Size (Enhanced), AAA (274 [AX1]): the product title on
 * the embedded card (app/embed/[handle]/[product]/page.tsx), the checkout a
 * creator puts on their own site, is a link at least 44 x 44 CSS px.
 *
 * Found by a browser audit (11 November 2026, Chromium, a local build of main
 * 7b04206e): the title link was 22 px tall ("Bread Basics Workbook" 185 x 22,
 * "Flour Cheat Sheet" 140 x 22). With a picture, the 160 px cover leads to the
 * same page (2.5.5's "equivalent" exception); without one there is no
 * equivalent. The title keeps its two-line clamp: its click area is stretched
 * over the block that holds the title and the store's name (at least 44 px
 * tall), the usual "stretched link" pattern, and its focus ring stays on the
 * words.
 */
const page = readFileSync("app/embed/[handle]/[product]/page.tsx", "utf8");
const css = readFileSync("app/globals.css", "utf8");

test("the title link carries the stretched class inside a positioned block at least 44 px tall", () => {
  const link = page.indexOf('className="st-title-link em-title"');
  assert.ok(link > 0, "the title link has em-title");
  const block = page.lastIndexOf("<div ", link);
  const tag = page.slice(block, page.indexOf(">", block));
  assert.match(tag, /(^|[\s"])relative(\s|")/, tag);
  assert.match(tag, /(^|[\s"])min-h-11(\s|")/, tag);
});

test("the stretched area covers the whole positioned block", () => {
  const at = css.indexOf(".em-title::after {");
  assert.ok(at >= 0, "a rule for .em-title::after");
  const body = css.slice(at, css.indexOf("}", at));
  assert.match(body, /content:\s*"";/);
  assert.match(body, /position:\s*absolute;/);
  assert.match(body, /inset:\s*0;/);
});
