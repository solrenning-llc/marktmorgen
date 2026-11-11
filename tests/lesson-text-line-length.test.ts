import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LessonText } from "../components/lesson-text";

/*
 * WCAG 2.2 1.4.8 Visual Presentation, AAA (274 [AX1]): a lesson's paragraphs
 * and lists are no wider than 80 characters a line.
 *
 * Found by a browser audit (11 November 2026, Chromium, a synthetic course's
 * free preview lesson, a local build of main 7b04206e): the lesson's text ran
 * the whole width of its column (max-w-5xl) and a paragraph reached 81
 * characters a line at 1280 px; a longer one would reach more. With each
 * paragraph and list held to 46ch none ran over 80 at 768 or 1280 px, nor with
 * 1.4.12 text spacing. Only the width it is drawn at changes: the creator's
 * words are rendered exactly as typed. Code and HTML previews keep the column.
 */
const html = renderToStaticMarkup(
  createElement(LessonText, {
    text: "A first paragraph of the lesson.\n\nA second one.\n\n- one item\n- another item\n\n```\nconst wide = 'code keeps the whole width';\n```",
  }),
);
const cap = (cls: string): number | null => {
  const m = /(?:^|\s)max-w-\[(\d+)ch\](?:\s|$)/.exec(cls);
  return m ? Number(m[1]) : null;
};
const classesOf = (tag: string) => [...html.matchAll(new RegExp(`<${tag}\\s[^>]*class="([^"]*)"`, "g"))].map((m) => m[1]);

test("every paragraph is at most 46ch wide", () => {
  const ps = classesOf("p");
  assert.ok(ps.length >= 2);
  for (const cls of ps) assert.ok((cap(cls) ?? 999) <= 46, cls);
});

test("every list is at most 46ch wide", () => {
  const uls = classesOf("ul");
  assert.ok(uls.length >= 1);
  for (const cls of uls) assert.ok((cap(cls) ?? 999) <= 46, cls);
});

test("a code block keeps the column's width, and the words are as typed", () => {
  for (const cls of classesOf("pre")) assert.equal(cap(cls), null, cls);
  assert.match(html, /A first paragraph of the lesson\./);
  assert.match(html, /const wide = &#x27;code keeps the whole width&#x27;;/);
});
