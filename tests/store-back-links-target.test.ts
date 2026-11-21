import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * WCAG 2.2 2.5.5 Target Size (Enhanced), AAA (274 [AX1]): a store page's
 * stand-alone way back ("Back to Quiet Oven", "All letters", "Keep my plan")
 * is a 44 x 44 CSS px target.
 *
 * The store front already drew its .st-footer-link at 44 px
 * ([data-store-layout] in app/globals.css). Every other page under a store
 * (tip, waitlist, letters, blog, manage, renew, review, pay, sign, podcast,
 * certificate, course, ...) did not: a browser audit (11 November 2026,
 * Chromium, synthetic store) measured "Back to Quiet Oven" on the tip page at
 * 130 x 20, and about thirty such links, a direct child of a <div> or a <nav>,
 * carry no min-h-11 of their own.
 *
 * A link directly inside a <div> or <nav> stands alone on those pages; a link
 * inside a sentence sits in a <p> or <span> and keeps its line (2.5.5 exempts
 * it). Summaries and quote captions are not <a> and keep their own rules.
 */
const css = readFileSync("app/globals.css", "utf8");

function ruleBody(selector: string): string | null {
  const at = css.indexOf(selector + " {");
  if (at === -1) return null;
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

test("a store page's stand-alone back link is a 44 px target outside the store front too", () => {
  const body = ruleBody(".st-page :is(div, nav) > a.st-footer-link");
  assert.ok(body, "a rule for .st-page :is(div, nav) > a.st-footer-link");
  assert.match(body!, /display:\s*inline-flex;/);
  assert.match(body!, /align-items:\s*center;/);
  assert.match(body!, /min-height:\s*2\.75rem;/);
});

test("the store front's own rule is kept", () => {
  const body = ruleBody("[data-store-layout] .st-footer-link:not(summary, figcaption > *)");
  assert.ok(body && /min-height:\s*2\.75rem;/.test(body));
});

test("the rule sits outside a cascade layer, so it wins over a link's own display utility", () => {
  const at = css.indexOf(".st-page :is(div, nav) > a.st-footer-link {");
  const before = css.slice(0, at);
  let depth = 0;
  for (const ch of before) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
  assert.equal(depth, 0);
});
