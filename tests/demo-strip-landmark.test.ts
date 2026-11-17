import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DemoStrip } from "../components/demo-notes";

/*
 * The demo store's strip, "Stripe test mode: no real money moves", across the
 * top of every page of /@harborkitchen (274 [AX1]). A browser audit (11
 * November 2026, Chromium, axe-core 4.13) found it outside every landmark on
 * every page of the demo (axe "region", a best practice under WCAG 1.3.1 and
 * 2.4.1): a screen reader user who moves by landmarks skips the one notice
 * that no real money is charged. It now sits in a named complementary
 * landmark, so it is listed with the page's regions.
 */
const html = renderToStaticMarkup(createElement(DemoStrip));

test("the demo strip is a named landmark", () => {
  const open = /^<aside([^>]*)>/.exec(html);
  assert.ok(open, html.slice(0, 120));
  assert.match(open![1], /aria-label="Demo store"/);
});

test("the strip still says what it said, inside the landmark", () => {
  assert.match(html, /Stripe test mode: no real money moves\./);
  assert.match(html, /4242 4242 4242 4242/);
  assert.match(html, /data-demo-strip=""/);
  assert.match(html, /<\/aside>$/);
});
