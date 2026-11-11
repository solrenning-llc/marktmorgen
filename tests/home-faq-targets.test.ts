import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Faq } from "../components/home-static";
import { HOME_QUESTIONS } from "../lib/home-faq";

/*
 * WCAG 2.2 2.5.5 Target Size (Enhanced), AAA (274 [AX1]): every link under an
 * answer of the home page's questions is pressed alone, one to a list item,
 * not inside a sentence, so it is at least 44 x 44 CSS px.
 *
 * Found by a browser audit (11 November 2026, Chromium, the home page with each
 * answer opened): "All prices and limits" 150 x 20, "Refund policy" 107 x 20,
 * and five more at 20 px tall, at 320 and 1280 px wide. A link's text is wider
 * than 44 px; its height comes from min-h-11 (2.75rem), drawn as an inline-flex
 * box so the height is its own and not only its line's.
 */
const markup = renderToStaticMarkup(createElement(Faq));
const answerLinks = [...markup.matchAll(/<li><a([^>]*)>([^<]*)<\/a><\/li>/g)].map((m) => ({ attrs: m[1], label: m[2] }));

test("every answer link is drawn, one to a list item", () => {
  const wanted = HOME_QUESTIONS.flatMap((item) => item.links ?? []).map((link) => link.label);
  assert.ok(wanted.length >= 6, "the questions link to the rest of the site");
  assert.deepEqual(answerLinks.map((link) => link.label.replace(/&#x27;/g, "'")), wanted);
});

test("every answer link is a 44 px tall target (2.5.5)", () => {
  for (const link of answerLinks) {
    const cls = /class="([^"]*)"/.exec(link.attrs)?.[1] ?? "";
    assert.match(cls, /(^|\s)min-h-11(\s|$)/, `${link.label}: min-h-11`);
    assert.match(cls, /(^|\s)inline-flex(\s|$)/, `${link.label}: inline-flex`);
    assert.match(cls, /(^|\s)items-center(\s|$)/, `${link.label}: its words centred in the target`);
    assert.match(cls, /(^|\s)link(\s|$)/, `${link.label}: still drawn as a link`);
  }
});
