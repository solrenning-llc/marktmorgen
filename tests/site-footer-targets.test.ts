import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteFooter } from "../components/site-footer";

/*
 * WCAG 2.2 2.5.5 Target Size (Enhanced), AAA (274 [AX1]): every link of the
 * site's footer is a 44 x 44 CSS px target that no other link covers.
 *
 * Found by a browser audit (11 November 2026, Chromium; the area that takes a
 * click measured with elementFromPoint) on /pricing and the 404 page: each
 * column link drew a 44 px box, but -my-2.5 under space-y-1.5 laid the boxes
 * 30 px apart, so the next link covered the bottom of each one and about 25
 * links took a click on only 30 px of height, at 320 and 1280 px. "Cooks" and
 * "Blog" were also 43 and 31 px wide.
 *
 * Each link is now at least 44 x 44 (min-h-11, min-w-11) with no negative
 * margin, so the boxes sit end to end and none covers another. The support
 * address stays a link inside its sentence, which 2.5.5 exempts.
 */
const VARIANTS = [
  ["full", renderToStaticMarkup(createElement(SiteFooter))],
  ["home", renderToStaticMarkup(createElement(SiteFooter, { variant: "home" }))],
  ["morning", renderToStaticMarkup(createElement(SiteFooter, { morning: true }))],
] as const;

/** Every link of a footer list (a column or the bottom row), with its class list and words. */
const anchors = (html: string) =>
  [...html.matchAll(/<li[^>]*>\s*<a([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    cls: /class="([^"]*)"/.exec(m[1])?.[1] ?? "",
    href: /href="([^"]*)"/.exec(m[1])?.[1] ?? "",
    words: m[2].replace(/<[^>]*>/g, "").trim(),
  }));

test("every footer link outside a sentence is a 44 x 44 target", () => {
  for (const [name, html] of VARIANTS) {
    const links = anchors(html).filter((a) => !a.href.startsWith("mailto:"));
    assert.ok(links.length > 10, `${name}: the footer's links are drawn`);
    for (const a of links) {
      const label = `${name}: ${a.words || a.href}`;
      assert.match(a.cls, /(^|\s)min-h-11(\s|$)/, `${label} is 44 px tall`);
      assert.match(a.cls, /(^|\s)min-w-11(\s|$)/, `${label} is 44 px wide, however short its word`);
    }
  }
});

test("no footer link pulls its box over a neighbour with a negative margin", () => {
  for (const [name, html] of VARIANTS) {
    for (const a of anchors(html)) {
      assert.doesNotMatch(a.cls, /(^|\s)-m[xytblr]?-/, `${name}: ${a.words || a.href}`);
    }
  }
});
