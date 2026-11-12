import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * WCAG 2.2 1.4.8 Visual Presentation, AAA (274 [AX1]): no block of /mission or
 * of a blog article (app/blog/[slug]/page.tsx) is wider than 80 characters.
 *
 * Found by a browser audit (11 November 2026, Chromium, a local build of main
 * 7b04206e): /mission had 17 blocks over 80 at 1280 px and 98 at 768 (its
 * story, its "built"/"not yet" lists, its notes and its timeline); an article
 * ("Sell a digital file from your bio") 26 (its body in .prose-nb, its lead,
 * its answers and its closing note). Each is now at most 46ch: none over 80 at
 * 320, 768 or 1280 px, nor with 1.4.12 text spacing.
 *
 * Review of this change (Claude 3, 12 November 2026) measured one block the
 * audit missed: the mission's "A note on how we write" quote, outside
 * .prose-nb, at 84 characters a line at 768 and 1280 px. It is capped too.
 */
const css = readFileSync("app/globals.css", "utf8");
const mission = readFileSync("app/mission/page.tsx", "utf8");
const article = readFileSync("app/blog/[slug]/page.tsx", "utf8");
const capped = (cls: string) => Number(/(?:^|\s)max-w-\[(\d+)ch\](?:\s|$)/.exec(cls)?.[1] ?? 999) <= 46;

test("an article's and the mission's prose is at most 46ch", () => {
  const at = css.indexOf("\n.prose-nb :where(p, li, blockquote) {");
  assert.ok(at >= 0);
  const cap = /max-width:\s*(\d+)ch;/.exec(css.slice(at, css.indexOf("}", at)));
  assert.ok(cap && Number(cap[1]) <= 46);
});

test("/mission: its lead, list items, note and timeline items are at most 46ch", () => {
  const lis = [...mission.matchAll(/<li key=\{item\} className="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(lis.length, 3);
  for (const cls of lis) assert.ok(capped(cls), cls);
  assert.ok(capped(/<p className="(t-lead mt-6[^"]*)">\s*What you pay us/.exec(mission)?.[1] ?? ""));
  assert.ok(capped(/<p className="([^"]*border-t border-line pt-5[^"]*)"/.exec(mission)?.[1] ?? ""));
  assert.ok(capped(/<p className="([^"]*)">\{r\.items\}/.exec(mission)?.[1] ?? ""));
  assert.ok(capped(/<blockquote className="([^"]*)">\s*We do not publish invented reviews/.exec(mission)?.[1] ?? ""));
});

test("a blog article: its lead, answers and closing note are at most 46ch", () => {
  assert.ok(capped(/<p className="(t-lead mt-5[^"]*)">\{post\.excerpt\}/.exec(article)?.[1] ?? ""));
  assert.ok(capped(/<dd className="([^"]*)">\{item\.a\}/.exec(article)?.[1] ?? ""));
  assert.ok(capped(/<p className="([^"]*)">Paid plans and paid selling remain closed/.exec(article)?.[1] ?? ""));
});
