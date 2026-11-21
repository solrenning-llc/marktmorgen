import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * WCAG 2.2 1.4.8 Visual Presentation, AAA (274 [AX1]): no block of the blog's
 * index (app/blog/page.tsx, components/blog-browser.tsx) is wider than 80
 * characters a line.
 *
 * Found by a browser audit (11 November 2026, Chromium, a local build of main
 * 7b04206e) at 1280 px: the count line ("17 articles · Written by us...") ran
 * 92 characters, the guides' lead 98 (max-w-3xl), the search lead 86
 * (max-w-2xl) and a card's excerpt 94. Each is now at most 46ch: none over 80
 * at 768 or 1280 px, nor with 1.4.12 text spacing.
 */
const page = readFileSync("app/blog/page.tsx", "utf8");
const browser = readFileSync("components/blog-browser.tsx", "utf8");
const capOfTag = (source: string, marker: string): number => {
  const at = source.indexOf(marker);
  assert.ok(at > 0, marker);
  const open = source.lastIndexOf("<p ", at);
  const tag = source.slice(open, source.indexOf(">", open));
  return Number(/max-w-\[(\d+)ch\]/.exec(tag)?.[1] ?? 999);
};

test("the blog's count line, guides' lead and search lead are at most 46ch", () => {
  assert.ok(capOfTag(page, "<span>{`${posts.length} articles`}</span>") <= 46);
  assert.ok(capOfTag(page, "Five practical guides:") <= 46);
  assert.ok(capOfTag(page, "Pick a subject or search for a word.") <= 46);
});

test("a card's excerpt is at most 46ch", () => {
  assert.ok(capOfTag(browser, "{post.excerpt}") <= 46);
});
